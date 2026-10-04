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
| **You import** | `ContentService`, `PrerequisiteEdge`, `CompletionChecker` |
| **You implement** | `ContentRepository` (in `core`) and a `CompletionChecker` |
| **Emits events** | `content.published` |
| **Permission actions** | `content.view`, `content.manage` (delegable to a TA) |
| **Enforcement** | **not yet.** The actions exist; the service does not check them |

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
)
```

### `createNode(node): Promise<ContentNode>`

Stores a new node (everything except `id` and `version`, which the repository
assigns) and returns it. It is a thin pass-through: the service does **not** check
that the section or the parent exists, or that `orderIndex` is free.

### `publish(id): Promise<ContentNode>`

Sets `published: true` and increments `version`, then emits `content.published`
with the new version. Throws `Content <id> not found` for an unknown id.

**Every call bumps the version**, even on a node that is already published, so
publishing twice gives versions 2 and 3. There is no way to unpublish through the
service.

### `reorder(sectionId, orderedIds): Promise<void>`

Asks the repository to apply the given order to the section's nodes. The service
does not validate that the ids belong to the section.

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

The rules exist and are final, but `ContentService` does not enforce them yet:

| Action | Default |
| --- | --- |
| `content.view` | admin, instructor, ta, student |
| `content.manage` | admin, instructor; **delegable** to a TA |

Until the service enforces them, check `content.manage` yourself before calling
`createNode`, `publish` or `reorder`, using the policy directly (see
[PERMISSIONS.md](./PERMISSIONS.md)). The assessment module already follows the
convention content will adopt: **only staff may see a node that is not published.**

## Known limitations

- **No permission enforcement yet.** Anyone who can reach the service can create,
  publish and reorder.
- **The prerequisite edges are fixed at construction.** They are a constructor
  argument, not read from a repository, so changing them means building a new service
  with the new list, and a host with per-section prerequisites must supply them all.
- **No unpublish**, and no history of earlier versions beyond the counter.
- **`createNode` and `reorder` do no validation** of sections, parents or ordering.
- **`isUnlocked` is direct-only and takes no account of dates.** Due dates and
  availability windows are in [CALENDAR.md](./CALENDAR.md).
- **Thin test coverage.** Only the `content.published` event is tested.
  `createNode`, `reorder` and `isUnlocked` have no tests of their own; the behaviour
  above was checked by reading the code and by running it directly.

## Tests

`test/content-events.test.ts` — `content.published`, and working with no event bus.
