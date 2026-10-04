# Admin

`src/services/admin/` — an audit trail: a wrapper that records who did what to what,
and a service that reads the history back. Subpath: `discendo-sdk/admin`.

The design is one small idea. Rather than scattering "log this" calls through every
service, you wrap the call you want recorded in a function, `withAudit`, and the
record is written for you.

## At a glance

| | |
| --- | --- |
| **You import** | `withAudit`, `AdminService`, and the types `AuditEntry`, `AuditRepository` |
| **You implement** | `AuditRepository` |
| **Emits events** | none |
| **Permission actions** | `admin.viewAuditLog` (admin only) |
| **Enforcement** | **not yet.** The action exists; `AdminService` does not check it |

## Types

```ts
interface AuditEntry {
  id: string;
  actorId: string;
  action: string;      // a name you choose, e.g. 'grade.record'
  targetId: string;    // what was acted on, e.g. a submission id
  timestamp: Date;
  diff?: Record<string, { before: unknown; after: unknown }>;
}

interface AuditRepository {
  append(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry>;
  listForTarget(targetId: string): Promise<AuditEntry[]>;
}
```

The repository is **append-only** by design: there is no update or delete. `diff` is for
before and after values; `withAudit` does not fill it in (see the limitations).

## `withAudit`

```ts
withAudit<T>(
  audit: AuditRepository,
  action: string,
  targetId: string,
  actorId: string,
  fn: () => Promise<T>,
): Promise<T>
```

Runs `fn`, and **after it succeeds** appends an entry `{ actorId, action, targetId,
timestamp: now }`, then returns `fn`'s result.

```ts
import { withAudit } from 'discendo-sdk/admin';

const entry = await withAudit(auditRepo, 'grade.record', submissionId, teacher.id, () =>
  grading.recordGrade(submissionId, userId, 85, 100, teacher.id, undefined, { actorId: teacher.id }),
);
```

It is a free function, not tied to any service, so it composes with anything: the SDK's
services, your own code, a database migration.

Two behaviours matter:

- **Only successes are recorded.** If `fn` throws, the error propagates and **no entry is
  written**. A refused or failed attempt leaves no trace. If you need to record denials
  (for example `PermissionDeniedError`), catch them yourself and append an entry.
- **A failing audit write fails the call.** The mutation has already happened by then, so
  the caller sees an error for something that took effect. Make `append` reliable, or
  handle that case.

## `AdminService`

```ts
new AdminService(audit: AuditRepository)
history(targetId: string): Promise<AuditEntry[]>
```

Returns the audit entries for one target, as the repository returns them.

## Permissions

`admin.viewAuditLog` is admin only. `AdminService.history` does not check it yet, so guard
the route that exposes it ([PERMISSIONS.md](./PERMISSIONS.md)). Audit entries can reveal
who changed whose grades; treat the history as sensitive.

## Audit trail and the SDK's own history

Some modules keep their own history already. Grading never overwrites a grade (each
regrade is a new entry marking the old one superseded; see [GRADING.md](./GRADING.md)) and
enrollment never deletes (see [ENROLLMENT.md](./ENROLLMENT.md)). `withAudit` is for the rest,
and for a single view across modules.

## Known limitations

- **No permission enforcement yet.**
- **Failures are not audited** (above).
- **`diff` is never populated.** `withAudit` records that something happened, not what
  changed.
- **The audit write is not in the same transaction** as the operation. If the process stops
  between the two, the action happened and the entry does not exist.
- **`history` is by target only.** No query by actor or time range, and no pagination.
- **The actor and target ids are whatever you pass**; `withAudit` verifies neither.
- **No tests for this module.** The behaviour above was checked by running the code.
