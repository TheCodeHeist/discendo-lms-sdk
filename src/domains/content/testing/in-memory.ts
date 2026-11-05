/** An in-memory `CompletionChecker`, for tests, demos and local development. */
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
