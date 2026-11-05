# Scheduling Module

`src/domains/scheduling/` — class-routine / timetable management, including an
auto-scheduling solver. This is the largest and most involved module in the
SDK. Subpath: `discendo-sdk/scheduling`.

**Scheduling is documented across three pages:**

- **This page:** the domain model, the repositories, and `SchedulingService` (the class a host calls).
- [SCHEDULING_RULES.md](./SCHEDULING_RULES.md): the pure rule functions (recurrence, occurrence
  generation, conflicts, availability, room matching, qualifications, attendance validation).
- [SCHEDULING_SOLVER.md](./SCHEDULING_SOLVER.md): the auto-scheduling solver, its soft
  constraints and the adapter between stored data and the solver.

**A note on `scheduling/calendar/`.** Inside this module sits a small,
self-contained sub-module, `calendar/`, that handles assignment due-date
windows (locked/open/closed) and iCal export. It shares no code with the
class-routine logic described in the rest of this document; it lives here
because both answer "is this thing available right now?". This document
covers the class-routine side; the calendar sub-module has its own page,
[CALENDAR.md](./CALENDAR.md). For a quick folder map and "which piece do I
need" table, see `src/domains/scheduling/README.md`.

**How scheduling fits with the rest of the SDK.**

- **Permissions.** Opt-in enforcement: pass `{ enforcement: { policy, repos } }` and every
  method needs an actor (see "Enforcement and organizations" below). Without it the service
  behaves as it always has. See [PERMISSIONS.md](./PERMISSIONS.md) and
  [GUARDIANS.md](./GUARDIANS.md).
- **Events.** It emits `scheduling.occurrenceCancelled` and
  `scheduling.occurrenceRescheduled`, and with enforcement on they say **who** did it, so admins
  can oversee instructors who cancel or move their own classes; see [EVENTS.md](./EVENTS.md).
- **Attendance.** `recordAttendanceForOccurrence` shares its record shape with
  the reporting module, so one repository can serve both; see
  [REPORTING.md](./REPORTING.md).
- **Tenancy.** With enforcement on, rooms (`Room.orgId`), teachers, groups and courses must belong
  to the actor's organization; see [TENANCY.md](./TENANCY.md).

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
                          TeacherQualification, ClassSessionTemplate, ClassOccurrence,
                          Room, SchedulingGroup
  repositories.ts         SchedulingRepository interface
  service.ts              SchedulingService — the facade most host apps interact with
  service/                Its implementation, one concern per file
    context.ts              Options, enforcement, check-result types, shared dependencies
    access.ts               Every permission and organization check, in one place
    checks.ts               checkConflicts / checkAvailabilityForResources / checkRoomForOccurrence / checkAll
    occurrences.ts          Materialize, cancel, reschedule, list, attendance
    auto-schedule.ts        planAutoSchedule / applyAutoSchedulePlan
    settings.ts             Availability, preferences, qualifications
    validation.ts           Input validation for settings and plans
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
everywhere in this module (see `availability.ts` in [SCHEDULING_RULES.md](./SCHEDULING_RULES.md)). This lets a
single-tutor setup skip declaring hours entirely, while an institution that
wants "teachers can only be booked 9–5" adds rules to enforce it.

### `ClassSessionTemplate`

```ts
interface ClassSessionTemplate {
  id: Id;
  sectionId: Id;
  courseId?: Id; // optional; only used for teacher-qualification checks
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

`courseId` is a loose reference to whatever the host calls "the course" (for
example `core.Course.id`). Scheduling never resolves it; it is consulted only by
the teacher-qualification check (see `teacher-qualification.ts` in [SCHEDULING_RULES.md](./SCHEDULING_RULES.md)), and a
template without one is never checked.

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
  orgId?: string;      // the organization it belongs to; see "Enforcement and organizations"
  name: string;
  capacity: number;
  features: string[];
}
```

A room with no `orgId` belongs to no organization, so with enforcement on only people with no
organization can see or use it. Give every room of a multi-organization deployment an `orgId`.

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

### `TeacherQualification`

```ts
interface TeacherQualification {
  teacherId: Id;
  qualifiedCourseIds: Id[];
}
```

Which courses a teacher may teach. Like `AvailabilityRule`, it is **opt-in**:
a teacher with *no record on file* is qualified for everything, so a single-tutor
setup never declares any. Once a teacher *has* a record, only the listed courses
count, and an empty `qualifiedCourseIds` means qualified for **nothing** (not
"unconstrained").

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

  findOccurrence(id: Id): Promise<ClassOccurrence | null>;
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

  /** null = no record on file, which means "qualified for everything", not an error. */
  findTeacherQualification(teacherId: Id): Promise<TeacherQualification | null>;

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

### `SchedulingSettingsRepository` (`repositories.ts`)

What the settings methods of `SchedulingService` write, kept apart from `SchedulingRepository` so a
host that only reads schedules does not have to implement it. Pass it as `options.settings`.

```ts
interface SchedulingSettingsRepository {
  replaceAvailability(resourceType, resourceId, rules): Promise<AvailabilityRule[]>; // replaces ALL
  findTeacherPreferences(teacherId: Id): Promise<TeacherSchedulingPreferences | null>;
  saveTeacherPreferences(p: TeacherSchedulingPreferences): Promise<TeacherSchedulingPreferences>;
  saveTeacherQualification(q: TeacherQualification): Promise<TeacherQualification>;
}
```

### `InMemorySchedulingRepository` (`testing/in-memory-repository.ts`)

A complete, `Map`-backed reference implementation of `SchedulingRepository`.
**Not exported from the package root** — it's meant as a starting point to
copy/adapt for a real implementation, and as the backbone of this module's
own test suite. Exposes seed helpers for tests: `seedTemplate`, `seedRoom`,
`seedGroup`, `seedAvailability`, `seedTeacherQualification`.

---


## `service.ts` — `SchedulingService`

`SchedulingService` is a facade: each group of methods below lives in its own file under
`src/domains/scheduling/service/`, and all of them share one set of permission and organization
checks (`src/domains/scheduling/service/access.ts`). Hosts only ever construct and call
`SchedulingService`; the parts are not exported.

The class most host apps interact with directly. Constructed with a
`SchedulingRepository`, and optionally an `AttendanceRecorder` and an `EventBus`:

```ts
const service = new SchedulingService(myRepository, attendanceRepo, bus);
```

Only the repository is required. Without a recorder, the attendance methods throw; without a bus,
nothing is emitted. A fourth argument, `options`, turns on enforcement and supplies the settings
repository:

```ts
new SchedulingService(repo, attendanceRepo, bus, {
  enforcement: { policy, repos },   // repos: users, courses, enrollments (+ guardianLinks, delegations)
  settings: repo,                   // a SchedulingSettingsRepository, only for the settings methods
});
```

### Enforcement and organizations

With `enforcement` set, every public method takes a trailing `actor?: { actorId }` that is
**required**, and a missing one is refused before anything is read. The section a call is about
always comes from the **stored** template (an occurrence's, a candidate's, a plan placement's),
never from what the caller says; a missing template, occurrence, section or course is refused like
a forbidden one.

| Method | Action | Who |
| --- | --- | --- |
| `cancelOccurrence`, `rescheduleOccurrence` | `scheduling.manageOccurrence` | admins, and the **instructor of that section** (their class, their call); a TA only when delegated |
| `checkConflicts`, `checkAll` | `scheduling.manageOccurrence` in the candidate's section | the same |
| `checkAvailabilityForResources`, `checkRoomForOccurrence` | `scheduling.manageOccurrence`, organization-wide (no candidate to tie to a section) | admins and instructors of the organization |
| `recordAttendanceForOccurrence`, `canRecordAttendance` | `scheduling.recordAttendance` | admins and the section's instructor; a TA when delegated. The student must be an **active student** of the section |
| `materializeOccurrences`, `planAutoSchedule`, `applyAutoSchedulePlan` | `scheduling.manage` | admins only |
| `listOccurrences` | `scheduling.view` | active members of the section, and a guardian whose link has the `schedule` scope, naming the ward |
| `setAvailability` / `getAvailability` (a **teacher**) | `scheduling.manageSettings` | that instructor, or an admin |
| `setAvailability` / `getAvailability` (a **room** or **group**) | `scheduling.manage` | admins only |
| `setTeacherPreferences`, `getTeacherPreferences`, `getTeacherQualification` | `scheduling.manageSettings` | that instructor, or an admin |
| `setTeacherQualification` | `scheduling.manageQualifications` | admins only: an instructor cannot qualify themselves |

**Organizations.** What a call touches must belong to the actor's organization, with "no
organization" matching only "no organization": rooms by `Room.orgId`, teachers by their account,
groups and courses through the section's course. A resource that does not exist and one in another
organization give the same `SchedulingTargetNotFoundError`, so nobody can use it to find out what
another organization has. The permission check always comes first. Concretely:

- `rescheduleOccurrence` refuses a `roomId` that is not the section's organization's.
- The planning checks refuse teachers, rooms and groups of another organization **before reading
  anyone's bookings**.
- `planAutoSchedule` gives the solver **only the organization's own rooms**, however big another
  organization's are, and refuses a template whose teachers or group are not the organization's.
- `applyAutoSchedulePlan` treats the plan as **untrusted input**, since it is data the caller hands
  over: every placement needs `scheduling.manage` in its template's section and a room of that
  organization, with well-formed times and days (`InvalidSchedulingPlanError`), and all of them are
  checked before the first write. A placement for a template that does not exist is refused instead
  of being skipped. Even an empty plan needs an admin.

**Oversight.** An instructor cancels or moves their own class without asking an admin, so both
events carry who did it (`actorId`, `actorRole`, `sectionId`, plus `previousStatus` or `from`).
Forward them to an audit log or tell the admins; see [EVENTS.md](./EVENTS.md). The SDK sends nothing
to anyone itself.

Without `enforcement` none of this applies: no actor, no permission checks, **no organization
checks** (the service has no way to resolve a section's organization without the core repositories),
and the events keep their old shape.

### Conflict & availability checking

#### `checkConflicts(candidate, resources, actor?): Promise<ResourceConflict[]>`

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

#### `materializeOccurrences(templateId, rangeStart, rangeEnd, actor?): Promise<ClassOccurrence[]>`

Generates and persists occurrences for a template across a date range.
**Idempotent** — it queries what's already materialized for that template
in that range first, and only creates occurrences for dates not already
covered, so calling this repeatedly (the "keep a rolling window filled"
pattern) is safe.

#### `cancelOccurrence(id, note?, actor?): Promise<ClassOccurrence>`

Sets `status: 'cancelled'` on a single occurrence and emits
`scheduling.occurrenceCancelled` (carrying `note` only when one was given). Does not
touch the template or any sibling occurrence.

#### `rescheduleOccurrence(id, patch, actor?): Promise<ClassOccurrence>`

```ts
patch: { roomId?: Id; startTime?: string; endTime?: string; date?: Date }
```

Applies overrides to a single occurrence and sets `status: 'moved'`, leaving the
template's own rule untouched, then emits `scheduling.occurrenceRescheduled` carrying the
occurrence's values **after** the move (not the patch). `materializeOccurrences` emits
nothing.

### Attendance

#### `recordAttendanceForOccurrence(occurrenceId, userId, status, actor?): Promise<void>`

Looks up the occurrence, refuses it with `validateAttendanceTarget` (throws
`recordAttendanceForOccurrence: <message>` for a missing or cancelled occurrence), and records
`{ sessionId: occurrenceId, userId, status, recordedAt: now }` through the `AttendanceRecorder`.
Throws if no recorder was given to the constructor.

#### `canRecordAttendance(occurrenceId, actor?): Promise<AttendanceValidationError | undefined>`

The same validation **without throwing**, for a UI that wants to show why a class cannot take
attendance (a cancelled one greyed out) instead of catching an exception.

### Auto-scheduling

#### `planAutoSchedule(templateIds, grid, durationOverrides?, solverOptions?, actor?): Promise<{ result: SolveResult; skippedAvailability: string[] }>`

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

Details added since the steps above: step 3 also loads each teacher's
`TeacherQualification` (when one is on file) and passes it to the solver, so an unqualified
template comes back in `unplaced` with its reason; and `solverOptions` is where you pass
`softConstraints` and `maxBacktrackSteps`. **If `options.settings` was given**, each teacher's saved
preferences (`setTeacherPreferences`) are added as `teacherTimePreference` soft constraints with
weight 1 for everyone, after yours, so no one outweighs anyone. With enforcement on, the plan stays
inside the actor's organization (see above).

#### `applyAutoSchedulePlan(result, actor?): Promise<ClassSessionTemplate[]>`

Writes a `SolveResult`'s placements back onto their templates — sets
`roomId`, `startTime`, `endTime`, and updates `rule.byDay` to the placed
days. Templates the solver marked unplaceable are silently skipped (left
completely untouched); the caller should handle those separately, e.g. via
manual scheduling. Returns only the templates that were actually updated —
applying an all-unplaced or empty `SolveResult` is a safe no-op that
returns an empty array.

### Reading the timetable

#### `listOccurrences(sectionId, from, to, actor?, { wardId? }): Promise<ClassOccurrence[]>`

A section's occurrences between two dates (inclusive), across all of its templates, oldest first,
**cancelled ones included** (students need to know a class is off). With enforcement it is
`scheduling.view` in the section: its active members, its staff, and a guardian whose link has the
`schedule` scope and who names the ward. A dropped, waitlisted or completed student, a guardian
without the scope or naming the wrong ward, and anyone from another section or organization are
refused, and the section's templates are not even read for them. Without enforcement it returns
everything.

### Settings

Settings are what the people running a timetable keep about themselves and their resources. They
need `options.settings` (a `SchedulingSettingsRepository`), or they throw. With enforcement each
checks permission first, then that the person or resource is in the actor's organization, then
validates.

| | Instructor, for themselves | Admin |
| --- | --- | --- |
| a teacher's **availability** (`setAvailability('teacher', id, rules)`) | yes | any teacher of the organization |
| a teacher's **preferences** (`setTeacherPreferences`) | yes | yes |
| reading a teacher's **qualification** | their own | any |
| a room's or group's **availability** | no | yes |
| a teacher's **qualification** (`setTeacherQualification`) | **no** | yes |

- **Availability** is replaced as a whole (an empty list clears it). Each rule needs a weekly
  recurrence with an interval of at least 1 and known days, `HH:MM` times with the end after the
  start, a timezone, and a valid `validFrom` (with `validUntil`, if any, not before it), or
  `InvalidSchedulingSettingsError` is thrown and the old rules are kept. Only those fields are
  stored.
- **Preferences** are `{ preferredStartWindow?: { earliest, latest } }` as `HH:MM` with the
  earliest no later than the latest; `{}` clears them. They are **soft**: they steer the planner,
  never make a plan fail.
- **Qualifications** are course ids; duplicates are dropped, and with enforcement every course must
  exist in the actor's organization. An **empty list means qualified for nothing**, while a teacher
  with **no record** is not restricted.

---


## Test inventory

Fifteen files under `test/` cover scheduling, all for `bun:test`. The rule and solver tests are
listed on [SCHEDULING_RULES.md](./SCHEDULING_RULES.md) and [SCHEDULING_SOLVER.md](./SCHEDULING_SOLVER.md).
These cover the service:

| File | Covers |
| --- | --- |
| `scheduling-service-autoschedule.test.ts` | `planAutoSchedule` + `applyAutoSchedulePlan` end to end against `InMemorySchedulingRepository` |
| `scheduling-service-qualifications.test.ts` | `planAutoSchedule` with qualifications on file |
| `scheduling-service-events.test.ts` | the cancel and reschedule events, no event on materializing, a throwing listener, working with no bus |
| `scheduling-permissions.test.ts` | enforcement end to end: who may cancel, move, plan, apply, record attendance, read the timetable and manage settings; the organization wall on rooms, teachers, groups and courses; a forged plan; the oversight on the events; saved preferences and qualifications reaching the planner; behaviour with enforcement off |
| `scheduling-calendar.test.ts` | the calendar sub-module; see [CALENDAR.md](./CALENDAR.md) |

### Verification

Three checks apply to this module, as to the rest of the SDK: `npx tsc --noEmit`, a strict typecheck
of the tests, and `bun test`. They are listed in "Verifying a change" in the root `README.md`.

## Known limitations

See also the limitations of the [rules](./SCHEDULING_RULES.md#known-limitations) and the
[solver](./SCHEDULING_SOLVER.md#known-limitations).

- **Organization checks need enforcement.** Without it the service cannot resolve a section's
  organization, so a plan may use any room. Turn enforcement on in a multi-organization deployment.
- **`rescheduleOccurrence` does not run the conflict, availability or room checks itself.** An
  instructor can move their class onto a time when a room is taken or they are unavailable. Call
  `checkAll` first, and use the `occurrenceRescheduled` event to see who moved what.
- **A cancelled occurrence can be moved or cancelled again.** Cancelling twice emits a second
  event, and moving a cancelled class marks it `moved`.
- **The planning checks are organization-wide for staff.** An instructor can see when any teacher,
  room or group of their organization is booked, not only their own section's, since arranging a
  class needs that.
- **Template creation stays with the host.** There is no service method to create or edit a
  template, so no permission rule covers it.
- **Only one preference kind is stored** (the teacher's preferred start window). Preferred rooms
  and spacing can still be passed as `softConstraints`, but are not persisted. Preferences are
  not part of `checkAll`.
- **Replacing availability is not atomic**, and two instructors cannot clash over it (each
  manages only their own), but an admin and an instructor editing the same teacher can.
- **`applyAutoSchedulePlan` does not check that a plan is a good one**, only that it is allowed
  and well-formed: a plan that double-books is applied if every placement is individually valid.
- **Sections are loose references without enforcement.** `sectionId` and `courseId` on a
  template are plain ids that scheduling does not resolve, so it cannot tell whether they exist.
  With enforcement a template whose section or course is missing is refused like a forbidden one.
