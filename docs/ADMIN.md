# Admin

`src/services/admin/` — an audit trail: a wrapper that records who did what to what,
and a service that reads the history back. Subpath: `discendo-sdk/admin`.

The design is one small idea. Rather than scattering "log this" calls through every
service, you wrap the call you want recorded in a function, and the record is written for you.

## At a glance

| | |
| --- | --- |
| **You import** | `withAudit`, `AdminService`, `AuditWriteFailedError`, `diffObjects`, and the types `AuditEntry`, `AuditRepository`, `AdminServiceOptions`, `AuditedOptions` |
| **You implement** | `AuditRepository` |
| **Emits events** | none |
| **Permission actions** | `admin.viewAuditLog` (admin only, never delegable) |
| **Enforcement** | opt-in: `{ enforcement: { policy, repos } }` in the second constructor argument |

## Types

```ts
interface AuditEntry {
  id: string;
  actorId: string;
  orgId?: string;        // the actor's organization, from their stored account (see below)
  action: string;        // a name you choose, e.g. 'grade.record'
  targetId: string;      // what was acted on, e.g. a submission id
  timestamp: Date;
  outcome?: 'denied';    // only on an entry recording a refused attempt
  diff?: Record<string, { before: unknown; after: unknown }>;
}

interface AuditRepository {
  append(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry>;
  listForTarget(targetId: string): Promise<AuditEntry[]>;
}
```

The repository is **append-only** by design: there is no update or delete. Persist `orgId` and
`outcome` if you want them back.

## `withAudit`

```ts
withAudit<T>(audit, action, targetId, actorId, fn: () => Promise<T>): Promise<T>
```

Runs `fn`, and **after it succeeds** appends `{ actorId, action, targetId, timestamp: now }`, then
returns `fn`'s result. It is a free function, not tied to any service, so it composes with anything:
the SDK's services, your own code, a database migration.

```ts
const entry = await withAudit(auditRepo, 'grade.record', submissionId, teacher.id, () =>
  grading.recordGrade(submissionId, userId, 85, 100, teacher.id, undefined, { actorId: teacher.id }),
);
```

- **Only successes are recorded.** If `fn` throws, the error propagates and no entry is written.
- **It trusts what you pass.** `actorId` is whatever you say, and **no organization is written**.
  With more than one organization use `AdminService.audited` below.
- **A failing audit write makes noise.** `fn` has already happened, so the call throws an
  `AuditWriteFailedError` (see below) that carries the result instead of a bare database error.

### `AuditWriteFailedError`

Thrown when an entry cannot be written. It exists so nothing is lost silently *and* nobody is
misled about what happened:

```ts
try {
  await admin.audited('grade.record', id, { actorId }, () => grading.recordGrade(...));
} catch (e) {
  if (e instanceof AuditWriteFailedError) {
    if (e.completed) use(e.result);   // it worked; only the log entry is missing: alert someone
    else console.warn(e.refusal);     // it was refused; recording the refusal failed
    // e.cause is why the write failed
  } else throw e;
}
```

## `AdminService`

```ts
new AdminService(audit: AuditRepository, options?: {
  enforcement?: { policy: PermissionPolicy; repos: { users: UserRepository } };
})
```

### `audited(action, targetId, actor, fn, options?): Promise<T>`

`withAudit`, as the actor's stored account. With enforcement: the actor is loaded, so `actorId` and
**`orgId` come from the repository, never from what the caller says**; an actor who does not exist
is refused (`PermissionDeniedError`) **without running `fn`**; and a missing actor is
`ActorRequiredError`. Without enforcement it records the `actorId` you give and no organization.

It needs **no particular role**: it records what your own, already authorized, call just did, and an
entry can only ever say that the *calling* actor did it. Options:

- **`diff`**: what changed, stored as given. Never computed for you. `diffObjects(before, after)`
  builds it.
- **`recordDenials`** (**off by default**): also write an entry, with `outcome: 'denied'`, when `fn`
  throws a `PermissionDeniedError`, then rethrow that same error. Other errors, and a missing actor,
  are never recorded. **Leave it off unless you rate-limit the endpoint**: a refused actor who keeps
  retrying writes an entry every time.

An entry that cannot be written throws `AuditWriteFailedError`. When a *refusal* could not be
recorded, `completed` is `false` and `refusal` is the original permission error.

### `history(targetId, actor?): Promise<AuditEntry[]>`

The entries for one target. Without enforcement: whatever the repository returns. **With
enforcement** (`actor` required):

- it needs `admin.viewAuditLog`: admins of an organization, never an instructor, TA or student,
  and never by delegation;
- only entries of the **admin's own organization** come back, with "no organization" matching only
  "no organization", and only entries for the target asked about. A target that belongs to another
  organization, or does not exist, gives `[]`, so it does not say which;
- the permission check comes first and nothing is read for a refused caller.

Entries with `outcome: 'denied'` are included.

### Existing audit entries: a migration

Entries written by plain `withAudit`, or before organizations existed, have **no `orgId`**, so with
enforcement on they are visible **only to an admin who also has no organization**. A host that
already has an audit table needs to backfill `orgId`, or those entries disappear from every
organization's admins. New entries from `audited` are stamped correctly.

### `diffObjects(before, after)`

```ts
diffObjects({ score: 70, note: 'a' }, { score: 85, note: 'a' });  // { score: { before: 70, after: 85 } }
```

Only the keys that differ, each with its old and new value (a key on one side only has `undefined`
on the other). Values are compared **by content**: equal nested objects, arrays and dates are not
reported. It is a plain function, and what you do with the result is up to you. The diff is stored
as given, so **think before putting sensitive values in it** (it is admin-only to read).

## Permissions

`admin.viewAuditLog` is admin only. Audit entries can reveal who changed whose grades, which is why
reading them is an organization-wide admin action and not something an instructor can be given
([PERMISSIONS.md](./PERMISSIONS.md)).

## Audit trail and the SDK's own history

Some modules keep their own history already. Grading never overwrites a grade (each regrade is a
new entry marking the old one superseded; see [GRADING.md](./GRADING.md)) and enrollment never
deletes (see [ENROLLMENT.md](./ENROLLMENT.md)). Cancelling or moving a class, and recording
attendance, say who did it on their own events and records
([EVENTS.md](./EVENTS.md), [SCHEDULING.md](./SCHEDULING.md), [REPORTING.md](./REPORTING.md)).
The audit log is for the rest, and for a single view across modules.

## Known limitations

- **The SDK does not audit itself.** Its services do not write audit entries; you wrap the calls
  you care about.
- **Failures other than refusals are not audited**, and refusals only if you opt in.
- **The audit write is not in the same transaction** as the operation. If the process stops between
  the two, the action happened and the entry does not exist.
- **`history` is by target only.** No query by actor or time range, and no pagination. Adding them
  needs new repository methods.
- **`withAudit` and a host that passes its own `actorId` are trusted.** Only `audited` with
  enforcement takes the actor and organization from the stored account.
- **No department-scoped admins.** Any admin of the organization can read its whole audit trail.
- **Only the service is guarded.** Your own code can still read the repository directly.
- **No events** are emitted when an entry is written.

## Tests

| File | Covers |
| --- | --- |
| `test/admin.test.ts` | `withAudit` (order, successes only, a failing write), `history` and `audited` with enforcement on (admins only, the organization wall in both directions and with none, the actor and organization taken from the stored account, an unknown or missing actor, opt-in refusals, loud write failures, check ordering) and off, and `diffObjects` |
| `test/core-permissions.test.ts` | that `admin.viewAuditLog` is the organization's admins alone, never delegated |
