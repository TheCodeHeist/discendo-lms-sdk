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
  /**
   * Loose course reference for teacher-qualification checks (see
   * SchedulingProblem.teacherQualifications). Optional — omit it if you
   * don't track subject-specific staffing; the check always passes when
   * this is undefined.
   */
  courseId?: Id;
  /** How many students attend — used for room capacity matching. */
  groupSize: number;
  requiredRoomFeatures?: string[];
  /**
   * Every weekday this session must meet on. The solver treats this as a
   * single atomic requirement: it picks ONE room and ONE start/end time
   * that works across ALL of these days simultaneously (see PlacedSession)
   * — never a different day landing in a different room/time. If two
   * templates happen to need genuinely independent per-day placement,
   * model them as separate UnscheduledSessions upstream (e.g. one session
   * per day) with distinct `id`s.
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
  /**
   * Teacher subject-qualification records. Optional/opt-in — omit entirely,
   * or omit a given teacher's record, to skip qualification enforcement for
   * them (see teacher-qualification.ts). Only consulted for sessions that
   * set `courseId`; a session with no `courseId` is never checked.
   */
  teacherQualifications?: import('../types.js').TeacherQualification[];
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
  /**
   * Sum of every soft constraint's weighted penalty across the placements
   * actually found — 0 if no softConstraints were supplied, or if every
   * placed candidate fully satisfied every constraint. Lower is better.
   * This scores only the ONE schedule the solver settled on; it is not
   * compared against alternative feasible schedules (see
   * soft-constraints.ts's module doc for why).
   */
  totalPenalty: number;
}

export interface SolverOptions {
  /** Backtracking search gives up and returns PARTIAL past this many attempts. */
  maxBacktrackSteps?: number;
  /**
   * Preferences to optimize for among feasible placements — see
   * soft-constraints.ts. Omit or leave empty for the previous
   * first-feasible-solution behavior with no preference ordering.
   */
  softConstraints?: import('./soft-constraints.js').SoftConstraint[];
}
