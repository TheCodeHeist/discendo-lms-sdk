# Scheduling: Solver

The auto-scheduling solver under `src/domains/scheduling/solver/` and the adapter that feeds it
(`src/domains/scheduling/solver-adapter.ts`). Most hosts reach it through
`SchedulingService.planAutoSchedule` (see [SCHEDULING.md](./SCHEDULING.md)); `solveSchedule` can also
be called directly with a hand-built problem. The hard constraints it applies come from the rule
functions on [SCHEDULING_RULES.md](./SCHEDULING_RULES.md).

## Overview

This is the NP-hard part: given a set of classes that need a room and time,
and a set of constraints (capacity, features, teacher/room/group
availability, no double-booking), produce a conflict-free assignment. Class
timetabling is a well-known NP-complete problem (it reduces to graph
coloring), so this module does not attempt to guarantee a global optimum —
it uses a backtracking search with a strong ordering heuristic, bounded so
it always terminates with a usable partial result rather than hanging.

### Design choice: zero runtime dependencies

The solver is implemented in pure TypeScript with no external solver
library (no OR-Tools/CP-SAT binding). This matches the project's
`package.json`, which declares no hard runtime dependencies. The module
comments explicitly note this as swappable: a CP-SAT-backed adapter could
be added later behind the same `SchedulingProblem -> SolveResult` function
signature for institutions large enough to need it, without changing
anything upstream.

### `solver/types.ts`

```ts
interface UnscheduledSession {
  id: Id;
  sectionId: Id;
  courseId?: Id; // only for qualification checks
  teacherIds: Id[];
  groupId: Id;
  groupSize: number;
  requiredRoomFeatures?: string[];
  candidateDays: Weekday[];
  durationMinutes: number;
}

interface SolverRoom {
  id: Id;
  capacity: number;
  features: string[];
}

interface ResourceAvailabilityWindow {
  resourceType: "teacher" | "room" | "group";
  resourceId: Id;
  day: Weekday;
  startTime: string;
  endTime: string;
}

interface SchedulingProblem {
  sessions: UnscheduledSession[];
  rooms: SolverRoom[];
  availability: ResourceAvailabilityWindow[];
  teacherQualifications?: TeacherQualification[]; // opt-in; see teacher-qualification.ts
  candidateSlotsPerDay: string[]; // e.g. every 30 min from 08:00-18:00
  days: Weekday[];
}

interface PlacedSession {
  sessionId: Id;
  roomId: Id;
  days: Weekday[];
  startTime: string;
  endTime: string;
}

interface UnplaceableSession {
  sessionId: Id;
  reason: string;
}

type SolveStatus = "COMPLETE" | "PARTIAL" | "INFEASIBLE";

interface SolveResult {
  status: SolveStatus;
  placements: PlacedSession[];
  unplaced: UnplaceableSession[];
  totalPenalty: number; // weighted soft-constraint penalty of the schedule found; 0 if none supplied
}

interface SolverOptions {
  maxBacktrackSteps?: number; // default 200,000
  softConstraints?: SoftConstraint[]; // preferences, see soft-constraints.ts
}
```

**Critical semantic to understand: `UnscheduledSession.candidateDays` is not
"pick any one of these days."** The solver treats it as a single atomic
requirement — it finds **one room and one start/end time that work across
every day in `candidateDays` simultaneously** (e.g. "Room 4, 10:00–11:00, on
Mon/Wed/Fri"), matching how institutions actually schedule recurring
classes (the same room and time slot for every meeting of the week, not a
different room each day). `PlacedSession.days` reflects this — it's the
full set of days the single placement applies to, not one day per
`UnscheduledSession`.

> **Note on this design:** the solver went through a real redesign
> mid-development. Its first version placed a session on only one day even
> when `candidateDays` (then modeled on the raw `RecurrenceRule`) listed
> several — silently under-scheduling any class meeting more than once a
> week. This was caught while wiring `solver-adapter.ts` and fixed by
> changing `PlacedSession.day: Weekday` to `PlacedSession.days: Weekday[]`
> and rewriting candidate generation to validate a candidate room/time
> against _all_ required days before accepting it. A regression test
> (`scheduling-solver.test.ts` / the "does not create a candidate if the
> room/time fails on even one of the candidate days" case) exists
> specifically to guard against this recurring.

The `SolverRoom` availability model is a **flattened, single representative
week** — the solver reasons about "does this fire on Monday at 10am in
general," not about specific calendar dates. Recurrence across actual
calendar weeks is handled separately, afterward, by `generator.ts`. See
`solver-adapter.ts` below for how real `AvailabilityRule`s (which are
date-anchored and can have `interval > 1`) get flattened into this shape,
and the one real limitation that flattening has.

### `solver/backtracking.ts` — the algorithm

```ts
function solveSchedule(
  problem: SchedulingProblem,
  options?: SolverOptions,
): SolveResult;
```

**Approach: most-constrained-variable backtracking.**

0. **Qualification first.** Before any searching, every session's teachers are
   checked with `checkAllTeachersQualified`. A session with an unqualified teacher
   can never be placed whatever the room or time, so it is pulled out up front and
   reported in `unplaced` with the specific reason ("Teacher t1 is not listed as
   qualified for course c1."), rather than the generic "no slot found". It never
   blocks the other sessions.
1. **Sort sessions by how few valid candidates they have, hardest first.**
   For each session, candidates are precomputed once: every `(room,
startTime)` pair where the room has sufficient capacity and required
   features, and where every teacher, the group, and the room are available
   (per `ResourceAvailabilityWindow`) across _all_ of the session's
   `candidateDays` at that time. Sessions with fewer valid candidates are
   scheduled first — this is the single biggest lever against combinatorial
   blowup: a session with only one qualifying room and one available time
   slot must never be left until last, after everything else has already
   claimed it.
2. **Try each candidate** for the current session, best-scoring first when soft
   constraints are supplied (see `soft-constraints.ts` below), in generated order
   otherwise; skip any that conflicts with a placement already made this search — same room, same
   day, overlapping time; or same group; or a shared teacher, again on a
   shared day with overlapping time.
3. **Recurse.** If every remaining session places successfully, done. If a
   branch dead-ends, backtrack and try the next candidate.
4. **Bounded by `maxBacktrackSteps`** (default 200,000) — rather than
   hanging on a pathological input, the search gives up and returns
   whatever was validly placed so far as `PARTIAL`.
5. If a session has **zero** candidates at all (no room/day/time
   combination satisfies capacity, features, and availability), or if every
   candidate it does have leads to a dead end further down the search, it's
   recorded in `unplaced` with a reason, and the search continues with the
   remaining sessions — **one impossible session never blocks every other
   session from getting a result.**

Overall status:

- `COMPLETE` — every session placed
- `PARTIAL` — some placed, some not
- `INFEASIBLE` — nothing could be placed at all

### `solver/soft-constraints.ts` — preferences

Hard constraints (capacity, features, availability, qualification, no double-booking)
decide whether a placement is *allowed*. **Soft constraints** decide which of the allowed
placements is *better*, and **never make a solve fail**.

```ts
interface SoftConstraint {
  name: string;
  weight: number;                          // penalties are multiplied by this
  penalty(ctx: CandidateContext): number;  // >= 0; 0 = fully satisfied
}

interface CandidateContext {
  session: UnscheduledSession;
  roomId: Id;
  days: Weekday[];
  startTime: string;
  endTime: string;
  placedSoFar: ReadonlyMap<string, PlacedSession>;   // only this branch of the search
  sessionsById: ReadonlyMap<string, UnscheduledSession>;
}

function scoreCandidate(constraints: SoftConstraint[], ctx: CandidateContext): number;
```

Three constraint builders are provided:

| Builder | Penalty |
| --- | --- |
| `teacherTimePreference(teacherId, earliest, latest, weight = 1)` | for a session that teacher teaches, the **minutes** by which the start falls outside `[earliest, latest]` (10 minutes early costs less than 3 hours early); 0 inside the window or for other teachers' sessions |
| `preferredRoomForCourse(courseId, preferredRoomIds, weight = 1)` | for a session of that course, a flat `1` if the room is not in the list, else 0; 0 for other courses and for sessions with no `courseId` |
| `spaceOutSameDaySessions(weight = 1, minGapMinutes = 30)` | for each already-placed session of the **same group** on a shared day, the shortfall in minutes below `minGapMinutes` between the two; an actual overlap is a hard conflict and is not penalized here |

`spaceOutSameDaySessions` can only choose a *start time*. A session's days are fixed by its
own rule, so it cannot move a class to another day.

```ts
const { result } = await service.planAutoSchedule(templateIds, grid, undefined, {
  softConstraints: [
    teacherTimePreference('t1', '10:00', '15:00', 2),
    preferredRoomForCourse('physics', ['lab-a', 'lab-b']),
    spaceOutSameDaySessions(),
  ],
});
result.totalPenalty;   // how well the schedule it found satisfied them
```

**What this does and does not guarantee.** The solver commits to the *first* feasible
assignment it finds; it does not compare complete schedules. Soft constraints work by
**ordering**: each session's candidates are scored and sorted so the search *tries
lower-penalty candidates first*, which tends to land on a good schedule but is a greedy
heuristic, not an optimum. `totalPenalty` reports the score of the one schedule found, so you
can see how it turned out or compare runs with different constraint sets. With no soft
constraints supplied, behaviour is exactly the earlier first-feasible search and
`totalPenalty` is `0`.

### `solver-adapter.ts` — bridging repository data and the solver

```ts
function flattenAvailabilityForSolver(
  rules: AvailabilityRule[],
  resourceType: "teacher" | "room" | "group",
  resourceId: Id,
): { windows: ResourceAvailabilityWindow[]; skipped: AvailabilityRule[] };

function roomToSolverRoom(room: Room): SolverRoom;

const ALL_WEEKDAYS: Weekday[];   // ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

interface SolvedTemplatePatch {
  templateId: Id;
  roomId: Id;
  startTime: string;
  endTime: string;
  days: Weekday[];
}
function placementsToTemplatePatches(
  placements: PlacedSession[],
): SolvedTemplatePatch[];
```

**Known, documented limitation:** `flattenAvailabilityForSolver` only
translates `AvailabilityRule`s with `interval === 1` (fires every week)
faithfully into the solver's single-representative-week model. A
fortnightly-or-sparser rule (`interval > 1`) has no single representative
week that correctly represents it — treating it as "always available on its
by-days" would under-constrain the solve, and treating it as "never
available" would over-constrain it, so **neither is picked silently: such
rules are skipped**, and the skipped resource is reported back via the
`skipped` array (surfaced as `skippedAvailability` in
`SchedulingService.planAutoSchedule`'s return value) so the caller can
decide — e.g. warn the user, or fall back to manual placement for that
specific resource.

`SolvedTemplatePatch` maps directly onto `ClassSessionTemplate`'s existing
`roomId`/`startTime`/`endTime` fields and `rule.byDay`, with no per-day
splitting needed — a direct consequence of the multi-day-atomic solver
design above.

---


## Tests

| File | Covers |
| --- | --- |
| `scheduling-solver.test.ts` | `solveSchedule`: basic placement, infeasible by capacity or feature, the multi-day-atomic regression, teacher contention, room double-booking avoidance, most-constrained-first ordering, `PARTIAL` results |
| `scheduling-solver-qualifications.test.ts` | the solver with qualifications: unqualified sessions unplaced with a reason and never blocking others, all co-teachers required |
| `scheduling-soft-constraints.test.ts` | the three constraint builders and `scoreCandidate`, each in isolation |
| `scheduling-solver-soft-constraints.test.ts` | the solver with preferences: `totalPenalty`, preferred slots and rooms chosen, spacing, still feasible when preferences cannot all be met, hard constraints never overridden |

## Known limitations

- **Soft constraints are a heuristic, not an optimizer.** The solver orders
  candidates by penalty and commits to the first feasible assignment; it never
  compares complete schedules, so the result is a *good* schedule, not the best
  one. Only three constraint kinds exist (teacher time window, preferred room,
  spacing), and "spread a course's sessions across the week" is not one of
  them, because a session's days are fixed by its own rule.
- **No CP-SAT / external solver adapter.** By design (matches the project's
  zero-runtime-dependency stance), but noted as a natural extension point
  for institutions large enough to need a stronger solver than backtracking
  provides.
- **`AvailabilityRule.interval > 1` is not usable by the solver.** See
  `solver-adapter.ts` above — such rules are skipped and reported, not
  silently mishandled, but they are also not enforced during auto-scheduling.
- **The solver assumes one room/time for a template's entire week.** A
  template that genuinely needs a different room on different days (e.g.
  lab on Monday, lecture hall on Wednesday) isn't representable as a single
  `UnscheduledSession` — it would need to be split into separate
  `UnscheduledSession`s with different `id`s upstream, which nothing
  currently automates.
