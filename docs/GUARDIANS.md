# Guardians

`GuardianLink` and the verification in `src/core/authorization.ts` — read-only
access for the parent or guardian of a student. Types and the verification live
in `discendo-sdk/core`.

Schools and other institutions with students under 18 need to let a parent see how
their child is doing without making the parent a member of the class. The SDK
models exactly that and no more: a guardian can **read**, within limits an
administrator chose, **only about their own ward**, and **only while that ward is
actually enrolled**.

## The model

A guardian is **not a role**. There is no `'guardian'` in `Role`, no guardian
enrollment, and no rule that mentions a guardian by role. What makes someone a
guardian of a particular student is a **link** between the two people:

```ts
type GuardianScope = 'grades' | 'attendance' | 'schedule';

interface GuardianLink {
  id: Id;
  guardianId: Id;
  wardId: Id;
  orgId?: Id;                    // the organization the link is valid in
  scopes: GuardianScope[];       // what the guardian may read
  status: 'active' | 'revoked';
  createdAt: Timestamp;
  revokedAt?: Timestamp;
}
```

- One link joins **one guardian to one ward**. A parent with two children has two
  links; a child with two guardians has two links, each with its own scopes.
- Only an `active` link counts. Revoking is a status change (and `revokedAt`), never
  a delete.
- `scopes` is what the administrator chose to share with *this* guardian.

### Scopes

Each scope opens exactly one read-only action:

| Scope | Opens | What it is for |
| --- | --- | --- |
| `grades` | `grading.view` | the ward's grades and final grade |
| `attendance` | `reporting.view` | the ward's attendance and reports |
| `schedule` | `scheduling.view` | the ward's class schedule |

A guardian can **never write anything**: the three actions above are the only ones
in the default rules that carry a `guardianScope`, and a test enforces that no
write action ever does.

## What a guardian can and cannot do

| Can | Cannot |
| --- | --- |
| read the ward's grades, if the link has `grades` | record, change or delete anything |
| read the ward's attendance, if the link has `attendance` | submit work or start a quiz attempt for the ward |
| read the ward's schedule, if the link has `schedule` | see another student's records, even in the same section |
| do all of this without being enrolled in anything | see content, rosters, discussions or attempt counts |
| | act once the ward has left the section |

Guardians read the **ward's own records**. They do not become a member of the class,
so they do not see course content, the roster or other students.

## How access is decided

When someone asks for a resource that belongs to another person (the `ownerId` is
not the actor), and your host supplied a `guardianLinks` repository,
`authorizeInSection` verifies the link. **All of these must hold**, and each is
checked by the SDK even if your repository returns something wrong:

1. `GuardianLinkRepository.findActive(actorId, ownerId)` returns a link.
2. The link is `active`.
3. The link names **this guardian** and **this ward**. A repository that answers
   with someone else's link grants nothing.
4. The link's `orgId` equals the course's organization (see
   [TENANCY.md](./TENANCY.md)).
5. The **ward is an active student in this section.** A guardian's access follows
   the ward's own enrollment, so it ends the moment the ward drops, is waitlisted,
   completes, or holds a different role there.
6. The rule for the action has a `guardianScope`, and the link includes it.
7. The policy itself re-checks that the ward is the resource's owner and that the
   actor is not "their own ward".

Failing any of these is simply a refusal. And the tenant check comes first, so a
guardian in one organization can never read in another.

## Wiring it up

Supply the repository; nothing else changes.

```ts
import type { GuardianLinkRepository } from 'discendo-sdk/core';

const guardianLinks: GuardianLinkRepository = {
  findActive: (guardianId, wardId) =>
    db.guardianLink.findFirst({ where: { guardianId, wardId, status: 'active' } }),
};

const repos = { users, courses, enrollments, content, terms, guardianLinks };

const grading = new GradingService(gradeRepo, bus, { policy, repos, submissions });

// The parent asks for their child's final grade:
const percent = await grading.computeFinalGradeForUser(
  child.id, sectionId, scheme,
  { actorId: parent.id },
);
```

Without `guardianLinks`, a guardian can read nothing, and nothing else is affected.

Creating and revoking links is **your code's job today**: write the rows through
your own repository. (The SDK has no link-management service yet; see the
limitations.)

## What works today

Scopes only matter where a service enforces the action behind them:

| Scope | Effective today? |
| --- | --- |
| `grades` | **Yes.** `GradingService.computeFinalGradeForUser` and `computeLetterGradeForUser` enforce `grading.view` |
| `attendance` | Only if you call the policy yourself. `ReportingService` does not enforce yet |
| `schedule` | Only if you call the policy yourself. `SchedulingService` does not enforce yet |

The scopes are still worth putting on links now: they take effect for each of those
actions the day its module starts enforcing.

## Announcements to guardians

Guardians get **their own channel**, separate from the one students read. If an
institution wants the same message in both, it sends it twice, and what a guardian
sees is only what the institution addressed to guardians. Guardians are tied to the
ward's enrollment, so they hear about the sections their ward is in. This is a
design decision for the communication module; it is **not built yet**, and a guardian
link does not give access to student announcements.

## Known limitations

- **No link-management service.** Nothing in the SDK creates, lists or revokes
  links, and there is no admin-only rule for it yet. You write the rows.
- **Three scopes only.** There is no scope for content or announcements.
- **Two of the three scopes are not enforced by a service yet** (see above).
- **Completed enrollments do not count**, so a guardian loses access when the ward
  completes a section. This follows the ward: if students are later given read-only
  access after completion, guardians will follow.
- **The SDK does not know anyone's age.** When a guardian's access should end (a
  ward turning 18, a custody change) is a decision for your application: revoke the
  link.
- **No events** are emitted when a link is created or revoked.

## Tests

| File | Covers |
| --- | --- |
| `test/core-permissions.test.ts` | the policy side: scopes, owner match, self-links, tenant check, overrides that drop the scope, and that no write action ever carries a scope |
| `test/grading-permissions.test.ts` | the service side: verification, revoked and cross-organization links, a repository returning the wrong link, following the ward's enrollment, failing closed with no repository |
| `test/assessment-permissions.test.ts` | a guardian gets nothing from the assessment actions |
