---
description: Install Discendo SDK and run your first enrollment, waitlist promotion, permission check and grade calculation in about five minutes.
---

# Quick Start

In about five minutes you'll have a script that enrolls students, fills a waitlist and promotes from it, refuses an action that isn't permitted, and calculates a weighted final grade. It uses an in-memory store, so no database or web server is needed.

::: tip Prefer a real app?
This page is a tour. To build a full LMS backend with a database and an HTTP API, go to the [Build an LMS tutorial](/tutorial/).
:::

## Prerequisites

- [**Bun**](https://bun.sh) 1.1+ (used in this guide), or **Node.js 18+**
- **TypeScript** (Bun runs it directly)

## 1. Create a project

```sh
mkdir discendo-quickstart && cd discendo-quickstart
bun init -y
```

## 2. Install the SDK

::: warning Not on npm yet
`discendo-sdk` hasn't been published to npm yet. Until it is, build it from source and install it from your local copy.
:::

::: code-group

```sh [From source (today)]
# next to your project
git clone https://github.com/TheCodeHeist/discendo-lms-sdk.git
cd discendo-lms-sdk && bun install && bun run build && cd -

# inside discendo-quickstart
bun add ../discendo-lms-sdk
```

```sh [bun (once published)]
bun add discendo-sdk
```

```sh [npm (once published)]
npm install discendo-sdk
```

```sh [pnpm (once published)]
pnpm add discendo-sdk
```

:::

The SDK is ESM-only and has **no runtime dependencies**.

## 3. Implement the repositories

Discendo never talks to a database itself. It asks _you_, through small repository interfaces. Core's `RepositoryContext` bundles the five that `EnrollmentService` and `ContentService` need: `users`, `courses`, `enrollments`, `content` and `terms`.

For this tour, each one is a `Map`. Create `memory-repos.ts`:

::: details memory-repos.ts (click to expand, about 90 lines)

```ts
import type {
  RepositoryContext,
  Identity,
  Course,
  CourseSection,
  Enrollment,
  ContentNode,
  AcademicTerm,
} from "discendo-sdk/core";

/** A throwaway, Map-backed RepositoryContext. Good for scripts and tests, not for production. */
export function createMemoryRepos() {
  const users = new Map<string, Identity>();
  const courses = new Map<string, Course>();
  const sections = new Map<string, CourseSection>();
  const enrollments = new Map<string, Enrollment>();
  const content = new Map<string, ContentNode>();
  const terms = new Map<string, AcademicTerm>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const repos: RepositoryContext = {
    users: {
      findById: async (id) => users.get(id) ?? null,
      findByExternalRef: async (ref) =>
        [...users.values()].find((u) => u.externalRef === ref) ?? null,
    },
    courses: {
      findCourse: async (id) => courses.get(id) ?? null,
      findSection: async (id) => sections.get(id) ?? null,
      listSections: async (courseId) =>
        [...sections.values()].filter((s) => s.courseId === courseId),
    },
    enrollments: {
      create: async (data) => {
        const e = { ...data, id: nextId("enr") };
        enrollments.set(e.id, e);
        return e;
      },
      findById: async (id) => enrollments.get(id) ?? null,
      update: async (id, patch) => {
        const e = { ...enrollments.get(id)!, ...patch };
        enrollments.set(id, e);
        return e;
      },
      // must return the MOST RECENT record for this user + section
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments.values()]
          .filter((e) => e.userId === userId && e.sectionId === sectionId)
          .at(-1) ?? null,
      listBySection: async (sectionId, status) =>
        [...enrollments.values()].filter(
          (e) =>
            e.sectionId === sectionId &&
            (status === undefined || e.status === status),
        ),
      countActive: async (sectionId) =>
        [...enrollments.values()].filter(
          (e) => e.sectionId === sectionId && e.status === "active",
        ).length,
    },
    content: {
      findById: async (id) => content.get(id) ?? null,
      listBySection: async (sectionId) =>
        [...content.values()].filter((n) => n.sectionId === sectionId),
      create: async (data) => {
        const n = { ...data, id: nextId("node"), version: 1 };
        content.set(n.id, n);
        return n;
      },
      update: async (id, patch) => {
        const n = { ...content.get(id)!, ...patch };
        content.set(id, n);
        return n;
      },
      reorder: async (_sectionId, orderedIds) => {
        orderedIds.forEach((id, orderIndex) => {
          const n = content.get(id);
          if (n) content.set(id, { ...n, orderIndex });
        });
      },
    },
    terms: { findById: async (id) => terms.get(id) ?? null },
  };

  /** Seed helpers: your real app would create these through its own admin UI. */
  const seed = {
    user: (u: Identity) => void users.set(u.id, u),
    course: (c: Course) => void courses.set(c.id, c),
    section: (s: CourseSection) => void sections.set(s.id, s),
  };

  return { repos, seed };
}
```

:::

Some rules your implementation has to follow that the types can't enforce:

- Return **`null`** for "not found". Never throw.
- `findByUserAndSection` returns the **most recent** record, because a student can drop and re-enroll.
- `countActive` counts only **`active`** enrollments, never waitlisted ones.

[Repositories](/concepts/repositories) lists all of them.

## 4. Write the script

Create `index.ts`:

```ts
import {
  EventBus,
  createRolePolicy,
  PermissionDeniedError,
} from "discendo-sdk/core";
import { EnrollmentService } from "discendo-sdk/enrollment";
import {
  computeFinalGrade,
  toLetterGrade,
  applyLatePolicy,
} from "discendo-sdk/grading";
import type { GradeEntry } from "discendo-sdk/grading";
import { createMemoryRepos } from "./memory-repos.ts";

// 1. Repositories + some data
const { repos, seed } = createMemoryRepos();
seed.user({ id: "admin-1", roles: ["admin"] });
seed.user({ id: "prof-1", roles: ["instructor"] });
seed.user({ id: "stu-1", roles: ["student"] });
seed.user({ id: "stu-2", roles: ["student"] });
seed.course({ id: "phys-101", title: "Intro to Physics" });
seed.section({
  id: "phys-101-a",
  courseId: "phys-101",
  capacity: 1,
  status: "published",
});
seed.section({ id: "phys-101-b", courseId: "phys-101", status: "published" }); // no capacity = unlimited

// 2. One event bus, shared by every service
const bus = new EventBus();
bus.on("*", (event) => console.log("📡", event.type, JSON.stringify(event)));

// 3. A service, constructed once
const enrollment = new EnrollmentService(repos, bus, { promoteOnDrop: true });

// 4. Use it
const first = await enrollment.enroll({
  userId: "stu-1",
  sectionId: "phys-101-a",
  role: "student",
});
const second = await enrollment.enroll({
  userId: "stu-2",
  sectionId: "phys-101-a",
  role: "student",
  waitlistIfFull: true,
});
console.log(first.status, second.status); // active waitlisted

await enrollment.drop(first.id); // the seat frees up, stu-2 is promoted automatically
console.log((await repos.enrollments.findById(second.id))?.status); // active

// 5. Turn permissions on
const guarded = new EnrollmentService(repos, bus, {
  policy: createRolePolicy(),
});
try {
  // a student may not enroll someone else
  await guarded.enroll(
    { userId: "stu-1", sectionId: "phys-101-a", role: "student" },
    { actorId: "stu-2" },
  );
} catch (err) {
  if (err instanceof PermissionDeniedError) console.log("⛔", err.message);
}
await guarded.enroll(
  { userId: "prof-1", sectionId: "phys-101-b", role: "instructor" },
  { actorId: "admin-1" },
); // ✅ an admin may

// 6. Pure grading functions: no repositories needed
const entry = (score: number, maxScore: number): GradeEntry => ({
  id: crypto.randomUUID(),
  submissionId: "s",
  userId: "stu-2",
  score,
  maxScore,
  graderId: "prof-1",
  gradedAt: new Date(),
});
const final = computeFinalGrade(
  new Map([
    ["homework", [entry(8, 10), entry(10, 10), entry(4, 10)]],
    ["exams", [entry(88, 100)]],
  ]),
  {
    categories: [
      { name: "homework", weight: 0.4, dropLowestN: 1 },
      { name: "exams", weight: 0.6 },
    ],
  },
);
const late = applyLatePolicy(90, 100, 2, {
  kind: "flatPenalty",
  percentPerDay: 5,
});
console.log(
  final.toFixed(1),
  toLetterGrade(final, [
    { minPercent: 90, label: "A" },
    { minPercent: 80, label: "B" },
    { minPercent: 70, label: "C" },
    { minPercent: 0, label: "F" },
  ]),
  late,
); // 88.8 B 80
```

## 5. Run it

```sh
bun index.ts
```

```txt
📡 enrollment.enrolled {"type":"enrollment.enrolled","enrollmentId":"enr-1","userId":"stu-1","sectionId":"phys-101-a","status":"active"}
📡 enrollment.enrolled {"type":"enrollment.enrolled","enrollmentId":"enr-2","userId":"stu-2","sectionId":"phys-101-a","status":"waitlisted"}
active waitlisted
📡 enrollment.dropped {"type":"enrollment.dropped","enrollmentId":"enr-1","userId":"stu-1","sectionId":"phys-101-a"}
📡 enrollment.promoted {"type":"enrollment.promoted","enrollmentId":"enr-2","userId":"stu-2","sectionId":"phys-101-a","previousStatus":"waitlisted","trigger":"auto"}
active
⛔ Not permitted: enrollment.enroll
📡 enrollment.enrolled {"type":"enrollment.enrolled","enrollmentId":"enr-3","userId":"prof-1","sectionId":"phys-101-b","status":"active"}
88.8 B 80
```

## What just happened

### Capacity and waitlists

Section `phys-101-a` has `capacity: 1`. The first student got the seat. The second passed `waitlistIfFull: true`, so instead of an error they were placed `waitlisted`. Because the service was built with `promoteOnDrop: true`, dropping the first student freed the seat and promoted the longest-waiting person automatically, emitting `enrollment.promoted` with `trigger: "auto"`.

Note that the drop **did not delete** anything. The enrollment's `status` became `dropped` and `droppedAt` was set, so history is preserved.

::: info Every active enrollment uses a seat
`capacity` is compared with `countActive`, which counts **every** active enrollment in the section, instructors and TAs included. That's why the instructor went into the unlimited section `phys-101-b`. Take staff into account when you set capacities.
:::

### Events

The services emitted typed events on the shared `EventBus`. `bus.on('*', …)` receives all of them. In a real app you'd subscribe to specific types, for example `bus.on('enrollment.promoted', notifyStudent)`. Events are fire-and-forget: a slow or failing listener never breaks the operation that caused it. See [Events](/concepts/events).

### Permissions

The first `EnrollmentService` had no policy, so it trusted its caller completely. This is useful when your API layer already authorizes. The second was built with `createRolePolicy()`, so **every call requires an `{ actorId }`**, and the service:

1. loads that actor's `Identity` from your `UserRepository` (it never trusts roles passed in by the caller),
2. checks the action (`enrollment.enroll`) and the role being granted (`enrollment.grantRole.instructor`) against the rules,
3. refuses with `PermissionDeniedError` _before reading anything else_, so a refused caller learns nothing.

A student enrolling someone else is refused. An account-wide admin is allowed. See [Permissions](/concepts/permissions).

### Pure functions

`computeFinalGrade`, `applyLatePolicy` and `toLetterGrade` need no repositories. Homework dropped its lowest score (4/10), averaged 90%, and is weighted 40%. The exam (88%) is weighted 60%. The final grade is **88.8 → B**. A 90/100 submitted two days late under a 5%-per-day policy becomes **80**. Because these functions are pure, you can use them to preview a grade in your UI before anything is saved.

## Next steps

| Next                                                          | Where                                      |
| ------------------------------------------------------------- | ------------------------------------------ |
| See how the modules fit together                              | [Architecture](/introduction/architecture) |
| Implement repositories properly (atomic seats, organizations) | [Repositories](/concepts/repositories)     |
| Build a real LMS with a database and an HTTP API              | [Build an LMS](/tutorial/)                 |
| Browse every module's API                                     | [Module Reference](/modules/)              |
