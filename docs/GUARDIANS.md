# Guardians

`GuardianLink`, the verification in `src/core/authorization.ts`, and `GuardianService` —
read-only access for the parent or guardian of a student, and the admin-only service that
creates and ends it. Types and the verification live in `discendo-sdk/core`; the service is
in `discendo-sdk/guardians`.

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
type GuardianScope = 'grades' | 'attendance' | 'schedule' | 'announcements';

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
| `announcements` | `communication.viewGuardianAnnouncements` | the announcements addressed to guardians |

A guardian can **never write anything**: the four actions above are the only ones
in the default rules that carry a `guardianScope`, and a test enforces that no
write action ever does.

## What a guardian can and cannot do

| Can | Cannot |
| --- | --- |
| read the ward's grades, if the link has `grades` | record, change or delete anything |
| read the ward's attendance, if the link has `attendance` | submit work or start a quiz attempt for the ward |
| read the ward's schedule, if the link has `schedule` | see another student's records, even in the same section |
| read the guardian announcements for the ward's sections, if the link has `announcements` | see content, rosters, discussions or attempt counts |
| do all of this without being enrolled in anything | read the announcements addressed to students |
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

Reading only needs `GuardianLinkRepository` (the one method above). To create, change and
revoke links with the SDK, implement `GuardianLinkManagementRepository` as well and use
`GuardianService` (next section); without it, writing the rows is your own code's job.

## Managing links: `GuardianService`

```ts
import { GuardianService } from 'discendo-sdk/guardians';
import type { GuardianLinkManagementRepository } from 'discendo-sdk/core';

const guardianLinks: GuardianLinkManagementRepository = {
  findActive: (guardianId, wardId) => db.guardianLink.findFirst({ where: { guardianId, wardId, status: 'active' } }),
  create: (link) => db.guardianLink.create({ data: link }),
  findById: (id) => db.guardianLink.findUnique({ where: { id } }),
  update: (id, patch) => db.guardianLink.update({ where: { id }, data: patch }),
  listByWard: (wardId) => db.guardianLink.findMany({ where: { wardId } }),
  listByGuardian: (guardianId) => db.guardianLink.findMany({ where: { guardianId } }),
};

const guardians = new GuardianService({ users, courses, enrollments, guardianLinks }, { policy });

const link = await guardians.createLink(parent.id, child.id, ['grades', 'announcements'], { actorId: admin.id });
```

The service **always enforces** (there is no unenforced mode): every method needs an
`{ actorId }` and the policy's say-so.

| Method | Action | Who |
| --- | --- | --- |
| `createLink(guardianId, wardId, scopes, actor)` | `guardian.manageLinks` | admins of the organization, **never delegable** |
| `updateScopes(linkId, scopes, actor)` | `guardian.manageLinks` | the same |
| `revokeLink(linkId, actor)` | `guardian.manageLinks` | the same |
| `listWards(guardianId, actor)` | `guardian.viewLinks` | admins, or the guardian themselves for their own links |
| `guardiansOfSection(sectionId, scope, actor)` | `guardian.listRecipients` | admins, and the instructors of that section |

**`createLink`**: both people must exist **in the acting admin's organization**, and must be
different people. A person who does not exist and one in another organization give the same
`GuardianLinkTargetError`, so an admin cannot probe another organization. Scopes must be a
non-empty list of known scopes (duplicates are dropped, the order kept), or
`InvalidGuardianLinkError`. The link's `orgId` is the ward's, never the caller's, and is absent
when nobody has an organization. **At most one link can be active per guardian and ward**: a
second is refused with `GuardianLinkExistsError` (carrying `linkId`); use `updateScopes`. A link
belongs to the person, not to a section, so the ward may be in no section, or a dropped one.

**`updateScopes`** replaces the scopes of an *active* link at once; the guardian's access
follows. A revoked link cannot be changed (create a new one). **`revokeLink`** ends access at
once, stamps `revokedAt` and keeps the record; revoking again changes nothing, not even the
time. For both, a link of another organization and one that does not exist give the same
`GuardianLinkNotFoundError`.

**`listWards`** returns the guardian's *active* links, so a guardian knows which `wardId` to
name when reading announcements. Revoked links and links of another organization are left out,
and a guardian who does not exist, or is in another organization, gives `[]`.

**`guardiansOfSection(sectionId, scope, actor)`** is the list to notify for a guardian
announcement: one `{ guardianId, wardIds }` per guardian, in the order the section's roster
gives, for guardians whose **active** link carries `scope`, in the course's organization, and
whose ward is an **active student** of the section. That is the rule reading applies, so nobody
is notified who could not read the message. Dropped, waitlisted and completed wards are left
out. It does one link lookup per student, and needs an actor, so a queued job must carry the
person who posted (an instructor or admin) or an admin. The permission check comes before
anything is read.

Nothing is created, changed or revoked for a refused call, and no events are emitted yet.

## What works today

Scopes only matter where a service enforces the action behind them:

| Scope | Effective today? |
| --- | --- |
| `grades` | **Yes.** `GradingService.computeFinalGradeForUser` and `computeLetterGradeForUser` enforce `grading.view` |
| `attendance` | **Yes.** `ReportingService.attendanceForStudent(sectionId, wardId, actor)` enforces `reporting.view` |
| `schedule` | **Yes.** `SchedulingService.listOccurrences(sectionId, from, to, actor, { wardId })` enforces `scheduling.view` |
| `announcements` | **Yes.** `CommunicationService.listAnnouncements(sectionId, actor, { wardId })` enforces `communication.viewGuardianAnnouncements` |

The scopes are still worth putting on links now: they take effect for each of those
actions the day its module starts enforcing.

## Announcements to guardians

Guardians get **their own channel**, separate from the one students read. If an
institution wants the same message in both, it sends it twice, and what a guardian
sees is only what the institution addressed to guardians. Guardians are tied to the
ward's enrollment, so they hear about the sections their ward is in, and **only while
the ward is an active student there**.

This is built in `CommunicationService` (see [COMMUNICATION.md](./COMMUNICATION.md)):

- **Posting** to guardians needs `communication.postGuardianAnnouncement`: admins and
  instructors only, and not delegable to a TA.
- **Reading** needs a verified link with the `announcements` scope. The guardian names
  the ward (`listAnnouncements(sectionId, actor, { wardId })`), because one guardian
  can have several wards, and gets only the guardian channel. A link without the scope,
  or a ward who has dropped the section, gets nothing, and a guardian never reads the
  students' channel.
- The notification for a guardian announcement carries `audience: 'guardians'`, so your
  sink can send it to guardians only.

## Known limitations

- **Whole-organization admins only.** Any admin of the organization can manage any link in it;
  department-scoped admins are not built.
- **No bulk import.** Links are created one at a time (a school with a roster of guardians
  loops over `createLink`, and gets one error per bad row to handle).
- **Create, update and revoke are not atomic.** Two admins creating the same link at the same
  moment can both pass the duplicate check; make the repository's `create` enforce one active link
  per guardian and ward if that matters.
- **Nobody is told when a link changes.** The guardian is not notified of a new, changed or revoked
  link, and the ward is never told.
- **Four scopes only.** There is no scope for content.
- **All four scopes are enforced by a service.** Each is read-only, and each follows the ward's enrollment.
- **A guardian follows the ward through completion, for the grades only.** While the ward
  is an active student a guardian gets every action their scopes open; once the ward has
  *completed* the section they keep the grades (`grading.view`, with the `grades` scope) and
  lose the rest (attendance, schedule, guardian announcements). A ward who dropped or is
  waitlisted gives a guardian nothing.
- **The SDK does not know anyone's age.** When a guardian's access should end (a
  ward turning 18, a custody change) is a decision for your application: revoke the
  link.
- **No events** are emitted when a link is created, changed or revoked (planned for the events round).

## Tests

| File | Covers |
| --- | --- |
| `test/guardians.test.ts` | `GuardianService`: who may manage and list, the organization wall in both directions and with no organizations, self-links, scope validation, one active link per pair, update and revoke (including idempotence), the guardian's own listing, and `guardiansOfSection` (scope, active wards only, revoked and foreign links, agreement with the read side), plus end-to-end checks that a created, changed or revoked link changes what the read side allows |
| `test/core-authorization-org.test.ts` | `authorizeWithinOwnOrg` and `assertInActorOrg` |
| `test/core-permissions.test.ts` | the policy side: scopes (including that `announcements` opens only the guardian channel), owner match, self-links, tenant check, overrides that drop the scope, and that no write action ever carries a scope |
| `test/communication-permissions.test.ts` | the guardian channel in `CommunicationService`: scope, ward, active enrollment, wrong ward, other organization |
| `test/grading-permissions.test.ts` | the service side: verification, revoked and cross-organization links, a repository returning the wrong link, following the ward's enrollment, failing closed with no repository |
| `test/assessment-permissions.test.ts` | a guardian gets nothing from the assessment actions |
