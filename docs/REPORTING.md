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
| **You import** | `ReportingService`, `toCsv`, and the types `AttendanceRecord`, `AttendanceStatus`, `AttendanceRepository`, `Exportable` |
| **You implement** | `AttendanceRepository`, and `Exportable` for whatever you want to export |
| **Emits events** | none |
| **Permission actions** | `reporting.recordAttendance`, `reporting.view` (a guardian can hold it via the `attendance` scope) |
| **Enforcement** | **not yet.** The actions exist; the service does not check them |

## Attendance

```ts
type AttendanceStatus = 'present' | 'absent' | 'excused' | 'late';

interface AttendanceRecord {
  sessionId: Id;        // the class session, e.g. a scheduling occurrence id
  userId: Id;
  status: AttendanceStatus;
  recordedAt: Date;
}

interface AttendanceRepository {
  record(entry: AttendanceRecord): Promise<void>;
  listForSession(sessionId: Id): Promise<AttendanceRecord[]>;
}
```

### `ReportingService`

```ts
new ReportingService(attendance: AttendanceRepository)
```

- **`recordAttendance(record): Promise<void>`** hands the record to the repository. It is a
  pass-through: it does not check that the session exists, that the person belongs to it, or
  that a mark has not already been recorded.
- **`computeCompletionPercent(totalItems, completedItems): number`** is
  `round(completed / total * 100)`, and `0` when `totalItems` is `0`. It does not clamp:
  `computeCompletionPercent(2, 3)` is `150`.

### Attendance and scheduling

The [scheduling](./SCHEDULING.md) module records attendance against a *class occurrence*
(`SchedulingService.recordAttendanceForOccurrence`) and refuses a cancelled one. To avoid a
dependency between the two modules it defines its own structurally identical
`AttendanceRecorder` shape. In practice that means **one `AttendanceRepository`
implementation can be passed to both** `ReportingService` and `SchedulingService`, with
nothing converted at the boundary.

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
- A cell containing a comma, a double quote or a line break is wrapped in double quotes,
  with inner quotes doubled.
- Lines are separated by `\n` (not CRLF), with no trailing newline.

### Spreadsheet formula injection (read this)

`toCsv` does **not** neutralise cells that begin with `=`, `+`, `-` or `@`. A name such as
`=HYPERLINK("http://evil")` is written as is, and when a person opens the file in Excel or
Google Sheets it may be evaluated as a formula. If any exported value can come from a
user (names, comments, free text), sanitise it before it reaches `toRows`, for example by
prefixing a `'` to values that start with one of those characters.

## Permissions

| Action | Default |
| --- | --- |
| `reporting.recordAttendance` | admin, instructor, ta |
| `reporting.view` | admin, instructor, ta; a student for their **own** records; a guardian with the `attendance` scope |

`ReportingService` does not enforce them yet, so check them with the policy at your API
boundary ([PERMISSIONS.md](./PERMISSIONS.md)). Taking attendance for a class is a staff
action, and viewing is personal: a student sees their own, never a classmate's.

## Known limitations

- **No permission enforcement yet.**
- **`toCsv` is vulnerable to formula injection** (above) and uses `\n` line endings.
- **`recordAttendance` does no validation**, and the repository decides what a repeat mark
  for the same person and session does.
- **No events** when attendance is recorded (planned).
- **No gradebook, roster or attendance exporters are provided.** The module defines the
  `Exportable` shape and the CSV writer; building the rows is your code's job.
- **No tests for this module.** `toCsv` and `ReportingService` have none; the behaviour
  above was checked by running the code. Scheduling's attendance integration is tested in
  `test/scheduling-attendance.test.ts`.
