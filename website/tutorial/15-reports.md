---
description: Record student attendance roll calls, compute course completion percentages, and generate downloadable CSV reports.
---

# 15. Attendance & Reports

In this chapter, we will build attendance recording and reporting endpoints using `ReportingService`, compute course completion rates, and generate downloadable CSV exports.

---

## 1. Implementing Reporting Routes (`src/routes/reports.ts`)

Create `src/routes/reports.ts`:

```ts
import { Hono } from "hono";
import { reportingService } from "../lib/services";
import { toCsv, computeCompletionPercent } from "discendo-sdk/reporting";
import { requireAuth } from "../lib/middleware";
import { handleDomainError } from "../lib/errors";

export const reportRoutes = new Hono();

// 1. Take Attendance Roll Call for a Session
reportRoutes.post("/sessions/:sessionId/attendance", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const sessionId = c.req.param("sessionId");
  const { marks } = await c.req.json(); // Array of { userId, status: 'present' | 'absent' | 'late' }

  try {
    await reportingService.recordAttendance(sessionId, marks, { actorId });
    return c.json({ ok: true, recordedCount: marks.length });
  } catch (err) {
    return handleDomainError(c, err);
  }
});

// 2. Student Attendance Summary
reportRoutes.get(
  "/sections/:sectionId/attendance/students/:userId",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId");
    const sectionId = c.req.param("sectionId");
    const userId = c.req.param("userId");

    try {
      const summary = await reportingService.attendanceForStudent(
        sectionId,
        userId,
        { actorId },
      );
      return c.json({ ok: true, summary });
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);

// 3. Export Section Gradebook / Roster to CSV
reportRoutes.get(
  "/sections/:sectionId/export/grades.csv",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId");
    const sectionId = c.req.param("sectionId");

    try {
      // 1. Fetch student grade summary data
      const data = [
        {
          id: "u-alice",
          name: "Alice Smith",
          percentage: "94.5%",
          letter: "A",
          status: "Active",
        },
        {
          id: "u-bob",
          name: "Bob Jones",
          percentage: "82.0%",
          letter: "B",
          status: "Active",
        },
        {
          id: "u-carol",
          name: "Carol Danvers",
          percentage: "78.5%",
          letter: "C",
          status: "Active",
        },
      ];

      // 2. Format with toCsv utility
      const csvContent = toCsv(data, {
        columns: [
          { key: "id", header: "Student ID" },
          { key: "name", header: "Full Name" },
          { key: "percentage", header: "Final Grade" },
          { key: "letter", header: "Letter Grade" },
          { key: "status", header: "Roster Status" },
        ],
      });

      // 3. Return as downloadable file
      return c.text(csvContent, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="grades-${sectionId}.csv"`,
      });
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);
```

---

## 2. Calculating Student Completion

Track student progress through mandatory lessons using `computeCompletionPercent`:

```ts
import { computeCompletionPercent } from "discendo-sdk/reporting";

const percent = computeCompletionPercent({
  completedNodeIds: ["node-1", "node-2"],
  totalRequiredNodeIds: ["node-1", "node-2", "node-3", "node-4"],
});

console.log(`Progress: ${percent}%`); // 50%
```

---

## Next Steps

Next, we will capture compliance and security audit trails in [Chapter 16: Audit Log](/tutorial/16-audit-log).
