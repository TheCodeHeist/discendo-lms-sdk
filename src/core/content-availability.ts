/**
 * When a content node may be opened and worked on, from its dates. It lives in `core` because
 * more than one module needs it: content (who may open a node) and assessment (who may submit to
 * it, or start a quiz), and modules may only share code through `core`. Pure.
 */
import type { ContentNode } from './types.js';

/** Where a node's dates put it right now. */
export type ContentAvailability = 'not-yet-open' | 'open' | 'closed';

/**
 * Where `node`'s dates put it at `now`: before `availableFrom` it is `not-yet-open`, after
 * `availableUntil` it is `closed`, otherwise `open`. Both ends are inclusive. Pure.
 */
export function contentAvailability(
  node: Pick<ContentNode, 'availableFrom' | 'availableUntil'>,
  now: Date = new Date(),
): ContentAvailability {
  if (node.availableFrom && now.getTime() < node.availableFrom.getTime()) return 'not-yet-open';
  if (node.availableUntil && now.getTime() > node.availableUntil.getTime()) return 'closed';
  return 'open';
}

/**
 * The content cannot be opened or worked on now: it has not opened yet, or (for submitting and
 * starting a quiz) it has closed. Thrown by `ContentService.getNode` and `AssessmentService` for a
 * student; staff are never refused for dates.
 */
export class ContentNotAvailableError extends Error {
  constructor(
    readonly contentId: string,
    readonly availability: ContentAvailability,
  ) {
    super(availability === 'not-yet-open' ? `Content ${contentId} is not open yet` : `Content ${contentId} has closed`);
    this.name = 'ContentNotAvailableError';
  }
}

