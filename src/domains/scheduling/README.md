# `domains/scheduling/`

Everything about **when things happen**: recurring class routines, the
concrete calendar those routines produce, the rules that stop two things
from occupying the same slot, and an auto-scheduler that fills in rooms and
times for you. This is the largest module in the SDK, so start here to find
your way around.

## Which piece do I need?

| I want to...                                            | Look at                                      |
| ------------------------------------------------------- | -------------------------------------------- |
| Define a recurring class ("Physics, Mon/Wed/Fri 10am")  | `ClassSessionTemplate` in `types.ts`         |
| Turn that pattern into dated meetings                   | `SchedulingService.materializeOccurrences`   |
| Cancel or move ONE meeting without touching the pattern | `cancelOccurrence` / `rescheduleOccurrence`  |
| Check if a slot is bookable (manual scheduling UI)      | `SchedulingService.checkAll`                 |
| Take attendance for a specific meeting                  | `recordAttendanceForOccurrence`              |
| Have the SDK propose rooms and times                    | `planAutoSchedule` then `applyAutoSchedulePlan` |
| Express preferences ("no early mornings for Ms. Rahman")| `solver/soft-constraints.ts`                 |
| Open/lock/close assignment due dates, export iCal       | `calendar/` (see below)                      |

## Folder map

```
scheduling/
  types.ts              Domain model: templates, occurrences, rooms, availability
  repositories.ts       SchedulingRepository: the interface YOUR database implements
  service.ts            SchedulingService: the class most host apps call

  rules/                Pure constraint checks (no I/O, no repository)
    recurrence.ts         "does this weekly rule fire on this date?"
    conflict.ts           double-booking detection
    availability.ts       is a teacher/room/group allowed to be used at this time?
    room-matching.ts      capacity and feature checks
    teacher-qualification.ts   is this teacher allowed to teach this course?

  generator.ts          Expands a template's recurrence into dated occurrences
  attendance.ts         Validates that attendance can be taken for an occurrence

  solver/               The auto-scheduler
    backtracking.ts       search algorithm
    soft-constraints.ts   preference scoring
    types.ts              solver input/output shapes
  solver-adapter.ts     Converts repository data to and from solver shapes

  calendar/             Assignment due-date windows + iCal export
  testing/              InMemorySchedulingRepository (for tests; not exported)
```

## How the layers fit together

Data flows one way through three layers, and knowing which layer you are in
tells you what you may depend on:

1. **`rules/`** are plain functions over plain data. They never touch a
   repository, so they are trivially testable and reusable. Call them
   directly if you only need a yes/no answer.
2. **`solver/`** composes the rules into a search. It is also a pure
   function (`solveSchedule(problem)`) with no repository access, so it can
   be swapped for a different solver later without touching anything else.
3. **`service.ts`** is the only place that talks to a repository. It loads
   data, calls the rules and solver, and writes results back.

If you are adding a new constraint (say, "a teacher may teach at most 5
hours a day"), it is a new file in `rules/`, plus a call site in either
`service.ts` (as a check) or `solver/` (as something the search respects).

## Why is `calendar/` inside scheduling?

`calendar/` handles assignment due-date windows (is this assignment
locked, open, or closed right now?) and iCal export. It has no dependency on
anything else in scheduling, and it shares no types with the class-routine
code. It lives here because both answer the same underlying question, "is
this thing available at this moment?", one for assignments and one for
teachers, rooms, and groups. A contributor looking for anything
time-related should only have one folder to check.

If you are building only assignment due dates and do not need class
routines, you can import `hyperlms-sdk/scheduling/calendar` directly and
skip everything else.

## Two rules of thumb

- **A template is a pattern; an occurrence is a real meeting.** Never edit
  a template to handle a one-off change (a sick teacher, a moved room).
  Edit that meeting's occurrence instead. Occurrences are cancelled, never
  deleted, so history stays intact.
- **Availability is opt-in.** A teacher, room, or group with no
  `AvailabilityRule` records is treated as always available, and a teacher
  with no `TeacherQualification` record is treated as qualified for
  everything. A single tutor never has to declare any of this, and an
  institution that wants enforcement adds the records.
