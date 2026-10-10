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

/**
 * Computes a weighted final grade (0–100) from a set of graded entries,
 * grouped by category name, respecting drop-lowest-N per category.
 */
export function computeFinalGrade(
  entriesByCategory: Map<string, GradeEntry[]>,
  scheme: GradingScheme,
): number {
  let total = 0;
  let weightUsed = 0;

  for (const category of scheme.categories) {
    const entries = entriesByCategory.get(category.name) ?? [];
    if (entries.length === 0) continue;

    // An entry that cannot be a grade (a maximum of zero or less, a negative score, or a number that
    // is not finite) is ignored, as if it were not there: one bad row must not turn a whole
    // student's grade into Infinity or NaN. `recordGrade` refuses to store such entries, so this
    // only matters for data that was written some other way.
    const percentages = entries
      .filter(isCountable)
      .map((e) => e.score / e.maxScore)
      .sort((a, b) => a - b);

    const dropped = category.dropLowestN ?? 0;
    const kept = percentages.slice(dropped);
    if (kept.length === 0) continue;

    const categoryAvg = kept.reduce((sum, p) => sum + p, 0) / kept.length;
    total += categoryAvg * category.weight;
    weightUsed += category.weight;
  }

  // Renormalize if some categories had no grades yet, so a partially-graded
  // course doesn't unfairly tank toward zero.
  return weightUsed > 0 ? (total / weightUsed) * 100 : 0;
}

function isCountable(e: GradeEntry): boolean {
  return Number.isFinite(e.score) && Number.isFinite(e.maxScore) && e.score >= 0 && e.maxScore > 0;
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
