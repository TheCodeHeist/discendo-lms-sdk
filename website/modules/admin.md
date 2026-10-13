---
description: Learn how discendo-sdk/admin tracks immutable audit logs, handles audit failures, and scopes security history across tenant organizations.
---

# Admin & Audit

`discendo-sdk/admin` provides audit logging infrastructure. Rather than scattering manual logging calls across your application, it wraps operations cleanly, capturing who did what, when, and to which entity.

---

## At a Glance

|                  |                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| **Import**       | `import { withAudit, AdminService, diffObjects, AuditWriteFailedError } from 'discendo-sdk/admin'` |
| **Repositories** | `AuditRepository` (append-only)                                                                    |
| **Events**       | None                                                                                               |
| **Permissions**  | `admin.viewAuditLog` (account-wide admin only, non-delegable)                                      |
| **Enforcement**  | Opt-in on `AdminService` via `{ enforcement: { policy, repos } }`                                  |

---

## Data Model (`AuditEntry`)

```ts
interface AuditEntry {
  id: string;
  actorId: string;
  orgId?: string; // Actor's organization, loaded from database
  action: string; // Operation name, e.g. 'grade.record', 'enrollment.drop'
  targetId: string; // Target resource ID
  timestamp: Date;
  outcome?: "denied"; // Set when recording a security refusal
  diff?: Record<string, { before: unknown; after: unknown }>;
}

interface AuditRepository {
  append(entry: Omit<AuditEntry, "id">): Promise<AuditEntry>;
  listForTarget(targetId: string): Promise<AuditEntry[]>;
}
```

The repository is **append-only by design**. There are no update or delete methods.

---

## Free Function: `withAudit`

`withAudit` wraps any asynchronous function, executing the operation and appending an audit record upon success:

```ts
import { withAudit } from "discendo-sdk/admin";

const result = await withAudit(
  auditRepo,
  "grade.record",
  submissionId,
  actorId,
  () =>
    gradingService.recordGrade(submissionId, userId, score, maxScore, actorId),
);
```

- **Only successful mutations are recorded:** If the wrapped function throws an error, the error propagates and no audit entry is stored.
- **Composable:** Works with any asynchronous code—SDK services, custom database queries, or external API calls.

---

## Multi-Tenant Auditing: `AdminService`

In multi-tenant deployments, use `AdminService` instead of plain `withAudit`. It ensures audit logs are stamped with the actor's verified organization and queries are tenant-scoped:

```ts
const adminService = new AdminService(auditRepo, {
  enforcement: { policy, repos },
});

// 1. Execute audited action
await adminService.audited(
  "course.archive",
  courseId,
  { actorId: "u-admin" },
  () => courseService.archiveCourse(courseId),
);

// 2. Query target audit history (scoped strictly to admin's organization)
const history = await adminService.history(courseId, { actorId: "u-admin" });
```

---

## Safe Error Handling: `AuditWriteFailedError`

What happens if an enrollment or grade update succeeds in the database, but saving the audit log record fails?

To prevent silent failures while letting callers know the primary mutation completed, Discendo throws `AuditWriteFailedError`:

```ts
try {
  await adminService.audited('grade.record', subId, { actorId }, () =>
    gradingService.recordGrade(...)
  )
} catch (err) {
  if (err instanceof AuditWriteFailedError) {
    if (err.completed) {
      // The grade was successfully recorded, but the audit trail write failed!
      alertDevOps(`Audit logging failure: ${err.message}`)
      return err.result // Safe to return the recorded grade
    }
  }
  throw err
}
```

---

## Object Diffing (`diffObjects`)

A pure helper that calculates state deltas for inclusion in audit log entries:

```ts
import { diffObjects } from "discendo-sdk/admin";

const before = { title: "CS101", capacity: 30, status: "draft" };
const after = { title: "CS101", capacity: 35, status: "published" };

const diff = diffObjects(before, after);
// {
//   capacity: { before: 30, after: 35 },
//   status: { before: 'draft', after: 'published' }
// }
```

---

## Known Limitations

- **No tamper-evident cryptographic hashing:** The SDK provides structured audit logging; cryptographic chaining (e.g. SHA-256 Merkle trees) must be implemented inside your `AuditRepository` if required by legal compliance.
