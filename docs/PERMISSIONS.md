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
| [communication](./COMMUNICATION.md) | yes, `postAnnouncement`, `listAnnouncements`, `reply`, `getThread` | `new CommunicationService(announcements, threads, sink, { enforcement: { policy, repos } })` |
| [scheduling](./SCHEDULING.md) | yes, every method of `SchedulingService` | `new SchedulingService(repo, recorder, bus, { enforcement: { policy, repos }, settings })` |
| [reporting](./REPORTING.md) | yes, `recordAttendance`, `listAttendanceForSession`, `attendanceForStudent` (`computeCompletionPercent` and `toCsv` are pure) | `new ReportingService(attendance, { sessions, enforcement: { policy, repos } })` |
| [admin](./ADMIN.md) | yes, `AdminService.history` and `audited` | `new AdminService(audit, { enforcement: { policy, repos } })` |

**Every module can now enforce.** Anything you build yourself, or an old route that bypasses these
services, still needs the policy called at your API boundary (see "Using the policy directly").

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
  Waitlisted, dropped and completed enrollments give no role (a completed student's
  read-only access is separate: see "After a student completes a section").
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
| `enrollment.promoteWaitlist` | admin, instructor | — | — | — |
| `enrollment.reviewRequest` | admin | — | — | — |
| `enrollment.grantRole.admin` | admin | — | — | — |
| `enrollment.grantRole.instructor` | admin | — | — | — |
| `enrollment.grantRole.ta` | admin, instructor | — | — | — |
| `enrollment.grantRole.student` | admin, instructor | — | — | yes |
| `content.view` | admin, instructor, ta, student | — | — | — |
| `content.manage` | admin, instructor | — | — | yes |
| `assessment.submit` | — | student | — | — |
| `assessment.startAttempt` | — | student | — | — |
| `assessment.answerQuiz` | — | student | — | — |
| `assessment.submitQuiz` | — | student | — | — |
| `assessment.viewAttempts` | admin, instructor, ta | student | — | — |
| `assessment.recordOffline` | admin, instructor | — | — | yes |
| `grading.record` | admin, instructor, ta | — | — | — |
| `grading.view` | admin, instructor, ta | student | grades | — |
| `communication.postAnnouncement` | admin, instructor | — | — | yes |
| `communication.postGuardianAnnouncement` | admin, instructor | — | — | — |
| `communication.viewAnnouncements` | admin, instructor, ta, student | — | — | — |
| `communication.viewGuardianAnnouncements` | admin, instructor, ta | — | announcements | — |
| `guardian.manageLinks` | admin | — | — | — |
| `guardian.viewLinks` | admin | admin, instructor, ta, student (their own links) | — | — |
| `guardian.listRecipients` | admin, instructor | — | — | — |
| `communication.participate` | admin, instructor, ta, student | — | — | — |
| `scheduling.view` | admin, instructor, ta, student | — | schedule | — |
| `scheduling.manage` | admin | — | — | — |
| `scheduling.manageOccurrence` | admin, instructor | — | — | yes |
| `scheduling.recordAttendance` | admin, instructor | — | — | yes |
| `scheduling.manageSettings` | admin | instructor (their own settings) | — | — |
| `scheduling.manageQualifications` | admin | — | — | — |
| `delegation.grant` | admin, instructor | — | — | — |
| `delegation.revoke` | admin, instructor | — | — | — |
| `delegation.view` | admin, instructor | ta | — | — |
| `reporting.recordAttendance` | admin, instructor | — | — | yes |
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
| **instructor** | enrolling and dropping, promoting people off the waitlist, granting `ta` and `student`, managing content, posting announcements, grading, viewing rosters, attempts, attendance, and delegating to TAs | — |
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

**Actions that belong to no section** (managing guardian links) use
`authorizeWithinOwnOrg` instead. It loads the actor, asks the policy in the **actor's own
organization** with no section (so only account-wide roles count: an `admin` of the
organization), and never involves a guardian link. The policy's tenant wall is then true by
construction, so **the service must compare every resource it touches with the actor's
organization**, which is what `assertInActorOrg` does (it refuses, as a plain
`PermissionDeniedError`, unless the resource's organization equals the actor's, with "no
organization" matching only "no organization").

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

## After a student completes a section

A student whose enrollment is `completed` keeps **read-only** access to **their own
grades** (`grading.view`) and to the **published content** (`content.view`), and
nothing else: no new submissions, no announcements or threads, no writes. A guardian of
that student follows, for the grades only. Dropped and waitlisted students keep nothing.

How it works, in three layers that all have to agree:

1. **The rule opts in.** `ActionRule.afterCompletion: true` is on exactly those two default
   rules (a test pins that only view actions carry it). Override a rule without the
   flag and the access is gone for that action.
2. **The service opts in.** `authorizeInSection(..., { afterCompletion: true })` is the only
   thing that puts a completed enrollment in the context, and only `GradingService` (the
   two view methods) and `ContentService` (`getNode`, `listNodes`) pass it. Every other
   action never sees it, so a custom policy gets no new data for them.
3. **Only students.** A completed TA or instructor gets nothing. `completedSectionRole`
   returns the role of a completed enrollment; the policy honors it only when it is
   `student`.

What a policy sees: `ctx.section.completedRole` (the completed role, only when the service
opted in) and `ctx.guardian.wardCompleted` (true when the ward is completed rather than
active). `ctx.section.role` stays `undefined` for a completed student. **A custom policy
that reads `ctx.guardian` itself must check `wardCompleted`**: it means "read-only access to
an action that is readable after completion", not the same as an active ward.

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

For your own routes, or anything that bypasses these services:

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

- **Enforcement is opt-in everywhere except delegation**, so a service built without it has no
  permission checks at all. In a deployment with real users, turn it on for every module.
- **A completed student keeps only two actions**: their own grades and the published
  content. Announcements, threads and a student's own attempt counts are not included
  (see [COMMUNICATION.md](./COMMUNICATION.md), [ASSESSMENT.md](./ASSESSMENT.md)). Widening
  it means adding `afterCompletion` to another view rule and making its service opt in.
- **Denials are not recorded by default.** A refusal throws; nothing is emitted or logged. Wrap
  calls with [`AdminService.audited(..., { recordDenials: true })`](./ADMIN.md) to write them to
  the audit log, or catch `PermissionDeniedError` yourself.
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
