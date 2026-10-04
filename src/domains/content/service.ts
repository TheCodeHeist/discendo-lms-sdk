import type { RepositoryContext } from '../../core/repositories.js';
import type { ContentNode } from '../../core/types.js';
import type { EventBus } from '../../core/events.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { authorizeInSection, isStaff } from '../../core/authorization.js';
import type { Authorized } from '../../core/authorization.js';
import { PermissionDeniedError } from '../../core/permissions.js';

export interface PrerequisiteEdge {
  contentId: string;
  requiresContentId: string;
}

/** Host app supplies completion state — the SDK doesn't own progress storage here. */
export interface CompletionChecker {
  isComplete(userId: string, contentId: string): Promise<boolean>;
}

export interface ContentServiceOptions {
  /**
   * Turns on permission enforcement. Once set, every public method that touches content
   * (everything except `isUnlocked`) requires an `{ actorId }` argument and refuses to run
   * without one. Leave it unset and the service behaves as it always has: no actor, no checks.
   */
  policy?: PermissionPolicy;
}

export class ContentService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly completion: CompletionChecker,
    private readonly prerequisites: PrerequisiteEdge[] = [],
    private readonly events?: EventBus,
    private readonly options: ContentServiceOptions = {},
  ) {}

  /**
   * Stores a new node. With enforcement on (`actor` required) the actor needs `content.manage`
   * in the node's section, and a `parentId` must be a node of that same section.
   */
  async createNode(node: Omit<ContentNode, 'id' | 'version'>, actor?: ActorContext): Promise<ContentNode> {
    if (this.options.policy) {
      await this.authorizeOn('content.manage', actor, node.sectionId);
      if (node.parentId !== undefined) {
        const parent = await this.repos.content.findById(node.parentId);
        if (!parent || parent.sectionId !== node.sectionId) {
          throw new Error(`The parent node ${node.parentId} must exist in the same section`);
        }
      }
    }
    return this.repos.content.create(node);
  }

  /**
   * Publishes a node (and bumps its version). With enforcement on the actor needs `content.manage`
   * in the node's section, which comes from the stored node; an unknown node is refused exactly
   * like a forbidden one.
   */
  async publish(id: string, actor?: ActorContext): Promise<ContentNode> {
    let current: ContentNode | null;
    if (this.options.policy) {
      // Only needed to find out which section this is about; skipped without an actor so the
      // caller gets "actor required" before anything about the content is looked up.
      current = actor ? await this.repos.content.findById(id) : null;
      await this.authorizeOn('content.manage', actor, current?.sectionId);
    } else {
      current = await this.repos.content.findById(id);
    }
    if (!current) throw new Error(`Content ${id} not found`);
    const updated = await this.repos.content.update(id, {
      published: true,
      version: current.version + 1,
    });

    void this.events?.emit({
      type: 'content.published',
      contentId: updated.id,
      sectionId: updated.sectionId,
      version: updated.version,
    });

    return updated;
  }

  /**
   * Applies an order to a section's nodes. With enforcement on the actor needs `content.manage`
   * in the section, and the list may only name nodes of that section, each at most once.
   */
  async reorder(sectionId: string, orderedIds: string[], actor?: ActorContext): Promise<void> {
    if (this.options.policy) {
      await this.authorizeOn('content.manage', actor, sectionId);
      const own = new Set((await this.repos.content.listBySection(sectionId)).map((n) => n.id));
      const seen = new Set<string>();
      for (const id of orderedIds) {
        if (!own.has(id)) throw new Error(`Node ${id} is not part of section ${sectionId}`);
        if (seen.has(id)) throw new Error(`Node ${id} appears more than once in the order`);
        seen.add(id);
      }
    }
    return this.repos.content.reorder(sectionId, orderedIds);
  }

  /**
   * Reads one node. With enforcement on (`actor` required) the actor needs `content.view` in the
   * node's section, and anyone who is not staff there is refused a node that is not published.
   * Without enforcement it returns whatever the repository has, drafts included.
   */
  async getNode(id: string, actor?: ActorContext): Promise<ContentNode> {
    if (!this.options.policy) {
      const node = await this.repos.content.findById(id);
      if (!node) throw new Error(`Content ${id} not found`);
      return node;
    }
    const node = actor ? await this.repos.content.findById(id) : null;
    const auth = await this.authorizeOn('content.view', actor, node?.sectionId);
    // authorizeOn has already refused a missing node, so there is one here.
    if (!node!.published && !isStaff(auth.ctx)) throw this.denied('content.view');
    return node!;
  }

  /**
   * Lists a section's nodes in the repository's order. With enforcement on (`actor` required)
   * the actor needs `content.view` in the section, and anyone who is not staff there gets only
   * the published nodes. Without enforcement it returns everything.
   */
  async listNodes(sectionId: string, actor?: ActorContext): Promise<ContentNode[]> {
    if (!this.options.policy) return this.repos.content.listBySection(sectionId);
    const auth = await this.authorizeOn('content.view', actor, sectionId);
    const nodes = await this.repos.content.listBySection(sectionId);
    return isStaff(auth.ctx) ? nodes : nodes.filter((n) => n.published);
  }

  /**
   * Simple DAG check — walk direct prerequisites, no need for a full graph library. This is a
   * pure question about the edges and the completion checker, not an access check: it takes no
   * actor and is not affected by enforcement. Read the node with `getNode` for access.
   */
  async isUnlocked(userId: string, contentId: string): Promise<boolean> {
    const required = this.prerequisites.filter((e) => e.contentId === contentId);
    for (const edge of required) {
      const done = await this.completion.isComplete(userId, edge.requiresContentId);
      if (!done) return false;
    }
    return true;
  }

  private authorizeOn(action: Action, actor: ActorContext | undefined, sectionId: string | undefined): Promise<Authorized> {
    return authorizeInSection(this.options.policy!, this.repos, action, actor, { sectionId });
  }

  private denied(action: Action): Error {
    return new PermissionDeniedError(action);
  }
}
