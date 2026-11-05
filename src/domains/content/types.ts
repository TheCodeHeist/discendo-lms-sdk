import type { ContentNode, Id } from '../../core/types.js';
import type { ContentAvailability } from '../../core/content-availability.js';

/** What a revision records: the change that produced that version. */
export type ContentChange = 'created' | 'updated' | 'published' | 'unpublished';

/**
 * One version of a content node: a full snapshot of the node as it was right after `change`, kept
 * forever. Version 1 is the node as created. Together the revisions are the node's history, so an
 * earlier version can be inspected or brought back (`ContentService.restoreRevision`).
 */
export interface ContentRevision {
  id: Id;
  contentId: Id;
  sectionId: Id;
  version: number;
  change: ContentChange;
  /** The fields an `updated` revision changed. Absent for the other changes. */
  changedFields?: string[];
  snapshot: ContentNode;
  /** Who made the change (with enforcement on, or when an actor is passed). */
  changedBy?: Id;
  changedAt: Date;
}

/**
 * Where `ContentService` keeps revisions (the `revisions` option). Append-only: nothing is ever
 * changed or removed.
 */
export interface ContentRevisionRepository {
  append(revision: Omit<ContentRevision, 'id'>): Promise<ContentRevision>;
  /** Every revision of the node, oldest (version 1) first. */
  listForContent(contentId: Id): Promise<ContentRevision[]>;
}

/** "`contentId` can only be opened once `requiresContentId` is complete." Both in the same section. */
export interface PrerequisiteEdge {
  contentId: string;
  requiresContentId: string;
}

/** A prerequisite as stored (`ContentPrerequisiteRepository`). */
export interface StoredPrerequisiteEdge extends PrerequisiteEdge {
  id: Id;
  sectionId: Id;
  createdBy?: Id;
  createdAt: Date;
}

/**
 * Where `ContentService` keeps prerequisites, so staff can change them while the service runs (the
 * `prerequisites` option). Edges passed to the constructor still count as well.
 */
export interface ContentPrerequisiteRepository {
  add(edge: Omit<StoredPrerequisiteEdge, 'id'>): Promise<StoredPrerequisiteEdge>;
  /** Removes the edge; returns whether there was one. */
  remove(contentId: Id, requiresContentId: Id): Promise<boolean>;
  /** The edges into `contentId` (what it requires). */
  listForContent(contentId: Id): Promise<StoredPrerequisiteEdge[]>;
  /** Every edge of the section, for the cycle check and for showing the whole map. */
  listForSection(sectionId: Id): Promise<StoredPrerequisiteEdge[]>;
}

/** `ContentService.checkAccess`: can this student open (and work on) this content now, and if not, why. */
export interface ContentAccess {
  /** True when the content is published, open, and every prerequisite is complete. */
  canOpen: boolean;
  /** True when the student may submit to it now: it can be opened, and it has not closed. */
  canSubmit: boolean;
  published: boolean;
  availability: ContentAvailability;
  /** The prerequisites the student has not completed yet (content ids). Empty when all are met. */
  missingPrerequisites: string[];
  availableFrom?: Date;
  availableUntil?: Date;
  dueAt?: Date;
}

/** What `ContentService.updateNode` can change. `null` clears a date. */
export interface ContentNodePatch {
  title?: string;
  kind?: ContentNode['kind'];
  parentId?: string | null;
  availableFrom?: Date | null;
  availableUntil?: Date | null;
  dueAt?: Date | null;
}

/** A prerequisite that cannot be: on itself, across sections, or one that would make a cycle. */
export class InvalidPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPrerequisiteError';
  }
}

/** A change to a node that cannot be stored: an empty title, dates in the wrong order, a parent in another section or below itself. */
export class InvalidContentChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidContentChangeError';
  }
}
