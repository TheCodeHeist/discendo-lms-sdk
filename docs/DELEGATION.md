# Delegation

`src/domains/delegation/` — lets an instructor (or an admin) hand some of their own
permissions to a teaching assistant in one section, and take them back at any time.
Subpath: `discendo-sdk/delegation`. The `TaGrant` type and the repository interface
live in `core`.

A TA starts with the TA defaults (viewing rosters, grading, attendance). Courses
differ in how much they trust their TAs: one instructor wants a TA to post
announcements, another wants one to enroll late students. Delegation lets the
instructor decide, per TA and per section, without anyone editing the policy.

## At a glance

| | |
| --- | --- |
| **You import** | `DelegationService`, `ActionNotDelegableError`, `NotAnActiveTaError` |
| **You implement** | `DelegationRepository` (`create`, `findById`, `listActiveForEnrollment`, `revoke`) |
| **Needs from `core`** | `users`, `courses`, `enrollments` (and `delegations`) |
| **Emits events** | none yet |
| **Permission actions** | `delegation.grant`, `delegation.revoke`, `delegation.view` |
| **Enforcement** | always on: the service requires a policy and an actor on every call |

## The model

```ts
interface TaGrant {
  id: Id;
  enrollmentId: Id;      // the TA's enrollment, not the person
  sectionId: Id;
  action: string;        // e.g. 'content.manage'
  grantedBy: Id;
  grantedAt: Timestamp;
  revokedAt?: Timestamp; // set when revoked
}
```

Three ideas carry the whole feature.

**A grant belongs to an enrollment, not a person.** It is tied to the TA's
enrollment in one section. When that enrollment ends and the person is enrolled
again, the new enrollment is a new record, and it starts with no grants. A TA who
is dropped and brought back does not quietly regain what they had.

**Only some actions can be delegated.** An action is delegable only if its rule says
`delegable: true`. A stored grant for any other action does nothing, however it got
there. The built-in delegable actions are:

| Action | What it lets the TA do |
| --- | --- |
| `content.manage` | manage the section's content |
| `communication.postAnnouncement` | post announcements |
| `enrollment.enroll` | enroll people (see below) |
| `enrollment.grantRole.student` | grant the `student` role |
| `assessment.recordOffline` | record work a student did offline (see [ASSESSMENT.md](./ASSESSMENT.md)) |
| `scheduling.manageOccurrence` | cancel or move a class, and run the planning checks (see [SCHEDULING.md](./SCHEDULING.md)) |
| `scheduling.recordAttendance` | take attendance for a class (see [SCHEDULING.md](./SCHEDULING.md)) |
| `reporting.recordAttendance` | take attendance for a session through the reporting module (see [REPORTING.md](./REPORTING.md)) |

Enrolling someone needs **both** `enrollment.enroll` *and* the grant for the role
being given, so a TA given both of the last two can enroll **students** and nothing
else. They cannot enroll a TA, an instructor or an admin, and they cannot bulk
enroll, drop anyone, or delegate onwards. Everything not on this list, such as
`enrollment.bulkEnroll`, `enrollment.promoteWaitlist`, `scheduling.manage`, the scheduling settings and the delegation actions themselves,
can never be delegated.

**Permissions never grow downwards.** An instructor can only hand over an action
they hold themselves in that section. A TA with delegated rights cannot grant
anything: `delegation.grant` is for admins and instructors only.

## `DelegationService`

```ts
new DelegationService(repos, { policy, delegableActions? })
```

- `repos`: the authorization repositories (`users`, `courses`, `enrollments`) plus
  `delegations`.
- `policy`: **required**. Delegation makes no sense without permission checks, so
  every method needs an actor.
- `delegableActions`: the actions that may be delegated. By default the service
  reads `policy.delegableActions`, which `createRolePolicy` provides from its rules.
  With any other policy that does not declare them, **nothing is delegable** unless
  you list them here.

### `grant(sectionId, taUserId, action, actor)`

Gives `taUserId` the right to do `action` in `sectionId`. Returns the `TaGrant`.

The checks run in this order, and a failure stops the call before anything is stored:

1. the actor may `delegation.grant` in this section (an instructor of it, or an
   admin), or `PermissionDeniedError`;
2. the action is delegable, or `ActionNotDelegableError`;
3. the actor holds the action themselves in this section, or `PermissionDeniedError`;
4. the target is an **active TA of this section**, or `NotAnActiveTaError`.

Granting the same action to the same TA twice is **idempotent**: the first grant is
returned and nothing new is stored. After a revoke, granting again creates a fresh
grant.

```ts
await delegation.grant('sec-1', 'ta-jane', 'enrollment.enroll', { actorId: teacher.id });
await delegation.grant('sec-1', 'ta-jane', 'enrollment.grantRole.student', { actorId: teacher.id });
// 'ta-jane' can now enroll students into sec-1, and nothing else new.
```

### `revoke(grantId, actor)`

Takes a grant back by setting `revokedAt`. It needs `delegation.revoke` in the
grant's section. Revoking an already revoked grant changes nothing and returns it.
An **unknown grant is refused exactly like a forbidden one**, with the same
`PermissionDeniedError` message, so ids cannot be probed. The effect is immediate:
the next call by that TA no longer sees the grant.

### `list(sectionId, taUserId, actor)`

The **active** grants of one TA in a section. Admins and instructors may list
anyone's; a TA may list their own (`delegation.view`). If `taUserId` is not an active
TA of the section the result is an empty list.

## How a grant takes effect

You do nothing extra. When a TA calls an enforcing service,
`authorizeInSection` looks up their grants (only for an active TA, and only if your
host supplied the `delegations` repository), re-checks what comes back, and passes
the verified action names to the policy. The policy lets the TA through only if the
action's rule is `delegable` *and* the grant is there.

```ts
// Before the grant:
await enrollment.enroll(newStudent, { actorId: 'ta-jane' });   // PermissionDeniedError

// After the instructor grants 'enrollment.enroll' and 'enrollment.grantRole.student':
await enrollment.enroll(newStudent, { actorId: 'ta-jane' });   // allowed

// After the instructor revokes either one:
await enrollment.enroll(newStudent, { actorId: 'ta-jane' });   // PermissionDeniedError again
```

The check that a repository's answer is honest is deliberate: a grant counts only if
it belongs to **this** enrollment, **this** section, and is **not revoked**. A
repository that returns another TA's grants, another section's, or a revoked one,
gives the TA nothing.

## The repository

```ts
interface DelegationRepository {
  create(grant: Omit<TaGrant, 'id'>): Promise<TaGrant>;
  findById(id: Id): Promise<TaGrant | null>;
  listActiveForEnrollment(enrollmentId: Id): Promise<TaGrant[]>;   // not revoked
  revoke(id: Id, at: Date): Promise<TaGrant>;                      // sets revokedAt
}
```

Supply it as `RepositoryContext.delegations`. Without it a TA only has the TA
defaults. Revoked grants should be **kept**, not deleted, so the history of who
granted what remains.

`EnrollmentRepository.findByUserAndSection` must return the **most recent** record
for a person and section, because that is what decides which enrollment a TA's grants
belong to.

## Errors

| Error | Meaning |
| --- | --- |
| `ActorRequiredError` | called without an `{ actorId }` |
| `PermissionDeniedError` | the actor may not delegate here, does not hold the action, or the section or grant is unknown |
| `ActionNotDelegableError` | the action is not on the delegable list (`.action` holds it) |
| `NotAnActiveTaError` | the target is not currently an active TA in that section |

`ActionNotDelegableError` and `NotAnActiveTaError` are raised only **after** the actor
has been authorized, so an unauthorized caller learns nothing from them.

## Making an action delegable

Mark it in a rule override:

```ts
const policy = createRolePolicy({
  overrides: {
    'myfeature.moderate': { roles: ['admin', 'instructor'], delegable: true },
  },
});
policy.delegableActions;   // includes 'myfeature.moderate'
```

Remember an override *replaces* the default rule, so restate `delegable: true` if you
override one of the built-in delegable actions.

## Known limitations

- **`communication.postAnnouncement` covers the students' channel only.** Posting to
  guardians (`communication.postGuardianAnnouncement`) is never delegable.
- **No events.** Granting and revoking emit nothing.
- **No expiry.** A grant lasts until it is revoked or the TA's enrollment ends.
- **`list` shows only active grants.** The revoked history is in your repository, but
  the service does not return it.
- **Grants outlive their grantor's role.** If the instructor who granted something
  later leaves the section, the grants stay until someone revokes them.
- **One TA at a time.** There is no "list every TA's grants in this section" method.

## Tests

`test/delegation.test.ts` covers the service (who may grant, revoke and list; every
refusal; idempotency; the not-delegable and not-held rules; the target checks) and the
effect of grants through `EnrollmentService`: both grants needed, students only,
nothing else gained, per-TA and per-section isolation, revocation, a re-enrolled TA
starting empty, and a repository returning the wrong grants. The policy side is in
`test/core-permissions.test.ts` ("delegated actions").
