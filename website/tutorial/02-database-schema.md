---
description: Design and define the relational database schema using Drizzle ORM to support Discendo SDK domain models.
---

# 2. Database Schema

Discendo SDK defines what data shapes look like in memory, but delegates storage to your database. In this chapter, we will design a relational schema with **Drizzle ORM** and SQLite that satisfies all SDK repository requirements.

---

## The Host vs SDK Data Boundary

Notice how the SDK models entities versus what your full application requires:

- **Users:** The SDK's `Identity` needs only `id`, `externalRef`, `roles`, and `orgId`. Your host application needs `email`, `passwordHash`, and `fullName`. We combine these into a single `users` table.
- **Course Sections:** Sections inherit `orgId` from their parent `Course`. We maintain a foreign key `course_sections.course_id -> courses.id`.
- **Enrollments:** Enrollments track `userId`, `sectionId`, `role`, and `status`. Dropping an enrollment sets `droppedAt`; records are never deleted.
- **Grades:** Grade entries store `supersededBy` to create an immutable audit trail.

---

## 1. Create the Schema File (`src/db/schema.ts`)

Create `src/db/schema.ts` and define the tables:

```ts
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

// 1. Organizations (Multi-tenant institutions)
export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// 2. Academic Terms (Calendars)
export const academicTerms = sqliteTable("academic_terms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  startsAt: integer("starts_at", { mode: "timestamp" }).notNull(),
  endsAt: integer("ends_at", { mode: "timestamp" }).notNull(),
  orgId: text("org_id").references(() => organizations.id),
});

// 3. Users (Host account details + SDK Identity fields)
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  externalRef: text("external_ref"),
  // Stored as JSON array: ['student', 'instructor', 'ta', 'admin']
  roles: text("roles", { mode: "json" }).$type<string[]>().notNull(),
  orgId: text("org_id").references(() => organizations.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// 4. Courses (Master course catalog)
export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  orgId: text("org_id").references(() => organizations.id),
  departmentId: text("department_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// 5. Course Sections (Specific scheduled cohorts)
export const courseSections = sqliteTable("course_sections", {
  id: text("id").primaryKey(),
  courseId: text("course_id")
    .notNull()
    .references(() => courses.id),
  termId: text("term_id").references(() => academicTerms.id),
  capacity: integer("capacity"), // null = unlimited seats
  status: text("status", { enum: ["draft", "published", "archived"] })
    .notNull()
    .default("draft"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// 6. Enrollments (User section roster join)
export const enrollments = sqliteTable("enrollments", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  sectionId: text("section_id")
    .notNull()
    .references(() => courseSections.id),
  role: text("role", {
    enum: ["student", "instructor", "ta", "admin"],
  }).notNull(),
  status: text("status", {
    enum: ["active", "waitlisted", "dropped", "completed"],
  }).notNull(),
  enrolledAt: integer("enrolled_at", { mode: "timestamp" }).notNull(),
  droppedAt: integer("dropped_at", { mode: "timestamp" }),
});

// 7. Content Nodes (Curriculum tree)
export const contentNodes = sqliteTable("content_nodes", {
  id: text("id").primaryKey(),
  sectionId: text("section_id")
    .notNull()
    .references(() => courseSections.id),
  kind: text("kind", {
    enum: ["page", "assignment", "quiz", "file", "link"],
  }).notNull(),
  title: text("title").notNull(),
  parentId: text("parent_id"),
  orderIndex: integer("order_index").notNull().default(0),
  published: integer("published", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// 8. Submissions (Student assessment turn-ins)
export const submissions = sqliteTable("submissions", {
  id: text("id").primaryKey(),
  contentId: text("contentId")
    .notNull()
    .references(() => contentNodes.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  payloadKind: text("payload_kind", {
    enum: ["text", "file", "url", "none", "quiz"],
  }).notNull(),
  payloadContent: text("payload_content").notNull(),
  attemptNumber: integer("attempt_number").notNull().default(1),
  submittedAt: integer("submitted_at", { mode: "timestamp" }).notNull(),
});

// 9. Grade Entries (Immutable grade ledger)
export const gradeEntries = sqliteTable("grade_entries", {
  id: text("id").primaryKey(),
  submissionId: text("submission_id")
    .notNull()
    .references(() => submissions.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  score: real("score").notNull(),
  maxScore: real("max_score").notNull(),
  graderId: text("grader_id").notNull(),
  gradedAt: integer("graded_at", { mode: "timestamp" }).notNull(),
  supersededBy: text("superseded_by"), // Points to newer entry upon regrade
});
```

---

## 2. Initialize the Database Connection (`src/db/index.ts`)

Connect Drizzle to Bun's native SQLite client in `src/db/index.ts`:

```ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

// Create or open the SQLite database file
const sqlite = new Database("sqlite.db");

// Enable WAL mode for high concurrent read/write performance
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite, { schema });
```

---

## 3. Configure Drizzle Kit (`drizzle.config.ts`)

Create `drizzle.config.ts` in your project root to manage database migrations:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: "sqlite.db",
  },
});
```

---

## 4. Push Schema to SQLite

Push your schema directly to the local SQLite database using Drizzle Kit:

```sh
bunx drizzle-kit push
```

You will see:

```
[✓] Changes applied successfully
```

---

## Next Steps

With our database tables live, we will implement the concrete Discendo repository interfaces in [Chapter 3: Implementing Repositories](/tutorial/03-repositories).
