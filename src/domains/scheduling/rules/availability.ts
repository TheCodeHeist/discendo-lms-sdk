/**
 * Checks whether a resource (teacher/room/group) is available at all for a
 * given date and time window — independent from whether it's already
 * booked. A resource can be simultaneously "available" (within work hours)
 * and "conflicted" (double-booked); this module only answers the former.
 *
 * A resource with no AvailabilityRule at all is treated as always available
 * — availability is opt-in. Institutions that want to enforce "teachers can
 * only be booked in their declared hours" add rules; ones that don't care
 * (a single-tutor private setup, say) simply never create any and every
 * check passes trivially.
 */
import type { AvailabilityRule } from '../types.js';
import { ruleFiresOn } from './recurrence.js';

function timeWithinWindow(
  candidateStart: string,
  candidateEnd: string,
  windowStart: string,
  windowEnd: string,
): boolean {
  return candidateStart >= windowStart && candidateEnd <= windowEnd;
}

export interface AvailabilityCheckResult {
  available: boolean;
  /** Populated when `available` is false: the rules considered and why none matched. */
  reason?: string;
}

/**
 * Returns whether at least one of the resource's availability rules covers
 * this date and fully contains this time window. If `rules` is empty, the
 * resource is treated as unconstrained (see module docstring).
 */
export function checkAvailability(
  rules: AvailabilityRule[],
  date: Date,
  startTime: string,
  endTime: string,
): AvailabilityCheckResult {
  if (rules.length === 0) return { available: true };

  for (const rule of rules) {
    if (rule.validFrom > date) continue;
    if (rule.validUntil && rule.validUntil < date) continue;
    if (!ruleFiresOn(rule.rule, rule.validFrom, date)) continue;
    if (timeWithinWindow(startTime, endTime, rule.startTime, rule.endTime)) {
      return { available: true };
    }
  }

  return {
    available: false,
    reason: `No availability rule covers ${startTime}-${endTime} on this date for this resource.`,
  };
}
