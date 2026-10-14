---
description: Assemble your repositories, EventBus, and permission policy into a unified, reusable service container.
---

# 4. Wiring Services

In this chapter, we will assemble our concrete repositories, the shared `EventBus`, and the authorization `RolePolicy` into a single, clean service container module (`src/lib/services.ts`).

---

## 1. Create the Service Container (`src/lib/services.ts`)

Create `src/lib/services.ts`:

```ts
import { EventBus, createRolePolicy } from "discendo-sdk/core";
import type { RepositoryContext } from "discendo-sdk/core";
import { EnrollmentService } from "discendo-sdk/enrollment";
import { ContentService } from "discendo-sdk/content";
import { GradingService } from "discendo-sdk/grading";

import { DrizzleUserRepository } from "../db/repositories/users";
import { DrizzleCourseRepository } from "../db/repositories/courses";
import { DrizzleEnrollmentRepository } from "../db/repositories/enrollments";
import { DrizzleContentRepository } from "../db/repositories/content";
import { DrizzleTermRepository } from "../db/repositories/terms";

// 1. Instantiate concrete repository adapters
export const repos: RepositoryContext = {
  users: new DrizzleUserRepository(),
  courses: new DrizzleCourseRepository(),
  enrollments: new DrizzleEnrollmentRepository(),
  content: new DrizzleContentRepository(),
  terms: new DrizzleTermRepository(),
};

// 2. Global EventBus singleton with error reporting
export const bus = new EventBus({
  onHandlerError: (err, event) => {
    console.error(
      `[EventBus] Handler threw error for event "${event.type}":`,
      err,
    );
  },
});

// Optional: Log all domain events to stdout during development
bus.on("*", (event) => {
  console.log(`[EventBus] 📡 ${event.type}`);
});

// 3. Permission authorization policy (using default rules)
export const policy = createRolePolicy();

// 4. Instantiate domain services
export const enrollmentService = new EnrollmentService(repos, bus, {
  policy,
  promoteOnDrop: true, // Automatically promotes longest-waiting student when a seat frees
});

export const contentService = new ContentService(repos, undefined, [], bus, {
  policy,
});

export const gradingService = new GradingService(
  // In a later chapter, we wire GradeRepository here
  undefined as any,
  bus,
  {
    policy,
    repos,
    submissions: async () => null,
  },
);
```

---

## 2. Seed and Test the Stack (`src/seed.ts`)

Let's write a seed script to test our end-to-end stack: inserting users and courses into SQLite, and executing an enrollment via `EnrollmentService`.

Create `src/seed.ts`:

```ts
import { db } from "./db";
import { users, courses, courseSections } from "./db/schema";
import { enrollmentService } from "./lib/services";

console.log("Seeding initial LMS data...");

// 1. Create admin and student accounts
const adminId = "u-admin-1";
const studentId = "u-student-1";

await db.insert(users).values([
  {
    id: adminId,
    name: "Administrator",
    email: "admin@academix.edu",
    passwordHash: "argon2-hash-placeholder",
    roles: ["admin"],
    createdAt: new Date(),
  },
  {
    id: studentId,
    name: "Alice Smith",
    email: "alice@academix.edu",
    passwordHash: "argon2-hash-placeholder",
    roles: ["student"],
    createdAt: new Date(),
  },
]);

// 2. Create course and section
const courseId = "course-cs101";
const sectionId = "sec-cs101-fall";

await db.insert(courses).values({
  id: courseId,
  title: "Introduction to Computer Science",
  description: "CS fundamentals with TypeScript",
  createdAt: new Date(),
});

await db.insert(courseSections).values({
  id: sectionId,
  courseId,
  capacity: 30,
  status: "published",
  createdAt: new Date(),
});

// 3. Use EnrollmentService to enroll Alice
console.log("Enrolling Alice via EnrollmentService...");
const enrollment = await enrollmentService.enroll(
  {
    userId: studentId,
    sectionId,
    role: "student",
  },
  { actorId: adminId }, // Authorized by administrator
);

console.log("✅ Successfully enrolled student!");
console.log(`Enrollment ID: ${enrollment.id}, Status: ${enrollment.status}`);
```

Run the seed script:

```sh
bun run src/seed.ts
```

Output:

```
Seeding initial LMS data...
Enrolling Alice via EnrollmentService...
[EventBus] 📡 enrollment.enrolled
✅ Successfully enrolled student!
Enrollment ID: enr-..., Status: active
```

---

## What We Have Built

You now have a fully functioning database-backed core:

1. **Drizzle ORM** manages your relational tables in SQLite.
2. **Repository adapters** bridge SQL data to the SDK's TypeScript types.
3. **EnrollmentService** enforces business rules, authorizes callers, updates the database, and emits events on the **EventBus**.

---

## Next Steps

In **Phase 2: People & Access**, we will build HTTP endpoints, JWT authentication middleware, and role enforcement:

- [Chapter 5: Authentication & Actors](/tutorial/05-authentication)
- [Chapter 6: Roles & Permissions](/tutorial/06-permissions)
- [Chapter 7: Organizations & Departments](/tutorial/07-organizations)
