# Content

`src/domains/content/` — the tree of material inside a section (pages,
assignments, quizzes, files, links): creating nodes, publishing them, ordering
them, and deciding whether a student has unlocked one. Subpath:
`discendo-sdk/content`.

This is the smallest of the domain modules, on purpose. The SDK does not store the
material itself (that is your database and your file store); it owns the *shape* of
a section's content and the rules around it.

## At a glance

| | |
| --- | --- |
| **You import** | `ContentService`, `ContentServiceOptions`, `PrerequisiteEdge`, `CompletionChecker` |
| **You implement** | `ContentRepository` (in `core`) and a `CompletionChecker` |
| **Emits events** | `content.published` |
| **Permission actions** | `content.view`, `content.manage` (delegable to a TA) |
| **Enforcement** | opt-in: the fifth constructor argument, `{ policy }` |

## The data (`core`)

```ts
type ContentKind = 'page' | 'assignment' | 'quiz' | 'file' | 'link';

interface ContentNode {
  id: Id;
  sectionId: Id;
  kind: ContentKind;
  title: string;
  parentId?: Id;        // content is a tree: a node may sit inside another
  orderIndex: number;   // position among its siblings
  published: boolean;   // false = a draft
  version: number;      // bumped each time it is published
}
```

The `kind` tells other modules what a node is for. Assessment treats an
`assignment` as something a student submits to and a `quiz` as something they
attempt (see [ASSESSMENT.md](./ASSESSMENT.md)). A node belongs to exactly one section,
and its organization is the organization of that section's course.

## `ContentService`

```ts
new ContentService(
  repos: RepositoryContext,
  completion: CompletionChecker,
  prerequisites: PrerequisiteEdge[] = [],
  events?: EventBus,
  options: ContentServiceOptions = {},     // { policy?: PermissionPolicy }
)
```

Every method except `isUnlocked` takes a trailing `actor?: { actorId }`. It is required
when `options.policy` is set and ignored otherwise.

### `createNode(node, actor?): Promise<ContentNode>`

Stores a new node (everything except `id` and `version`, which the repository
assigns) and returns it. Without enforcement it is a thin pass-through: it does **not**
check that the section or the parent exists, or that `orderIndex` is free.

**With enforcement** the actor needs `content.manage` in `node.sectionId`, and if
`parentId` is set it must be a node of **that same section** (otherwise a plain `Error`
about the parent, thrown after the permission check so a stranger learns nothing).

### `publish(id, actor?): Promise<ContentNode>`

Sets `published: true` and increments `version`, then emits `content.published`
with the new version. Throws `Content <id> not found` for an unknown id.

**Every call bumps the version**, even on a node that is already published, so
publishing twice gives versions 2 and 3. There is no way to unpublish through the
service.

**With enforcement** the actor needs `content.manage` in the node's section, taken from
the **stored node**. An unknown node is refused exactly like a forbidden one
(`PermissionDeniedError`, not "not found").

### `reorder(sectionId, orderedIds, actor?): Promise<void>`

Asks the repository to apply the given order to the section's nodes. Without enforcement
the service does not validate that the ids belong to the section.

**With enforcement** the actor needs `content.manage` in the section, and the list may
only name nodes **of that section**, each **at most once** (otherwise a plain `Error`,
after the permission check). It need not name every node, and an empty list is a no-op.

### `getNode(id, actor?): Promise<ContentNode>`

Reads one node. **With enforcement** the actor needs `content.view` in the node's
section, and **anyone who is not staff there is refused a draft**. Staff (admin,
instructor, TA) can read drafts. An unknown node is refused like a forbidden one.
Without enforcement it returns what the repository has, **drafts included**, and throws
`Content <id> not found` for an unknown id.

### `listNodes(sectionId, actor?): Promise<ContentNode[]>`

A section's nodes, in the repository's order. **With enforcement** the actor needs
`content.view` in the section; staff get every node, **everyone else only the published
ones**. The section's nodes are not even read for a refused caller. Without enforcement
it returns everything.

### `isUnlocked(userId, contentId): Promise<boolean>`

Whether a person has met the prerequisites for a node.

```ts
const prerequisites = [
  { contentId: 'quiz-2', requiresContentId: 'lesson-2' },
  { contentId: 'quiz-2', requiresContentId: 'quiz-1' },
];
const service = new ContentService(repos, completion, prerequisites);

await service.isUnlocked('stu-1', 'quiz-2');   // true only if BOTH are complete
```

- A node with no prerequisites is always unlocked.
- Prerequisites combine with **AND**: every edge naming the node must be complete.
- It checks **direct** prerequisites only. It does not check that the prerequisite is
  itself unlocked; if `c` requires `b` and `b` requires `a`, completing `b` is enough
  to unlock `c`, whether or not `a` is done. In practice a student cannot complete `b`
  without unlocking it, so this holds as long as your application gates completion.
- A cycle in the edges cannot hang it, since only one level is read.
- **It is not an access check.** It takes no actor and enforcement does not affect it: it
  only reads the edges and asks your `CompletionChecker`. Use `getNode` to decide whether
  someone may see a node at all.

## `CompletionChecker`

```ts
interface CompletionChecker {
  isComplete(userId: string, contentId: string): Promise<boolean>;
}
```

Whether a student has *completed* something is application knowledge (a viewed page,
a graded submission, a passed quiz), and the SDK owns no progress storage. You implement
this; the service only asks.

## `PrerequisiteEdge`

```ts
interface PrerequisiteEdge { contentId: string; requiresContentId: string }
```

One edge says "`contentId` requires `requiresContentId`". The edges are passed to the
constructor as a plain array.

## Events

`content.published` (`contentId`, `sectionId`, `version`) after each successful
`publish`. See [EVENTS.md](./EVENTS.md).

## Permissions

Turn enforcement on with `{ policy }` as the fifth constructor argument:

```ts
const content = new ContentService(repos, completion, edges, bus, { policy });

await content.createNode({ sectionId: 'sec-1', kind: 'page', title: 'Week 1', orderIndex: 1, published: false }, { actorId: teacher.id });
await content.publish(node.id, { actorId: teacher.id });
await content.listNodes('sec-1', { actorId: student.id });   // published nodes only
```

| Method | Action | Who |
| --- | --- | --- |
| `createNode`, `publish`, `reorder` | `content.manage` | admins and instructors of the section; a TA only when delegated (see [DELEGATION.md](./DELEGATION.md)) |
| `getNode`, `listNodes` | `content.view` | active members of the section, and completed students (read-only); **drafts for staff only** |

- **The section is the node's, never the caller's** (for `publish` and `getNode`), and a
  missing node, section or course is refused like a forbidden one, for every actor.
- **Reading needs an active student, or a completed one** (read-only, published nodes only);
  writing needs staff. Dropped and waitlisted students are refused. Guardians get nothing here.
- **The permission check comes first**, before the parent, the ids or any content are
  looked up, and nothing is looked up before the actor is known.
- Nothing is stored, changed or emitted for a refused call.
- Without `{ policy }` the service behaves exactly as it always has, except that it has
  two more methods, `getNode` and `listNodes`.

## Known limitations

- **A completed student can read published content, never drafts, and write nothing.**
  `getNode` and `listNodes` honor a completed student (see [PERMISSIONS.md](./PERMISSIONS.md));
  every write refuses them.
- **Without enforcement there are no checks**, and `getNode` / `listNodes` show drafts.
  Turn enforcement on, or filter by `published` yourself.
- **Only the service is guarded.** Your own code can still read and write the
  `ContentRepository` directly.
- **A node that is not unlocked is still readable.** `getNode` does not look at
  prerequisites: call `isUnlocked` yourself before showing it to a student.
- **`createNode` creates a node as published if you say so**, which skips the version bump
  and the `content.published` event that `publish` gives. Anyone who may manage content may
  do this.
- **The prerequisite edges are fixed at construction.** They are a constructor
  argument, not read from a repository, so changing them means building a new service
  with the new list, and a host with per-section prerequisites must supply them all.
- **No unpublish**, and no history of earlier versions beyond the counter.
- **Without enforcement, `createNode` and `reorder` do no validation** of sections,
  parents or ordering.
- **`isUnlocked` is direct-only and takes no account of dates.** Due dates and
  availability windows are in [CALENDAR.md](./CALENDAR.md).
- **`reorder` and `publish` are not atomic.** Two simultaneous calls can interleave.

## Tests

| File | Covers |
| --- | --- |
| `test/content-events.test.ts` | `content.published`, and working with no event bus |
| `test/content-permissions.test.ts` | every method with enforcement on (who may, delegation, drafts, completed students, parents, reorder ids, unknown and orphaned targets, check ordering, no lookups before the actor is known), `isUnlocked` (none, AND, direct-only, per person, cycles) and behaviour with enforcement off |
