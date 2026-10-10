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
PRODID:-//DiscendoLMS//discendo-sdk//EN
BEGIN:VEVENT
UID:assign-1
DTSTAMP:20261004T090000Z
DTSTART:20261012T235900Z
SUMMARY:Essay\, draft one
END:VEVENT
END:VCALENDAR
```

- **Every line ends with CRLF**, the last one (`END:VCALENDAR`) included, and never a bare LF.
- **Long lines are folded** at 75 octets (RFC 5545 §3.1): the line break is CRLF followed by a
  single space, and the space counts toward the next line's 75. The limit is in **octets**, not
  characters, so a multi-byte character (an accented letter, a CJK character, an emoji) is only
  ever moved whole to the next line, never split. A reader unfolds by removing each CRLF that is
  followed by a space or tab, and gets the original line back exactly.
- `PRODID` is `-//DiscendoLMS//discendo-sdk//EN`.
- `UID` is the item's `id`, so a calendar app updates an event instead of duplicating it
  when the feed is fetched again.
- `DTSTAMP` is the time of export (not the due date). `DTSTART` is the due date in UTC,
  with seconds and no milliseconds, zero-padded.
- Events keep the order you pass; an empty list gives just the calendar shell.
- An invalid `dueAt` **throws** (a `RangeError`) instead of writing a garbage date.
- There is no `DTEND`, `DESCRIPTION` or time-zone block: each due date is a single
  instant.

### Output changed from earlier versions

Earlier versions did not fold, did not end with a final CRLF, and had `PRODID:-//lms-sdk//EN`.
Calendar apps treat `PRODID` as informational and read folded lines and the final CRLF as the
standard says, so this should be invisible to subscribers. A host that **compares exported text**
(a snapshot test, a cache key, an ETag over the body) will see the difference.

### Text escaping and injection

Titles and ids are escaped as RFC 5545 §3.3.11 requires: `\` becomes `\\`, `;` becomes
`\;`, `,` becomes `\,`, and a line break becomes a literal `\n`. The backslash is
handled first so the backslashes added by the other rules are not doubled.

This is a **security** measure, not tidiness. Calendar feeds are subscribed to by other
people. A title containing a line break could otherwise start a new content line and
inject properties or whole events into everyone's calendar. Neither the title nor the id
can do that; tests show it. Ordinary text, including Unicode, passes through untouched.

## Known limitations

- **Due dates only.** There is no recurring-event export; the timetables from
  [SCHEDULING.md](./SCHEDULING.md) are not exported by this method.
- **No `VTIMEZONE`**, because everything is UTC.
- **`UID` is just the item's id**, with no domain part, so two systems that both export an id
  `1` would collide in one subscriber's calendar. Use ids that are unique across your system.
- **A very long line becomes many lines.** Folding is correct, but a feed with thousands of
  characters in a title is still a heavy feed.

## Tests

`test/scheduling-calendar.test.ts` — availability (inclusive bounds, one-sided windows,
offsets, the default `now`), the iCal shell, line separators, date formatting and UTC,
`DTSTAMP`, invalid dates, the escaping and injection cases, and the folding and termination
cases (the 75-octet boundary, multi-byte and four-byte text wherever the fold falls, unfolding
back to the original line, folding of long ids, and that folding cannot be used to inject lines).
