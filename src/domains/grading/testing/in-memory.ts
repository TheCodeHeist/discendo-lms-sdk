/**
 * In-memory implementations of the grading repositories: grades, time extensions and excusals.
 * Complete, including the optional atomic `supersedeIfCurrent`, and kept in this process only.
 */
import { InMemoryTable } from '../../../core/testing/table.js';
import type { ExcusalRepository, TimeExtensionRepository } from '../accommodations.js';
import type { GradeRepository } from '../service.js';
import type { Excusal, GradeEntry, TimeExtension } from '../types.js';

/** Where a graded submission belongs: what `listForUserInSection` needs and `GradeEntry` lacks. */
export interface GradePlacement {
  sectionId: string;
  /** The grading-scheme category the work counts towards (e.g. `homework`). */
  category: string;
  /** The content the submission was for. Needed when excusals are in use. */
  contentId?: string;
}

export interface InMemoryGradeRepositoryOptions {
  /**
   * Finds where a submission belongs. A `GradeEntry` only carries a `submissionId`, so the grade
   * store cannot know a grade's section or category on its own (a real database would join).
   * Submissions placed with `place()` are found without it. A submission that neither knows is
   * left out of `listForUserInSection`.
   */
  locate?: (submissionId: string) => GradePlacement | null | Promise<GradePlacement | null>;
}

export class InMemoryGradeRepository implements GradeRepository {
  private readonly entries = new InMemoryTable<GradeEntry>('grade', 'Grade entry');
  private readonly placements = new Map<string, GradePlacement>();

  constructor(private readonly options: InMemoryGradeRepositoryOptions = {}) {}

  /** Says where a submission belongs, for `listForUserInSection`. */
  place(submissionId: string, placement: GradePlacement): this {
    this.placements.set(submissionId, { ...placement });
    return this;
  }

  async create(entry: Omit<GradeEntry, 'id'>): Promise<GradeEntry> {
    return this.entries.insert(entry);
  }

  async findById(id: string): Promise<GradeEntry | null> {
    return this.entries.get(id);
  }

  async markSuperseded(id: string, byId: string): Promise<void> {
    this.entries.update(id, { supersededBy: byId });
  }

  async supersedeIfCurrent(id: string, byId: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.supersededBy !== undefined) return false;
    this.entries.update(id, { supersededBy: byId });
    return true;
  }

  async listForUserInSection(
    userId: string,
    sectionId: string,
  ): Promise<Array<GradeEntry & { category: string; contentId?: string }>> {
    const out: Array<GradeEntry & { category: string; contentId?: string }> = [];
    for (const entry of this.entries.where((e) => e.userId === userId)) {
      const placement = this.placements.get(entry.submissionId) ?? (await this.options.locate?.(entry.submissionId)) ?? null;
      if (!placement || placement.sectionId !== sectionId) continue;
      out.push({
        ...entry,
        category: placement.category,
        ...(placement.contentId !== undefined ? { contentId: placement.contentId } : {}),
      });
    }
    return out;
  }

  /** Every entry for a submission, superseded ones included, oldest first. Not needed by the SDK. */
  async listForSubmission(submissionId: string): Promise<GradeEntry[]> {
    return this.entries.where((e) => e.submissionId === submissionId);
  }
}

export class InMemoryTimeExtensionRepository implements TimeExtensionRepository {
  private readonly extensions = new InMemoryTable<TimeExtension>('ext', 'Time extension');

  async create(e: Omit<TimeExtension, 'id'>): Promise<TimeExtension> {
    return this.extensions.insert(e);
  }

  async findById(id: string): Promise<TimeExtension | null> {
    return this.extensions.get(id);
  }

  async findActive(userId: string, contentId: string): Promise<TimeExtension | null> {
    return this.extensions.last((e) => e.userId === userId && e.contentId === contentId && e.revokedAt === undefined);
  }

  async listForContent(contentId: string, options: { includeRevoked?: boolean } = {}): Promise<TimeExtension[]> {
    return this.extensions.where((e) => e.contentId === contentId && (options.includeRevoked || e.revokedAt === undefined));
  }

  async revoke(id: string, at: Date, by: string): Promise<TimeExtension> {
    return this.extensions.update(id, { revokedAt: at, revokedBy: by });
  }
}

export class InMemoryExcusalRepository implements ExcusalRepository {
  private readonly excusals = new InMemoryTable<Excusal>('excusal', 'Excusal');

  async create(e: Omit<Excusal, 'id'>): Promise<Excusal> {
    return this.excusals.insert(e);
  }

  async findById(id: string): Promise<Excusal | null> {
    return this.excusals.get(id);
  }

  async findActive(userId: string, contentId: string): Promise<Excusal | null> {
    return this.excusals.last((e) => e.userId === userId && e.contentId === contentId && e.revokedAt === undefined);
  }

  async listForContent(contentId: string, options: { includeRevoked?: boolean } = {}): Promise<Excusal[]> {
    return this.excusals.where((e) => e.contentId === contentId && (options.includeRevoked || e.revokedAt === undefined));
  }

  /** Every excusal of this student in this section, revoked ones included (the grade calculation filters them). */
  async listForUser(userId: string, sectionId: string): Promise<Excusal[]> {
    return this.excusals.where((e) => e.userId === userId && e.sectionId === sectionId);
  }

  async revoke(id: string, at: Date, by: string): Promise<Excusal> {
    return this.excusals.update(id, { revokedAt: at, revokedBy: by });
  }
}
