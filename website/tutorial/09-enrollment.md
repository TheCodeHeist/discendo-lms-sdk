---
description: Implement student course registration, automated waitlists, seat caps, auto-promotion on drop, and bulk roster imports.
---

# 9. Enrollment & Waitlists

In this chapter, we will build the registration engine for Academix using `EnrollmentService`. It handles seat capacities, waitlist queues, drops with auto-promotion, and bulk roster imports.

---

## 1. Implementing Enrollment Routes (`src/routes/enrollments.ts`)

Create `src/routes/enrollments.ts`:

```ts
import { Hono } from "hono";
import { enrollmentService } from "../lib/services";
import { requireAuth } from "../lib/middleware";
import { handleDomainError } from "../lib/errors";

export const enrollmentRoutes = new Hono();

// 1. Enroll into a Section (Self-registration or staff assignment)
enrollmentRoutes.post("/sections/:sectionId/enroll", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const sectionId = c.req.param("sectionId");
  const body = await c.req.json();

  // Default to enrolling oneself as a student if userId is omitted
  const userId = body.userId || actorId;
  const role = body.role || "student";
  const waitlistIfFull = body.waitlistIfFull ?? true;

  try {
    const enrollment = await enrollmentService.enroll(
      {
        userId,
        sectionId,
        role,
        waitlistIfFull,
      },
      { actorId }, // Authorized by authenticated caller
    );

    return c.json(
      {
        ok: true,
        enrollment: {
          id: enrollment.id,
          userId: enrollment.userId,
          sectionId: enrollment.sectionId,
          role: enrollment.role,
          status: enrollment.status, // 'active' or 'waitlisted'
          enrolledAt: enrollment.enrolledAt,
        },
      },
      201,
    );
  } catch (err) {
    return handleDomainError(c, err);
  }
});

// 2. Drop an Enrollment
enrollmentRoutes.post("/sections/:sectionId/drop", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const { enrollmentId } = await c.req.json();

  try {
    const dropped = await enrollmentService.drop(enrollmentId, { actorId });
    return c.json({ ok: true, dropped });
  } catch (err) {
    return handleDomainError(c, err);
  }
});

// 3. Promote Students from Waitlist
enrollmentRoutes.post(
  "/sections/:sectionId/promote",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId");
    const sectionId = c.req.param("sectionId");

    try {
      const promoted = await enrollmentService.promoteFromWaitlist(sectionId, {
        actorId,
      });
      return c.json({ ok: true, promotedCount: promoted.length, promoted });
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);

// 4. View Section Roster
enrollmentRoutes.get("/sections/:sectionId/roster", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const sectionId = c.req.param("sectionId");
  const status = c.req.query("status") as any; // Optional: 'active' | 'waitlisted'

  try {
    const roster = await enrollmentService.listRoster(sectionId, status, {
      actorId,
    });
    return c.json({ ok: true, roster });
  } catch (err) {
    return handleDomainError(c, err);
  }
});

// 5. Bulk Roster Import (SIS Sync)
enrollmentRoutes.post("/sections/:sectionId/bulk", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const sectionId = c.req.param("sectionId");
  const { rows } = await c.req.json(); // Array of { userExternalRef, role }

  try {
    const report = await enrollmentService.bulkEnroll(sectionId, rows, {
      actorId,
    });
    return c.json({ ok: true, report });
  } catch (err) {
    return handleDomainError(c, err);
  }
});
```

---

## 2. Register Routes in Main Server (`src/index.ts`)

Update `src/index.ts` to mount our route modules:

```ts
import { Hono } from "hono";
import { authRoutes } from "./routes/auth";
import { orgRoutes } from "./routes/organizations";
import { courseRoutes } from "./routes/courses";
import { enrollmentRoutes } from "./routes/enrollments";

const app = new Hono();

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Mount API routes
app.route("/api/auth", authRoutes);
app.route("/api/organizations", orgRoutes);
app.route("/api/courses", courseRoutes);
app.route("/api/enrollments", enrollmentRoutes);

export default {
  port: 3000,
  fetch: app.fetch,
};
```

---

## 3. How the Registration Engine Operates

### Seat Capacities & Waitlists:

When section capacity is 30:

1. Students 1 through 30 receive `status: 'active'`.
2. Student 31 attempts to enroll:
   - Because `waitlistIfFull: true` was passed, they receive `status: 'waitlisted'`.
   - The SDK emits `enrollment.enrolled` with `status: 'waitlisted'`.

### Auto-Promotion on Drop:

Because we configured `promoteOnDrop: true` in our `EnrollmentService`:

1. When student 10 calls `/drop`, their status becomes `'dropped'`.
2. The service detects a freed seat and immediately promotes student 31 from `'waitlisted'` to `'active'`.
3. The SDK emits `enrollment.dropped` followed by `enrollment.promoted` with `trigger: 'auto'`.

All of this happens atomically without writing custom queue logic in your controllers.

---

## Next Steps

With students enrolled, we will organize learning materials in [Chapter 10: Course Content](/tutorial/10-content).
