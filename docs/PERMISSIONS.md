# Permissions

`src/core/permissions.ts` and `src/core/authorization.ts` — who may do what, and
how the services enforce it. Exported from `discendo-sdk/core`.

Permissions are **opt-in per service**. Construct a service without a policy and
it behaves exactly as it always did: no actor, no checks, your own API layer
decides. Construct it *with* a policy and it enforces: every call needs to say
who is acting, and anything the policy does not clearly allow is refused.

## Read this first: the SDK does not authenticate anyone

An enforcing service is told who is acting with an `{ actorId }`. **The SDK
trusts that id.** Authenticating the person (sessions, tokens, SSO) is your
application's job, and you must pass the id of the person who actually made the
request, never an id taken from request input. What the SDK does *not* trust is
anything else about the caller: it loads the actor from your `UserRepository` by
that id, so roles and organization are never taken from the call.

## Quick start

```ts
import { createRolePolicy } from 'discendo-sdk/core';
import { EnrollmentService } from 'discendo-sdk/enrollment';

const policy = createRolePolicy();            // the default rules, see below

const enrollment = new EnrollmentService(repos, bus, { policy });

// Every call now says who is acting.
await enrollment.enroll(
  { userId: 'stu-1', sectionId: 'sec-1', role: 'student' },
  { actorId: currentUser.id },                // the authenticated user
);
```

If `currentUser` is not allowed to do that, the call throws
`PermissionDeniedError` and nothing happens: nothing is written and no event is
emitted. Forget the actor and it throws `ActorRequiredError`; the call is never
allowed through without one.

### Mapping errors to responses

| Error | Meaning | Typical HTTP |
| --- | --- | --- |
| `PermissionDeniedError` | the policy said no, or the target could not be proven | 403 |
| `ActorRequiredError` | a bug in your code: you called an enforcing service without an actor | 500 |
| `TenantMismatchError` | something from one organization was used with another's (see [TENANCY.md](./TENANCY.md)) | 403 or 400 |

`PermissionDeniedError` carries the `action` it refused. Its message ("Not
permitted: grading.record") deliberately says nothing about *why*.

## Which modules enforce today

| Module | Enforces | How you turn it on |
| --- | --- | --- |
| [enrollment](./ENROLLMENT.md) | yes, every method | `new EnrollmentService(repos, bus, { policy })` |
| [grading](./GRADING.md) | yes, `recordGrade` and both final-grade methods | `new GradingService(grades, bus, { policy, repos, submissions })` |
| [assessment](./ASSESSMENT.md) | yes, all three methods | `new AssessmentService(subs, quizzes, hook, bus, { policy, repos })` |
| [delegation](./DELEGATION.md) | always (it has no unenforced mode) | `new DelegationService(repos, { policy })` |
| [content](./CONTENT.md) | yes, `createNode`, `publish`, `reorder`, `getNode`, `listNodes` (`isUnlocked` is a pure check) | `new ContentService(repos, completion, edges, bus, { policy })` |
| [communication](./COMMUNICATION.md) | not yet | `communication.postAnnouncement`, `communication.participate` exist |
| [scheduling](./SCHEDULING.md) | not yet | `scheduling.view`, `scheduling.manage` exist |
| [reporting](./REPORTING.md) | not yet | `reporting.recordAttendance`, `reporting.view` exist |
| [admin](./ADMIN.md) | not yet | `admin.viewAuditLog` exists |

For the modules that do not enforce yet, call the policy yourself at your API
boundary (see "Using the policy directly").

Every enforcing service follows the same discipline, so what you learn here
transfers: authorization comes first, before anything about the target is looked up
or any limit is checked, so a refused caller learns nothing.

## Roles

```ts
type Role = 'student' | 'instructor' | 'ta' | 'admin';
```

There are two places a role can come from, and they mean different things:

- **`Enrollment.role`** is what someone is *inside one section*. Every action that
  targets a section uses this, and **only an `active` enrollment counts**.
  Waitlisted, dropped and completed enrollments give no role.
- **`Identity.roles`** is account-wide. For an action that targets a section, only
  `admin` is honoured from here: a global "instructor" does not get to manage every
  section, only the ones they are enrolled in as an instructor. For actions with no
  section, `Identity.roles` are used as they are.

A **guardian** is not a role; see [GUARDIANS.md](./GUARDIANS.md).

## The default rules

`DEFAULT_RULES` maps each action to a rule. This table is the whole of the default
policy.

| Action | Roles | Own resource only | Guardian scope | Delegable |
| --- | --- | --- | --- | --- |
| `enrollment.enroll` | admin, instructor | — | — | yes |
| `enrollment.bulkEnroll` | admin | — | — | — |
| `enrollment.drop` | admin, instructor | student | — | — |
| `enrollment.viewRoster` | admin, instructor, ta | — | — | — |
| `enrollment.grantRole.admin` | admin | — | — | — |
| `enrollment.grantRole.instructor` | admin | — | — | — |
| `enrollment.grantRole.ta` | admin, instructor | — | — | — |
| `enrollment.grantRole.student` | admin, instructor | — | — | yes |
| `content.view` | admin, instructor, ta, student | — | — | — |
| `content.manage` | admin, instructor | — | — | yes |
| `assessment.submit` | — | student | — | — |
| `assessment.startAttempt` | — | student | — | — |
| `assessment.viewAttempts` | admin, instructor, ta | student | — | — |
| `assessment.recordOffline` | admin, instructor | — | — | yes |
| `grading.record` | admin, instructor, ta | — | — | — |
| `grading.view` | admin, instructor, ta | student | grades | — |
| `communication.postAnnouncement` | admin, instructor | — | — | yes |
| `communication.participate` | admin, instructor, ta, student | — | — | — |
| `scheduling.view` | admin, instructor, ta, student | — | schedule | — |
| `scheduling.manage` | admin | — | — | — |
| `delegation.grant` | admin, instructor | — | — | — |
| `delegation.revoke` | admin, instructor | — | — | — |
| `delegation.view` | admin, instructor | ta | — | — |
| `reporting.recordAttendance` | admin, instructor, ta | — | — | — |
| `reporting.view` | admin, instructor, ta | student | attendance | — |
| `admin.viewAuditLog` | admin | — | — | — |

### Reading a rule

```ts
interface ActionRule {
  roles?: readonly Role[];        // may always do it
  ownRoles?: readonly Role[];     // may do it only to their OWN resource
  guardianScope?: GuardianScope;  // a guardian with this scope on a verified link may do it
  delegable?: boolean;            // an instructor may hand it to a TA
}
```

- **`roles`**: anyone holding one of these roles (in the section, or `admin`
  account-wide) may do it.
- **`ownRoles`**: a person with one of these roles may do it only when
  `resourceOwnerId` is their own id. This is how a student sees *their* grade but
  not a classmate's. If the owner is unknown, an own-only rule denies.
- **`guardianScope`**: see [GUARDIANS.md](./GUARDIANS.md). Only read-only actions
  carry one.
- **`delegable`**: see [DELEGATION.md](./DELEGATION.md).

`enrollment.grantRole.<role>` is a family of actions: **enrolling someone with a
role needs `enrollment.enroll` *and* `enrollment.grantRole.<that role>`**. That is
what stops an instructor from enrolling someone as an admin, or a TA with delegated
enrolling from creating other TAs.

### The hierarchy

Role-based rights are nested, and a test pins it:

> student ⊆ ta ⊆ instructor ⊆ admin

Everything a student may do *by role* a TA may do too, and so on up. Rights that
come from owning a resource (the "Own resource only" column) sit outside that
ordering: a student may see their own grades, a TA is not a student. A policy you
build with `overrides` is free to break the nesting; the default table never does.

### In plain words

| Role | By role | On their own resource |
| --- | --- | --- |
| **admin** | everything below, plus bulk enrollment, granting the admin and instructor roles, managing schedules, reading the audit log | — |
| **instructor** | enrolling and dropping, granting `ta` and `student`, managing content, posting announcements, grading, viewing rosters, attempts, attendance, and delegating to TAs | — |
| **ta** | viewing rosters, grading, viewing attempts, attendance, content, schedules and the discussion; plus whatever an instructor has delegated | viewing their own delegations |
| **student** | viewing content and schedules, taking part in discussion | dropping, submitting, starting attempts, viewing attempts, grades and attendance |

## How a decision is made

For an enforced call the service runs `authorizeInSection`, which does the work
in a fixed order, and **every step fails closed**:

1. **An actor was supplied**, or `ActorRequiredError`.
2. **A target section was named**, or `PermissionDeniedError`.
3. **The actor exists** in `UserRepository`, or `PermissionDeniedError`.
4. **The section and its course exist**, or `PermissionDeniedError`. (The course is
   needed to know the organization.)
5. **The facts are gathered**: the actor's enrollment and its role, a TA's verified
   delegations, and a guardian's verified link.
6. **The policy is asked.** Inside the default policy:
   1. the actor's organization must equal the resource's (never skipped, so not even
      an admin acts across organizations);
   2. then the rule for the action is looked up, and an action with no rule is denied;
   3. then, in order: `roles`, then `ownRoles` against the owner, then a delegated
      grant (a TA, a `delegable` rule), then a guardian link (a rule with a scope).
7. **Only an exact `true` allows.** A policy that returns anything else, or throws,
   means the action does not happen.

`authorizeInSection` returns the context it authorized. Services that keep unpublished
material away from everyone but staff (assessment and content) pass it to
`isStaff(ctx)`, which is true for an admin, instructor or TA **of that section** (a
student, a guardian and a person with no role there are not staff).

Two properties follow from this and are worth relying on:

- **A missing target is a denial, not "not found", for every actor.** An unknown
  section, enrollment, submission or content item is refused with the same
  `PermissionDeniedError` as a forbidden one, with the same message, so nobody can
  use the SDK to probe which ids exist.
- **Authorization happens before everything else.** The enrollment shortcut, the
  attempt limit, the "already graded" check: none of them run for someone who may
  not make the call, so none of them can leak information.

### The context a policy receives

```ts
interface PermissionContext {
  actor: Identity;
  section?: { role?: Role; delegated?: readonly Action[] };
  resourceOrgId: Id | undefined;     // required; undefined = "belongs to no organization"
  resourceOwnerId?: Id;
  guardian?: { wardId: Id; scopes: readonly GuardianScope[] };
}
```

`section.delegated` and `guardian` arrive **already verified**; the policy does not
look anything up. `resourceOrgId` is a required key so a caller cannot forget it,
and a JavaScript caller that omits it is treated as saying "no organization", which
fails closed.

## Customizing

### Overriding rules

```ts
const policy = createRolePolicy({
  overrides: {
    // TAs may post announcements; they could not before.
    'communication.postAnnouncement': { roles: ['admin', 'instructor', 'ta'] },
    // A rule of your own for a feature of yours.
    'library.borrow': { roles: ['student', 'instructor'] },
    // Nobody may drop (an empty rule denies everyone).
    'enrollment.drop': {},
  },
});
```

- **An override *replaces* the default rule for that action; it is not merged.**
  The example above takes `delegable` away from `communication.postAnnouncement`,
  because the new rule does not say `delegable: true`. Restate anything you want
  to keep.
- You can add actions of your own. Any string is an action.
- **A misspelt action name is not an error.** `'grading.recrod'` simply adds a rule
  nobody ever asks for, and the real `grading.record` keeps its default. Check the
  spelling against the table above.
- The returned policy also exposes `delegableActions`, the actions whose (final)
  rule is `delegable`.

### Writing your own policy

`PermissionPolicy` is one method, and it may be async, so you can look things up
(attribute-based rules, time of day, a feature flag):

```ts
import type { PermissionPolicy } from 'discendo-sdk/core';

const officeHours: PermissionPolicy = {
  async can(action, ctx) {
    if (action === 'grading.record' && !(await withinOfficeHours())) return false;
    return base.can(action, ctx);          // fall back to the default rules
  },
};
```

You receive the already-verified context, so you do not need to look up the
actor, their enrollment or their links. Remember the contract: **only an exact
`true` allows**, a thrown error stops the action, and a policy that does not
declare `delegableActions` makes nothing delegable.

### Using the policy directly

For the modules that do not enforce yet, or for your own routes:

```ts
import { authorize, activeSectionRole } from 'discendo-sdk/core';

const membership = await repos.enrollments.findByUserAndSection(user.id, sectionId);
await authorize(policy, 'content.manage', {
  actor: user,
  section: { role: activeSectionRole(membership) },
  resourceOrgId: course.orgId,
});
// throws PermissionDeniedError unless allowed
```

`authorize(policy, action, ctx)` throws unless the policy returns exactly `true`.
`activeSectionRole(enrollment)` returns the role of an `active` enrollment and
`undefined` otherwise. `effectiveRoles(ctx)` returns the roles that count for a
context.

## Adding enforcement to a module

This is the checklist the existing services follow, for anyone extending the SDK.

1. **Give every public method an action** in `DEFAULT_RULES`, and add an optional
   trailing `actor?: ActorContext` parameter.
2. **Make enforcement opt-in** through the constructor (`{ policy, repos }`), and
   when it is on make `actor` mandatory.
3. **Never take the section from the caller.** Find it from something you trust (a
   content node, a submission) so a caller cannot name a section they are allowed in
   while acting on another.
4. **Call `authorizeInSection` first**, before any lookup, limit or existence check.
   A target that cannot be found must produce the same `PermissionDeniedError` as a
   forbidden one.
5. **Pass `ownerId`** whenever the resource belongs to a person, so "own" rules and
   guardian links work.
6. **Write the tests first**, then break the code on purpose (mutation testing) and
   confirm each break fails a test. Every enforcing module in the SDK was built
   this way.

## Known limitations

- **Four modules do not enforce yet** (see the table above). The rules exist, the
  wiring does not.
- **Completed enrollments grant nothing.** Today a student whose enrollment is
  `completed` can no longer view their own grades or content. Read-only access
  after completion is planned.
- **Denials are not recorded.** A refusal throws; nothing is emitted or logged. Wrap
  calls with [`withAudit`](./ADMIN.md) or catch `PermissionDeniedError` yourself.
- **No department-scoped roles.** An admin is an admin of the whole organization.
- **The actor id is trusted** (see the top of this page).

## Tests

| File | Covers |
| --- | --- |
| `test/core-permissions.test.ts` | the policy: every rule, tenant check in both directions, `ownRoles`, guardian and delegated paths, overrides, the role hierarchy, `authorize`, `activeSectionRole`, `effectiveRoles` |
| `test/enrollment-permissions.test.ts` | enforcement in `EnrollmentService` |
| `test/grading-permissions.test.ts` | enforcement in `GradingService`, including guardians |
| `test/assessment-permissions.test.ts` | enforcement in `AssessmentService` |
| `test/delegation.test.ts` | `DelegationService` and delegated grants taking effect |
