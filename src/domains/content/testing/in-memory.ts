/** An in-memory `CompletionChecker`, for tests, demos and local development. */
import { InMemoryTable } from '../../../core/testing/table.js';
import type {
  ContentPrerequisiteRepository,
  ContentRevision,
  ContentRevisionRepository,
  StoredPrerequisiteEdge,
} from '../types.js';
import type { CompletionChecker } from '../service.js';

/**
 * Remembers which content each person has completed. `ContentService.isUnlocked` asks it whether
 * a prerequisite is done; mark things done with `markComplete`. An optional `fallback` is asked
 * about anything not marked (for example "has this person submitted it?").
 */
export class InMemoryCompletionTracker implements CompletionChecker {
  private readonly done = new Set<string>();

  constructor(private readonly fallback?: (userId: string, contentId: string) => Promise<boolean>) {}

  markComplete(userId: string, contentId: string): this {
    this.done.add(`${userId}\u0000${contentId}`);
    return this;
  }

  async isComplete(userId: string, contentId: string): Promise<boolean> {
    if (this.done.has(`${userId}\u0000${contentId}`)) return true;
    return (await this.fallback?.(userId, contentId)) ?? false;
  }
}

/** Append-only revision history. */
export class InMemoryContentRevisionRepository implements ContentRevisionRepository {
  private readonly revisions = new InMemoryTable<ContentRevision>('rev', 'Content revision');

  async append(revision: Omit<ContentRevision, 'id'>): Promise<ContentRevision> {
    return this.revisions.insert(revision);
  }

  async listForContent(contentId: string): Promise<ContentRevision[]> {
    return this.revisions.where((r) => r.contentId === contentId).sort((a, b) => a.version - b.version);
  }
}

export class InMemoryContentPrerequisiteRepository implements ContentPrerequisiteRepository {
  private readonly edges = new InMemoryTable<StoredPrerequisiteEdge>('edge', 'Prerequisite');

  async add(edge: Omit<StoredPrerequisiteEdge, 'id'>): Promise<StoredPrerequisiteEdge> {
    return this.edges.insert(edge);
  }

  async remove(contentId: string, requiresContentId: string): Promise<boolean> {
    const found = this.edges.where((e) => e.contentId === contentId && e.requiresContentId === requiresContentId);
    for (const e of found) this.edges.delete(e.id);
    return found.length > 0;
  }

  async listForContent(contentId: string): Promise<StoredPrerequisiteEdge[]> {
    return this.edges.where((e) => e.contentId === contentId);
  }

  async listForSection(sectionId: string): Promise<StoredPrerequisiteEdge[]> {
    return this.edges.where((e) => e.sectionId === sectionId);
  }
}
