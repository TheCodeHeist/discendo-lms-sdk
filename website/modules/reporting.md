---
description: Learn how discendo-sdk/reporting tracks student attendance, calculates completion percentages, and exports data to CSV.
---

# Reporting

`discendo-sdk/reporting` is a data consumer module. It records and aggregates attendance marks, computes course progress percentages, and formats arbitrary collections into downloadable CSV files.

---

## At a Glance

|                  |                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Import**       | `import { ReportingService, toCsv, computeCompletionPercent } from 'discendo-sdk/reporting'` |
| **Repositories** | `AttendanceRepository`                                                                       |
| **Locators**     | `SessionLocator`                                                                             |
| **Events**       | `reporting.attendanceRecorded`                                                               |
| **Permissions**  | `reporting.recordAttendance` (delegable), `reporting.view`                                   |
| **Enforcement**  | Opt-in via constructor options `{ sessions, enforcement: { policy, repos } }`                |

---

## Attendance Tracking

```ts
type AttendanceStatus = "present" | "absent" | "excused" | "late";

interface AttendanceRecord {
  sessionId: string; // The class meeting or occurrence ID
  userId: string;
  status: AttendanceStatus;
  recordedAt: Date;
  recordedBy?: string; // Actor ID who took roll call
}

interface AttendanceRepository {
  record(entry: AttendanceRecord): Promise<void>;
  listForSession(sessionId: string): Promise<AttendanceRecord[]>;
}
```

### The `SessionLocator` Pattern

Because `reporting` cannot import `scheduling` directly (preserving the zero-cross-domain import rule), you provide a small locator that resolves session IDs to course sections:

```ts
const sessionLocator: SessionLocator = {
  sectionOf: async (sessionId) => {
    const occurrence = await schedulingRepo.findOccurrence(sessionId);
    if (!occurrence) return null;
    const template = await schedulingRepo.findTemplate(occurrence.templateId);
    return template?.sectionId ?? null;
  },
  sessionsInSection: async (sectionId) => {
    const occurrences =
      await schedulingRepo.listOccurrencesForSection(sectionId);
    return occurrences.map((o) => o.id);
  },
};
```

### `ReportingService` Operations

```ts
const reporting = new ReportingService(attendanceRepo, {
  sessions: sessionLocator,
  enforcement: { policy, repos },
});

// 1. Record attendance marks
await reporting.recordAttendance(
  "session-oct14",
  [
    { userId: "u-alice", status: "present" },
    { userId: "u-bob", status: "late" },
  ],
  { actorId: "u-instructor" },
);

// 2. Fetch student attendance summary
const summary = await reporting.attendanceForStudent("sec-101", "u-alice", {
  actorId: "u-instructor",
});
// { present: 14, late: 1, excused: 0, absent: 1, attendanceRate: 0.9375 }
```

---

## Course Completion Percentage

A pure calculation utility to determine student progress through course modules:

```ts
import { computeCompletionPercent } from "discendo-sdk/reporting";

const percent = computeCompletionPercent({
  completedNodeIds: ["node-1", "node-2", "node-3"],
  totalRequiredNodeIds: ["node-1", "node-2", "node-3", "node-4"],
});

console.log(`${percent}% completed`); // 75%
```

---

## CSV Export (`toCsv`)

Formats arrays of arbitrary objects into standard CSV text with RFC 4180 escaping:

```ts
import { toCsv } from "discendo-sdk/reporting";

const csvString = toCsv(
  [
    { id: "101", name: "Alice Smith", grade: "92.5%", status: "Pass" },
    { id: "102", name: "Bob Jones, Jr.", grade: "84.0%", status: "Pass" },
  ],
  {
    columns: [
      { key: "id", header: "Student ID" },
      { key: "name", header: "Full Name" },
      { key: "grade", header: "Final Grade" },
      { key: "status", header: "Status" },
    ],
  },
);
```

Handles comma escaping, double quotes, and line breaks automatically.

---

## Known Limitations

- **No historical attendance point-in-time state:** Attendance marks represent the current mark recorded for a session.
