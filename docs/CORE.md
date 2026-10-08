# Core

`src/core/` — the shared vocabulary every other module is built on: the common
types, the repository interfaces a host implements, the event bus, and the
tenancy and permission machinery. Subpath: `discendo-sdk/core`.

`core` imports nothing else in the SDK, and every other module may import
`core` (and nothing but `core` and itself). That rule is what lets a host adopt
one module without pulling in the rest, and `test/architecture.test.ts`
enforces it.

This page covers the types and the repository interfaces. The larger pieces
that live in `core` have their own pages:

| Piece | File | Page |
| --- | --- | --- |
| Event bus and the event catalog | `events.ts` | [EVENTS.md](./EVENTS.md) |
| Organizations and departments | `tenancy.ts` | [TENANCY.md](./TENANCY.md) |
| Roles, rules, policies and enforcement | `permissions.ts`, `authorization.ts` | [PERMISSIONS.md](./PERMISSIONS.md) |
| Guardian links | `types.ts`, `authorization.ts` | [GUARDIANS.md](./GUARDIANS.md) |
| TA grants | `types.ts`, `authorization.ts` | [DELEGATION.md](./DELEGATION.md) |

## File inventory

| File | What it holds |
| --- | --- |
| `types.ts` | `Id`, `Timestamp`, `Role`, `Identity`, `Organization`, `Department`, `Course`, `CourseSection`, `Enrollment`, `ContentNode`, `AcademicTerm`, `GuardianLink`, `TaGrant` |
| `repositories.ts` | The repository interfaces and the `RepositoryContext` bundle |
| `events.ts` | `EventBus` and every `LmsEvent` variant |
| `tenancy.ts` | `sameOrg`, `assertSameOrg`, `assertCourseDepartment`, `TenantMismatchError`, `UnknownDepartmentError` |
| `permissions.ts` | `DEFAULT_RULES`, `createRolePolicy`, `authorize`, `activeSectionRole`, `effectiveRoles`, `PermissionDeniedError`, `ActorRequiredError` |
| `authorization.ts` | `authorizeInSection`, the one function every enforcing service goes through |

## Types (`types.ts`)

### `Id` and `Timestamp`

`Id` is `string`, `Timestamp` is `Date`. Every timestamp the SDK produces or
reads is UTC; converting for display is the host's job, at the edge.

### `Role`

```ts
type Role = 'student' | 'instructor' | 'ta' | 'admin';
```

Four roles, and nothing else. In particular **a guardian is not a role**: a
guardian is someone with a `GuardianLink` to a student (see
[GUARDIANS.md](./GUARDIANS.md)). A `Role` can live in two places and they mean
different things: `Enrollment.role` is what someone is *inside one section*, and
`Identity.roles` is what they are account-wide. Only account-wide `admin` is
honoured when an action targets a section. See [PERMISSIONS.md](./PERMISSIONS.md).

### `Identity`

```ts
interface Identity {
  id: Id;
  externalRef?: string;   // the host's own user record, if different
  roles: Role[];
  orgId?: Id;             // the organization this person belongs to
}
```

What the SDK knows about a person. It is deliberately thin: names, emails and
credentials are the host's business. Services that enforce permissions load the
`Identity` from `UserRepository` by id and never trust roles or an organization
passed in by a caller.

### `Course` and `CourseSection`

A `Course` is a template ("Intro to Physics"). A `CourseSection` is one running
instance of it ("Intro to Physics, Fall 2026, Section B") with its own term,
capacity and status. They stay separate on purpose, because merging them is the
most common regret in LMS data models.

```ts
interface Course {
  id: Id;
  title: string;
  description?: string;
  orgId?: Id;          // owner organization (see TENANCY.md)
  departmentId?: Id;   // optional grouping inside the organization
}

interface CourseSection {
  id: Id;
  courseId: Id;
  termId?: Id;
  capacity?: number;   // unset = unlimited
  status: 'draft' | 'published' | 'archived';
}
```

Sections, enrollments and content do not repeat the organization; they inherit it
through their course.

### `Enrollment` and `EnrollmentStatus`

```ts
type EnrollmentStatus = 'active' | 'waitlisted' | 'dropped' | 'completed';

interface Enrollment {
  id: Id;
  userId: Id;
  sectionId: Id;
  role: Role;
  status: EnrollmentStatus;
  enrolledAt: Timestamp;
  droppedAt?: Timestamp;
}
```

Enrollments are never deleted: dropping flips `status` and sets `droppedAt`.
**Only an `active` enrollment grants a role.** Waitlisted, dropped and completed
enrollments give no role in permission checks (`activeSectionRole`). The one exception
is read-only: a `completed` student keeps their own grades and the published content
(see [PERMISSIONS.md](./PERMISSIONS.md)). A person can
end up with several records for one section (dropped, then enrolled again), which is
why `EnrollmentRepository.findByUserAndSection` must return the most recent.

### `ContentNode` and `ContentKind`

```ts
type ContentKind = 'page' | 'assignment' | 'quiz' | 'file' | 'link';

interface ContentNode {
  id: Id;
  sectionId: Id;
  kind: ContentKind;
  title: string;
  parentId?: Id;       // content is a tree
  orderIndex: number;
  published: boolean;
  version: number;
}
```

### `AcademicTerm`

`{ id, name, startsAt, endsAt, orgId? }`. Terms may carry an organization, since
a term belongs to an institution's calendar.

### Types documented elsewhere

`Organization` and `Department` are in [TENANCY.md](./TENANCY.md), `GuardianLink`
and `GuardianScope` in [GUARDIANS.md](./GUARDIANS.md), and `TaGrant` in
[DELEGATION.md](./DELEGATION.md).

## Repository interfaces (`repositories.ts`)

The SDK never imports a database client. Wherever it needs to read or write
something it asks a repository interface, and your application implements that
interface over whatever you use. These are the ones in `core`:

| Interface | Methods | Needed by |
| --- | --- | --- |
| `UserRepository` | `findById(id)`, `findByExternalRef(ref, orgId?)` | enrollment, every enforcing service |
| `CourseRepository` | `findCourse(id)`, `findSection(id)`, `listSections(courseId)` | enrollment, every enforcing service |
| `EnrollmentRepository` | `create`, `findById`, `update`, `findByUserAndSection`, `listBySection(sectionId, status?)`, `countActive(sectionId)`, and optionally `createIfSeatFree(enrollment, capacity)` and `promoteIfSeatFree(enrollmentId, capacity)` | enrollment, every enforcing service |
| `ContentRepository` | `findById`, `listBySection`, `create`, `update`, `reorder` | content, assessment (when enforcing) |
| `TermRepository` | `findById(id)` | part of `RepositoryContext` |
| `OrganizationRepository` | `findById(id)` | optional; nothing in the SDK requires it yet |
| `DepartmentRepository` | `findById(id)`, `listByOrg(orgId)` | optional; for hosts that group courses |
| `DelegationRepository` | `create`, `findById`, `listActiveForEnrollment`, `revoke` | optional; for TA delegation |
| `GuardianLinkRepository` | `findActive(guardianId, wardId)` | optional; for guardians |

### What your implementations must guarantee

The SDK relies on a few behaviours that the type signatures cannot express.

- **Return `null` for "not found", never throw.** Every lookup returns
  `Promise<T | null>`, and the enforcing services turn a `null` into a refusal.
- **`findByUserAndSection` returns the most recent record** when a person has
  several for one section. Permission checks and delegated grants depend on it
  being the current enrollment.
- **`findByExternalRef(ref, orgId)` stays inside the organization** when `orgId`
  is given, because two organizations may reuse the same external reference.
  Hosts without organizations can ignore the argument.
- **`create` returns the stored record with its assigned `id`, and `update`
  returns the updated record.** Services use the returned value, not what they
  passed in.
- **`countActive` counts `active` enrollments only.** It drives capacity and the
  waitlist, so waitlisted people must not be counted.
- **Optional fields are omitted, not set to `undefined`.** The SDK is compiled with
  `exactOptionalPropertyTypes`, so a TypeScript host should not return
  `{ orgId: undefined }`; leave the key out.
- **The repositories behind the enforcing services must be the real source of
  truth.** Authorization re-checks what a repository returns for guardian links and
  delegated grants, but it cannot tell whether your `findByUserAndSection` is
  lying about who is enrolled.

### `RepositoryContext`

```ts
interface RepositoryContext {
  users: UserRepository;
  courses: CourseRepository;
  enrollments: EnrollmentRepository;
  content: ContentRepository;
  terms: TermRepository;
  organizations?: OrganizationRepository;
  departments?: DepartmentRepository;
  delegations?: DelegationRepository;
  guardianLinks?: GuardianLinkRepository;
}
```

The five required repositories are what `EnrollmentService` and `ContentService`
are built from. The four optional ones are switched on simply by supplying them:
leave one out and the feature it backs is off (a guardian can read nothing, a TA
has only the TA defaults, and so on) rather than broken.

Not every module goes through `RepositoryContext`. `grading`, `assessment`,
`communication`, `reporting`, `admin` and `scheduling` define and take their own
repositories directly, because those entities are theirs. Even so, a module that
enforces permissions also needs a few of the `core` repositories (to load the
actor and their enrollment); each module's page says which.

## Errors defined in `core`

| Error | Thrown when | Details |
| --- | --- | --- |
| `PermissionDeniedError` | the policy refuses, or the target cannot be proven | [PERMISSIONS.md](./PERMISSIONS.md) |
| `ActorRequiredError` | an enforcing service is called without an `{ actorId }` | [PERMISSIONS.md](./PERMISSIONS.md) |
| `TenantMismatchError` | something from one organization is used with another's | [TENANCY.md](./TENANCY.md) |
| `UnknownDepartmentError` | a course names a department that was not found | [TENANCY.md](./TENANCY.md) |

## Known limitations

- **The roles are fixed.** `Role` is a closed union of four. You can add *actions* and
  change which roles may do them, but not invent a fifth role such as `registrar`.
- **Some repositories are not used by any service yet.** `OrganizationRepository` and
  `TermRepository` exist for hosts; `AcademicTerm` and `Organization` are not read by the
  SDK's own services.
- **Repository behaviour is documented, not tested for you.** There is no shared contract
  test suite to run against your implementations. The only reference implementation in the
  package tree is scheduling's in-memory repository, and it is for tests and development.
- **`Identity` is deliberately thin.** No names, emails or credentials, so the SDK cannot
  display or look anyone up by them.
- **No built-in persistence** of any kind, by design.

## Conventions that hold throughout

- **No hard deletes.** Statuses and superseding entries keep history.
- **UTC everywhere.** Convert at the presentation layer, never inside SDK logic.
- **Optional means optional.** Wiring you do not need (events, hooks, enforcement,
  the optional repositories) can be left out, and the module behaves as it always
  did.
