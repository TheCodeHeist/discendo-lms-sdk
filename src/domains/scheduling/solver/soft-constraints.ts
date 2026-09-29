/**
 * Soft constraints for the backtracking solver: preferences a schedule
 * should satisfy where possible, but that never make a solve fail outright
 * the way a hard constraint (capacity, availability, qualification) does.
 *
 * How this actually affects the search: the backtracking solver in
 * backtracking.ts finds the FIRST feasible assignment, not a globally
 * optimal one (full optimization is a much larger undertaking — see
 * SCHEDULING.md's "Known limitations"). Soft constraints work by scoring
 * each candidate and sorting a session's candidate list so the
 * backtracking search TRIES lower-penalty candidates first. Since
 * backtracking commits to the first candidate that doesn't immediately
 * conflict, trying good candidates first means the solution it settles on
 * tends to be a good one — but this is a greedy heuristic, not a
 * guarantee. Two different feasible schedules are never compared against
 * each other; nothing is re-solved to check for a better alternative once
 * one is found. `SolveResult.totalPenalty` reports the score of whatever
 * was actually found, so a caller can at least see how good it turned out
 * to be, and compare across different SoftConstraint configurations run
 * separately if they want to.
 */
import type { Id } from '../../../core/types.js';
import type { Weekday } from '../types.js';
import type { PlacedSession, UnscheduledSession } from './types.js';

/**
 * What a SoftConstraint scores: one candidate (room + time + days) being
 * considered for one session, plus enough of the in-progress solve to
 * score things that depend on other placements (e.g. spreading a group's
 * sessions across the week). `placedSoFar` only contains sessions the
 * search has already committed to in this branch — never the whole
 * eventual schedule, since that isn't known yet.
 */
export interface CandidateContext {
  session: UnscheduledSession;
  roomId: Id;
  days: Weekday[];
  startTime: string;
  endTime: string;
  placedSoFar: ReadonlyMap<string, PlacedSession>;
  sessionsById: ReadonlyMap<string, UnscheduledSession>;
}

export interface SoftConstraint {
  name: string;
  /** Relative importance — penalties are multiplied by this before summing. */
  weight: number;
  /** Non-negative; 0 means this candidate fully satisfies the preference. */
  penalty(ctx: CandidateContext): number;
}

const HOUR_MINUTES = 60;

function toMinutes(time: string): number {
  const parts = time.split(':');
  return Number(parts[0] ?? 0) * HOUR_MINUTES + Number(parts[1] ?? 0);
}

/**
 * Teacher time-of-day preference: penalizes candidates that start before
 * `earliestPreferred` or after `latestPreferred` for the given teacher.
 * Distance from the window is what's scored (in minutes), not a flat
 * penalty — a slot 10 minutes early is preferred over one 3 hours early,
 * even though both violate the preference.
 */
export function teacherTimePreference(
  teacherId: Id,
  earliestPreferred: string,
  latestPreferred: string,
  weight = 1,
): SoftConstraint {
  return {
    name: `teacherTimePreference:${teacherId}`,
    weight,
    penalty(ctx) {
      if (!ctx.session.teacherIds.includes(teacherId)) return 0;
      const start = toMinutes(ctx.startTime);
      const earliest = toMinutes(earliestPreferred);
      const latest = toMinutes(latestPreferred);
      if (start < earliest) return earliest - start;
      if (start > latest) return start - latest;
      return 0;
    },
  };
}

/**
 * Preferred room for a course: 0 penalty if the candidate's room is one of
 * the preferred rooms (or if the session has no courseId to match against),
 * a flat penalty otherwise. Multiple acceptable rooms can be listed (e.g.
 * "either lab works").
 */
export function preferredRoomForCourse(
  courseId: Id,
  preferredRoomIds: Id[],
  weight = 1,
): SoftConstraint {
  return {
    name: `preferredRoomForCourse:${courseId}`,
    weight,
    penalty(ctx) {
      if (ctx.session.courseId !== courseId) return 0;
      return preferredRoomIds.includes(ctx.roomId) ? 0 : 1;
    },
  };
}

/**
 * Discourages clustering a group's sessions back-to-back on days they
 * already share, in favor of spacing them out across the day.
 *
 * Note on what this can and cannot influence: a session's meeting days
 * (`candidateDays`) are a fixed requirement, not a free choice the solver
 * makes — see UnscheduledSession's docstring. So this constraint cannot
 * move a session to a different day than the one its own rule already
 * fixes; two sessions that both require, say, Monday will always share
 * Monday regardless of scoring. What it CAN influence is the START TIME
 * chosen for a session on a day it already shares with another one of the
 * same group's sessions — preferring a time slot that isn't immediately
 * adjacent to that other session, so a student's day isn't wall-to-wall
 * classes with zero breathing room. Penalizes 0 for a day the candidate
 * doesn't share with any other placed session of the group.
 */
export function spaceOutSameDaySessions(weight = 1, minGapMinutes = 30): SoftConstraint {
  return {
    name: 'spaceOutSameDaySessions',
    weight,
    penalty(ctx) {
      let penalty = 0;
      const candidateStart = toMinutes(ctx.startTime);
      const candidateEnd = toMinutes(ctx.endTime);

      for (const placed of ctx.placedSoFar.values()) {
        const placedSession = ctx.sessionsById.get(placed.sessionId);
        if (!placedSession || placedSession.groupId !== ctx.session.groupId) continue;

        const sharesADay = placed.days.some((d) => ctx.days.includes(d));
        if (!sharesADay) continue;

        const placedStart = toMinutes(placed.startTime);
        const placedEnd = toMinutes(placed.endTime);
        const gapBefore = candidateStart - placedEnd;
        const gapAfter = placedStart - candidateEnd;
        const actualGap = Math.max(gapBefore, gapAfter);

        if (actualGap < 0) continue; // an actual overlap is a hard conflict, not this constraint's job
        if (actualGap < minGapMinutes) penalty += minGapMinutes - actualGap;
      }
      return penalty;
    },
  };
}

/** Sums every constraint's weighted penalty for one candidate. */
export function scoreCandidate(constraints: SoftConstraint[], ctx: CandidateContext): number {
  let total = 0;
  for (const constraint of constraints) {
    total += constraint.weight * constraint.penalty(ctx);
  }
  return total;
}
