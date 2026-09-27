import type { GradeEntry, GradingScheme, GradeScale } from './types.js';
import type { EventBus } from '../core/events.js';
import { computeFinalGrade, toLetterGrade } from './calculations.js';

export interface GradeRepository {
  create(entry: Omit<GradeEntry, 'id'>): Promise<GradeEntry>;
  markSuperseded(id: string, byId: string): Promise<void>;
  listForUserInSection(
    userId: string,
    sectionId: string,
  ): Promise<Array<GradeEntry & { category: string }>>;
}

export class GradingService {
  constructor(
    private readonly grades: GradeRepository,
    private readonly events?: EventBus,
  ) {}

  /**
   * Records a grade. Never overwrites — if the submission was already
   * graded, the old entry is marked superseded and a fresh one is created.
   * This gives you a full audit trail for free.
   */
  async recordGrade(
    submissionId: string,
    userId: string,
    score: number,
    maxScore: number,
    graderId: string,
    previousEntryId?: string,
  ): Promise<GradeEntry> {
    const entry = await this.grades.create({
      submissionId,
      userId,
      score,
      maxScore,
      graderId,
      gradedAt: new Date(),
    });
    if (previousEntryId) {
      await this.grades.markSuperseded(previousEntryId, entry.id);
    }

    void this.events?.emit({
      type: 'grading.gradePosted',
      gradeEntryId: entry.id,
      submissionId: entry.submissionId,
      userId: entry.userId,
      score: entry.score,
      maxScore: entry.maxScore,
      graderId: entry.graderId,
    });

    return entry;
  }

  async computeFinalGradeForUser(
    userId: string,
    sectionId: string,
    scheme: GradingScheme,
  ): Promise<number> {
    const entries = await this.grades.listForUserInSection(userId, sectionId);
    const byCategory = new Map<string, GradeEntry[]>();
    for (const e of entries) {
      if (e.supersededBy) continue; // only count current entries
      const bucket = byCategory.get(e.category) ?? [];
      bucket.push(e);
      byCategory.set(e.category, bucket);
    }
    return computeFinalGrade(byCategory, scheme);
  }

  async computeLetterGradeForUser(
    userId: string,
    sectionId: string,
    scheme: GradingScheme,
    scale: GradeScale,
  ): Promise<string> {
    const percent = await this.computeFinalGradeForUser(userId, sectionId, scheme);
    return toLetterGrade(percent, scale);
  }
}
