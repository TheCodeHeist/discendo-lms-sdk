/**
 * Shared logic for asking "does this RecurrenceRule fire on this specific
 * date?" — used by both occurrence generation (generator.ts) and
 * availability checking (availability.ts) so the interval/anchor-week math
 * exists in exactly one place.
 */
import type { RecurrenceRule, Weekday } from './types.js';

const WEEKDAY_INDEX: Record<Weekday, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export function atMidnightUtc(d: Date): Date {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function mondayOf(d: Date): Date {
  const copy = atMidnightUtc(d);
  const daysSinceMonday = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - daysSinceMonday);
  return copy;
}

/**
 * True if `date` matches the rule's weekday set and interval, anchored to
 * `anchorFrom` (typically the owning template/rule's own validFrom — this
 * is what makes "every 2nd week" stable regardless of what window you're
 * querying). Does not check validFrom/validUntil bounds — callers clamp
 * those separately, since generation and availability clamp differently.
 */
export function ruleFiresOn(rule: RecurrenceRule, anchorFrom: Date, date: Date): boolean {
  if (rule.raw) {
    throw new Error(
      'ruleFiresOn: rule uses a raw RRULE string; plug in a real RRULE ' +
        'library (e.g. rrule.js) to evaluate it — this only understands ' +
        'the structured RecurrenceRule fields.',
    );
  }

  const targetDows = new Set(rule.byDay.map((d) => WEEKDAY_INDEX[d]));
  if (!targetDows.has(date.getUTCDay())) return false;

  const anchorMonday = mondayOf(anchorFrom);
  const dateMonday = mondayOf(date);
  const weeksSinceAnchor = Math.round(
    (dateMonday.getTime() - anchorMonday.getTime()) / (7 * 24 * 60 * 60 * 1000),
  );
  return weeksSinceAnchor >= 0 && weeksSinceAnchor % rule.interval === 0;
}
