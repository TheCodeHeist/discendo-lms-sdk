---
description: Implement security and compliance audit logging for sensitive academic mutations using withAudit and AdminService.
---

# 16. Audit Log

In this chapter, we will build an append-only audit trail for compliance and institutional accreditation (such as FERPA and GDPR). We will use `withAudit` and `AdminService` to record who executed sensitive operations.

---

## 1. Audit Table & Repository (`src/db/repositories/audit.ts`)

Add the audit log table to `src/db/schema.ts`:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const auditEntries = sqliteTable("audit_entries", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  orgId: text("org_id"),
  action: text("action").notNull(),
  targetId: text("target_id").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
  diff: text("diff", { mode: "json" }),
});
```

Create `src/db/repositories/audit.ts` to implement `AuditRepository`:

```ts
import { eq, desc } from "drizzle-orm";
import type { AuditRepository, AuditEntry } from "discendo-sdk/admin";
import { db } from "../index";
import { auditEntries } from "../schema";

export class DrizzleAuditRepository implements AuditRepository {
  async append(entry: Omit<AuditEntry, "id">): Promise<AuditEntry> {
    const id = crypto.randomUUID();
    await db.insert(auditEntries).values({
      id,
      actorId: entry.actorId,
      orgId: entry.orgId ?? null,
      action: entry.action,
      targetId: entry.targetId,
      timestamp: entry.timestamp,
      diff: entry.diff ?? null,
    });
    return { id, ...entry };
  }

  async listForTarget(targetId: string): Promise<AuditEntry[]> {
    const rows = await db.query.auditEntries.findMany({
      where: eq(auditEntries.targetId, targetId),
      orderBy: [desc(auditEntries.timestamp)],
    });
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      targetId: row.targetId,
      timestamp: row.timestamp,
      ...(row.orgId ? { orgId: row.orgId } : {}),
      ...(row.diff ? { diff: row.diff as any } : {}),
    }));
  }
}
```

---

## 2. Wrapping Sensitive Operations with `withAudit`

`withAudit` wraps any asynchronous function, executing the operation and appending the audit log record **after** the primary mutation succeeds:

```ts
import { withAudit } from "discendo-sdk/admin";
import { auditRepo } from "../lib/services";

// Example: Grade update with audit trail
export async function updateGradeWithAudit(
  submissionId: string,
  actorId: string,
  score: number,
) {
  return await withAudit(
    auditRepo,
    "grade.override",
    submissionId, // target ID
    actorId, // who performed the override
    async () => {
      return await gradingService.recordGrade(
        submissionId,
        "u-student",
        score,
        100,
        actorId,
      );
    },
  );
}
```

---

## 3. Querying Audit History (`src/routes/admin.ts`)

Build an admin endpoint to inspect an entity's modification history:

```ts
import { Hono } from "hono";
import { adminService } from "../lib/services";
import { requireAuth } from "../lib/middleware";
import { handleDomainError } from "../lib/errors";

export const adminRoutes = new Hono();

// Query Audit Trail for an Entity (Admin Only)
adminRoutes.get("/audit/:targetId", requireAuth, async (c) => {
  const actorId = c.get("actorId");
  const targetId = c.req.param("targetId");

  try {
    const history = await adminService.history(targetId, { actorId });
    return c.json({ ok: true, targetId, history });
  } catch (err) {
    return handleDomainError(c, err);
  }
});
```

---

## Next Steps

Next, we will establish read-only parent oversight in [Chapter 17: Parent Portal (Guardians)](/tutorial/17-guardians).
