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

    const percentages = entries
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

export function toLetterGrade(percent: number, scale: GradeScale): string {
  const sorted = [...scale].sort((a, b) => b.minPercent - a.minPercent);
  const band = sorted.find((b) => percent >= b.minPercent);
  return band?.label ?? 'N/A';
}
