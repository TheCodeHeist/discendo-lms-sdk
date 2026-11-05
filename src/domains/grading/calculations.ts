import type { GradeEntry, GradingScheme, LatePolicy, GradeScale } from './types.js';

/**
 * All functions here are pure — no repository access, no side effects.
 * Keeping calculation logic pure makes it trivial to unit test and to
 * reuse in contexts where you're previewing a grade before committing it.
 */

export function applyLatePolicy(
  score: number,
  maxScore: number,
  daysLate: number,
  policy: LatePolicy,
): number {
  if (daysLate <= 0) return score;

  switch (policy.kind) {
    case 'none':
      return score;
    case 'flatPenalty': {
      const penaltyPercent = Math.min(
        policy.percentPerDay * daysLate,
        policy.maxPenaltyPercent ?? 100,
      );
      return Math.max(0, score - maxScore * (penaltyPercent / 100));
    }
    case 'cutoff':
      return daysLate > policy.afterDays ? 0 : score;
  }
}

/** Why an entry was left out of a final grade. */
export type SkippedEntryReason = 'invalid-max-score' | 'invalid-score';

/** One category's part in a final grade (see `explainFinalGrade`). */
export interface CategoryBreakdown {
  name: string;
  /** The weight from the scheme. */
  weight: number;
  /** The share of the final grade it actually carries, after renormalizing (0 to 1). 0 if it has no grades yet. */
  effectiveWeight: number;
  /** The category average as a percentage (0 to 100), or null when nothing in it counts yet. */
  percent: number | null;
  /** The entries averaged, by id. */
  counted: string[];
  /** The entries left out by the category's `dropLowestN`, lowest first. */
  dropped: string[];
}

/** A final grade with its working shown. */
export interface FinalGradeExplanation {
  /** The final percentage (0 to 100), exactly what `computeFinalGrade` returns. */
  percent: number;
  /** One per category of the scheme, in the scheme's order. */
  categories: CategoryBreakdown[];
  /**
   * Entries that could not be counted, with why: a maximum of zero or less, or a score that is
   * negative or not a finite number. `recordGrade` never stores these; they come from data written
   * some other way, and are listed so they can be found and fixed instead of quietly not counting.
   */
  skipped: Array<{ entryId: string; category: string; reason: SkippedEntryReason }>;
  /** Entries in a category the scheme does not have, so they count for nothing. */
  uncategorized: Array<{ entryId: string; category: string }>;
}

/**
 * Computes a weighted final grade (0-100) from a set of graded entries, grouped by category name,
 * respecting drop-lowest-N per category, and shows the working: what each category contributed,
 * which entries were dropped, and which could not be counted at all (and why). Pure.
 *
 * A category with no countable grades yet is left out and the others are renormalized, so a
 * partly graded course does not tank towards zero.
 */
export function explainFinalGrade(
  entriesByCategory: Map<string, GradeEntry[]>,
  scheme: GradingScheme,
): FinalGradeExplanation {
  const skipped: FinalGradeExplanation['skipped'] = [];
  const working: Array<Omit<CategoryBreakdown, 'effectiveWeight'> & { average: number | null }> = [];

  for (const category of scheme.categories) {
    const valid: Array<{ id: string; fraction: number }> = [];
    for (const e of entriesByCategory.get(category.name) ?? []) {
      const reason = invalidReason(e);
      if (reason) skipped.push({ entryId: e.id, category: category.name, reason });
      else valid.push({ id: e.id, fraction: e.score / e.maxScore });
    }
    // Lowest first; ties keep their order, so which of two equal grades is dropped is stable.
    valid.sort((a, b) => a.fraction - b.fraction);
    const dropCount = Math.min(category.dropLowestN ?? 0, valid.length);
    const kept = valid.slice(dropCount);
    const average = kept.length > 0 ? kept.reduce((sum, v) => sum + v.fraction, 0) / kept.length : null;
    working.push({
      name: category.name,
      weight: category.weight,
      percent: average === null ? null : average * 100,
      counted: kept.map((v) => v.id),
      dropped: valid.slice(0, dropCount).map((v) => v.id),
      average,
    });
  }

  const weightUsed = working.reduce((sum, c) => sum + (c.average === null ? 0 : c.weight), 0);
  const total = working.reduce((sum, c) => sum + (c.average === null ? 0 : c.average * c.weight), 0);
  const known = new Set(scheme.categories.map((c) => c.name));
  const uncategorized: FinalGradeExplanation['uncategorized'] = [];
  for (const [name, entries] of entriesByCategory) {
    if (!known.has(name)) for (const e of entries) uncategorized.push({ entryId: e.id, category: name });
  }

  return {
    percent: weightUsed > 0 ? (total / weightUsed) * 100 : 0,
    categories: working.map(({ average, ...c }) => ({
      ...c,
      effectiveWeight: average === null || weightUsed <= 0 ? 0 : c.weight / weightUsed,
    })),
    skipped,
    uncategorized,
  };
}

/**
 * Computes a weighted final grade (0-100) from a set of graded entries, grouped by category name,
 * respecting drop-lowest-N per category. An entry that cannot be a grade (a maximum of zero or
 * less, a negative score, or a number that is not finite) is ignored, as if it were not there, so
 * one bad row cannot turn a whole grade into Infinity or NaN; `explainFinalGrade` lists them.
 */
export function computeFinalGrade(
  entriesByCategory: Map<string, GradeEntry[]>,
  scheme: GradingScheme,
): number {
  return explainFinalGrade(entriesByCategory, scheme).percent;
}

function invalidReason(e: GradeEntry): SkippedEntryReason | undefined {
  if (typeof e.maxScore !== 'number' || !Number.isFinite(e.maxScore) || e.maxScore <= 0) return 'invalid-max-score';
  if (typeof e.score !== 'number' || !Number.isFinite(e.score) || e.score < 0) return 'invalid-score';
  return undefined;
}

export function toLetterGrade(percent: number, scale: GradeScale): string {
  const sorted = [...scale].sort((a, b) => b.minPercent - a.minPercent);
  const band = sorted.find((b) => percent >= b.minPercent);
  return band?.label ?? 'N/A';
}

/**
 * The deadline a student really has: `dueAt` plus their extension, if any. Returns a new date.
 * `extraSeconds` must be a finite number from 0 up.
 */
export function effectiveDueAt(dueAt: Date, extension?: { extraSeconds: number } | null): Date {
  if (!extension) return new Date(dueAt.getTime());
  const { extraSeconds } = extension;
  if (typeof extraSeconds !== 'number' || !Number.isFinite(extraSeconds) || extraSeconds < 0) {
    throw new Error('extraSeconds must be a finite number from zero up');
  }
  return new Date(dueAt.getTime() + extraSeconds * 1000);
}

/**
 * How many days late a submission is, as whole days: a day that has started counts, so one second
 * late is 1 day and a day and a second is 2. On time, or exactly at the deadline, is 0. The deadline is
 * the student's own (`effectiveDueAt`), so an extension is already taken into account. The result is
 * what `applyLatePolicy` takes.
 */
export function daysLate(
  submittedAt: Date,
  dueAt: Date,
  extension?: { extraSeconds: number } | null,
): number {
  const deadline = effectiveDueAt(dueAt, extension).getTime();
  return Math.max(0, Math.ceil((submittedAt.getTime() - deadline) / 86_400_000));
}
