---
description: Learn how discendo-sdk/scheduling/calendar evaluates open/locked/closed item availability windows and exports due dates to iCal (.ics).
---

# Calendar & iCal

`discendo-sdk/scheduling/calendar` provides two pure, dependency-free utilities:

1. Evaluating whether an assignment, quiz, or content node is **locked**, **open**, or **closed** at a given instant.
2. Generating RFC 5545 standard **iCalendar (`.ics`)** feeds of course due dates for calendar apps (Google Calendar, Apple Calendar, Outlook).

::: tip Self-contained
This submodule has **no database requirements, no constructor arguments, and no side effects**.
:::

---

## At a Glance

|                  |                                                                              |
| ---------------- | ---------------------------------------------------------------------------- |
| **Import**       | `import { CalendarService, toIcal } from 'discendo-sdk/scheduling/calendar'` |
| **Repositories** | None                                                                         |
| **Events**       | None                                                                         |
| **Permissions**  | None (pure calculation functions)                                            |

---

## Evaluating Availability Windows (`getAvailability`)

```ts
type AvailabilityState = "locked" | "open" | "closed";

interface AvailabilityWindow {
  opensAt?: Date; // If omitted, open from the beginning of time
  closesAt?: Date; // If omitted, never closes
}
```

### The State Machine:

```ts
import { CalendarService } from "discendo-sdk/scheduling/calendar";

const calendar = new CalendarService();

const window = {
  opensAt: new Date("2026-10-10T09:00:00Z"),
  closesAt: new Date("2026-10-17T23:59:59Z"),
};

calendar.getAvailability(window, new Date("2026-10-05T00:00:00Z")); // 'locked'
calendar.getAvailability(window, new Date("2026-10-12T12:00:00Z")); // 'open'
calendar.getAvailability(window, new Date("2026-10-18T00:00:00Z")); // 'closed'
```

### Invariants:

- **Inclusive boundaries:** Exactly at `opensAt`, the state is already `'open'`. Exactly at `closesAt`, it remains `'open'`; one millisecond later, it becomes `'closed'`.
- **Pure comparisons:** Compares UTC epoch timestamps, avoiding timezone offset confusion.

---

## iCalendar Export (`toIcal`)

Generates standard `.ics` calendar content for assignment deadlines and exam schedules:

```ts
import { toIcal } from "discendo-sdk/scheduling/calendar";

const icsString = toIcal([
  {
    id: "asg-lab1",
    title: "CS101: Lab 1 Submission Deadline",
    dueAt: new Date("2026-10-15T23:59:00Z"),
  },
  {
    id: "exam-midterm",
    title: "CS101: Midterm Exam",
    dueAt: new Date("2026-10-22T14:00:00Z"),
  },
]);
```

### Sample Output:

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//DiscendoLMS//discendo-sdk//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:asg-lab1@discendo-lms
DTSTAMP:20261013T200000Z
DTSTART:20261015T235900Z
SUMMARY:CS101: Lab 1 Submission Deadline
END:VEVENT
BEGIN:VEVENT
UID:exam-midterm@discendo-lms
DTSTAMP:20261013T200000Z
DTSTART:20261022T140000Z
SUMMARY:CS101: Midterm Exam
END:VEVENT
END:VCALENDAR
```

---

## Serving iCal Feeds in HTTP Handlers

You can serve this as a live subscription feed for students in an API endpoint:

```ts
app.get("/api/users/:userId/calendar.ics", async (c) => {
  const userId = c.req.param("userId");
  const assignments = await db.assignments.findDueDatesForUser(userId);

  const ics = toIcal(
    assignments.map((a) => ({
      id: a.id,
      title: `${a.courseCode}: ${a.title}`,
      dueAt: a.dueAt,
    })),
  );

  return c.text(ics, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="calendar.ics"',
  });
});
```
