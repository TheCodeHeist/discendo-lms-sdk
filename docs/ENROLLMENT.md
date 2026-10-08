# Enrollment

`src/domains/enrollment/` — putting people into sections and taking them out:
enrolling with a role, waitlisting at capacity and promoting people off the waitlist,
dropping, listing a roster, and importing a roster in bulk. Subpath: `discendo-sdk/enrollment`.

Enrollment is also the module the permission system leans on most. A person's role
*in a section* is whatever their `active` enrollment says, so who may do what
everywhere else begins here.

## At a glance

| | |
| --- | --- |
| **You import** | `EnrollmentService` and the types `EnrollOptions`, `PromoteOptions`, `BatchEnrollRow`, `BatchReport` |
| **You implement** | the `core` repositories: `users`, `courses`, `enrollments` (the others in `RepositoryContext` are unused here) |
| **Emits events** | `enrollment.enrolled`, `enrollment.dropped`, `enrollment.promoted` |
| **Permission actions** | `enrollment.enroll`, `enrollment.bulkEnroll`, `enrollment.drop`, `enrollment.viewRoster`, `enrollment.promoteWaitlist`, `enrollment.grantRole.<role>` |
| **Enforcement** | opt-in: `new EnrollmentService(repos, bus, { policy })` |

## Types (`types.ts`)

```ts
interface EnrollOptions {
  userId: string;
  sectionId: string;
  role: Role;
  /** If the section is at capacity (or people are already waiting), waitlist instead of throwing. */
  waitlistIfFull?: boolean;
  /** Let this enrollment go into a section that is still a `draft`. Archived sections never take one. */
  allowDraft?: boolean;
}

interface PromoteOptions {
  /** Promote in a section that is still a `draft`. Archived sections never promote. */
  allowDraft?: boolean;
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
 (none) ── enroll ┤        │                     ├── drop ──► dropped
                  │        └── promote ──┐       │
                  └──────────────► active ◄──────┘
                                       │
                                       └── (set by your code) ──► completed
```

- A new enrollment is `active`, or `waitlisted` when the section is full **or people are
  already waiting** and the caller asked for waitlisting.
- A waitlisted person becomes `active` through `promoteFromWaitlist` (or automatically
  after a drop, if you turned on `promoteOnDrop`), longest-waiting first.
- `drop` moves an active or waitlisted enrollment to `dropped` and sets `droppedAt`. Nothing is ever
  deleted. A `completed` enrollment **cannot** be dropped: it is history.
- **A dropped person who is enrolled again gets a brand-new record.** The old one
  stays as history. Anything attached to the old enrollment (TA grants, for example)
  does not carry over.
- `completed` is reserved for your application. The SDK never sets it. A completed
  **student** keeps read-only access to their own grades and the published content, and
  nothing else (see [PERMISSIONS.md](./PERMISSIONS.md)).
- **Only `active` enrollments grant a role** in permission checks.

## `EnrollmentService`

```ts
new EnrollmentService(repos: RepositoryContext, events?: EventBus, options?: { policy?: PermissionPolicy; promoteOnDrop?: boolean })
```

`promoteOnDrop` turns on automatic promotion (see `drop` below). It is off by default.

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
5. **Section status.** A section only takes new enrollments while it is **published**. An
   `archived` section never does, and a `draft` one does not unless the call passes
   `allowDraft: true`, which is how staff load a roster before the section opens. A closed
   section throws `SectionNotOpenError` (with `sectionId` and `status`) and creates nothing and
   emits nothing. This comes after the tenant check, so a person of another organization is told
   "wrong organization", and after the idempotent shortcut, so someone already enrolled still gets
   their enrollment back after the section closes. Someone who **dropped** and tries again after it
   closed is refused.
6. **Capacity and the queue.** If the section has a `capacity`, people who are already waiting
   come first: **a newcomer never takes a free seat while anyone is on the waitlist.** With
   `waitlistIfFull` the newcomer is `waitlisted`; otherwise the call throws `Section <id> is at
   capacity or has a waitlist`. (The seat is for the person at the front: call
   `promoteFromWaitlist`, or use `promoteOnDrop`.) With nobody waiting, the section is checked
   as before: if it is full, `waitlistIfFull` waitlists the newcomer, and otherwise it throws
   `Section <id> is at capacity`. A section with no `capacity` is unlimited. How "full" is
   decided depends on your repository:
   - **With `createIfSeatFree`** (recommended): the service hands the repository an `active`
     enrollment and the capacity, and the repository checks and takes the seat as **one atomic
     step**, returning `null` if the section is full. Two people cannot both get the last seat. The
     waitlisted enrollment is then made with the ordinary `create`. It is not called while
     somebody is waiting.
   - **Without it**: the service reads `countActive` and then calls `create`, which is **not
     atomic** (see the limitations).
7. Creates the record (`enrolledAt` is now) and emits `enrollment.enrolled`.

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

- **It is idempotent.** Dropping an enrollment that is already dropped returns it unchanged: no
  new `droppedAt`, no second event, no write.
- **Only active and waitlisted enrollments can be dropped.** A `completed` one throws
  `EnrollmentNotDroppableError`, so a finished course cannot be turned into a dropped one and
  lose its completion. This is checked after the permission check, so a stranger learns nothing
  about the enrollment's state.
- Without enforcement an unknown id throws `Enrollment <id> not found` instead of reaching your
  repository.
- **With `promoteOnDrop` on, dropping an `active` enrollment promotes the next person.** The
  freed seat goes to the longest-waiting person, exactly as `promoteFromWaitlist` would, and
  `enrollment.promoted` is emitted (with `trigger: 'auto'` and no `actorId`) after
  `enrollment.dropped`. Dropping a waitlisted, completed or already dropped enrollment promotes
  nobody. It runs under the drop's own permission (a student who drops themselves does not need
  `enrollment.promoteWaitlist`, and `drop` still returns only their own record). It skips a
  draft or archived section. **It never fails the drop:** if the promotion throws, the drop
  stands and the error is swallowed; call `promoteFromWaitlist` to catch up.

### `promoteFromWaitlist(sectionId, actor?, options?): Promise<Enrollment[]>`

Gives free seats to waiting people and returns the enrollments it promoted, in order.

1. **(Enforcement on)** authorizes `enrollment.promoteWaitlist` in the section (admin and
   instructor; **not** delegable). This comes first, so a stranger cannot tell a missing section
   from a closed one.
2. Looks up the section; throws `Section <id> not found` if it does not exist. An `archived`
   section throws `SectionNotOpenError`, and so does a `draft` one unless `options.allowDraft`.
3. **Free seats** are `capacity - countActive`. With no `capacity` the whole waitlist is
   promoted. With no free seat, or nobody waiting, it returns `[]` and writes nothing.
4. **Order:** the longest-waiting first, by `enrolledAt`, with the enrollment id breaking ties.
   The service sorts, so your repository's own order does not matter.
5. Each promotion sets `status: 'active'` through `promoteIfSeatFree` (see below) or, without
   it, a plain `update`, then emits `enrollment.promoted` with `trigger: 'manual'` (and
   `actorId` when permissions are enforced).

It is **idempotent**: calling it again promotes nobody. Call it after you raise a section's
`capacity` (the SDK has no service for editing sections), or as a catch-up after a failed
`promoteOnDrop`. Every role on the waitlist counts the same: seats are counted by `countActive`,
for staff and students alike.

```ts
await courses.setCapacity('sec-1', 40);                       // your own code
const moved = await service.promoteFromWaitlist('sec-1', { actorId: teacher.id });
moved.map((e) => e.userId);                                    // longest-waiting first
```

### `listRoster(sectionId, status?, actor?): Promise<Enrollment[]>`

The section's enrollments, optionally only those with one `status`. Needs
`enrollment.viewRoster` (admin, instructor, TA).

### `bulkEnroll(sectionId, rows, actor?, options?): Promise<BatchReport>`

Imports a roster feed. Each row names a person by the **host's own reference**
(`userExternalRef`); the service resolves it with `UserRepository.findByExternalRef`,
passing the course's organization so two institutions can reuse a reference. Rows are
enrolled with `waitlistIfFull: true`. `options.allowDraft` applies to every row, as on `enroll`;
without it, every row of a draft or archived section fails with the reason from
`SectionNotOpenError`.

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
| `promoteFromWaitlist` | `enrollment.promoteWaitlist` | the section |
| `bulkEnroll` | `enrollment.bulkEnroll`, then `enrollment.grantRole.<role>` per row | the section |

Under the default rules `enrollment.enroll` and `enrollment.grantRole.student` can be
**delegated** to a TA, who can then enroll students and nothing more. `enrollment.promoteWaitlist`
cannot be delegated. See
[DELEGATION.md](./DELEGATION.md) and [PERMISSIONS.md](./PERMISSIONS.md).

## Events

| Event | When |
| --- | --- |
| `enrollment.enrolled` | a new record is created, with `status` `'active'` or `'waitlisted'` (each successful `bulkEnroll` row too) |
| `enrollment.dropped` | `drop` succeeds |
| `enrollment.promoted` | a waitlisted person is made `active`: `trigger` is `'manual'` (`promoteFromWaitlist`, with `actorId` when permissions are enforced) or `'auto'` (`promoteOnDrop`, no actor) |

No event for the idempotent shortcut, for a refused call, or for a cross-tenant
rejection. See [EVENTS.md](./EVENTS.md).

## What the repositories must do

- `EnrollmentRepository.findByUserAndSection` returns the **most recent** record when
  a person has several for the section (a dropped one, then a later one).
- `countActive(sectionId)` counts `active` enrollments only. It decides capacity when
  `createIfSeatFree` is not provided.
- **`createIfSeatFree?(enrollment, capacity): Promise<Enrollment | null>`** is optional. Implement
  it as one atomic step (a transaction with a row lock, or a conditional insert such as
  `INSERT ... WHERE (SELECT count(*) ... ) < capacity`), counting the same enrollments
  `countActive` counts, and return `null` when the section is full. Existing hosts that do not
  provide it keep working as before.
- **`promoteIfSeatFree?(enrollmentId, capacity): Promise<Enrollment | null>`** is optional. Implement
  it as one atomic step: set the enrollment to `active` only if it is **still `waitlisted`** and the
  section has fewer than `capacity` active enrollments (counting what `countActive` counts), and
  return the updated record, or `null` if nothing changed (the section is full, or someone else just
  promoted that person). The service then moves on to the next person in line. Hosts without it keep
  working, with the race noted below. It is not used for a section with no `capacity`.
- `listBySection(sectionId, status?)` **must honor `status`**: the service lists only `waitlisted`
  enrollments to promote and to decide whether a newcomer must queue.
- `update(id, patch)` returns the updated record; `create` returns the stored one with
  its `id`.
- `UserRepository.findByExternalRef(ref, orgId?)` stays within `orgId` when given.

## Known limitations

- **Promotion is not automatic unless you turn on `promoteOnDrop`,** and then it only reacts to
  a drop. Freeing a seat any other way (raising `capacity`, changing an enrollment's status
  yourself) needs a call to `promoteFromWaitlist`.
- **A failed automatic promotion is silent.** `promoteOnDrop` swallows its errors so a drop never
  fails; the waiting person stays waitlisted until the next `promoteFromWaitlist`. A
  `deliveryFailed` event is planned for the events round.
- **Without `promoteIfSeatFree`, promotion is not atomic.** It reads `countActive`, lists the
  waitlist and then updates, so two simultaneous promotions into the last seat can both succeed. (A
  test pins this: without it, two simultaneous promotions overfill a section by one.)
- **Seats are counted for every role, and the waitlist is not split by role.** A TA or an instructor
  added while the section is full, or while students are waiting, is waitlisted like anyone else, and
  is promoted in the same order.
- **A newcomer cannot jump the queue, but the queue is only read, not locked.** Someone who joins the
  waitlist at the same instant a newcomer is checking can still be overtaken.
- **Without `createIfSeatFree`, the capacity check is not atomic.** It reads `countActive` and
  then creates, so two simultaneous enrollments into the last seat can both succeed. Provide
  `createIfSeatFree` if seats are strict. (A test pins this: without it, two simultaneous
  enrollments both take a one-seat section.)
- **Enrolling the same person twice at once is not guarded either.** Two simultaneous calls can
  both find no existing enrollment and each create one. A unique constraint on `(userId,
  sectionId)` for non-dropped enrollments in your database prevents it.
- **`countActive` decides what consumes a seat.** If your implementation counts staff
  as well as students, enrolling a TA uses a student seat.
- **Closing a section does not touch existing enrollments.** Archiving a section leaves its
  enrollments as they are; only *new* enrollments are refused.
- **Re-enrolling after a drop is refused once the section has closed**, even for someone who had
  a place before.
- **No events for status changes** other than enroll, drop and promotion.

## Tests

| File | Covers |
| --- | --- |
| `test/enrollment-permissions.test.ts` | every method with enforcement on: who may do what, role escalation, bulk rows, courses with no organization |
| `test/enrollment-tenancy.test.ts` | the tenant check (including strict handling of courses with no organization), bulk import with organization hints, cross-department enrollment |
| `test/atomic-repositories.test.ts` | capacity races with and without `createIfSeatFree`: one last seat taken once, ten people into three seats, bulk import, and unchanged behaviour without it |
| `test/enrollment-lifecycle.test.ts` | `drop` (idempotent, completed enrollments refused, unknown ids, with and without enforcement) and the section-status checks on `enroll` and `bulkEnroll` (draft, archived, `allowDraft`, ordering against the tenant check and the idempotent shortcut) |
| `test/enrollment-events.test.ts` | the two events, with and without a bus |
| `test/enrollment-waitlist.test.ts` | `promoteFromWaitlist` (order, free seats, raised capacity, idempotence, section status, races with and without `promoteIfSeatFree`, permissions and their ordering, the `enrollment.promoted` event), `promoteOnDrop`, and newcomers waiting behind the waitlist |
| `test/delegation.test.ts` | a TA with delegated rights enrolling students through this service |
