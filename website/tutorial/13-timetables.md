---
description: Build academic timetable management endpoints, materialize dated calendar occurrences, and automate room scheduling using the backtracking solver.
---

# 13. Timetables

In this chapter, we will build the timetable and scheduling engine for Academix using `SchedulingService`. It handles physical classroom assignments, recurring weekly class routines, calendar occurrence materialization, and automated timetable solving.

---

## 1. Scheduling Database Tables

Add scheduling tables to `src/db/schema.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { courseSections, users } from "./schema";

// Physical Classrooms
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  capacity: integer("capacity").notNull(),
  features: text("features", { mode: "json" }).$type<string[]>().notNull(),
  orgId: text("org_id"),
});

// Recurring Class Templates
export const classTemplates = sqliteTable("class_templates", {
  id: text("id").primaryKey(),
  sectionId: text("section_id")
    .notNull()
    .references(() => courseSections.id),
  roomId: text("room_id").references(() => rooms.id),
  teacherIds: text("teacher_ids", { mode: "json" }).$type<string[]>().notNull(),
  days: text("days", { mode: "json" }).$type<string[]>().notNull(), // ['MO', 'WE', 'FR']
  startTime: text("start_time").notNull(), // "10:00"
  endTime: text("end_time").notNull(), // "10:50"
  validFrom: integer("valid_from", { mode: "timestamp" }).notNull(),
  validUntil: integer("valid_until", { mode: "timestamp" }),
});

// Materialized Concrete Occurrences
export const classOccurrences = sqliteTable("class_occurrences", {
  id: text("id").primaryKey(),
  templateId: text("template_id")
    .notNull()
    .references(() => classTemplates.id),
  date: integer("date", { mode: "timestamp" }).notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  roomId: text("room_id").references(() => rooms.id),
  teacherIds: text("teacher_ids", { mode: "json" }).$type<string[]>().notNull(),
  status: text("status", { enum: ["scheduled", "cancelled"] })
    .notNull()
    .default("scheduled"),
  cancellationReason: text("cancellation_reason"),
});
```

---

## 2. Implementing Scheduling Routes (`src/routes/schedules.ts`)

Create `src/routes/schedules.ts`:

```ts
import { Hono } from "hono";
import { schedulingService } from "../lib/services";
import { requireAuth } from "../lib/middleware";
import { handleDomainError } from "../lib/errors";

export const scheduleRoutes = new Hono();

// 1. Create a Recurring Class Routine Template
scheduleRoutes.post(
  "/sections/:sectionId/templates",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId");
    const sectionId = c.req.param("sectionId");
    const {
      teacherIds,
      days,
      startTime,
      endTime,
      roomId,
      validFrom,
      validUntil,
    } = await c.req.json();

    try {
      const template = await (schedulingService as any).repo.createTemplate({
        sectionId,
        teacherIds: teacherIds ?? [actorId],
        roomId: roomId ?? undefined,
        rule: { freq: "WEEKLY", interval: 1, byDay: days },
        startTime,
        endTime,
        timezone: "UTC",
        validFrom: new Date(validFrom),
        validUntil: validUntil ? new Date(validUntil) : undefined,
      });

      return c.json({ ok: true, template }, 201);
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);

// 2. Materialize Occurrences Across a Semester Date Range
scheduleRoutes.post(
  "/templates/:templateId/materialize",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId");
    const templateId = c.req.param("templateId");
    const { from, to } = await c.req.json();

    try {
      const occurrences = await schedulingService.materializeOccurrences(
        templateId,
        new Date(from),
        new Date(to),
        { actorId }, // Requires scheduling.manage
      );

      return c.json({ ok: true, count: occurrences.length, occurrences }, 201);
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);

// 3. Cancel a Single Meeting Exception
scheduleRoutes.post(
  "/occurrences/:occurrenceId/cancel",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId");
    const occurrenceId = c.req.param("occurrenceId");
    const { reason } = await c.req.json();

    try {
      const cancelled = await schedulingService.cancelOccurrence(
        occurrenceId,
        reason ?? "Class cancelled",
        { actorId }, // Requires scheduling.manageOccurrence
      );

      return c.json({ ok: true, cancelled });
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);

// 4. Auto-Schedule Unplaced Templates (Solver)
scheduleRoutes.post("/auto-schedule/plan", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const { templateIds, slots, days } = await c.req.json();

  try {
    // Phase 1: Propose plan without touching database
    const { result, skippedAvailability } =
      await schedulingService.planAutoSchedule(
        templateIds,
        {
          candidateSlotsPerDay: slots ?? [
            "09:00",
            "10:00",
            "11:00",
            "13:00",
            "14:00",
          ],
          days: days ?? ["MO", "TU", "WE", "TH", "FR"],
        },
        { actorId },
      );

    return c.json({
      ok: true,
      status: result.status,
      placements: result.placements,
      unplaced: result.unplaced,
    });
  } catch (err) {
    return handleDomainError(c, err);
  }
});
```

---

## 3. The Auto-Scheduler in Action

When an administrator runs `/auto-schedule/plan`:

1. The solver inspects candidate classrooms and teacher availability.
2. It assigns conflict-free rooms and times to unscheduled sections.
3. If approved, calling `applyAutoSchedulePlan(result)` writes the assignments to the database.

---

## Next Steps

Next, we will broadcast announcements and deliver real-time notifications in [Chapter 14: Announcements & Notifications](/tutorial/14-notifications).
