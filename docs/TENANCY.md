# Tenancy: organizations and departments

`src/core/tenancy.ts` — how the SDK keeps separate institutions apart when they
share one deployment, and how an institution can optionally sort its courses
into departments. Exported from `discendo-sdk/core`.

**If you run a single school or a single university you can skip this page.**
Leave `orgId` unset everywhere and nothing here ever refuses anything.

## The model in one paragraph

An **organization** is one institution: a university, a school, a company. It is
the hard wall of the SDK: nobody acts across it, not even an admin. A
**department** is an optional grouping of courses *inside* one organization. It
is for sorting and reporting and is not a boundary at all, so a student can take
courses from several departments of the same institution (a major in one, a minor
in another) with no special handling.

| | Organization | Department |
| --- | --- | --- |
| Represents | an institution | a faculty, department or subject area inside one |
| Is a boundary | **yes**, the tenant wall | no |
| Where it is set | `Identity.orgId`, `Course.orgId`, `AcademicTerm.orgId` | `Course.departmentId` |
| Needed by a school | no | no |

## Where `orgId` lives

- A **course** carries the `orgId` of the organization that owns it. Sections,
  enrollments and content inherit it through their course, so they never repeat it.
- An **identity** carries the `orgId` of the organization the person belongs to.
- An **academic term** may carry one, because a term belongs to an institution's
  calendar. (No service reads `AcademicTerm.orgId` yet; it is there for hosts.)

```ts
interface Organization { id: Id; name: string }
```

## The one rule

> An organization id matches **the same id, and nothing else**. "No organization"
> (`undefined`) matches only "no organization".

```ts
sameOrg('org-a', 'org-a');          // true
sameOrg('org-a', 'org-b');          // false
sameOrg(undefined, undefined);      // true   (a single-institution deployment)
sameOrg('org-a', undefined);        // false  (an org member cannot act on an un-owned course)
sameOrg(undefined, 'org-a');        // false  (an un-affiliated person cannot join an org's course)
```

Ids are opaque and compared exactly: `'ORG-A'` is not `'org-a'`.

The "no organization only matches no organization" half is what stops a person
from slipping into an org-scoped course by *omission*. It is applied in both
directions.

## Where the SDK checks it

| Check | Where | What it does |
| --- | --- | --- |
| **Permissions** | every enforcing service, through the policy | The actor's organization must equal the resource's organization before any rule is even consulted. Never skipped, so an admin of one organization cannot act in another's. See [PERMISSIONS.md](./PERMISSIONS.md) |
| **Enrolling a user** | `EnrollmentService.enroll` and `bulkEnroll` | The person being enrolled must belong to the course's organization, strictly in both directions: a person with no organization can only join a course with none, and a person with an organization cannot join a course that has none. The person is always loaded to check this. A cross-tenant attempt is rejected before the capacity logic runs, so the person is not waitlisted either, and no event is emitted |
| **Looking up by external reference** | `bulkEnroll` | The course's organization is passed to `UserRepository.findByExternalRef(ref, orgId)`, so two organizations can reuse the same external reference and each resolves to its own person |
| **Guardian links** | guardian verification | A link's `orgId` must equal the course's organization. See [GUARDIANS.md](./GUARDIANS.md) |
| **Course departments** | `assertCourseDepartment`, called by *your* code | A department must belong to the same organization as the course placed in it |

With enforcement turned on (see [PERMISSIONS.md](./PERMISSIONS.md)), the
permission check runs on every call to that service. Even a bug elsewhere in your
host, such as a route that forgets to scope a query, cannot then let one
organization's people act on another's courses through the SDK. Without
enforcement the SDK still applies the enrollment check but leaves the rest to
your own API layer.

## Deployment modes

| Mode | What you set | Result |
| --- | --- | --- |
| **One institution** | nothing | `undefined` matches `undefined` everywhere, so every check passes. Zero cost |
| **Several institutions** | `orgId` on every course **and** every identity | Full isolation |
| **Mixed** (some identities or courses without an org) | not recommended | See below |

In a **mixed** deployment, a person who belongs to an organization is refused on a
course that has none, and a person with no organization is refused on an org's
course. That is deliberate and fails closed, but it will look like a bug if you
migrate gradually. When moving an existing single-institution deployment to
organizations, set `orgId` on the **courses and on the identities together**, and
do not leave either side half done.

## Errors

### `TenantMismatchError`

```ts
class TenantMismatchError extends Error {
  readonly expectedOrgId: Id | undefined;
  readonly actualOrgId: Id | undefined;
}
```

Thrown when something from one organization is used with another's. The
**message is deliberately generic** (for example "User does not belong to this
course's organization"): it may end up in an API response or a bulk-import report,
and it must never tell a caller which organization owns a course. The two ids are
available as properties for your own logging.

### `assertSameOrg(expected, actual, message)`

Throws `TenantMismatchError` unless `sameOrg(expected, actual)`. Use it in your
own code to apply the same rule the SDK applies.

## Departments

```ts
interface Department {
  id: Id;
  orgId?: Id;     // must match the organization of the courses placed in it
  name: string;
}

// on Course:
departmentId?: Id;
```

A course names its department with `Course.departmentId`. Everything about it is
optional: a school never sets it, and nothing in the SDK requires the
`departments` repository.

### `DepartmentRepository`

```ts
interface DepartmentRepository {
  findById(id: Id): Promise<Department | null>;
  /** `undefined` = the departments that belong to no organization. */
  listByOrg(orgId: Id | undefined): Promise<Department[]>;
}
```

Supply it as `RepositoryContext.departments` if you use departments. The SDK does
not read it for you; it exists so your code and the SDK agree on the shape.

### `assertCourseDepartment(course, department)`

For *your* code, when it creates or edits a course. Pass the course and whatever
`departments.findById(course.departmentId)` returned:

```ts
const course = { id: 'c1', title: 'Harmony', orgId: 'org-a', departmentId: 'dept-music' };
const department = await repos.departments.findById(course.departmentId);

assertCourseDepartment(course, department);   // throws unless it is valid
await courseRepo.save(course);
```

| Situation | Result |
| --- | --- |
| the course has no `departmentId` | passes, whatever else is passed |
| the department exists and belongs to the course's organization | passes |
| both have no organization (single institution) | passes |
| the department belongs to another organization (or one has an org and the other none) | `TenantMismatchError` |
| the course names a department but none was found, or a different one was passed | `UnknownDepartmentError` |

`UnknownDepartmentError` is generic in the same way (message "Unknown
department", the id on `.departmentId` for your logs).

### Studying across departments

Nothing needs configuring. A student of organization `org-a` can be enrolled in a
section of a science course and a section of a music course of that same
organization; the department of a course plays no part in enrollment or in any
permission check.

## Known limitations

- **The check is also skipped on the idempotent path.** If the person is already
  enrolled, `enroll` returns the existing record before any tenant logic.
- **No department-scoped administrators.** An admin is an admin of the whole
  organization. Department-level administration is not built.
- **`OrganizationRepository` and `AcademicTerm.orgId` are not read by any
  service.** They are there for hosts.
- **The SDK does not stop you creating a course with the wrong organization.**
  It enforces the wall between organizations at *use*; setting a course's `orgId`
  correctly when you create it is your code's job.

## Tests

| File | Covers |
| --- | --- |
| `test/core-tenancy.test.ts` | `sameOrg`, `assertSameOrg`, and the generic message |
| `test/core-department.test.ts` | `assertCourseDepartment` in every case above |
| `test/enrollment-tenancy.test.ts` | the enrollment check, bulk import with `orgId` hints, cross-department enrollment |
| `test/core-permissions.test.ts` | the permission-side tenant check, both directions |
