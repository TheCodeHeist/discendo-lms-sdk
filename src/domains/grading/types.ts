export interface GradeEntry {
  id: string;
  submissionId: string;
  userId: string;
  score: number;
  maxScore: number;
  graderId: string;
  gradedAt: Date;
  /** Set when a later entry supersedes this one — never delete/overwrite. */
  supersededBy?: string;
}

export interface GradeCategory {
  name: string;
  weight: number; // 0–1, all categories should sum to 1
  dropLowestN?: number;
}

export interface GradingScheme {
  categories: GradeCategory[];
}

export type LatePolicy =
  | { kind: 'none' }
  | { kind: 'flatPenalty'; percentPerDay: number; maxPenaltyPercent?: number }
  | { kind: 'cutoff'; afterDays: number }; // zero credit after N days

export interface GradeScaleBand {
  minPercent: number;
  label: string; // 'A', 'A-', 'Pass', etc.
}

export type GradeScale = GradeScaleBand[];

/**
 * Extra time one student was given on one piece of content: added to a deadline
 * (`effectiveDueAt`, `daysLate`) or to a quiz's time limit (`AssessmentService`'s `extensions`
 * option). Never deleted: ending it sets `revokedAt`.
 */
export interface TimeExtension {
  id: string;
  userId: string;
  contentId: string;
  sectionId: string;
  extraSeconds: number;
  reason?: string;
  grantedBy: string;
  grantedAt: Date;
  revokedAt?: Date;
  revokedBy?: string;
}

/**
 * One student excused from one piece of content: it is left out of their final grade, as if it
 * did not exist, rather than counted as zero. Never deleted: ending it sets `revokedAt`.
 */
export interface Excusal {
  id: string;
  userId: string;
  contentId: string;
  sectionId: string;
  reason?: string;
  excusedBy: string;
  excusedAt: Date;
  revokedAt?: Date;
  revokedBy?: string;
}
