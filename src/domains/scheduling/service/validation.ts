import { InvalidSchedulingSettingsError } from '../types.js';
import type { AvailabilityRule, RecurrenceRule, TeacherSchedulingPreferences, Weekday } from '../types.js';

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesBetween(start: string, end: string): number | undefined {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return undefined;
  return eh * 60 + em - (sh * 60 + sm);
}

function validRecurrence(rule: RecurrenceRule): boolean {
  return (
    !!rule &&
    rule.freq === 'WEEKLY' &&
    Number.isInteger(rule.interval) &&
    rule.interval >= 1 &&
    Array.isArray(rule.byDay) &&
    rule.byDay.length > 0 &&
    rule.byDay.every((d) => WEEKDAYS.includes(d))
  );
}

type AvailabilityInput = Omit<AvailabilityRule, 'id' | 'resourceId' | 'resourceType'>;

/** Availability rules the planner and checks can rely on, copied field by field (nothing else gets through). */
export function validateAvailability(rules: AvailabilityInput[]): AvailabilityInput[] {
  if (!Array.isArray(rules)) throw new InvalidSchedulingSettingsError('Availability must be a list of rules');
  return rules.map((r, i) => {
    const where = `Availability rule ${i + 1}`;
    if (!validRecurrence(r.rule)) throw new InvalidSchedulingSettingsError(`${where}: the recurrence needs a weekly rule with an interval of at least 1 and known days`);
    if (!HHMM.test(r.startTime) || !HHMM.test(r.endTime)) throw new InvalidSchedulingSettingsError(`${where}: times must be HH:MM`);
    if (toMinutes(r.startTime) >= toMinutes(r.endTime)) throw new InvalidSchedulingSettingsError(`${where}: it must end after it starts`);
    if (typeof r.timezone !== 'string' || r.timezone === '') throw new InvalidSchedulingSettingsError(`${where}: a timezone is required`);
    if (!(r.validFrom instanceof Date) || Number.isNaN(r.validFrom.getTime())) throw new InvalidSchedulingSettingsError(`${where}: validFrom must be a date`);
    if (r.validUntil !== undefined && (!(r.validUntil instanceof Date) || Number.isNaN(r.validUntil.getTime()) || r.validUntil < r.validFrom)) {
      throw new InvalidSchedulingSettingsError(`${where}: validUntil must be a date on or after validFrom`);
    }
    return {
      rule: { ...r.rule },
      startTime: r.startTime,
      endTime: r.endTime,
      timezone: r.timezone,
      validFrom: r.validFrom,
      ...(r.validUntil !== undefined ? { validUntil: r.validUntil } : {}),
    };
  });
}

export function validatePreferences(
  preferences: Omit<TeacherSchedulingPreferences, 'teacherId'>,
): Omit<TeacherSchedulingPreferences, 'teacherId'> {
  const window = preferences?.preferredStartWindow;
  if (window === undefined) return {};
  if (!HHMM.test(window.earliest) || !HHMM.test(window.latest)) {
    throw new InvalidSchedulingSettingsError('A preferred start window needs earliest and latest as HH:MM');
  }
  if (toMinutes(window.earliest) > toMinutes(window.latest)) {
    throw new InvalidSchedulingSettingsError('A preferred start window cannot end before it starts');
  }
  return { preferredStartWindow: { earliest: window.earliest, latest: window.latest } };
}
