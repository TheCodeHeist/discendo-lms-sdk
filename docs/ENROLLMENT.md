# Enrollment

`src/domains/enrollment/` — putting people into sections and taking them out:
enrolling with a role, waitlisting at capacity, dropping, listing a roster, and
importing a roster in bulk. Subpath: `discendo-sdk/enrollment`.

Enrollment is also the module the permission system leans on most. A person's role
*in a section* is whatever their `active` enrollment says, so who may do what
everywhere else begins here.

## At a glance

| | |
| --- | --- |
| **You import** | `EnrollmentService` and the types `EnrollOptions`, `BatchEnrollRow`, `BatchReport` |
| **You implement** | the `core` repositories: `users`, `courses`, `enrollments` (the others in `RepositoryContext` are unused here) |
| **Emits events** | `enrollment.enrolled`, `enrollment.dropped` |
| **Permission actions** | `enrollment.enroll`, `enrollment.bulkEnroll`, `enrollment.drop`, `enrollment.viewRoster`, `enrollment.grantRole.<role>` |
| **Enforcement** | opt-in: `new EnrollmentService(repos, bus, { policy })` |

## Types (`types.ts`)

```ts
interface EnrollOptions {
  userId: string;
  sectionId: string;
  role: Role;
  /** If the section is at capacity, waitlist instead of throwing. */
  waitlistIfFull?: boolean;
}

interface BatchEnrollRow {
  userExternalRef: string;   // the host's own reference, resolved to a user for you
  role: Role;
}

interface BatchReport {
  succeeded: number;
  failed: Array<{ row: BatchEnrollRow; reason: string }>;
}
```

`Enrollment` and `EnrollmentStatus` are in [CORE.md](./CORE.md).

## The life of an enrollment

```
                  ┌──────────────► waitlisted ──┐
 (none) ── enroll ┤                              ├── drop ──► dropped
                  └──────────────► active ───────┘
                                       │
                                       └── (set by your code) ──► completed
```

- A new enrollment is `active`, or `waitlisted` when the section is full and the
  caller asked for waitlisting.
- `drop` moves either to `dropped` and sets `droppedAt`. Nothing is ever deleted.
- **A dropped person who is enrolled again gets a brand-new record.** The old one
  stays as history. Anything attached to the old enrollment (TA grants, for example)
  does not carry over.
- `completed` is reserved for your application. The SDK never sets it.
- **Only `active` enrollments grant a role** in permission checks.

## `EnrollmentService`

```ts
new EnrollmentService(repos: RepositoryContext, events?: EventBus, options?: { policy?: PermissionPolicy })
```

Every method takes a trailing `actor?: { actorId }`. It is required when a `policy`
is configured and ignored otherwise.

### `enroll(opts, actor?): Promise<Enrollment>`

Enrolls `opts.userId` into `opts.sectionId` with `opts.role`.

1. **(Enforcement on)** authorizes `enrollment.enroll` in the section *and*
   `enrollment.grantRole.<role>` for the role being given. Both are required, so an
   instructor can give `ta` and `student` but not `instructor` or `admin`.
2. **Idempotent shortcut.** If the person already has an enrollment in the section
   that is **not dropped** (active, waitlisted or completed), that record is
   returned and nothing else happens: no new record, no event. Authorization still
   comes first, so an unauthorized caller cannot use this to learn who is enrolled.
3. Looks up the section; throws `Section <id> not found` if it does not exist.
4. **Tenant check**: the section's course must exist (otherwise `Course <id> not found`),
   and the person must belong to the course's organization (see
   [TENANCY.md](./TENANCY.md)). This is strict in both directions: "no organization"
   matches only "no organization". The person is loaded (`users.findById`) after the
   course, and an unknown person throws `User <id> not found`. A mismatch throws
   `TenantMismatchError` and creates nothing, *before* the capacity logic, so a
   cross-tenant person is not waitlisted.
5. **Capacity.** If the section has a `capacity` and `countActive` has reached it:
   with `waitlistIfFull` the new enrollment is `waitlisted`, otherwise it throws
   `Section <id> is at capacity`. A section with no `capacity` is unlimited.
6. Creates the record (`enrolledAt` is now) and emits `enrollment.enrolled`.

```ts
const enrollment = await service.enroll(
  { userId: 'stu-1', sectionId: 'sec-1', role: 'student', waitlistIfFull: true },
  { actorId: teacher.id },
);
enrollment.status;   // 'active' or 'waitlisted'
```

### `drop(enrollmentId, actor?): Promise<Enrollment>`

Sets `status: 'dropped'` and `droppedAt`, then emits `enrollment.dropped`. With
enforcement on it first loads the enrollment to learn whose it is and which section
it is in, and needs `enrollment.drop` there: **a student may drop themselves**, and
admins and instructors may drop anyone. An unknown enrollment id is refused exactly
like a forbidden one.

### `listRoster(sectionId, status?, actor?): Promise<Enrollment[]>`

The section's enrollments, optionally only those with one `status`. Needs
`enrollment.viewRoster` (admin, instructor, TA).

### `bulkEnroll(sectionId, rows, actor?): Promise<BatchReport>`

Imports a roster feed. Each row names a person by the **host's own reference**
(`userExternalRef`); the service resolves it with `UserRepository.findByExternalRef`,
passing the course's organization so two institutions can reuse a reference. Rows are
enrolled with `waitlistIfFull: true`.

- It **never throws for a bad row.** Each failure is reported with a reason and the
  rest continue: `'user not found'`, `'not permitted'` (enforcement: the actor may
  not grant that row's role), or the error message from the enrollment itself
  (at capacity, tenant mismatch, section not found, course not found).
- Enforcement needs `enrollment.bulkEnroll` for the section (admin only by default),
  and checks `enrollment.grantRole.<role>` per row.
- The batch resolves the course's organization once, so a missing section is reported
  per row instead of failing the whole call.

```ts
const report = await service.bulkEnroll('sec-1', rows, { actorId: admin.id });
report.succeeded;        // 118
report.failed;           // [{ row: { userExternalRef: 'x42', role: 'student' }, reason: 'user not found' }, ...]
```

## Permissions at a glance

| Method | Action | Checked against |
| --- | --- | --- |
| `enroll` | `enrollment.enroll` and `enrollment.grantRole.<role>` | the section; the person being enrolled is the owner |
| `drop` | `enrollment.drop` | the enrollment's section; its person is the owner (so a student may drop themselves) |
| `listRoster` | `enrollment.viewRoster` | the section |
| `bulkEnroll` | `enrollment.bulkEnroll`, then `enrollment.grantRole.<role>` per row | the section |

Under the default rules `enrollment.enroll` and `enrollment.grantRole.student` can be
**delegated** to a TA, who can then enroll students and nothing more. See
[DELEGATION.md](./DELEGATION.md) and [PERMISSIONS.md](./PERMISSIONS.md).

## Events

| Event | When |
| --- | --- |
| `enrollment.enrolled` | a new record is created, with `status` `'active'` or `'waitlisted'` (each successful `bulkEnroll` row too) |
| `enrollment.dropped` | `drop` succeeds |

No event for the idempotent shortcut, for a refused call, or for a cross-tenant
rejection. See [EVENTS.md](./EVENTS.md).

## What the repositories must do

- `EnrollmentRepository.findByUserAndSection` returns the **most recent** record when
  a person has several for the section (a dropped one, then a later one).
- `countActive(sectionId)` counts `active` enrollments only. It decides capacity.
- `update(id, patch)` returns the updated record; `create` returns the stored one with
  its `id`.
- `UserRepository.findByExternalRef(ref, orgId?)` stays within `orgId` when given.

## Known limitations

- **No waitlist promotion.** Dropping an active student does not move anyone off the
  waitlist; your code must do that (list with `status: 'waitlisted'`, then update).
- **The capacity check is not atomic.** It reads `countActive` and then creates, so
  two simultaneous enrollments into the last seat can both succeed. If seats are
  strict, enforce capacity in your repository as well.
- **`countActive` decides what consumes a seat.** If your implementation counts staff
  as well as students, enrolling a TA uses a student seat.
- **`drop` is not idempotent.** Dropping an already dropped enrollment sets
  `droppedAt` again and emits another event.
- **Section status is not checked.** Nothing stops an enrollment into a `draft` or
  `archived` section.
- **No events for status changes** other than enroll and drop.

## Tests

| File | Covers |
| --- | --- |
| `test/enrollment-permissions.test.ts` | every method with enforcement on: who may do what, role escalation, bulk rows, courses with no organization |
| `test/enrollment-tenancy.test.ts` | the tenant check (including strict handling of courses with no organization), bulk import with organization hints, cross-department enrollment |
| `test/enrollment-events.test.ts` | the two events, with and without a bus |
| `test/delegation.test.ts` | a TA with delegated rights enrolling students through this service |
