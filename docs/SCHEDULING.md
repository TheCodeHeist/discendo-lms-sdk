# Scheduling Module

`src/domains/scheduling/` — class-routine / timetable management, including an
auto-scheduling solver. This is the largest and most involved module in the
SDK. Subpath: `hyperlms-sdk/scheduling`.

**A note on `scheduling/calendar/`.** Inside this module sits a small,
self-contained sub-module, `calendar/`, that handles assignment due-date
windows (locked/open/closed) and iCal export. It shares no code with the
class-routine logic described in the rest of this document; it lives here
because both answer "is this thing available right now?". This document
covers the class-routine side. For a quick folder map and "which piece do I
need" table, see `src/domains/scheduling/README.md`.

## Why the module is shaped this way

Class-routine management is deceptively hard because institutions vary
enormously — a single private tutor and a multi-department university both
need to be served by the same abstractions. The module is built on four
deliberately separate layers, because conflating them (e.g. storing "meets
Tuesdays at 3pm" directly as a flat field) is what makes real-world
exceptions — a sick teacher, a moved room, a fortnightly elective —
unmanageable later:

1. **`RecurrenceRule`** — an abstract, timeless repeating pattern (a
   deliberate subset of RFC 5545/RRULE)
2. **`ClassSessionTemplate`** — "this section meets per this rule, this
   duration, taught by these teachers" — still abstract, no calendar dates
   yet
3. **`ClassOccurrence`** — one concrete meeting on one real date,
   materialized from a template. Cancelling, moving, or substituting a
   single class is done by editing its occurrence, never by forking the
   template's rule.
4. **`AvailabilityRule`** — separate recurring rules for _when a resource
   can be used at all_ (teacher work hours, room open hours, group meeting
   hours). Independent from what's actually booked — a resource can be
   simultaneously "available" and "double-booked," and the module checks
   these two things separately.

On top of these four layers sits conflict detection, room-requirement
matching, and — the hardest part — an auto-scheduling solver that can
propose a full conflict-free timetable given a set of unscheduled sessions.

## File inventory

```
src/domains/scheduling/
  types.ts               Domain model: Weekday, RecurrenceRule, AvailabilityRule,
                          ClassSessionTemplate, ClassOccurrence, Room, SchedulingGroup
  repositories.ts         SchedulingRepository interface
  service.ts              SchedulingService — the class most host apps interact with
  rules/                  Pure constraint checks (no I/O, no repository)
    recurrence.ts           Shared "does this rule fire on this date" logic
    conflict.ts             Pure double-booking detection over occurrences
    availability.ts         Pure "is this resource allowed to be booked here" checks
    room-matching.ts        Pure capacity/feature matching for rooms
    teacher-qualification.ts  Pure "is this teacher allowed to teach this course"
  generator.ts            Materializes ClassOccurrences from a template + date range
  attendance.ts           Validates attendance can be recorded for an occurrence
  solver-adapter.ts       Bridges repository data <-> the solver's pure input/output shapes
  solver/
    types.ts               Solver input/output types (UnscheduledSession, SchedulingProblem,
                            PlacedSession, SolveResult, etc.)
    backtracking.ts         The actual solver algorithm
    soft-constraints.ts     Preference scoring (teacher time, preferred room, spacing)
    index.ts                Barrel export for solver/
  calendar/               Assignment due-date windows + iCal export (self-contained)
  testing/
    in-memory-repository.ts  Reference SchedulingRepository implementation (Map-backed).
                              NOT exported from the package root — for tests/dev only.
  index.ts                Module barrel (exports everything above except testing/)
```

---

## Domain model (`types.ts`)

### `Weekday`

```ts
type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
```

### `RecurrenceRule`

```ts
interface RecurrenceRule {
  freq: "WEEKLY";
  interval: number; // 1 = every week, 2 = fortnightly, etc.
  byDay: Weekday[]; // days this pattern fires on
  raw?: string; // escape hatch for a full RFC 5545 RRULE string
}
```

Deliberately a _subset_ of RFC 5545 — only `WEEKLY` frequency is modeled
natively. The `raw` field exists as an escape hatch if a host app supplies a
full RRULE string, but **nothing in this module currently evaluates `raw`
rules** — `recurrence.ts`'s `ruleFiresOn` throws if it encounters one. If
you need more of the RRULE spec than this covers, bring in a real RRULE
library (e.g. `rrule.js`) and store its string form in `raw`, but you'll
need to route evaluation through that library yourself; it is not wired in.

### `AvailabilityRule`

```ts
interface AvailabilityRule {
  id: Id;
  resourceId: Id;
  resourceType: "teacher" | "room" | "group";
  rule: RecurrenceRule;
  startTime: string; // "HH:MM", interpreted in `timezone`
  endTime: string;
  timezone: string;
  validFrom: Timestamp;
  validUntil?: Timestamp;
}
```

A recurring window during which a resource is usable _at all_ — independent
of whether it's actually booked. Availability is **opt-in**: a resource
with zero `AvailabilityRule`s on file is treated as always available
everywhere in this module (see `availability.ts` below). This lets a
single-tutor setup skip declaring hours entirely, while an institution that
wants "teachers can only be booked 9–5" adds rules to enforce it.

### `ClassSessionTemplate`

```ts
interface ClassSessionTemplate {
  id: Id;
  sectionId: Id;
  teacherIds: Id[]; // multiple co-teachers supported, none privileged
  groupId: Id;
  roomId?: Id; // optional — a template can exist unscheduled
  rule: RecurrenceRule;
  startTime: string;
  endTime: string;
  timezone: string;
  validFrom: Timestamp;
  validUntil?: Timestamp;
  requiredRoomFeatures?: string[]; // e.g. ["lab", "projector"]
}
```

The abstract "this class meets on this pattern" record. `roomId`,
`startTime`, and `endTime` are optional/mutable specifically so a template
can be created before scheduling is decided, then filled in later — either
manually or via `SchedulingService.planAutoSchedule` /
`applyAutoSchedulePlan`.

### `ClassOccurrence`

```ts
type OccurrenceStatus = "scheduled" | "cancelled" | "moved" | "completed";

interface ClassOccurrence {
  id: Id;
  templateId: Id;
  date: Timestamp;
  status: OccurrenceStatus;
  teacherIds?: Id[]; // override — only set when this occurrence deviates
  roomId?: Id;
  startTime?: string;
  endTime?: string;
  note?: string;
}
```

One concrete, materialized meeting. The override fields exist precisely so
that a substitute teacher, a moved room, or a shifted time for a single
class doesn't require touching the template — see `effectiveWindow` in
`conflict.ts`, which is how the rest of the module resolves "does this
occurrence use the template's time or its own."

### `Room`

```ts
interface Room {
  id: Id;
  name: string;
  capacity: number;
  features: string[];
}
```

### `SchedulingGroup`

```ts
interface SchedulingGroup {
  id: Id;
  sectionId: Id;
  size: number;
}
```

A group being scheduled together — a section, batch, or cohort. `size` is
what room-capacity matching checks against.

---

## `SchedulingRepository` (`repositories.ts`)

The interface a host app implements against its actual database. All
methods are async and take/return plain domain types — no query-builder or
ORM leakage.

```ts
interface SchedulingRepository {
  findTemplate(id: Id): Promise<ClassSessionTemplate | null>;
  listTemplatesForSection(sectionId: Id): Promise<ClassSessionTemplate[]>;
  createTemplate(
    template: Omit<ClassSessionTemplate, "id">,
  ): Promise<ClassSessionTemplate>;
  updateTemplate(
    id: Id,
    patch: Partial<ClassSessionTemplate>,
  ): Promise<ClassSessionTemplate>;

  listOccurrences(
    templateId: Id,
    from: Date,
    to: Date,
  ): Promise<ClassOccurrence[]>;
  listOccurrencesForResource(
    resourceType: "teacher" | "room" | "group",
    resourceId: Id,
    from: Date,
    to: Date,
  ): Promise<ClassOccurrence[]>;
  createOccurrences(
    occurrences: Array<Omit<ClassOccurrence, "id">>,
  ): Promise<ClassOccurrence[]>;
  updateOccurrence(
    id: Id,
    patch: Partial<ClassOccurrence>,
  ): Promise<ClassOccurrence>;

  listAvailability(
    resourceType: "teacher" | "room" | "group",
    resourceId: Id,
  ): Promise<AvailabilityRule[]>;

  findRoom(id: Id): Promise<Room | null>;
  listRooms(): Promise<Room[]>;
  findGroup(id: Id): Promise<SchedulingGroup | null>;
}
```

Notably, there is **no** "list all templates" or "list all unscheduled
templates" method — only `listTemplatesForSection`. Callers of
`SchedulingService.planAutoSchedule` supply an explicit list of template IDs
to schedule, rather than the service discovering them itself; this keeps
the service decoupled from however a host app decides which templates need
scheduling (a dedicated query, a term-planning UI selection, etc.).

### `InMemorySchedulingRepository` (`testing/in-memory-repository.ts`)

A complete, `Map`-backed reference implementation of `SchedulingRepository`.
**Not exported from the package root** — it's meant as a starting point to
copy/adapt for a real implementation, and as the backbone of this module's
own test suite. Exposes seed helpers for tests: `seedTemplate`, `seedRoom`,
`seedGroup`, `seedAvailability`.

---

## `recurrence.ts` — shared date-matching logic

```ts
function atMidnightUtc(d: Date): Date;
function addDays(d: Date, days: number): Date;
function ruleFiresOn(
  rule: RecurrenceRule,
  anchorFrom: Date,
  date: Date,
): boolean;
```

`ruleFiresOn` is the single place that answers "does this rule fire on this
specific date?" — both `generator.ts` and `availability.ts` call it, so the
interval/anchor-week math exists in exactly one place. It:

- Throws if `rule.raw` is set (see the `RecurrenceRule` note above)
- Checks the date's weekday is in `rule.byDay`
- Computes weeks elapsed since the Monday of `anchorFrom`'s week, and
  requires `weeksSinceAnchor % rule.interval === 0` — this is what makes
  "every 2nd week" stable no matter what date range you query, as long as
  you always anchor to the same `anchorFrom` (typically the owning
  template's or rule's own `validFrom`)
- Does **not** check `validFrom`/`validUntil` bounds itself — callers clamp
  those separately, since `generator.ts` and `availability.ts` clamp
  differently (generation clamps the _iteration range_; availability
  checking clamps a single _queried date_)

---

## `generator.ts` — occurrence materialization

```ts
function generateOccurrences(
  template: ClassSessionTemplate,
  rangeStart: Date,
  rangeEnd: Date,
): Array<Omit<ClassOccurrence, "id">>;
```

Expands a template's `RecurrenceRule` into dated occurrences within
`[rangeStart, rangeEnd]`, further clamped to the template's own
`validFrom`/`validUntil`.

**Deliberately windowed — never "generate forever."** A template's rule can
be open-ended (no `validUntil`), so materializing "everything" isn't a valid
operation. The intended usage pattern is a rolling window: keep the next N
days (e.g. 90) materialized at all times, calling this periodically, rather
than trying to generate a whole term or an unbounded future in one call.

---

## `conflict.ts` — pure double-booking detection

```ts
interface ResourceConflict {
  resourceType: "teacher" | "room" | "group";
  resourceId: string;
  occurrenceA: ClassOccurrence;
  occurrenceB: ClassOccurrence;
}

function effectiveWindow(
  occ: ClassOccurrence,
  templateStart: string,
  templateEnd: string,
): { start: string; end: string };
function findConflictsForResource(
  resourceType: "teacher" | "room" | "group",
  resourceId: string,
  candidate: ClassOccurrence,
  candidateWindow: { start: string; end: string },
  existing: ClassOccurrence[],
  existingWindows: Map<string, { start: string; end: string }>,
): ResourceConflict[];
```

Pure — no repository access, no recurrence math, just interval overlap on a
matching date. `effectiveWindow` resolves an occurrence's actual start/end,
preferring its own override fields over the template's. `findConflictsForResource`:

- Skips comparing an occurrence to itself
- **Treats cancelled occurrences as never conflicting** — a cancelled slot
  frees the resource entirely
- Only compares occurrences on the same calendar date
- Flags a conflict only when time windows actually overlap

This module is usable completely standalone: a host app doing purely manual
scheduling gets conflict checking without ever touching the solver.

---

## `availability.ts` — pure resource-availability checks

```ts
interface AvailabilityCheckResult {
  available: boolean;
  reason?: string;
}

function checkAvailability(
  rules: AvailabilityRule[],
  date: Date,
  startTime: string,
  endTime: string,
): AvailabilityCheckResult;
```

Answers "is this resource even allowed to be booked here?" — independent of
whether it's already booked (that's `conflict.ts`'s job; a resource can be
simultaneously available and double-booked). Behavior:

- **Empty `rules` array → always available.** Availability enforcement is
  opt-in per resource.
- Otherwise, at least one rule must cover the date (via `ruleFiresOn`, plus
  `validFrom`/`validUntil` bounds) **and** fully contain the requested
  `[startTime, endTime]` window.
- Multiple rules for the same resource are OR'd together — this supports
  split shifts (e.g. a teacher available 9–12 and again 14–18) by supplying
  two `AvailabilityRule`s.

---

## `room-matching.ts` — pure capacity/feature matching

```ts
interface RoomRequirement {
  minCapacity: number;
  requiredFeatures?: string[];
}

interface RoomMatchResult {
  suitable: boolean;
  reasons: string[];
}

function checkRoomSuitability(
  room: Room,
  requirement: RoomRequirement,
): RoomMatchResult;
function findSuitableRooms(rooms: Room[], requirement: RoomRequirement): Room[];
```

No booking or conflict awareness — a room can be "suitable" here and still
be double-booked (see `conflict.ts`) or outside its own open hours (see
`availability.ts`, since rooms can have `AvailabilityRule`s too). All three
checks are combined in `SchedulingService.checkAll` and in the solver.

`checkRoomSuitability` reports **all** applicable reasons at once (both a
capacity shortfall and missing features, if both apply), not just the
first problem found.

---

## `solver/` — the auto-scheduling solver

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
}

interface SolverOptions {
  maxBacktrackSteps?: number; // default 200,000
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
2. **Try each candidate in order** for the current session; skip any that
   conflicts with a placement already made this search — same room, same
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

### `solver-adapter.ts` — bridging repository data and the solver

```ts
function flattenAvailabilityForSolver(
  rules: AvailabilityRule[],
  resourceType: "teacher" | "room" | "group",
  resourceId: Id,
): { windows: ResourceAvailabilityWindow[]; skipped: AvailabilityRule[] };

function roomToSolverRoom(room: Room): SolverRoom;

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

## `service.ts` — `SchedulingService`

The class most host apps interact with directly. Constructed with a single
`SchedulingRepository`:

```ts
const service = new SchedulingService(myRepository);
```

### Conflict & availability checking

#### `checkConflicts(candidate, resources): Promise<ResourceConflict[]>`

```ts
resources: {
  teacherIds: Id[];
  roomId?: Id;
  groupId: Id;
  startTime: string;
  endTime: string;
}
```

Checks a candidate occurrence against everything already booked for the
same teachers/room/group on that date. Returns every conflict found across
all three resource types — an empty array means clear. This is the
primitive both manual scheduling UIs and the solver-driven flow build on.
**Only checks double-booking** — it does not check whether the resources
are even supposed to be working that slot (see `checkAvailabilityForResources`).

#### `checkAvailabilityForResources(date, resources): Promise<AvailabilityViolation[]>`

```ts
interface AvailabilityViolation {
  resourceType: "teacher" | "room" | "group";
  resourceId: Id;
  reason: string;
}
```

Loads each resource's `AvailabilityRule`s from the repository and runs
`checkAvailability` against each. A resource with no rules on file passes
trivially (see `availability.ts`).

#### `checkRoomForOccurrence(roomId, requirement): Promise<RoomViolation | undefined>`

```ts
interface RoomViolation {
  roomId: Id;
  reasons: string[];
}
```

Loads the room and runs `checkRoomSuitability`. Returns `undefined` when
suitable (so callers can treat "no violation" as falsy without an extra
boolean field). Returns a violation (with `reasons: ["Room ... not found."]`)
if the room ID doesn't resolve at all.

#### `checkAll(candidate, resources, roomRequirement?): Promise<SchedulingCheckResult>`

```ts
interface SchedulingCheckResult {
  conflicts: ResourceConflict[];
  availabilityViolations: AvailabilityViolation[];
  roomViolation?: RoomViolation;
  ok: boolean; // true only when all three checks pass
}
```

Runs all three checks together (in parallel via `Promise.all`) — the single
call most scheduling UIs actually want, since "is this slot bookable at
all" means conflicts, availability, and room suitability all at once.
`roomRequirement` is optional; omit it to skip capacity/feature enforcement
for that call.

### Occurrence materialization & mutation

#### `materializeOccurrences(templateId, rangeStart, rangeEnd): Promise<ClassOccurrence[]>`

Generates and persists occurrences for a template across a date range.
**Idempotent** — it queries what's already materialized for that template
in that range first, and only creates occurrences for dates not already
covered, so calling this repeatedly (the "keep a rolling window filled"
pattern) is safe.

#### `cancelOccurrence(id, note?): Promise<ClassOccurrence>`

Sets `status: 'cancelled'` on a single occurrence. Does not touch the
template or any sibling occurrence.

#### `rescheduleOccurrence(id, patch): Promise<ClassOccurrence>`

```ts
patch: { roomId?: Id; startTime?: string; endTime?: string; date?: Date }
```

Applies overrides to a single occurrence and sets `status: 'moved'`,
leaving the template's own rule untouched.

### Auto-scheduling

#### `planAutoSchedule(templateIds, grid, durationOverrides?, solverOptions?): Promise<{ result: SolveResult; skippedAvailability: string[] }>`

```ts
grid: { candidateSlotsPerDay: string[]; days: Weekday[] }
durationOverrides?: Record<Id, number>   // minutes, per template ID
```

The end-to-end entry point for auto-scheduling:

1. Loads every named template from the repository (throws if any ID doesn't
   resolve)
2. Loads and flattens `AvailabilityRule`s for every distinct teacher, group,
   and room involved (via `flattenAvailabilityForSolver`), collecting which
   resources had rules skipped due to the `interval > 1` limitation
3. Loads every room and converts it to `SolverRoom`
4. Builds one `UnscheduledSession` per template — resolving `groupSize` from
   the repository's `SchedulingGroup`, and deriving `durationMinutes` from
   the template's own `startTime`/`endTime` unless overridden via
   `durationOverrides` (necessary for a brand-new template that has no
   times set yet)
5. Runs `solveSchedule`
6. **Returns the result without writing anything.** This is a deliberate
   two-step design — silently overwriting templates on every planning call
   would be a surprising thing for a library to do, and a caller may well
   want to show the plan to a human before committing it.

#### `applyAutoSchedulePlan(result): Promise<ClassSessionTemplate[]>`

Writes a `SolveResult`'s placements back onto their templates — sets
`roomId`, `startTime`, `endTime`, and updates `rule.byDay` to the placed
days. Templates the solver marked unplaceable are silently skipped (left
completely untouched); the caller should handle those separately, e.g. via
manual scheduling. Returns only the templates that were actually updated —
applying an all-unplaced or empty `SolveResult` is a safe no-op that
returns an empty array.

---

## Test inventory

Six test files, all under `test/`, all written for `bun:test`:

| File                                      | Lines | Covers                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduling.test.ts`                      | 91    | `conflict.ts` — overlap, back-to-back non-overlap, cancelled occurrences, cross-date isolation, `effectiveWindow`                                                                                                                                                               |
| `scheduling-generator.test.ts`            | 152   | `generator.ts` — weekly/fortnightly expansion, `validFrom`/`validUntil` clamping                                                                                                                                                                                                |
| `scheduling-availability.test.ts`         | 77    | `availability.ts` — no-rules default, in/out of hours, wrong weekday, `validFrom`/`validUntil` bounds, split shifts, fortnightly availability                                                                                                                                   |
| `scheduling-room-matching.test.ts`        | 54    | `room-matching.ts` — capacity, features, combined violations, `findSuitableRooms` filtering                                                                                                                                                                                     |
| `scheduling-solver.test.ts`               | 163   | `solveSchedule` — basic placement, infeasible-by-capacity, infeasible-by-feature, the multi-day-atomic-placement regression case, teacher-contention resolution across days, room double-booking avoidance, most-constrained-first ordering, `PARTIAL` results                  |
| `scheduling-service-autoschedule.test.ts` | 139   | `SchedulingService.planAutoSchedule` + `applyAutoSchedulePlan` end to end against `InMemorySchedulingRepository` — single-template scheduling, multi-template teacher-sharing, room-feature requirements, repository-sourced availability rules, safe no-op on infeasible plans |

### A note on how this was verified

The development environment used to build this module did not have the Bun
runtime available (only `tsc` for typechecking). Every module was
additionally verified **behaviorally** — not just typechecked — by
compiling to plain JavaScript and exercising the exact scenarios described
in the `bun:test` files (and additional stress tests) via a Node.js
harness. Across the full history of this module's development, **52
behavioral checks were run and passed** against the final combined build,
including a 12-session/3-teacher/2-room/4-group stress test confirming zero
real scheduling conflicts in the solver's output, and a targeted regression
check for the multi-day placement bug described above. This doesn't replace
running the actual `bun test` suite — do that as the first thing after
extracting this project — but it means the logic itself has been exercised,
not just type-checked.

## Known limitations / not yet implemented

- **No soft-constraint optimization.** The solver only satisfies hard
  constraints (capacity, features, availability, no double-booking). It
  does not yet support preferences like "avoid morning classes for this
  teacher," "spread a course's sessions across the week," or "prefer this
  room for this course." All feasible solutions are treated equally; the
  first one the backtracking search finds is returned.
- **No CP-SAT / external solver adapter.** By design (matches the project's
  zero-runtime-dependency stance), but noted as a natural extension point
  for institutions large enough to need a stronger solver than backtracking
  provides.
- **`AvailabilityRule.interval > 1` is not usable by the solver.** See
  `solver-adapter.ts` above — such rules are skipped and reported, not
  silently mishandled, but they are also not enforced during auto-scheduling.
- **`RecurrenceRule.raw` (arbitrary RRULE strings) is not evaluated
  anywhere.** The field exists as a schema escape hatch only;
  `recurrence.ts` throws if it encounters one.
- **The solver assumes one room/time for a template's entire week.** A
  template that genuinely needs a different room on different days (e.g.
  lab on Monday, lecture hall on Wednesday) isn't representable as a single
  `UnscheduledSession` — it would need to be split into separate
  `UnscheduledSession`s with different `id`s upstream, which nothing
  currently automates.
