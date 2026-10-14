---
description: Learn how Discendo SDK abstracts database persistence using repository interfaces, and the critical guarantees your implementations must provide.
---

# Repositories

Discendo SDK never connects directly to a database. It delegates persistence to **repository interfaces** that you implement in your host application using your preferred ORM (Drizzle, Prisma, Kysely), raw SQL, or in-memory collections for testing.

---

## Core Repositories: `RepositoryContext`

Several services (`EnrollmentService`, `ContentService`) require access to shared entities like users, courses, and terms. These are bundled into a single object: `RepositoryContext`.

```ts
import type { RepositoryContext } from "discendo-sdk/core";
```

### Required Repositories

| Repository                             | Purpose                                 | Primary Methods                                                                        |
| -------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `users` (`UserRepository`)             | Lookup user identity and account roles  | `findById(id)`, `findByExternalRef(ref, orgId?)`                                       |
| `courses` (`CourseRepository`)         | Read course metadata and sections       | `findCourse(id)`, `findSection(id)`, `listSections(courseId)`                          |
| `enrollments` (`EnrollmentRepository`) | Manage student/staff rosters            | `create`, `findById`, `update`, `findByUserAndSection`, `listBySection`, `countActive` |
| `content` (`ContentRepository`)        | Store hierarchical course content trees | `findById`, `listBySection`, `create`, `update`, `reorder`                             |
| `terms` (`TermRepository`)             | Academic terms and date boundaries      | `findById(id)`                                                                         |

### Optional Repositories

Supplying these unlocks optional capabilities. If omitted, the corresponding feature stays safely disabled without throwing errors:

| Repository            | Feature Unlocked                                      |
| --------------------- | ----------------------------------------------------- |
| `organizations`       | Multi-tenant organization queries                     |
| `departments`         | Categorizing courses into departmental faculties      |
| `enrollmentRequests`  | Self-service student enrollment approval workflows    |
| `delegations`         | Instructor-to-TA privilege delegation                 |
| `guardianLinks`       | Parent/guardian read-only portal access               |
| `groups`              | Study and project groups within course sections       |
| `coursePrerequisites` | Automated course prerequisite and co-requisite checks |

---

## Domain-Specific Repositories

Specialized domain modules manage their own distinct entities and define standalone repository interfaces rather than using `RepositoryContext`:

| Module                       | Repository Interface                                         | Managed Entity                                                        |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `discendo-sdk/grading`       | `GradeRepository`                                            | Immutable grade entries with `supersededBy` tracking                  |
| `discendo-sdk/assessment`    | `SubmissionRepository`, `QuizRepository`, `RubricRepository` | Assignment submissions, randomized quiz attempts, and scoring rubrics |
| `discendo-sdk/scheduling`    | `SchedulingRepository`                                       | Rooms, instructor availability, session templates, and occurrences    |
| `discendo-sdk/communication` | `AnnouncementRepository`, `ThreadRepository`                 | Section announcements and threaded discussion replies                 |
| `discendo-sdk/admin`         | `AuditRepository`                                            | Immutable security and compliance event records                       |

---

## Non-Typeable Guarantees

TypeScript interfaces describe method signatures, but they cannot enforce runtime behavior. The SDK relies on several guarantees that your implementations must respect:

### 1. Return `null` for missing records (Never throw)

Every finder must return `Promise<T | null>` when an ID is not found. Enforcing services rely on `null` to detect non-existent targets and trigger fail-closed security rules.

### 2. `findByUserAndSection` must return the most recent record

A student may enroll, drop out, and re-enroll in the same section over time. Your query must return the **most recent** record (sorted by `enrolledAt DESC` or primary key):

```sql
SELECT * FROM enrollments
WHERE user_id = $1 AND section_id = $2
ORDER BY enrolled_at DESC
LIMIT 1;
```

### 3. `countActive` must count only `'active'` records

This method drives seat capacity checks and waitlist promotions. Waitlisted, dropped, or completed enrollments must never be included in this count:

```sql
SELECT COUNT(*) FROM enrollments
WHERE section_id = $1 AND status = 'active';
```

### 4. Respect exact optional properties

The SDK is compiled with `exactOptionalPropertyTypes: true`. Do not return `{ orgId: undefined }` on records that have no organization; omit the property or set it to `undefined` only if optional in the interface.

---

## Atomic Concurrency Methods

Under high traffic (e.g., course registration opening at 9:00 AM), two concurrent requests could check `countActive()`, observe an open seat, and both execute `create()`, over-enrolling the section.

To eliminate race conditions, the SDK supports optional **atomic repository methods**:

### `createIfSeatFree`

```ts
export interface EnrollmentRepository {
  // Optional atomic method
  createIfSeatFree?(
    enrollment: Omit<Enrollment, "id">,
    capacity: number,
  ): Promise<Enrollment | null>;
}
```

If implemented, `EnrollmentService.enroll()` invokes this method instead of the two-step `countActive()` + `create()` flow. Your implementation performs the check and insertion within a single database transaction or atomic statement:

::: code-group

```ts [Drizzle ORM (PostgreSQL transaction)]
async createIfSeatFree(data, capacity) {
  return await db.transaction(async (tx) => {
    // Acquire a lock on the section or count active seats
    const [row] = await tx
      .select({ count: count() })
      .from(enrollments)
      .where(and(eq(enrollments.sectionId, data.sectionId), eq(enrollments.status, 'active')))

    if (row.count >= capacity) {
      return null // Section is full; SDK will place student on waitlist
    }

    const [created] = await tx.insert(enrollments).values(data).returning()
    return created
  })
}
```

```sql [Raw SQL (PostgreSQL conditional insert)]
INSERT INTO enrollments (id, user_id, section_id, role, status, enrolled_at)
SELECT gen_random_uuid(), $1, $2, $3, 'active', NOW()
WHERE (
  SELECT COUNT(*) FROM enrollments
  WHERE section_id = $2 AND status = 'active'
) < $4
RETURNING *;
```

:::

### `promoteIfSeatFree`

```ts
export interface EnrollmentRepository {
  promoteIfSeatFree?(
    enrollmentId: Id,
    capacity: number,
  ): Promise<Enrollment | null>;
}
```

Used by `promoteFromWaitlist()` and `promoteOnDrop`. It changes a `'waitlisted'` enrollment to `'active'` **only if** the seat count remains under `capacity`, returning `null` if another concurrent worker claimed the seat first.

### `decideIfPending`

```ts
export interface EnrollmentRequestRepository {
  decideIfPending?(
    id: Id,
    patch: Partial<Omit<EnrollmentRequest, "id">>,
  ): Promise<EnrollmentRequest | null>;
}
```

Used by `EnrollmentRequestService` to prevent race conditions when two reviewers simultaneously attempt to approve, reject, or modify the same pending request.

---

## Next Steps

- See how services consume these repositories in [Services & Wiring](/concepts/services).
- Explore a complete Drizzle ORM implementation in the [Build an LMS Tutorial](/tutorial/03-repositories).
