# Scheduling: Rules

The pure functions under `src/domains/scheduling/rules/`, plus `generator.ts` and `attendance.ts`.
None of them does I/O or touches a repository: they take plain data and return plain data, which is
what lets `SchedulingService` (see [SCHEDULING.md](./SCHEDULING.md)) and the solver (see
[SCHEDULING_SOLVER.md](./SCHEDULING_SOLVER.md)) share them, and what lets a host call them directly,
for example to preview a placement before saving it. All are exported from `discendo-sdk/scheduling`.

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

- Throws if `rule.raw` is set (see the `RecurrenceRule` note in [SCHEDULING.md](./SCHEDULING.md))
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

## `teacher-qualification.ts` — who may teach what

```ts
interface QualificationCheckResult {
  qualified: boolean;
  reason?: string;
}

function checkTeacherQualified(
  teacherId: Id,
  courseId: string | undefined,
  qualifications: TeacherQualification[],
): QualificationCheckResult;

function checkAllTeachersQualified(
  teacherIds: Id[],
  courseId: string | undefined,
  qualifications: TeacherQualification[],
): QualificationCheckResult[];
```

Pure and time-blind: it answers only the **staffing** question, independent of
when. A teacher can be fully qualified and still be double-booked (`conflict.ts`) or
off shift (`availability.ts`).

`checkTeacherQualified` is `{ qualified: true }` when `courseId` is `undefined`
(nothing to check against), when the teacher has no record in `qualifications`, or when
the course is in their `qualifiedCourseIds`. Otherwise it returns
`{ qualified: false, reason }` naming the teacher and the course.

`checkAllTeachersQualified` is what a **multi-teacher** session needs: **every**
co-teacher must be qualified, not just one. It returns one failure per unqualified
teacher, so an empty array means everyone is fine.

Qualification is enforced by the **solver** (an unqualified session is reported as
unplaceable with the reason) and therefore by `planAutoSchedule`. It is **not**
part of `SchedulingService.checkAll`, which covers conflicts, availability and room
suitability only.

---


## `attendance.ts` — attendance validation

```ts
type AttendanceMark = 'present' | 'absent' | 'excused' | 'late';
interface AttendanceEntry { sessionId: Id; userId: Id; status: AttendanceMark; recordedAt: Date; recordedBy?: Id }

/** What scheduling needs from an attendance store (a structural subset of reporting's). */
interface AttendanceRecorder {
  record(entry: AttendanceEntry): Promise<void>;
  listForSession(sessionId: Id): Promise<AttendanceEntry[]>;
}

interface AttendanceValidationError {
  reason: 'occurrence-not-found' | 'occurrence-cancelled';
  message: string;
}

function validateAttendanceTarget(occurrence: ClassOccurrence | null): AttendanceValidationError | undefined;
```

`validateAttendanceTarget` is pure: it takes the occurrence rather than fetching it. It refuses a
missing occurrence and a **cancelled** one (a class that never happened must not be marked, or
reporting's "classes held" counts would be wrong). A `scheduled`, `moved` or `completed` occurrence is
valid. A host that really needs a note for a cancelled class should model it separately.

With enforcement on, `recordAttendanceForOccurrence` stamps `recordedBy` with the actor, like
`ReportingService.recordAttendance` does, so the two ways of recording attendance leave the same
audit trail. Without enforcement it is not set.

The shapes are defined here, structurally identical to the ones in the reporting module, so the
two modules need not import each other and one repository implementation can serve both (see
[REPORTING.md](./REPORTING.md)).

---


## Tests

| File | Covers |
| --- | --- |
| `scheduling.test.ts` | `conflict.ts`: overlap, back-to-back non-overlap, cancelled occurrences, cross-date isolation, `effectiveWindow` |
| `scheduling-generator.test.ts` | `generator.ts`: weekly and fortnightly expansion, `validFrom`/`validUntil` clamping |
| `scheduling-availability.test.ts` | `availability.ts`: no-rules default, in/out of hours, wrong weekday, date bounds, split shifts, fortnightly availability |
| `scheduling-room-matching.test.ts` | `room-matching.ts`: capacity, features, combined violations, `findSuitableRooms` |
| `scheduling-teacher-qualification.test.ts` | `checkTeacherQualified` and `checkAllTeachersQualified`: no `courseId`, no record on file, an empty list, multi-teacher |
| `scheduling-attendance.test.ts` | `validateAttendanceTarget` and the service's attendance methods |

## Known limitations

- **Qualification is not part of `checkAll`.** It is enforced by the solver
  (and so by `planAutoSchedule`), but a manual placement checked with
  `checkAll` is not tested for it.
- **`RecurrenceRule.raw` (arbitrary RRULE strings) is not evaluated
  anywhere.** The field exists as a schema escape hatch only;
  `recurrence.ts` throws if it encounters one.
