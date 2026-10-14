---
description: The foundational core module of Discendo SDK, exporting shared types, repository contracts, the EventBus, and the RBAC authorization engine.
---

# Core Module

`discendo-sdk/core` defines the shared domain vocabulary, repository contracts, event bus, tenancy walls, and authorization rules that every other module depends upon.

::: important Architectural Foundation
`core` imports nothing else in the SDK. All other modules may import `core`, but never each other.
:::

---

## At a Glance

|             |                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Import**  | `import { ... } from 'discendo-sdk/core'`                                                                                           |
| **Exports** | Domain models (`Course`, `Section`, `Enrollment`…), `RepositoryContext`, `EventBus`, `createRolePolicy`, `DEFAULT_RULES`, `sameOrg` |
| **Errors**  | `PermissionDeniedError`, `ActorRequiredError`, `TenantMismatchError`, `UnknownDepartmentError`                                      |

---

## Domain Types (`types.ts`)

### `Id` and `Timestamp`

```ts
type Id = string;
type Timestamp = Date;
```

All timestamps produced or consumed by the SDK are JavaScript `Date` instances in **UTC**.

### `Role`

```ts
type Role = "student" | "instructor" | "ta" | "admin";
```

The SDK recognizes exactly four roles:

- **`Enrollment.role`:** The role a user possesses inside one specific course section. Only `'active'` enrollments confer this role.
- **`Identity.roles`:** The roles a user possesses account-wide. For section-level actions, only account-wide `'admin'` is honored.

::: info Guardians are not a role
Parents and guardians do not hold a `Role`. They receive read-only access via a [`GuardianLink`](/modules/guardians).
:::

### `Identity`

What the SDK knows about an individual user:

```ts
interface Identity {
  id: Id;
  externalRef?: string; // Optional host-provided ID (e.g. SIS student ID)
  roles: Role[]; // Account-wide roles
  orgId?: Id; // Organization the user belongs to
}
```

Discendo intentionally avoids storing names, emails, avatars, or passwords; those stay in your application's user tables.

### `Course` and `CourseSection`

```ts
interface Course {
  id: Id;
  title: string;
  description?: string;
  orgId?: Id; // Tenant owner
  departmentId?: Id; // Optional faculty/department categorization
}

interface CourseSection {
  id: Id;
  courseId: Id;
  termId?: Id;
  capacity?: number; // Unset = unlimited seats
  status: "draft" | "published" | "archived";
}
```

- **Course:** The academic offering or master template ("Introduction to Computer Science").
- **CourseSection:** A specific scheduled cohort ("CS101, Fall 2026, Section 01"). Sections inherit their organization directly from their parent course.

### `Enrollment` and `EnrollmentStatus`

```ts
type EnrollmentStatus = "active" | "waitlisted" | "dropped" | "completed";

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

Enrollments are **never deleted**. When a student leaves, `status` becomes `'dropped'` and `droppedAt` is recorded. Only `'active'` enrollments grant operational permissions.

### `ContentNode` and `ContentKind`

```ts
type ContentKind = "page" | "assignment" | "quiz" | "file" | "link";

interface ContentNode {
  id: Id;
  sectionId: Id;
  kind: ContentKind;
  title: string;
  parentId?: Id; // Content forms a hierarchical tree
  orderIndex: number;
  published: boolean;
  version: number; // Incremented on publish/unpublish
}
```

### `AcademicTerm`

```ts
interface AcademicTerm {
  id: Id;
  name: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  orgId?: Id;
}
```

---

## Repositories (`repositories.ts`)

`RepositoryContext` bundles the repositories shared across multiple services:

```ts
interface RepositoryContext {
  // Required for EnrollmentService and ContentService
  users: UserRepository;
  courses: CourseRepository;
  enrollments: EnrollmentRepository;
  content: ContentRepository;
  terms: TermRepository;

  // Optional extensions
  organizations?: OrganizationRepository;
  departments?: DepartmentRepository;
  enrollmentRequests?: EnrollmentRequestRepository;
  delegations?: DelegationRepository;
  guardianLinks?: GuardianLinkRepository;
  groups?: GroupRepository;
  coursePrerequisites?: CoursePrerequisiteRepository;
}
```

See the dedicated [Repositories Guide](/concepts/repositories) for full implementation requirements.

---

## Event Bus (`events.ts`)

Discendo uses an in-memory, typed event bus to broadcast domain events without tight coupling:

```ts
import { EventBus } from "discendo-sdk/core";

const bus = new EventBus({
  onHandlerError: (err, event) => console.error(err, event),
});

bus.on("enrollment.enrolled", (event) => {
  // event is typed as EnrolledEvent
});
```

See the dedicated [Events Guide](/concepts/events) for the full event catalog and delivery guarantees.

---

## Tenancy (`tenancy.ts`)

Provides multi-tenant assertions and helpers:

- **`sameOrg(a, b)`:** Compares two tenant IDs (`undefined` matches only `undefined`).
- **`assertSameOrg(a, b)`:** Throws `TenantMismatchError` if the two IDs do not match.
- **`assertCourseDepartment(course, department)`:** Verifies that a department belongs to the same organization as the course placed in it.

See the dedicated [Tenancy Guide](/concepts/tenancy).

---

## Permissions (`permissions.ts` & `authorization.ts`)

Provides the role-based access control engine:

- **`createRolePolicy(options?)`:** Creates a permission policy pre-loaded with `DEFAULT_RULES`.
- **`DEFAULT_RULES`:** The baseline permissions matrix across all SDK actions.
- **`authorizeInSection(...)`:** Evaluates permissions for a given actor against a specific section, taking into account `active` enrollment roles, account-wide admin status, and TA grants.

See the dedicated [Permissions Guide](/concepts/permissions).

---

## Core Errors

| Error                    | Condition                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `PermissionDeniedError`  | Thrown when an actor lacks permission or when a private target resource cannot be proven to exist. |
| `ActorRequiredError`     | Thrown when an enforcing service is called without an `{ actorId }`.                               |
| `TenantMismatchError`    | Thrown when cross-tenant operations are attempted.                                                 |
| `UnknownDepartmentError` | Thrown when a course specifies a department ID that does not exist in the database.                |

---

## Known Limitations

- **Fixed roles:** The set of four roles (`student`, `instructor`, `ta`, `admin`) is fixed. Custom roles (such as `registrar` or `auditor`) cannot be introduced directly into the `Role` union; you customize access by overriding rule actions instead.
- **Thin Identity:** `Identity` contains only roles, ID, and tenant ID. User names, emails, and credentials must be managed entirely in host code.
