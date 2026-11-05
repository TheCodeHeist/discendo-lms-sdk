import type { ContentNodeUpdate, RepositoryContext } from "../../core/repositories.js";
import type { ContentNode } from "../../core/types.js";
import type { EventBus } from "../../core/events.js";
import type {
  Action,
  ActorContext,
  PermissionPolicy,
} from "../../core/permissions.js";
import { authorizeInSection, isStaff } from "../../core/authorization.js";
import type { Authorized } from "../../core/authorization.js";
import { PermissionDeniedError } from "../../core/permissions.js";
import { ContentNotAvailableError, contentAvailability } from "../../core/content-availability.js";
import { InvalidContentChangeError, InvalidPrerequisiteError } from "./types.js";
import type {
  ContentAccess,
  ContentChange,
  ContentNodePatch,
  ContentPrerequisiteRepository,
  ContentRevision,
  ContentRevisionRepository,
  PrerequisiteEdge,
  StoredPrerequisiteEdge,
} from "./types.js";

/** Host app supplies completion state — the SDK doesn't own progress storage here. */
export interface CompletionChecker {
  isComplete(userId: string, contentId: string): Promise<boolean>;
}

export interface ContentServiceOptions {
  /**
   * Turns on permission enforcement. Once set, every public method that touches content
   * (everything except `isUnlocked` and `checkAccess`) requires an `{ actorId }` argument and refuses
   * to run without one. Leave it unset and the service behaves as it always has: no actor, no checks.
   */
  policy?: PermissionPolicy;
  /**
   * Keep a revision (a full snapshot) of every create, edit, publish and unpublish, so a node's
   * history can be read (`listRevisions`) and an earlier version brought back (`restoreRevision`).
   * Without it only the `version` counter is kept.
   */
  revisions?: ContentRevisionRepository;
  /**
   * Store prerequisites, so staff can add and remove them while the service runs
   * (`addPrerequisite`, `removePrerequisite`). Edges passed to the constructor still count too.
   */
  prerequisites?: ContentPrerequisiteRepository;
}

/** The fields a revision of kind `updated` can name. */
const EDITABLE = ["title", "kind", "parentId", "availableFrom", "availableUntil", "dueAt"] as const;

export class ContentService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly completion: CompletionChecker,
    private readonly fixedPrerequisites: PrerequisiteEdge[] = [],
    private readonly events?: EventBus,
    private readonly options: ContentServiceOptions = {},
  ) {}

  /**
   * Stores a new node (version 1). With enforcement on (`actor` required) the actor needs
   * `content.manage` in the node's section, and a `parentId` must be a node of that same section.
   * Its dates must be in order (`availableFrom` <= `dueAt` <= `availableUntil`, where set), or it
   * throws `InvalidContentChangeError`.
   */
  async createNode(
    node: Omit<ContentNode, "id" | "version">,
    actor?: ActorContext,
  ): Promise<ContentNode> {
    if (this.options.policy) {
      await this.authorizeOn("content.manage", actor, node.sectionId);
      if (node.parentId !== undefined) {
        const parent = await this.repos.content.findById(node.parentId);
        if (!parent || parent.sectionId !== node.sectionId) {
          throw new Error(
            `The parent node ${node.parentId} must exist in the same section`,
          );
        }
      }
    }
    checkDates(node);
    const created = await this.repos.content.create(node);
    await this.recordRevision(created, "created", actor);
    return created;
  }

  /**
   * Changes a node's title, kind, parent or dates (`null` clears a date or the parent), and bumps its
   * version: students may see something different now. With enforcement on the actor needs
   * `content.manage` in the node's section. A title must not be empty, the dates must stay in order,
   * and the parent must be a node of the same section that is not the node itself or below it
   * (`InvalidContentChangeError`). A patch that changes nothing returns the node unchanged, with no
   * new version. Emits `content.updated` with the fields that changed.
   */
  async updateNode(id: string, patch: ContentNodePatch, actor?: ActorContext): Promise<ContentNode> {
    const { current, auth } = await this.loadForManage(id, actor);
    const next = applyPatch(current, patch);
    const changed = EDITABLE.filter((f) => !sameValue(current[f], next[f]));
    if (changed.length === 0) return current;

    if (next.title.trim() === "") throw new InvalidContentChangeError("A title cannot be empty");
    checkDates(next);
    if (changed.includes("parentId") && next.parentId !== undefined) await this.checkParent(current, next.parentId);

    const patchToStore: ContentNodeUpdate = { version: current.version + 1 };
    for (const f of changed) Object.assign(patchToStore, { [f]: next[f] }); // undefined clears it
    const updated = await this.repos.content.update(id, patchToStore);
    await this.recordRevision(updated, "updated", actor, changed);

    const orgId = await this.orgIdOf(auth, updated.sectionId);
    void this.events?.emit({
      type: "content.updated",
      contentId: updated.id,
      sectionId: updated.sectionId,
      version: updated.version,
      changedFields: changed,
      ...(actor ? { updatedBy: actor.actorId } : {}),
      ...(orgId !== undefined ? { orgId } : {}),
    });
    return updated;
  }

  /**
   * Publishes a node (and bumps its version). With enforcement on the actor needs `content.manage`
   * in the node's section, which comes from the stored node; an unknown node is refused exactly
   * like a forbidden one.
   */
  async publish(id: string, actor?: ActorContext): Promise<ContentNode> {
    return this.setPublished(id, true, actor);
  }

  /**
   * Unpublishes a node (and bumps its version). With enforcement on the actor needs `content.manage`
   * in the node's section, which comes from the stored node; an unknown node is refused exactly
   * like a forbidden one.
   */
  async unpublish(id: string, actor?: ActorContext): Promise<ContentNode> {
    return this.setPublished(id, false, actor);
  }

  /**
   * Applies an order to a section's nodes. With enforcement on the actor needs `content.manage`
   * in the section, and the list may only name nodes of that section, each at most once.
   */
  async reorder(
    sectionId: string,
    orderedIds: string[],
    actor?: ActorContext,
  ): Promise<void> {
    if (this.options.policy) {
      await this.authorizeOn("content.manage", actor, sectionId);
      const own = new Set(
        (await this.repos.content.listBySection(sectionId)).map((n) => n.id),
      );
      const seen = new Set<string>();
      for (const id of orderedIds) {
        if (!own.has(id))
          throw new Error(`Node ${id} is not part of section ${sectionId}`);
        if (seen.has(id))
          throw new Error(`Node ${id} appears more than once in the order`);
        seen.add(id);
      }
    }
    return this.repos.content.reorder(sectionId, orderedIds);
  }

  /**
   * Reads one node. With enforcement on (`actor` required) the actor needs `content.view` in the
   * node's section, and anyone who is not staff there is refused a node that is not published, and
   * gets `ContentNotAvailableError` for one that has not opened yet (`availableFrom`). Without
   * enforcement it returns whatever the repository has, drafts included.
   */
  async getNode(id: string, actor?: ActorContext): Promise<ContentNode> {
    if (!this.options.policy) {
      const node = await this.repos.content.findById(id);
      if (!node) throw new Error(`Content ${id} not found`);
      return node;
    }
    const node = actor ? await this.repos.content.findById(id) : null;
    const auth = await this.authorizeOn("content.view", actor, node?.sectionId);
    // authorizeOn has already refused a missing node, so there is one here.
    if (isStaff(auth.ctx)) return node!;
    if (!node!.published) throw this.denied("content.view");
    if (contentAvailability(node!) === "not-yet-open") throw new ContentNotAvailableError(node!.id, "not-yet-open");
    return node!;
  }

  /**
   * Lists a section's nodes in the repository's order. With enforcement on (`actor` required)
   * the actor needs `content.view` in the section, and anyone who is not staff there gets only
   * the published nodes. A node that has not opened yet is still listed, with its dates, so a page
   * can show what is coming; `getNode` refuses to open it. Without enforcement it returns everything.
   */
  async listNodes(
    sectionId: string,
    actor?: ActorContext,
  ): Promise<ContentNode[]> {
    if (!this.options.policy)
      return this.repos.content.listBySection(sectionId);
    const auth = await this.authorizeOn("content.view", actor, sectionId);
    const nodes = await this.repos.content.listBySection(sectionId);
    return isStaff(auth.ctx) ? nodes : nodes.filter((n) => n.published);
  }

  // ---- history ----

  /**
   * Every revision of a node, oldest (version 1) first: a full snapshot after each create, edit,
   * publish and unpublish, with who did it and when. Needs the `revisions` option. With enforcement
   * on, staff only (`content.manage`): drafts and earlier wording are not for students.
   */
  async listRevisions(id: string, actor?: ActorContext): Promise<ContentRevision[]> {
    await this.loadForManage(id, actor);
    return this.revisionStore().listForContent(id);
  }

  /**
   * Brings back the title, kind, parent and dates of an earlier version, as a new edit (so a new
   * version; nothing in the history is changed). Whether the node is published is not touched: use
   * `publish` and `unpublish` for that. Same permission as `updateNode`.
   */
  async restoreRevision(id: string, version: number, actor?: ActorContext): Promise<ContentNode> {
    await this.loadForManage(id, actor);
    const revision = (await this.revisionStore().listForContent(id)).find((r) => r.version === version);
    if (!revision) throw new InvalidContentChangeError(`Content ${id} has no version ${version}`);
    const s = revision.snapshot;
    return this.updateNode(
      id,
      {
        title: s.title,
        kind: s.kind,
        parentId: s.parentId ?? null,
        availableFrom: s.availableFrom ?? null,
        availableUntil: s.availableUntil ?? null,
        dueAt: s.dueAt ?? null,
      },
      actor,
    );
  }

  // ---- prerequisites ----

  /**
   * Requires `requiresContentId` to be complete before `contentId` can be opened. Needs the
   * `prerequisites` option. Both must be nodes of the same section, not the same node, and the edge
   * must not close a cycle (`InvalidPrerequisiteError`). Adding one that exists returns it. With
   * enforcement on, needs `content.manage` in the section.
   */
  async addPrerequisite(
    contentId: string,
    requiresContentId: string,
    actor?: ActorContext,
  ): Promise<StoredPrerequisiteEdge> {
    const store = this.prerequisiteStore();
    const { current } = await this.loadForManage(contentId, actor);
    if (contentId === requiresContentId) throw new InvalidPrerequisiteError("Content cannot require itself");
    const required = await this.repos.content.findById(requiresContentId);
    if (!required || required.sectionId !== current.sectionId) {
      throw new InvalidPrerequisiteError("A prerequisite must be content of the same section");
    }
    const existing = (await store.listForContent(contentId)).find((e) => e.requiresContentId === requiresContentId);
    if (existing) return existing;

    const edges = [...this.fixedPrerequisites, ...(await store.listForSection(current.sectionId))];
    if (reaches(edges, requiresContentId, contentId)) {
      throw new InvalidPrerequisiteError(`That would make a cycle: ${requiresContentId} already requires ${contentId}`);
    }
    return store.add({
      contentId,
      requiresContentId,
      sectionId: current.sectionId,
      createdAt: new Date(),
      ...(actor ? { createdBy: actor.actorId } : {}),
    });
  }

  /** Removes a stored prerequisite; returns whether there was one. Same permission as `addPrerequisite`. */
  async removePrerequisite(contentId: string, requiresContentId: string, actor?: ActorContext): Promise<boolean> {
    const store = this.prerequisiteStore();
    await this.loadForManage(contentId, actor);
    return store.remove(contentId, requiresContentId);
  }

  /**
   * What a node requires (content ids): the stored prerequisites and the ones given to the
   * constructor. With enforcement on, needs `content.view` in its section.
   */
  async listPrerequisites(contentId: string, actor?: ActorContext): Promise<string[]> {
    if (this.options.policy) {
      const node = actor ? await this.repos.content.findById(contentId) : null;
      await this.authorizeOn("content.view", actor, node?.sectionId);
    }
    return this.requiredFor(contentId);
  }

  /**
   * Simple DAG check — walk direct prerequisites, no need for a full graph library. This is a
   * pure question about the edges and the completion checker, not an access check: it takes no
   * actor and is not affected by enforcement. It looks at prerequisites only, not dates; see
   * `checkAccess` for both.
   */
  async isUnlocked(userId: string, contentId: string): Promise<boolean> {
    return (await this.missingPrerequisites(userId, contentId)).length === 0;
  }

  /**
   * Whether a student can open a piece of content now, and submit to it, and if not, why: whether
   * it is published, where its dates put it (`not-yet-open`, `open`, `closed`), and which
   * prerequisites they have not completed. Like `isUnlocked` it takes no actor (it answers a
   * question, it does not show the content); pass `now` to ask about another moment.
   */
  async checkAccess(userId: string, contentId: string, options: { now?: Date } = {}): Promise<ContentAccess> {
    const node = await this.repos.content.findById(contentId);
    if (!node) throw new Error(`Content ${contentId} not found`);
    const availability = contentAvailability(node, options.now);
    const missingPrerequisites = await this.missingPrerequisites(userId, contentId);
    const canOpen = node.published && availability !== "not-yet-open" && missingPrerequisites.length === 0;
    return {
      canOpen,
      canSubmit: canOpen && availability === "open",
      published: node.published,
      availability,
      missingPrerequisites,
      ...(node.availableFrom ? { availableFrom: node.availableFrom } : {}),
      ...(node.availableUntil ? { availableUntil: node.availableUntil } : {}),
      ...(node.dueAt ? { dueAt: node.dueAt } : {}),
    };
  }

  // ---- internals ----

  private async setPublished(id: string, published: boolean, actor: ActorContext | undefined): Promise<ContentNode> {
    const { current, auth } = await this.loadForManage(id, actor);
    const updated = await this.repos.content.update(id, {
      published,
      version: current.version + 1,
    });
    await this.recordRevision(updated, published ? "published" : "unpublished", actor);

    const orgId = await this.orgIdOf(auth, updated.sectionId);
    void this.events?.emit({
      type: published ? "content.published" : "content.unpublished",
      contentId: updated.id,
      sectionId: updated.sectionId,
      version: updated.version,
      ...(orgId !== undefined ? { orgId } : {}),
    });
    return updated;
  }

  /**
   * Loads a node for a change. With enforcement the actor needs `content.manage` in the stored
   * node's section; the node is looked up only once there is an actor, and an unknown node is
   * refused exactly like a forbidden one.
   */
  private async loadForManage(
    id: string,
    actor: ActorContext | undefined,
  ): Promise<{ current: ContentNode; auth: Authorized | undefined }> {
    let current: ContentNode | null;
    let auth: Authorized | undefined;
    if (this.options.policy) {
      current = actor ? await this.repos.content.findById(id) : null;
      auth = await this.authorizeOn("content.manage", actor, current?.sectionId);
    } else {
      current = await this.repos.content.findById(id);
    }
    if (!current) throw new Error(`Content ${id} not found`);
    return { current, auth };
  }

  private async checkParent(node: ContentNode, parentId: string): Promise<void> {
    const parent = await this.repos.content.findById(parentId);
    if (!parent || parent.sectionId !== node.sectionId) {
      throw new InvalidContentChangeError(`The parent node ${parentId} must exist in the same section`);
    }
    // Walk up from the new parent: meeting the node itself means it would sit below itself.
    const seen = new Set<string>();
    for (let at: ContentNode | null = parent; at; at = at.parentId ? await this.repos.content.findById(at.parentId) : null) {
      if (at.id === node.id) throw new InvalidContentChangeError("A node cannot be moved under itself");
      if (seen.has(at.id)) break;
      seen.add(at.id);
    }
  }

  private async recordRevision(
    node: ContentNode,
    change: ContentChange,
    actor: ActorContext | undefined,
    changedFields?: string[],
  ): Promise<void> {
    const store = this.options.revisions;
    if (!store) return;
    await store.append({
      contentId: node.id,
      sectionId: node.sectionId,
      version: node.version,
      change,
      ...(changedFields ? { changedFields } : {}),
      snapshot: structuredClone(node),
      ...(actor ? { changedBy: actor.actorId } : {}),
      changedAt: new Date(),
    });
  }

  private async requiredFor(contentId: string): Promise<string[]> {
    const fixed = this.fixedPrerequisites.filter((e) => e.contentId === contentId).map((e) => e.requiresContentId);
    const stored = this.options.prerequisites
      ? (await this.options.prerequisites.listForContent(contentId)).map((e) => e.requiresContentId)
      : [];
    return [...new Set([...fixed, ...stored])];
  }

  private async missingPrerequisites(userId: string, contentId: string): Promise<string[]> {
    const missing: string[] = [];
    for (const required of await this.requiredFor(contentId)) {
      if (!(await this.completion.isComplete(userId, required))) missing.push(required);
    }
    return missing;
  }

  private revisionStore(): ContentRevisionRepository {
    if (!this.options.revisions) throw new Error("Content history needs a ContentRevisionRepository (options.revisions)");
    return this.options.revisions;
  }

  private prerequisiteStore(): ContentPrerequisiteRepository {
    if (!this.options.prerequisites) {
      throw new Error("Changing prerequisites needs a ContentPrerequisiteRepository (options.prerequisites)");
    }
    return this.options.prerequisites;
  }

  private async orgIdOf(auth: Authorized | undefined, sectionId: string): Promise<string | undefined> {
    return auth?.ctx.resourceOrgId ?? auth?.ctx.actor.orgId ?? (await this.orgIdOfSection(sectionId));
  }

  private async orgIdOfSection(sectionId: string): Promise<string | undefined> {
    const sec = await this.repos.courses.findSection(sectionId);
    if (!sec) return undefined;
    const course = await this.repos.courses.findCourse(sec.courseId);
    return course?.orgId;
  }

  private authorizeOn(
    action: Action,
    actor: ActorContext | undefined,
    sectionId: string | undefined,
  ): Promise<Authorized> {
    // Only reading opts in: a completed student keeps read-only access to published content.
    return authorizeInSection(this.options.policy!, this.repos, action, actor, {
      sectionId,
      afterCompletion: action === "content.view",
    });
  }

  private denied(action: Action): Error {
    return new PermissionDeniedError(action);
  }
}

/** The node with the patch applied: `null` clears, `undefined` leaves alone. */
function applyPatch(node: ContentNode, patch: ContentNodePatch): ContentNode {
  const next: ContentNode = { ...node };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.parentId === null) delete next.parentId;
  else if (patch.parentId !== undefined) next.parentId = patch.parentId;
  for (const field of ["availableFrom", "availableUntil", "dueAt"] as const) {
    const value = patch[field];
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  return next;
}

/** `availableFrom` <= `dueAt` <= `availableUntil`, for whichever are set, and each a real date. */
function checkDates(node: Pick<ContentNode, "availableFrom" | "availableUntil" | "dueAt">): void {
  const dates: Array<[string, Date | undefined]> = [
    ["availableFrom", node.availableFrom],
    ["dueAt", node.dueAt],
    ["availableUntil", node.availableUntil],
  ];
  for (const [name, d] of dates) {
    if (d !== undefined && (!(d instanceof Date) || Number.isNaN(d.getTime()))) {
      throw new InvalidContentChangeError(`${name} must be a valid date`);
    }
  }
  const set = dates.filter((x): x is [string, Date] => x[1] !== undefined);
  for (let i = 1; i < set.length; i++) {
    if (set[i - 1]![1].getTime() > set[i]![1].getTime()) {
      throw new InvalidContentChangeError(`${set[i - 1]![0]} must not be after ${set[i]![0]}`);
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/** Whether `from` reaches `to` by following "requires" edges. */
function reaches(edges: PrerequisiteEdge[], from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of edges) if (e.contentId === at) stack.push(e.requiresContentId);
  }
  return false;
}
