import type { RepositoryContext } from '../core/repositories.js';
import type { ContentNode } from '../core/types.js';

export interface PrerequisiteEdge {
  contentId: string;
  requiresContentId: string;
}

/** Host app supplies completion state — the SDK doesn't own progress storage here. */
export interface CompletionChecker {
  isComplete(userId: string, contentId: string): Promise<boolean>;
}

export class ContentService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly completion: CompletionChecker,
    private readonly prerequisites: PrerequisiteEdge[] = [],
  ) {}

  async createNode(node: Omit<ContentNode, 'id' | 'version'>): Promise<ContentNode> {
    return this.repos.content.create(node);
  }

  async publish(id: string): Promise<ContentNode> {
    const current = await this.repos.content.findById(id);
    if (!current) throw new Error(`Content ${id} not found`);
    return this.repos.content.update(id, {
      published: true,
      version: current.version + 1,
    });
  }

  async reorder(sectionId: string, orderedIds: string[]): Promise<void> {
    return this.repos.content.reorder(sectionId, orderedIds);
  }

  /** Simple DAG check — walk direct prerequisites, no need for a full graph library. */
  async isUnlocked(userId: string, contentId: string): Promise<boolean> {
    const required = this.prerequisites.filter((e) => e.contentId === contentId);
    for (const edge of required) {
      const done = await this.completion.isComplete(userId, edge.requiresContentId);
      if (!done) return false;
    }
    return true;
  }
}
