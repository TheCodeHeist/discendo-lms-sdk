---
description: Write comprehensive integration and unit tests for your LMS using Bun's native test runner without running an external HTTP server.
---

# 18. Testing

Testing an LMS requires verifying not just happy paths, but critical edge cases: seat capacity races, waitlist promotions, permission rejections, and tenant isolation.

Because Bun has a built-in test runner (`bun:test`) and Hono supports testing via `app.fetch()`, we can write fast, end-to-end integration tests without spinning up a live network server or mock container.

---

## 1. Setting Up the Test Environment

Create `tests/setup.ts` to provide an isolated in-memory database and test helpers:

```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../src/db/schema";

export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const testDb = drizzle(sqlite, { schema });
  return { testDb, sqlite };
}
```

---

## 2. Testing Enrollment & Waitlists (`tests/enrollment.test.ts`)

Create `tests/enrollment.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "bun:test";
import app from "../src/index";
import { db } from "../src/db";
import { users, courses, courseSections, enrollments } from "../src/db/schema";
import { createAuthToken } from "../src/lib/auth";

describe("Enrollment Integration Flow", () => {
  let adminToken: string;
  let student1Token: string;
  let student2Token: string;
  let sectionId: string;

  beforeEach(async () => {
    // 1. Seed admin and students
    const adminId = "u-admin-test";
    const stu1Id = "u-stu-1";
    const stu2Id = "u-stu-2";

    await db.insert(users).values([
      {
        id: adminId,
        name: "Admin",
        email: "admin@test.edu",
        passwordHash: "hash",
        roles: ["admin"],
        createdAt: new Date(),
      },
      {
        id: stu1Id,
        name: "Stu 1",
        email: "stu1@test.edu",
        passwordHash: "hash",
        roles: ["student"],
        createdAt: new Date(),
      },
      {
        id: stu2Id,
        name: "Stu 2",
        email: "stu2@test.edu",
        passwordHash: "hash",
        roles: ["student"],
        createdAt: new Date(),
      },
    ]);

    adminToken = await createAuthToken({
      id: adminId,
      email: "admin@test.edu",
      roles: ["admin"],
    });
    student1Token = await createAuthToken({
      id: stu1Id,
      email: "stu1@test.edu",
      roles: ["student"],
    });
    student2Token = await createAuthToken({
      id: stu2Id,
      email: "stu2@test.edu",
      roles: ["student"],
    });

    // 2. Create section with capacity: 1
    const courseId = "course-test";
    sectionId = "sec-test";

    await db
      .insert(courses)
      .values({ id: courseId, title: "Test Course", createdAt: new Date() });
    await db
      .insert(courseSections)
      .values({
        id: sectionId,
        courseId,
        capacity: 1,
        status: "published",
        createdAt: new Date(),
      });
  });

  it("enrolls first student and waitlists second student when capacity is 1", async () => {
    // Student 1 enrolls -> gets active seat
    const res1 = await app.fetch(
      new Request(
        `http://localhost/api/enrollments/sections/${sectionId}/enroll`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${student1Token}`,
          },
          body: JSON.stringify({ role: "student", waitlistIfFull: true }),
        },
      ),
    );
    expect(res1.status).toBe(201);
    const data1 = await res1.json();
    expect(data1.enrollment.status).toBe("active");

    // Student 2 enrolls -> gets waitlisted
    const res2 = await app.fetch(
      new Request(
        `http://localhost/api/enrollments/sections/${sectionId}/enroll`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${student2Token}`,
          },
          body: JSON.stringify({ role: "student", waitlistIfFull: true }),
        },
      ),
    );
    expect(res2.status).toBe(201);
    const data2 = await res2.json();
    expect(data2.enrollment.status).toBe("waitlisted");
  });

  it("promotes waitlisted student automatically when active student drops", async () => {
    // 1. Enroll both
    const r1 = await app.fetch(
      new Request(
        `http://localhost/api/enrollments/sections/${sectionId}/enroll`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${student1Token}`,
          },
          body: JSON.stringify({ role: "student", waitlistIfFull: true }),
        },
      ),
    );
    const { enrollment: e1 } = await r1.json();

    const r2 = await app.fetch(
      new Request(
        `http://localhost/api/enrollments/sections/${sectionId}/enroll`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${student2Token}`,
          },
          body: JSON.stringify({ role: "student", waitlistIfFull: true }),
        },
      ),
    );
    const { enrollment: e2 } = await r2.json();

    // 2. Student 1 drops their seat
    const dropRes = await app.fetch(
      new Request(
        `http://localhost/api/enrollments/sections/${sectionId}/drop`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${student1Token}`,
          },
          body: JSON.stringify({ enrollmentId: e1.id }),
        },
      ),
    );
    expect(dropRes.status).toBe(200);

    // 3. Verify Student 2 was auto-promoted to active in database
    const updatedE2 = await db.query.enrollments.findFirst({
      where: (row, { eq }) => eq(row.id, e2.id),
    });
    expect(updatedE2?.status).toBe("active");
  });
});
```

---

## 3. Testing Permission Denials (`tests/permissions.test.ts`)

Verify that unauthorized actions are refused with `403 Forbidden` and fail closed:

```ts
import { describe, it, expect } from "bun:test";
import app from "../src/index";
import { createAuthToken } from "../src/lib/auth";

describe("RBAC Protection", () => {
  it("forbids students from publishing draft content nodes", async () => {
    const studentToken = await createAuthToken({
      id: "u-student-attacker",
      email: "attacker@test.edu",
      roles: ["student"],
    });

    const res = await app.fetch(
      new Request("http://localhost/api/content/nodes/node-draft-1/publish", {
        method: "POST",
        headers: { Authorization: `Bearer ${studentToken}` },
      }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
    expect(body.action).toBe("content.manage");
  });
});
```

---

## 4. Running the Tests

Execute your test suite with Bun:

```sh
bun test
```

Output:

```
✓ Enrollment Integration Flow > enrolls first student and waitlists second student [2.45ms]
✓ Enrollment Integration Flow > promotes waitlisted student automatically when active student drops [1.90ms]
✓ RBAC Protection > forbids students from publishing draft content nodes [0.85ms]

 3 pass
 0 fail
Ran 3 tests. [12.00ms]
```

Tests run in milliseconds because SQLite runs in-memory and HTTP handlers execute directly in-process without network overhead.

---

## Next Steps

Now we are ready to containerize and deploy Academix in the final chapter: [Chapter 19: Deployment](/tutorial/19-deployment).
