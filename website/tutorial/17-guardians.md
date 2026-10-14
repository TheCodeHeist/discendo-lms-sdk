---
description: Build a parent portal giving parents and guardians read-only oversight over student grades, attendance, and schedules.
---

# 17. Parent Portal (Guardians)

In this chapter, we will build a parent portal for Academix using `GuardianService`. Parents receive read-only oversight of their children's grades, attendance, and announcements without being enrolled in courses.

---

## 1. Guardian Links Database Table

Add the `guardian_links` table to `src/db/schema.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { users } from "./schema";

export const guardianLinks = sqliteTable("guardian_links", {
  id: text("id").primaryKey(),
  guardianId: text("guardian_id")
    .notNull()
    .references(() => users.id),
  wardId: text("ward_id")
    .notNull()
    .references(() => users.id),
  orgId: text("org_id"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(), // ['grades', 'attendance', 'announcements']
  status: text("status", { enum: ["active", "revoked"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});
```

---

## 2. Implementing Guardian Management Routes (`src/routes/guardians.ts`)

Create `src/routes/guardians.ts`:

```ts
import { Hono } from "hono";
import { guardianService, gradingService } from "../lib/services";
import { requireAuth } from "../lib/middleware";
import { handleDomainError } from "../lib/errors";

export const guardianRoutes = new Hono();

// 1. Admin Creates a Parent-Student Link
guardianRoutes.post("/links", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const { guardianId, wardId, scopes } = await c.req.json();

  try {
    const link = await guardianService.createLink(
      {
        guardianId,
        wardId,
        scopes: scopes ?? ["grades", "attendance", "announcements"],
      },
      { actorId }, // Admin role required
    );

    return c.json({ ok: true, link }, 201);
  } catch (err) {
    return handleDomainError(c, err);
  }
});

// 2. Admin Revokes a Parent Link
guardianRoutes.delete("/links/:linkId", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const linkId = c.req.param("linkId");

  try {
    const revoked = await guardianService.revokeLink(linkId, { actorId });
    return c.json({ ok: true, revoked });
  } catch (err) {
    return handleDomainError(c, err);
  }
});

// 3. Parent Views Ward's Grades
guardianRoutes.get(
  "/wards/:wardId/sections/:sectionId/grades",
  requireAuth,
  async (c) => {
    const actorId = c.get("actorId"); // Parent's user ID
    const wardId = c.req.param("wardId");
    const sectionId = c.req.param("sectionId");

    try {
      // Calling gradingService directly: authorization engine verifies guardian link automatically!
      const grades = await gradingService.getGradesForStudent(
        sectionId,
        wardId,
        { actorId }, // Parent is the actor, wardId is the target
      );

      return c.json({ ok: true, wardId, grades });
    } catch (err) {
      return handleDomainError(c, err);
    }
  },
);
```

---

## 3. How the Authorization Engine Protects Student Privacy

When the parent calls `/wards/:wardId/sections/:sectionId/grades`:

1. `authorizeInSection` observes that `actorId ('u-parent') !== targetUserId ('u-student')`.
2. It looks up active links in `GuardianLinkRepository`.
3. It confirms that the link includes the `'grades'` scope.
4. It confirms that the ward is currently an **active student** in the specified section.
5. If the student drops the class, or if the link is revoked, the parent receives `403 Forbidden` immediately.

---

## Next Steps

Now that all business domains and operational services are built, we enter **Phase 5: Shipping**:

- [Chapter 18: Testing](/tutorial/18-testing)
- [Chapter 19: Deployment](/tutorial/19-deployment)
