---
description: Build concrete, type-safe repository implementations using Drizzle ORM to fulfill Discendo SDK contracts.
---

# 3. Implementing Repositories

In this chapter, we will implement the repository interfaces required by `RepositoryContext`. These classes translate Discendo's domain queries into type-safe Drizzle ORM SQL statements.

---

## 1. User Repository (`src/db/repositories/users.ts`)

Implements `UserRepository` (`findById` and `findByExternalRef`):

```ts
import { eq, and } from "drizzle-orm";
import type { UserRepository, Identity, Role } from "discendo-sdk/core";
import { db } from "../index";
import { users } from "../schema";

export class DrizzleUserRepository implements UserRepository {
  async findById(id: string): Promise<Identity | null> {
    const row = await db.query.users.findFirst({
      where: eq(users.id, id),
    });
    if (!row) return null;

    return {
      id: row.id,
      roles: row.roles as Role[],
      ...(row.externalRef ? { externalRef: row.externalRef } : {}),
      ...(row.orgId ? { orgId: row.orgId } : {}),
    };
  }

  async findByExternalRef(
    ref: string,
    orgId?: string,
  ): Promise<Identity | null> {
    const condition = orgId
      ? and(eq(users.externalRef, ref), eq(users.orgId, orgId))
      : eq(users.externalRef, ref);

    const row = await db.query.users.findFirst({ where: condition });
    if (!row) return null;

    return {
      id: row.id,
      roles: row.roles as Role[],
      ...(row.externalRef ? { externalRef: row.externalRef } : {}),
      ...(row.orgId ? { orgId: row.orgId } : {}),
    };
  }
}
```

::: tip Notice exact optional properties
We spread `...(row.externalRef ? { externalRef: row.externalRef } : {})` rather than passing `{ externalRef: undefined }`. Discendo is compiled with `exactOptionalPropertyTypes: true`, so optional keys should be omitted when not present.
:::

---

## 2. Course Repository (`src/db/repositories/courses.ts`)

Implements `CourseRepository` (`findCourse`, `findSection`, `listSections`):

```ts
import { eq } from "drizzle-orm";
import type {
  CourseRepository,
  Course,
  CourseSection,
} from "discendo-sdk/core";
import { db } from "../index";
import { courses, courseSections } from "../schema";

export class DrizzleCourseRepository implements CourseRepository {
  async findCourse(id: string): Promise<Course | null> {
    const row = await db.query.courses.findFirst({ where: eq(courses.id, id) });
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
      ...(row.orgId ? { orgId: row.orgId } : {}),
      ...(row.departmentId ? { departmentId: row.departmentId } : {}),
    };
  }

  async findSection(id: string): Promise<CourseSection | null> {
    const row = await db.query.courseSections.findFirst({
      where: eq(courseSections.id, id),
    });
    if (!row) return null;
    return {
      id: row.id,
      courseId: row.courseId,
      status: row.status,
      ...(row.termId ? { termId: row.termId } : {}),
      ...(row.capacity !== null && row.capacity !== undefined
        ? { capacity: row.capacity }
        : {}),
    };
  }

  async listSections(courseId: string): Promise<CourseSection[]> {
    const rows = await db.query.courseSections.findMany({
      where: eq(courseSections.courseId, courseId),
    });
    return rows.map((row) => ({
      id: row.id,
      courseId: row.courseId,
      status: row.status,
      ...(row.termId ? { termId: row.termId } : {}),
      ...(row.capacity !== null && row.capacity !== undefined
        ? { capacity: row.capacity }
        : {}),
    }));
  }
}
```

---

## 3. Enrollment Repository (`src/db/repositories/enrollments.ts`)

Implements `EnrollmentRepository`, including atomic concurrency methods:

```ts
import { eq, and, desc, count } from "drizzle-orm";
import type { EnrollmentRepository, Enrollment, Role } from "discendo-sdk/core";
import { db } from "../index";
import { enrollments } from "../schema";

export class DrizzleEnrollmentRepository implements EnrollmentRepository {
  async create(data: Omit<Enrollment, "id">): Promise<Enrollment> {
    const id = crypto.randomUUID();
    await db.insert(enrollments).values({
      id,
      userId: data.userId,
      sectionId: data.sectionId,
      role: data.role,
      status: data.status,
      enrolledAt: data.enrolledAt,
      droppedAt: data.droppedAt ?? null,
    });
    return { id, ...data };
  }

  async findById(id: string): Promise<Enrollment | null> {
    const row = await db.query.enrollments.findFirst({
      where: eq(enrollments.id, id),
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      sectionId: row.sectionId,
      role: row.role as Role,
      status: row.status as Enrollment["status"],
      enrolledAt: row.enrolledAt,
      ...(row.droppedAt ? { droppedAt: row.droppedAt } : {}),
    };
  }

  async update(id: string, patch: Partial<Enrollment>): Promise<Enrollment> {
    await db
      .update(enrollments)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.droppedAt !== undefined
          ? { droppedAt: patch.droppedAt }
          : {}),
      })
      .where(eq(enrollments.id, id));

    const updated = await this.findById(id);
    if (!updated) throw new Error(`Enrollment ${id} not found`);
    return updated;
  }

  // Must return the MOST RECENT record for a user in a section
  async findByUserAndSection(
    userId: string,
    sectionId: string,
  ): Promise<Enrollment | null> {
    const row = await db.query.enrollments.findFirst({
      where: and(
        eq(enrollments.userId, userId),
        eq(enrollments.sectionId, sectionId),
      ),
      orderBy: [desc(enrollments.enrolledAt)],
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      sectionId: row.sectionId,
      role: row.role as Role,
      status: row.status as Enrollment["status"],
      enrolledAt: row.enrolledAt,
      ...(row.droppedAt ? { droppedAt: row.droppedAt } : {}),
    };
  }

  async listBySection(
    sectionId: string,
    status?: Enrollment["status"],
  ): Promise<Enrollment[]> {
    const condition = status
      ? and(
          eq(enrollments.sectionId, sectionId),
          eq(enrollments.status, status),
        )
      : eq(enrollments.sectionId, sectionId);

    const rows = await db.query.enrollments.findMany({ where: condition });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      sectionId: row.sectionId,
      role: row.role as Role,
      status: row.status as Enrollment["status"],
      enrolledAt: row.enrolledAt,
      ...(row.droppedAt ? { droppedAt: row.droppedAt } : {}),
    }));
  }

  // Counts ONLY active enrollments
  async countActive(sectionId: string): Promise<number> {
    const [res] = await db
      .select({ count: count() })
      .from(enrollments)
      .where(
        and(
          eq(enrollments.sectionId, sectionId),
          eq(enrollments.status, "active"),
        ),
      );
    return res?.count ?? 0;
  }

  // Atomic seat acquisition
  async createIfSeatFree(
    data: Omit<Enrollment, "id">,
    capacity: number,
  ): Promise<Enrollment | null> {
    const active = await this.countActive(data.sectionId);
    if (active >= capacity) return null;
    return this.create(data);
  }

  // Atomic waitlist promotion
  async promoteIfSeatFree(
    enrollmentId: string,
    capacity: number,
  ): Promise<Enrollment | null> {
    const target = await this.findById(enrollmentId);
    if (!target || target.status !== "waitlisted") return null;
    const active = await this.countActive(target.sectionId);
    if (active >= capacity) return null;
    return this.update(enrollmentId, { status: "active" });
  }
}
```

---

## 4. Content Repository (`src/db/repositories/content.ts`)

Implements `ContentRepository` (`create`, `findById`, `listBySection`, `update`, `reorder`):

```ts
import { eq, asc } from "drizzle-orm";
import type {
  ContentRepository,
  ContentNode,
  ContentKind,
} from "discendo-sdk/core";
import { db } from "../index";
import { contentNodes } from "../schema";

export class DrizzleContentRepository implements ContentRepository {
  async findById(id: string): Promise<ContentNode | null> {
    const row = await db.query.contentNodes.findFirst({
      where: eq(contentNodes.id, id),
    });
    if (!row) return null;
    return {
      id: row.id,
      sectionId: row.sectionId,
      kind: row.kind as ContentKind,
      title: row.title,
      orderIndex: row.orderIndex,
      published: row.published,
      version: row.version,
      ...(row.parentId ? { parentId: row.parentId } : {}),
    };
  }

  async listBySection(sectionId: string): Promise<ContentNode[]> {
    const rows = await db.query.contentNodes.findMany({
      where: eq(contentNodes.sectionId, sectionId),
      orderBy: [asc(contentNodes.orderIndex)],
    });
    return rows.map((row) => ({
      id: row.id,
      sectionId: row.sectionId,
      kind: row.kind as ContentKind,
      title: row.title,
      orderIndex: row.orderIndex,
      published: row.published,
      version: row.version,
      ...(row.parentId ? { parentId: row.parentId } : {}),
    }));
  }

  async create(
    node: Omit<ContentNode, "id" | "version">,
  ): Promise<ContentNode> {
    const id = crypto.randomUUID();
    const version = 1;
    await db.insert(contentNodes).values({
      id,
      sectionId: node.sectionId,
      kind: node.kind,
      title: node.title,
      orderIndex: node.orderIndex,
      published: node.published,
      version,
      parentId: node.parentId ?? null,
      createdAt: new Date(),
    });
    return { id, version, ...node };
  }

  async update(id: string, patch: Partial<ContentNode>): Promise<ContentNode> {
    await db
      .update(contentNodes)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.orderIndex !== undefined
          ? { orderIndex: patch.orderIndex }
          : {}),
        ...(patch.published !== undefined
          ? { published: patch.published }
          : {}),
        ...(patch.version !== undefined ? { version: patch.version } : {}),
        ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      })
      .where(eq(contentNodes.id, id));

    const updated = await this.findById(id);
    if (!updated) throw new Error(`ContentNode ${id} not found`);
    return updated;
  }

  async reorder(sectionId: string, orderedIds: string[]): Promise<void> {
    for (let index = 0; index < orderedIds.length; index++) {
      const id = orderedIds[index]!;
      await db
        .update(contentNodes)
        .set({ orderIndex: index })
        .where(eq(contentNodes.id, id));
    }
  }
}
```

---

## 5. Term Repository (`src/db/repositories/terms.ts`)

Implements `TermRepository`:

```ts
import { eq } from "drizzle-orm";
import type { TermRepository, AcademicTerm } from "discendo-sdk/core";
import { db } from "../index";
import { academicTerms } from "../schema";

export class DrizzleTermRepository implements TermRepository {
  async findById(id: string): Promise<AcademicTerm | null> {
    const row = await db.query.academicTerms.findFirst({
      where: eq(academicTerms.id, id),
    });
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      ...(row.orgId ? { orgId: row.orgId } : {}),
    };
  }
}
```

---

## Next Steps

Now that persistence is completely wired, we will construct our service container in [Chapter 4: Wiring Services](/tutorial/04-wiring-services).
