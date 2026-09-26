/**
 * Types for the auto-suggestion solver — the NP-hard part. This module
 * intentionally does NOT depend on SchedulingRepository: it's a pure
 * function over an in-memory problem description, so it can be tested,
 * swapped out (a future CP-SAT adapter), or run outside a database
 * entirely. The caller (a service method) is responsible for loading
 * everything below out of the repository and feeding it in.
 */
import type { Id } from '../../core/types.js';

/** One class that still needs a room+time slot decided for it. */
export interface UnscheduledSession {
  id: Id;
  sectionId: Id;
  teacherIds: Id[];
  groupId: Id;
  /** How many students attend — used for room capacity matching. */
  groupSize: number;
  requiredRoomFeatures?: string[];
  /**
   * Weekdays this specific session may be placed on — the solver picks ONE
   * of these for the final placement (see PlacedSession). This is NOT "the
   * template meets on all of these days" — a template meeting 3x/week must
   * be submitted as three separate UnscheduledSessions (one per weekly
   * meeting), each with its own `id`, so each gets its own day+room+time
   * and none of them collide with each other. See solver-adapter.ts for
   * the split.
   */
  candidateDays: import('../types.js').Weekday[];
  /** Duration in minutes — used to pick candidate slots of the right length. */
  durationMinutes: number;
}

export interface SolverRoom {
  id: Id;
  capacity: number;
  features: string[];
}

/** A single bookable slot: one weekday + one start time, within the institution's grid. */
export interface TimeSlot {
  day: import('../types.js').Weekday;
  /** "HH:MM", must align to the solver's slot grid (see SolverOptions.slotGranularityMinutes). */
  startTime: string;
}

export interface ResourceAvailabilityWindow {
  resourceType: 'teacher' | 'room' | 'group';
  resourceId: Id;
  day: import('../types.js').Weekday;
  startTime: string;
  endTime: string;
}

export interface SchedulingProblem {
  sessions: UnscheduledSession[];
  rooms: SolverRoom[];
  /**
   * Availability windows already flattened to concrete day/time ranges for
   * one representative week (the solver reasons about one repeating week,
   * not calendar dates — recurrence is handled by the generator afterward).
   * Omit a resource entirely to treat it as always available.
   */
  availability: ResourceAvailabilityWindow[];
  /** Candidate start times to try, in order, e.g. every 30 min from 08:00-18:00. */
  candidateSlotsPerDay: string[];
  days: import('../types.js').Weekday[];
}

/**
 * The solver's answer for one session: a single room and a single start/end
 * time that applies to EVERY day in that session's `candidateDays` — e.g.
 * "Room 4, 10:00-11:00, on Mon/Wed/Fri". Institutions overwhelmingly want
 * one consistent room/time across a week's meetings for the same class, so
 * this is the default the solver optimizes for rather than allowing each
 * day to land in a different room independently (which is a different,
 * harder problem — split the template into one UnscheduledSession per day
 * upstream if that flexibility is genuinely needed).
 */
export interface PlacedSession {
  sessionId: Id;
  roomId: Id;
  days: import('../types.js').Weekday[];
  startTime: string;
  endTime: string;
}

export interface UnplaceableSession {
  sessionId: Id;
  reason: string;
}

export type SolveStatus = 'COMPLETE' | 'PARTIAL' | 'INFEASIBLE';

export interface SolveResult {
  status: SolveStatus;
  placements: PlacedSession[];
  unplaced: UnplaceableSession[];
}

export interface SolverOptions {
  /** Backtracking search gives up and returns PARTIAL past this many attempts. */
  maxBacktrackSteps?: number;
}
