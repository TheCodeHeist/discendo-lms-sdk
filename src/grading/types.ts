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
