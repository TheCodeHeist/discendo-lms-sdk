# Calendar

`src/domains/scheduling/calendar/` — two small, pure helpers for dates: is
something open, locked or closed *right now*, and an iCalendar (`.ics`) export of
due dates. Subpath: `discendo-sdk/scheduling/calendar` (also re-exported from
`discendo-sdk/scheduling`).

It sits next to the [scheduling](./SCHEDULING.md) module (timetables, rooms and the
solver) but does not depend on it: this is about the *availability windows* and
*due dates* of individual items, not recurring classes. `CalendarService` has no
constructor arguments, no repository and no side effects.

## At a glance

| | |
| --- | --- |
| **You import** | `CalendarService`, `AvailabilityWindow`, `AvailabilityState` |
| **You implement** | nothing |
| **Emits events** | none |
| **Permission actions** | none (it reads nothing and stores nothing) |

## All times are UTC

Every `Date` into and out of this module is an instant, and the iCal output is
written in UTC. Converting to a viewer's local time zone is a presentation concern:
do it at the edge in your application. Doing it inside SDK logic is how you get
off-by-one-day bugs.

## `getAvailability(window, now?)`

```ts
type AvailabilityState = 'locked' | 'open' | 'closed';

interface AvailabilityWindow {
  opensAt?: Date;     // unset = no lower bound
  closesAt?: Date;    // unset = never closes
}

new CalendarService().getAvailability(window, now = new Date()): AvailabilityState
```

| `now` is… | State |
| --- | --- |
| before `opensAt` | `'locked'` |
| after `closesAt` | `'closed'` |
| otherwise | `'open'` |

- **Both ends are inclusive.** At exactly `opensAt` it is already `'open'`; at exactly
  `closesAt` it is still `'open'`, and one millisecond later it is `'closed'`.
- A window with no bounds is always `'open'`. With only `opensAt` it is locked until it
  opens and then open forever; with only `closesAt` it is open until it closes.
- It compares real instants, so dates built from different UTC offsets agree.
- `now` defaults to the current time. Pass it in tests, and to ask "what was the state
  at time T".

```ts
const window = { opensAt: new Date('2026-10-05T08:00:00Z'), closesAt: new Date('2026-10-12T23:59:00Z') };
calendar.getAvailability(window, new Date('2026-10-01T00:00:00Z'));   // 'locked'
calendar.getAvailability(window, new Date('2026-10-06T00:00:00Z'));   // 'open'
calendar.getAvailability(window, new Date('2026-10-13T00:00:00Z'));   // 'closed'
```

Use it with an assignment's window to decide whether the student can open it, and
combine it with `ContentService.isUnlocked` ([CONTENT.md](./CONTENT.md)) for
prerequisites. Neither is applied automatically anywhere: assessment, for example, does
not consult it.

## `toIcal(events)`

```ts
toIcal(events: Array<{ id: string; title: string; dueAt: Date }>): string
```

Produces an RFC 5545 calendar a student can subscribe to or download, with one
`VEVENT` per due date:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//lms-sdk//EN
BEGIN:VEVENT
UID:assign-1
DTSTAMP:20261004T090000Z
DTSTART:20261012T235900Z
SUMMARY:Essay\, draft one
END:VEVENT
END:VCALENDAR
```

- **Lines are separated by CRLF**, never a bare LF.
- `UID` is the item's `id`, so a calendar app updates an event instead of duplicating it
  when the feed is fetched again.
- `DTSTAMP` is the time of export (not the due date). `DTSTART` is the due date in UTC,
  with seconds and no milliseconds, zero-padded.
- Events keep the order you pass; an empty list gives just the calendar shell.
- An invalid `dueAt` **throws** (a `RangeError`) instead of writing a garbage date.
- There is no `DTEND`, `DESCRIPTION` or time-zone block: each due date is a single
  instant.

### Text escaping and injection

Titles and ids are escaped as RFC 5545 §3.3.11 requires: `\` becomes `\\`, `;` becomes
`\;`, `,` becomes `\,`, and a line break becomes a literal `\n`. The backslash is
handled first so the backslashes added by the other rules are not doubled.

This is a **security** measure, not tidiness. Calendar feeds are subscribed to by other
people. A title containing a line break could otherwise start a new content line and
inject properties or whole events into everyone's calendar. Neither the title nor the id
can do that; tests show it. Ordinary text, including Unicode, passes through untouched.

## Known limitations

These two are marked as pending tests (`it.todo`) in `test/scheduling-calendar.test.ts`:

- **No line folding.** RFC 5545 §3.1 says lines longer than 75 octets must be folded. A
  very long title is written on one line. Most calendar apps accept it; a strict
  parser may not.
- **No trailing CRLF.** The output ends at `END:VCALENDAR` with no final line break,
  where the RFC expects every line, the last included, to end in CRLF.

Also:

- **`PRODID` still reads `-//lms-sdk//EN`**, the project's earlier name.
- **Due dates only.** There is no recurring-event export; the timetables from
  [SCHEDULING.md](./SCHEDULING.md) are not exported by this method.
- **No `VTIMEZONE`**, because everything is UTC.

## Tests

`test/scheduling-calendar.test.ts` — availability (inclusive bounds, one-sided windows,
offsets, the default `now`), the iCal shell, line separators, date formatting and UTC,
`DTSTAMP`, invalid dates, and the escaping and injection cases. The two limitations above
are listed there as pending.
