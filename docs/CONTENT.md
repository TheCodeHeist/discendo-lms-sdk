# Content

`src/domains/content/` — the tree of material inside a section (pages,
assignments, quizzes, files, links): creating nodes, publishing them, ordering
them, editing them with a full version history, giving them dates, and deciding whether a
student may open one yet. Subpath: `discendo-sdk/content`.

The SDK does not store the material itself (that is your database and your file store); it
owns the *shape* of a section's content and the rules around it: who may see and change what,
in which order, from when to when, and after what.

## At a glance

| | |
| --- | --- |
| **You import** | `ContentService`, `ContentServiceOptions`, `PrerequisiteEdge`, `CompletionChecker`, `InvalidContentChangeError`, `InvalidPrerequisiteError`; from `core`, `contentAvailability` and `ContentNotAvailableError` |
| **You implement** | `ContentRepository` (in `core`) and a `CompletionChecker`; optionally a `ContentRevisionRepository` (history) and a `ContentPrerequisiteRepository` (prerequisites staff can change) |
| **Emits events** | `content.published`, `content.unpublished`, `content.updated` |
| **Permission actions** | `content.view`, `content.manage` (delegable to a TA) |
| **Enforcement** | opt-in: a `policy` in the constructor's config |

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
  version: number;      // 1 when created; +1 for every publish, unpublish and edit
  availableFrom?: Date; // UTC: before this a student cannot open it or submit to it
  availableUntil?: Date;// UTC: after this a student can still read it, but not submit to it
  dueAt?: Date;         // UTC: when it is due (informational; see "Dates" below)
}
```

The `kind` tells other modules what a node is for. Assessment treats an
`assignment` as something a student submits to and a `quiz` as something they
attempt (see [ASSESSMENT.md](./ASSESSMENT.md)). A node belongs to exactly one section,
and its organization is the organization of that section's course.

## `ContentService`

```ts
new ContentService({
  repos: RepositoryContext & {
    contentRevisions?: ContentRevisionRepository;       // turns the version history on
    contentPrerequisites?: ContentPrerequisiteRepository;   // prerequisites staff can change
  };
  completion: CompletionChecker;
  fixedPrerequisites?: PrerequisiteEdge[];   // prerequisites that never change while running
  policy?: PermissionPolicy;
  events?: EventBus;
})
```

| Option | Turns on |
| --- | --- |
| `policy` | permission enforcement (see "Permissions") |
| `revisions` | a `ContentRevisionRepository`: the version history (`listRevisions`, `restoreRevision`) |
| `prerequisites` | a `ContentPrerequisiteRepository`: prerequisites staff add and remove while running (`addPrerequisite`, `removePrerequisite`). Edges passed to the constructor count as well |

Every method except `isUnlocked` and `checkAccess` takes a trailing `actor?: { actorId }`. It is
required when a `policy` is set and ignored otherwise.

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
publishing twice gives versions 2 and 3. To hide content again, call `unpublish`.

**With enforcement** the actor needs `content.manage` in the node's section, taken from
the **stored node**. An unknown node is refused exactly like a forbidden one
(`PermissionDeniedError`, not "not found").

### `unpublish(id, actor?): Promise<ContentNode>`

Sets `published: false` and increments `version`, then emits `content.unpublished`
with the new version. Throws `Content <id> not found` for an unknown id.

**Every call bumps the version**, even on a node that is already unpublished.

**With enforcement** the actor needs `content.manage` in the node's section, taken from
the **stored node**. An unknown node is refused exactly like a forbidden one
(`PermissionDeniedError`, not "not found").

### `reorder(sectionId, orderedIds, actor?): Promise<void>`

Asks the repository to apply the given order to the section's nodes. Without enforcement
the service does not validate that the ids belong to the section.

**With enforcement** the actor needs `content.manage` in the section, and the list may
only name nodes **of that section**, each **at most once** (otherwise a plain `Error`,
after the permission check). It need not name every node, and an empty list is a no-op.

### `updateNode(id, patch, actor?): Promise<ContentNode>`

Edits a node's `title`, `kind`, `parentId`, `availableFrom`, `availableUntil` or `dueAt` (`null`
clears a date or the parent) and **bumps its version**. Students may now see something different.
It throws `InvalidContentChangeError` for:

- an empty title;
- dates out of order (`availableFrom` <= `dueAt` <= `availableUntil`, for whichever are set);
- a parent that is in another section, or is the node itself or below it.

A patch that changes nothing returns the node unchanged, with no new version. Emits
`content.updated` with the `changedFields`. Needs `content.manage`. `createNode` checks the dates in
the same way.

### `getNode(id, actor?): Promise<ContentNode>`

Reads one node. **With enforcement** the actor needs `content.view` in the node's
section, **anyone who is not staff there is refused a draft**, and a student gets
**`ContentNotAvailableError`** for a node that has not opened yet (`availableFrom`). Staff (admin,
instructor, TA) can read drafts. An unknown node is refused like a forbidden one.
Without enforcement it returns what the repository has, **drafts included**, and throws
`Content <id> not found` for an unknown id.

### `listNodes(sectionId, actor?): Promise<ContentNode[]>`

A section's nodes, in the repository's order. **With enforcement** the actor needs
`content.view` in the section; staff get every node, **everyone else only the published
ones**. The section's nodes are not even read for a refused caller. Without enforcement
it returns everything.

A node that has not opened yet is **still listed**, with its dates, so a page can show what is coming.
`getNode` is what refuses to open it.

### Version history: `listRevisions(id, actor?)` and `restoreRevision(id, version, actor?)`

With the `revisions` option, every create, edit, publish and unpublish appends a `ContentRevision`.
Each revision is a **full snapshot** of the node right after the change, with `version`, `change`
(`created`, `updated`, `published` or `unpublished`), `changedFields` for an edit, `changedBy` and
`changedAt`. Nothing in the history is ever changed or removed.

- `listRevisions` returns them oldest first. **Staff only** (`content.manage`): earlier wording and
  drafts are not for students.
- `restoreRevision` brings back an earlier version's title, kind, parent and dates **as a new edit**,
  with a new version, so the history keeps both. It leaves `published` alone: use `publish` or
  `unpublish` for that. It has the same permission as `updateNode`. An unknown version throws
  `InvalidContentChangeError`.

```ts
interface ContentRevisionRepository {
  append(revision: Omit<ContentRevision, 'id'>): Promise<ContentRevision>;
  listForContent(contentId: string): Promise<ContentRevision[]>;   // oldest version first
}
```

### Prerequisites: `addPrerequisite`, `removePrerequisite`, `listPrerequisites`

With the `prerequisites` option, staff (`content.manage`) can add and remove prerequisites while the
service runs, so they are no longer fixed when it is built. `addPrerequisite(contentId,
requiresContentId, actor?)` throws `InvalidPrerequisiteError` for:

- a node requiring itself;
- a node of another section;
- an edge that would **close a cycle**, directly or through other edges, the constructor's included.

Adding an edge that already exists returns it. `removePrerequisite` returns whether there was one.
`listPrerequisites(contentId, actor?)` gives what a node requires, stored and constructor edges
together, to anyone with `content.view` in the section.

```ts
interface ContentPrerequisiteRepository {
  add(edge: Omit<StoredPrerequisiteEdge, 'id'>): Promise<StoredPrerequisiteEdge>;
  remove(contentId: string, requiresContentId: string): Promise<boolean>;
  listForContent(contentId: string): Promise<StoredPrerequisiteEdge[]>;   // what it requires
  listForSection(sectionId: string): Promise<StoredPrerequisiteEdge[]>;
}
```

### Dates and `checkAccess(userId, contentId, { now? }): Promise<ContentAccess>`

A node's dates put it in one of three states, worked out by the pure `contentAvailability(node, now?)`
from `core`. Both ends are inclusive.

| State | When | A student |
| --- | --- | --- |
| `not-yet-open` | before `availableFrom` | sees it listed, cannot open it, cannot submit or start a quiz |
| `open` | otherwise | can open it and work on it |
| `closed` | after `availableUntil` | can still read it, cannot submit, start a quiz or save quiz answers |

The dates are enforced for students, with enforcement on, by `getNode` and by assessment's
`submit`, `generateAttempt` and `saveAnswer`, each throwing `ContentNotAvailableError` (with
`availability`). Staff are never refused for dates. **A quiz attempt already started can still
be submitted after its quiz closes**, with the answers saved in time. `dueAt` is information only:
work handed in after it is accepted until `availableUntil`. Whether it is late, and the penalty,
are yours to decide with `daysLate` and `applyLatePolicy` (see [GRADING.md](./GRADING.md)).

`checkAccess` answers "can this student open this, and submit to it, right now, and if not, why?"
in one call. It returns `canOpen`, `canSubmit`, `published`, `availability`, the
`missingPrerequisites` (the ones they have not completed) and the node's dates. Like `isUnlocked` it
takes no actor: it answers a question and shows nothing. Pass `now` to ask about another moment.

### `isUnlocked(userId, contentId): Promise<boolean>`

Whether a person has met the prerequisites for a node.

```ts
const prerequisites = [
  { contentId: 'quiz-2', requiresContentId: 'lesson-2' },
  { contentId: 'quiz-2', requiresContentId: 'quiz-1' },
];
const service = new ContentService({ repos, completion, fixedPrerequisites: prerequisites });

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
  someone may see a node at all, and `checkAccess` for prerequisites and dates together.

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

One edge says "`contentId` requires `requiresContentId`". Edges passed to the constructor as a
plain array are fixed for the life of the service; stored ones (above) can change. Both count.

## Events

`content.published` and `content.unpublished` (`contentId`, `sectionId`, `version`) after each
successful `publish` and `unpublish`, and `content.updated` (`contentId`, `sectionId`, `version`,
`changedFields`, `updatedBy?`) after each edit that changed something, a restore included. See
[EVENTS.md](./EVENTS.md).

## Permissions

Turn enforcement on with a `policy`:

```ts
const content = new ContentService({ repos, completion, events: bus, policy });

await content.createNode({ sectionId: 'sec-1', kind: 'page', title: 'Week 1', orderIndex: 1, published: false }, { actorId: teacher.id });
await content.publish(node.id, { actorId: teacher.id });
await content.listNodes('sec-1', { actorId: student.id });   // published nodes only
```

| Method | Action | Who |
| --- | --- | --- |
| `createNode`, `updateNode`, `publish`, `unpublish`, `reorder`, `listRevisions`, `restoreRevision`, `addPrerequisite`, `removePrerequisite` | `content.manage` | admins and instructors of the section; a TA only when delegated (see [DELEGATION.md](./DELEGATION.md)) |
| `getNode`, `listNodes`, `listPrerequisites` | `content.view` | active members of the section, and completed students (read-only); **drafts for staff only**; a student cannot open a node before it opens |

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
- **A node that is not unlocked is still readable.** `getNode` looks at dates, not at
  prerequisites: call `checkAccess` (or `isUnlocked`) yourself before showing it to a student.
  Assessment does not check prerequisites before a submission either.
- **`createNode` creates a node as published if you say so**, which skips the version bump
  and the `content.published` event that `publish` gives. Anyone who may manage content may
  do this.
- **Without the `prerequisites` option, the edges are fixed at construction.** With it, staff can
  change them while running; the constructor's edges still cannot be removed that way.
- **Without the `revisions` option there is no history** beyond the `version` counter.
- **The history is of the node, not of your material.** A snapshot holds the node's fields (title,
  kind, parent, dates, published). The text or file behind it lives in your store, so keep your own
  versions of it if you need them. The node's `version` is a good key for that.
- **Versions are not atomic.** Two edits at the same moment can both read version 3 and both write
  version 4. Make your repository's `update` refuse a stale version if that matters.
- **`dueAt` is not enforced.** Lateness and penalties are yours to decide (see "Dates").
- **Without enforcement, `createNode` and `reorder` do no validation** of sections,
  parents or ordering.
- **`isUnlocked` is direct-only and takes no account of dates.** `checkAccess` adds the
  dates; it is direct-only for prerequisites too.
- **`reorder` and `publish` are not atomic.** Two simultaneous calls can interleave.

## Tests

| File | Covers |
| --- | --- |
| `test/content-events.test.ts` | `content.published`, `content.unpublished`, and working with no event bus |
| `test/content-history.test.ts` | `contentAvailability`; `updateNode` (version, event, clearing, no-op, validation of title, dates and parents, staff only); the history (every change recorded, restoring as a new edit, staff only); stored prerequisites (add, remove, `isUnlocked`, self, cross-section and cycle refusals, idempotence, staff only); `checkAccess`; dates enforced by `getNode` and by assessment (submitting early or late, a quiz closing mid-attempt) |
| `test/content-permissions.test.ts` | every method with enforcement on (who may, delegation, drafts, completed students, parents, reorder ids, unknown and orphaned targets, check ordering, no lookups before the actor is known), `isUnlocked` (none, AND, direct-only, per person, cycles) and behaviour with enforcement off |
