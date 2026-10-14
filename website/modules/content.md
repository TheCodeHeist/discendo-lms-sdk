---
description: Learn how discendo-sdk/content manages course content trees, publishing versions, and prerequisite gating.
---

# Content

`discendo-sdk/content` models the structure of a course section: modules, pages, assignments, quizzes, files, and links. It governs the content hierarchy, tracks publishing versions, and evaluates prerequisite unlock conditions.

The SDK does not store raw file binaries or HTML bodies—those remain in your database or S3 bucket. Discendo manages the tree structure, ordering, and visibility rules.

---

## At a Glance

|                  |                                                         |
| ---------------- | ------------------------------------------------------- |
| **Import**       | `import { ContentService } from 'discendo-sdk/content'` |
| **Repositories** | `ContentRepository` (in `RepositoryContext`)            |
| **Events**       | `content.published`, `content.unpublished`              |
| **Permissions**  | `content.view`, `content.manage` (delegable to TAs)     |
| **Enforcement**  | Opt-in: `{ policy }` in options                         |

---

## Data Model (`ContentNode`)

```ts
type ContentKind = "page" | "assignment" | "quiz" | "file" | "link";

interface ContentNode {
  id: Id;
  sectionId: Id;
  kind: ContentKind;
  title: string;
  parentId?: Id; // Content is a tree; parents group items into modules
  orderIndex: number; // Sibling display order
  published: boolean; // false = draft hidden from students
  version: number; // Incremented on every publish/unpublish action
}
```

- **Tree Hierarchy:** A node with `parentId === undefined` is a root module or top-level item. Child nodes nest beneath parents.
- **Content Kind:** Tells other modules what the node represents. `assessment` treats `'assignment'` as a submission target and `'quiz'` as an interactive assessment.

---

## `ContentService`

```ts
new ContentService(
  repos: RepositoryContext,
  completion?: CompletionChecker,
  prerequisites: PrerequisiteEdge[] = [],
  events?: EventBus,
  options?: { policy?: PermissionPolicy }
)
```

### `createNode(node, actor?): Promise<ContentNode>`

Creates a new draft node (`published: false`, `version: 1`).

```ts
const module = await contentService.createNode(
  {
    sectionId: "sec-101",
    kind: "page",
    title: "Week 1: Introduction to Mechanics",
    orderIndex: 0,
  },
  { actorId: "u-instructor" },
);

const assignment = await contentService.createNode(
  {
    sectionId: "sec-101",
    kind: "assignment",
    title: "Lab 1 Report",
    parentId: module.id,
    orderIndex: 0,
  },
  { actorId: "u-instructor" },
);
```

- Requires `content.manage` in the section.
- If `parentId` is specified, it must belong to the same section.

### `publish(id, actor?): Promise<ContentNode>`

Makes a node visible to students (`published: true`).

```ts
await contentService.publish(node.id, { actorId: "u-instructor" });
```

- **Version Bumping:** Increments `version` on every call.
- Emits `content.published` with the updated version number.
- Requires `content.manage`.

### `unpublish(id, actor?): Promise<ContentNode>`

Hides a node from students (`published: false`). Increments `version` and emits `content.unpublished`.

### `reorder(sectionId, orderedIds, actor?): Promise<void>`

Updates sibling order indices:

```ts
await contentService.reorder("sec-101", ["node-3", "node-1", "node-2"], {
  actorId: "u-instructor",
});
```

- Requires `content.manage`.
- All IDs in `orderedIds` must belong to the given `sectionId`.

### `getNode(id, actor?): Promise<ContentNode | null>`

Loads a node with visibility checks:

- Staff (`admin`, `instructor`, `ta`) can view both draft and published nodes.
- Students can only view published nodes. Draft nodes throw `PermissionDeniedError` for students.

---

## Prerequisite Gating (`isUnlocked`)

You can lock content nodes until a student completes prerequisite nodes:

```ts
// Define completion checker against your database
const completionChecker: CompletionChecker = {
  isCompleted: async (userId, nodeId) => {
    return await myDb.completions.exists({ where: { userId, nodeId } });
  },
};

// Define prerequisite edges
const prerequisites: PrerequisiteEdge[] = [
  { sourceId: "node-week1", targetId: "node-week2" }, // Must finish Week 1 before Week 2 unlocks
];

const contentService = new ContentService(
  repos,
  completionChecker,
  prerequisites,
  bus,
  { policy },
);

// Check if a student can access Week 2:
const unlocked = await contentService.isUnlocked("node-week2", "u-student");
```

`isUnlocked` is a pure evaluation function that does not require an actor.

---

## Known Limitations

- **No recursive cascade delete:** The SDK does not manage cascading deletions of child trees.
- **Paywalled or timed unlock rules:** Gating is strictly based on `CompletionChecker` and explicit prerequisite edges. Time-based locking is handled by the [Calendar module](/modules/scheduling/calendar).
