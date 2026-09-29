/**
 * Materializes ClassOccurrence rows from a ClassSessionTemplate's recurrence
 * rule, for a bounded date range. Deliberately windowed (never "generate
 * forever") — see generateOccurrences' docstring for why.
 */
import type { ClassOccurrence, ClassSessionTemplate } from './types.js';
import { addDays, atMidnightUtc, ruleFiresOn } from './rules/recurrence.js';

/**
 * Generates dated occurrences for a template within [rangeStart, rangeEnd],
 * further clamped to the template's own validFrom/validUntil.
 *
 * Windowed by design: a template's rule can be open-ended (no validUntil),
 * so "materialize everything" isn't a valid operation. Callers should run
 * this on a rolling basis (e.g. always keep the next 90 days materialized)
 * rather than trying to generate a whole term/forever in one call.
 *
 * `interval` support: with WEEKLY freq and interval N, weeks are counted
 * from the Monday of the week containing validFrom — week 0, N, 2N, ...
 * fire; others are skipped. interval=1 fires every week.
 */
export function generateOccurrences(
  template: ClassSessionTemplate,
  rangeStart: Date,
  rangeEnd: Date,
): Array<Omit<ClassOccurrence, 'id'>> {
  const effectiveStart = atMidnightUtc(
    template.validFrom > rangeStart ? template.validFrom : rangeStart,
  );
  const cappedEnd =
    template.validUntil && template.validUntil < rangeEnd ? template.validUntil : rangeEnd;
  const effectiveEnd = atMidnightUtc(cappedEnd);

  if (effectiveStart > effectiveEnd) return [];

  const occurrences: Array<Omit<ClassOccurrence, 'id'>> = [];

  for (let cursor = effectiveStart; cursor <= effectiveEnd; cursor = addDays(cursor, 1)) {
    if (!ruleFiresOn(template.rule, template.validFrom, cursor)) continue;

    occurrences.push({
      templateId: template.id,
      date: new Date(cursor),
      status: 'scheduled',
    });
  }

  return occurrences;
}
