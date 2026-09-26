/**
 * Zero-dependency backtracking solver for the class-routine placement
 * problem. This is the "default" solver — see the module doc in
 * ../../../ (scheduling/index.ts re-export) for why: it needs no external
 * process, installs with plain `npm/bun install`, and is good enough for
 * small-to-medium institutions. A CP-SAT-backed adapter can be swapped in
 * later behind the same SchedulingProblem -> SolveResult signature for
 * larger instances that need it.
 *
 * Approach: most-constrained-variable backtracking.
 *   1. Sort sessions by how few valid (room, day, time) options they have —
 *      schedule the hardest-to-place session first. This is the single
 *      biggest lever against the combinatorial blowup: a session with only
 *      one qualifying room and one available teacher slot should never be
 *      left until last, where everything else has already claimed the slot.
 *   2. For the current session, try each candidate (room, day, time) in
 *      order; a candidate is only tried if it passes capacity/feature/
 *      availability pre-filtering AND doesn't conflict with placements
 *      already made this search.
 *   3. Recurse. If every remaining session gets placed, done. If a branch
 *      dead-ends, backtrack and try the next candidate.
 *   4. Bounded by maxBacktrackSteps — returns PARTIAL rather than hanging
 *      on a pathological input; whatever got placed is still valid.
 */
import type {
  PlacedSession,
  ResourceAvailabilityWindow,
  SchedulingProblem,
  SolverOptions,
  SolveResult,
  UnplaceableSession,
  UnscheduledSession,
} from './types.js';

const DEFAULT_MAX_STEPS = 200_000;

function addMinutes(time: string, minutes: number): string {
  const parts = time.split(':');
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function windowCovers(
  window: ResourceAvailabilityWindow,
  day: string,
  start: string,
  end: string,
): boolean {
  return window.day === day && start >= window.startTime && end <= window.endTime;
}

/** True if `resourceId` has no availability windows at all (= unconstrained) or one that covers this slot. */
function isAvailable(
  availability: ResourceAvailabilityWindow[],
  resourceType: ResourceAvailabilityWindow['resourceType'],
  resourceId: string,
  day: string,
  start: string,
  end: string,
): boolean {
  const windows = availability.filter(
    (w) => w.resourceType === resourceType && w.resourceId === resourceId,
  );
  if (windows.length === 0) return true;
  return windows.some((w) => windowCovers(w, day, start, end));
}

interface Candidate {
  roomId: string;
  days: import('../types.js').Weekday[];
  startTime: string;
  endTime: string;
}

/**
 * Builds candidates for a session: each candidate fixes one room and one
 * start/end time, applied across ALL of the session's candidateDays at
 * once (see PlacedSession's docstring for why). A candidate is only
 * generated if every one of those days independently passes capacity/
 * feature/availability checks — a room/time that works Monday but not
 * Wednesday for the same teacher is not a valid candidate at all.
 */
function candidatesFor(
  session: UnscheduledSession,
  problem: SchedulingProblem,
): Candidate[] {
  const suitableRooms = problem.rooms.filter(
    (r) =>
      r.capacity >= session.groupSize &&
      (session.requiredRoomFeatures ?? []).every((f) => r.features.includes(f)),
  );
  const days = problem.days.filter((d) => session.candidateDays.includes(d));

  const out: Candidate[] = [];
  for (const room of suitableRooms) {
    for (const startTime of problem.candidateSlotsPerDay) {
      const endTime = addMinutes(startTime, session.durationMinutes);

      const allDaysOk = days.every((day) => {
        const teachersOk = session.teacherIds.every((t) =>
          isAvailable(problem.availability, 'teacher', t, day, startTime, endTime),
        );
        const groupOk = isAvailable(problem.availability, 'group', session.groupId, day, startTime, endTime);
        const roomOk = isAvailable(problem.availability, 'room', room.id, day, startTime, endTime);
        return teachersOk && groupOk && roomOk;
      });

      if (allDaysOk && days.length > 0) {
        out.push({ roomId: room.id, days, startTime, endTime });
      }
    }
  }
  return out;
}

function conflictsWithPlaced(
  session: UnscheduledSession,
  candidate: Candidate,
  placedSoFar: Map<string, PlacedSession>,
  sessionsById: Map<string, UnscheduledSession>,
): boolean {
  for (const placed of placedSoFar.values()) {
    const sharedDay = placed.days.some((d) => candidate.days.includes(d));
    if (!sharedDay) continue;
    if (!timesOverlap(placed.startTime, placed.endTime, candidate.startTime, candidate.endTime)) continue;

    if (placed.roomId === candidate.roomId) return true;

    const placedSession = sessionsById.get(placed.sessionId);
    if (!placedSession) continue;
    if (placedSession.groupId === session.groupId) return true;
    if (placedSession.teacherIds.some((t) => session.teacherIds.includes(t))) return true;
  }
  return false;
}

export function solveSchedule(problem: SchedulingProblem, options: SolverOptions = {}): SolveResult {
  const maxSteps = options.maxBacktrackSteps ?? DEFAULT_MAX_STEPS;
  const sessionsById = new Map(problem.sessions.map((s) => [s.id, s]));

  // Precompute candidates once per session, then order by fewest options
  // first (most-constrained-variable) — this is what keeps the search tree
  // small in practice instead of degrading toward brute force.
  const candidatesBySession = new Map(
    problem.sessions.map((s) => [s.id, candidatesFor(s, problem)] as const),
  );
  const orderedSessions = [...problem.sessions].sort(
    (a, b) => (candidatesBySession.get(a.id)?.length ?? 0) - (candidatesBySession.get(b.id)?.length ?? 0),
  );

  const placedSoFar = new Map<string, PlacedSession>();
  const unplaced: UnplaceableSession[] = [];
  let steps = 0;
  let exhausted = false;

  function backtrack(index: number): boolean {
    if (index >= orderedSessions.length) return true;
    steps += 1;
    if (steps > maxSteps) {
      exhausted = true;
      return false;
    }

    const session = orderedSessions[index]!;
    const candidates = candidatesBySession.get(session.id) ?? [];

    if (candidates.length === 0) {
      unplaced.push({
        sessionId: session.id,
        reason: 'No room/day/time combination satisfies capacity, features, and availability.',
      });
      return backtrack(index + 1);
    }

    for (const candidate of candidates) {
      if (exhausted) return false;
      if (conflictsWithPlaced(session, candidate, placedSoFar, sessionsById)) continue;

      placedSoFar.set(session.id, {
        sessionId: session.id,
        roomId: candidate.roomId,
        days: candidate.days,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
      });

      if (backtrack(index + 1)) return true;

      placedSoFar.delete(session.id);
    }

    // Every candidate led to a dead end further down the line — rather than
    // failing the whole solve, record this session as unplaceable and move
    // on, so one hard session doesn't block everything else from a result.
    unplaced.push({
      sessionId: session.id,
      reason: 'Every available slot conflicts with a higher-priority placement.',
    });
    return backtrack(index + 1);
  }

  backtrack(0);

  const placements = [...placedSoFar.values()];
  const status: SolveResult['status'] =
    unplaced.length === 0 ? 'COMPLETE' : placements.length === 0 ? 'INFEASIBLE' : 'PARTIAL';

  return { status, placements, unplaced };
}
