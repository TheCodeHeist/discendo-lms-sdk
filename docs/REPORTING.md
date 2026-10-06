# Reporting

`src/services/reporting/` — attendance records, a completion-percentage helper, and
CSV export for anything that can be turned into flat rows. Subpath:
`discendo-sdk/reporting`.

Reporting is a *consumer* module: it holds the shapes for things that other modules
produce (an attendance mark, a gradebook row) and the plumbing to export them, and it
deliberately computes little. Progress, for example, is derived from content-completion
events, not kept as mutable state.

## At a glance

| | |
| --- | --- |
| **You import** | `ReportingService`, `toCsv`, and the types `AttendanceRecord`, `AttendanceStatus`, `AttendanceRepository`, `SessionLocator`, `ReportingServiceOptions`, `StudentAttendanceReport`, `CsvOptions`, `Exportable` |
| **You implement** | `AttendanceRepository`, `SessionLocator` (to read reports or enforce permissions), and `Exportable` for whatever you want to export |
| **Emits events** | none |
| **Permission actions** | `reporting.recordAttendance` (delegable), `reporting.view` (a guardian can hold it via the `attendance` scope) |
| **Enforcement** | opt-in: `{ enforcement: { policy, repos } }` in the second constructor argument, which also needs `sessions` |

## Attendance

```ts
type AttendanceStatus = 'present' | 'absent' | 'excused' | 'late';

interface AttendanceRecord {
  sessionId: Id;        // the class session, e.g. a scheduling occurrence id
  userId: Id;
  status: AttendanceStatus;
  recordedAt: Date;
  recordedBy?: Id;      // who recorded it; set when permissions are enforced
}

interface AttendanceRepository {
  record(entry: AttendanceRecord): Promise<void>;
  listForSession(sessionId: Id): Promise<AttendanceRecord[]>;
}

/** How reporting finds out which section a session belongs to, and which sessions a section has. */
interface SessionLocator {
  sectionOf(sessionId: Id): Promise<Id | null>;           // null: no such session
  sessionsInSection(sectionId: Id): Promise<Id[]>;
}
```

### The session locator

`sessionId` is a loose string, and reporting cannot ask the scheduling module which section it is in
(modules stay independent), so **you tell it**. This is the same pattern as grading's
`SubmissionLocator`. With scheduling, answer from your class occurrences:

```ts
const sessions: SessionLocator = {
  sectionOf: async (sessionId) => {
    const occurrence = await schedulingRepo.findOccurrence(sessionId);
    return occurrence ? (await schedulingRepo.findTemplate(occurrence.templateId))?.sectionId ?? null : null;
  },
  sessionsInSection: async (sectionId) =>
    (await schedulingService.listOccurrences(sectionId, termStart, termEnd, adminActor)).map((o) => o.id),
};
```

The section a call is about **always comes from the locator**, never from the caller, and a
session it does not know is refused like a forbidden one.

### `ReportingService`

```ts
new ReportingService(attendance: AttendanceRepository, options?: {
  sessions?: SessionLocator;
  enforcement?: { policy: PermissionPolicy; repos: AuthorizationRepos };
})
```

`enforcement` requires `sessions`, and the constructor throws if it is missing. With enforcement
every attendance method takes a trailing `actor?: { actorId }` that is **required**; without it the
actor is ignored and nothing is checked. The `repos` need `users`, `courses` and `enrollments`
(plus `guardianLinks` and `delegations` if you use them).

- **`recordAttendance(record, actor?): Promise<void>`**. Without enforcement it is a
  **pass-through**: it hands the record to the repository exactly as given. With enforcement:
  the actor needs `reporting.recordAttendance` in the session's section (admins and the section's
  instructor; a TA **only if the instructor delegated it**, see [DELEGATION.md](./DELEGATION.md)),
  and the person must be an **active student** of that section (a dropped, waitlisted or completed
  student, an instructor, or a stranger is refused like a forbidden call). The status must be one of
  the four, or it throws a plain `Error` after the permission check. The record that is stored is
  **rebuilt from the four known fields**: the time is the service's clock (so nobody can backdate a
  mark), `recordedBy` is the actor, and anything else the caller passed is dropped.
- **`listAttendanceForSession(sessionId, actor?): Promise<AttendanceRecord[]>`**: every mark of one
  session. With enforcement it is **staff only** (`reporting.view` in the session's section, and the
  actor must be staff there even if a custom policy would say otherwise). A student or guardian uses
  `attendanceForStudent`.
- **`attendanceForStudent(sectionId, userId, actor?): Promise<StudentAttendanceReport>`**: one
  student's marks across the section's sessions, **oldest first**, with a count per status:

  ```ts
  const { records, summary } = await reporting.attendanceForStudent('sec-1', child.id, { actorId: parent.id });
  // summary: { present: 12, absent: 1, excused: 0, late: 2, total: 15 }
  ```

  The owner is the student you name: a student may read their own, staff of the section anyone's,
  and a **guardian** whose verified link has the `attendance` scope their ward's, while the ward is
  an active student there. A dropped, waitlisted or **completed** student is refused: read-only
  access after completion covers grades and content only. It makes **one repository call per
  session**, once each, so a section with many sessions costs that many calls. It needs `sessions`
  even without enforcement.
- **`computeCompletionPercent(totalItems, completedItems): number`** is
  `round(completed / total * 100)`, kept **between 0 and 100**: more completed than total gives
  `100`, and a negative count, a total of zero or less, or anything that is not a finite number
  gives `0`. It is a pure helper with no permissions.

The permission check always comes first, nothing is looked up before the actor is known, and
nothing is recorded for a refused call.

### Attendance and scheduling

The [scheduling](./SCHEDULING.md) module records attendance against a *class occurrence*
(`SchedulingService.recordAttendanceForOccurrence`), refuses a cancelled one, and with enforcement
stamps `recordedBy` too. To avoid a dependency between the two modules it defines its own
structurally identical `AttendanceRecorder` shape. In practice that means **one
`AttendanceRepository` implementation can be passed to both** `ReportingService` and
`SchedulingService`, with nothing converted at the boundary.

**There are two ways in, with the same rules.** Both need an instructor or admin of the section (or
a TA appointed for it) and an active student, and both stamp who recorded the mark. They differ in
what they know: scheduling refuses a **cancelled** occurrence, while reporting knows only the section,
so use `recordAttendanceForOccurrence` for scheduled classes. The two actions are separate
(`scheduling.recordAttendance` and `reporting.recordAttendance`), so appointing a TA for one does not
appoint them for the other.

## CSV export

```ts
interface Exportable {
  toRows(): Record<string, string | number>[];
}

toCsv(exportable: Exportable): string
```

Anything that can describe itself as flat rows can be exported: a gradebook, a roster,
attendance.

```ts
const gradebook: Exportable = {
  toRows: () => students.map((s) => ({ name: s.name, final: s.finalPercent })),
};
const csv = toCsv(gradebook);
// "name,final\nAda Lovelace,92\n..."
```

How it behaves:

- The **header row is the keys of the first row.** Later rows are written under those
  headers: an extra key is dropped, and a missing one becomes an empty cell.
- No rows gives an empty string.
- A cell containing a comma, a double quote, a carriage return or a line break is wrapped in
  double quotes, with inner quotes doubled.
- Lines are separated by `\n` (not CRLF), with no trailing newline.

### Spreadsheet formula injection

A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return can be **run as a formula**
when someone opens the file in Excel or Google Sheets (a name such as `=HYPERLINK("http://evil")`).
So `toCsv` **neutralizes these by default**, by writing a leading `'` before the text:

```ts
toCsv({ toRows: () => [{ name: '=1+1', score: -5 }] });
// "name,score\n'=1+1,-5"
```

- It is done **before quoting**, so a payload that contains a comma stays one safe cell.
- **Numbers are never touched**: a number `-5` is written as `-5`. Only text is changed, so a
  text `"-5"` becomes `'-5`. Pass numbers as numbers.
- The header cells are cleaned too.
- For data you wrote yourself, `toCsv(x, { sanitizeFormulas: false })` writes the text exactly as it
  is. **Do not use it for anything a person can type.**
- This is a change from earlier versions, which wrote such cells as they were. A host that exported
  text starting with one of those characters will now see a leading `'` in it.

## Permissions

| Method | Action | Who |
| --- | --- | --- |
| `recordAttendance` | `reporting.recordAttendance` | admins, and the section's instructor; a TA only when delegated. The student must be an active student of the section |
| `listAttendanceForSession` | `reporting.view` | staff of the session's section (admins, instructors, TAs) |
| `attendanceForStudent` | `reporting.view` | the student themselves; staff of the section; a guardian with the `attendance` scope, for their ward |

**TAs get nothing by default.** A teaching assistant is optional and appointed by the instructor, so
`reporting.recordAttendance` is for admins and instructors, and a TA records attendance only when the
instructor delegates it. (TAs can still *read* attendance, as staff.) This is narrower than the earlier
default, which let TAs record, but nothing enforced it, so no running host is affected.

Taking attendance is a staff action, and viewing is personal: a student sees their own, never a
classmate's, and a guardian sees only their ward's. See [PERMISSIONS.md](./PERMISSIONS.md) and
[GUARDIANS.md](./GUARDIANS.md).

## Known limitations

- **The host implements the locator.** Reporting trusts what `SessionLocator` says about which
  section a session is in.
- **Without enforcement `recordAttendance` does no validation**, and `listAttendanceForSession` and
  `attendanceForStudent` check nothing.
- **A repeat mark** for the same person and session is the repository's call. The service does not
  prevent one, and `attendanceForStudent` would count both.
- **Reporting does not know a session was cancelled.** Only scheduling does, so use its method for
  scheduled classes.
- **`attendanceForStudent` costs one repository call per session.** A repository that can answer
  "this student's marks in these sessions" in one query is not part of the interface yet.
- **A completed student cannot read their own attendance**, and neither can their guardian.
- **Only the service is guarded.** Your own code can still use the repository directly.
- **No events** when attendance is recorded (planned for the events round).
- **No gradebook, roster or attendance exporters are provided.** The module defines the
  `Exportable` shape and the CSV writer; building the rows is your code's job.
- **`toCsv` uses `\n` line endings**, not CRLF.

## Tests

| File | Covers |
| --- | --- |
| `test/reporting.test.ts` | every attendance method with enforcement on (who may record and read, delegation, active-student targets, the locator, a rebuilt record that cannot be backdated, staff-only session lists, a student's and a guardian's report, check ordering, no lookups before the actor is known) and off, the completion percent, and `toCsv` (layout, quoting, formula injection and its opt-out) |
| `test/core-permissions.test.ts` | the two reporting rules, and that `reporting.recordAttendance` is delegable |
| `test/scheduling-permissions.test.ts` | that scheduling stamps `recordedBy` on attendance too |
| `test/scheduling-attendance.test.ts` | scheduling's attendance integration |
