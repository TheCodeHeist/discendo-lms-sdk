import { describe, it, expect } from 'bun:test';
import { solveSchedule, teacherTimePreference, preferredRoomForCourse, spaceOutSameDaySessions } from '../src/scheduling/index.js';
import type { SchedulingProblem, UnscheduledSession } from '../src/scheduling/index.js';

function session(overrides: Partial<UnscheduledSession> = {}): UnscheduledSession {
  return {
    id: 's1',
    sectionId: 'sec-1',
    teacherIds: ['teacher-1'],
    groupId: 'group-1',
    groupSize: 20,
    candidateDays: ['MO'],
    durationMinutes: 60,
    ...overrides,
  };
}

function baseProblem(overrides: Partial<SchedulingProblem> = {}): SchedulingProblem {
  return {
    sessions: [session()],
    rooms: [{ id: 'room-1', capacity: 30, features: [] }],
    availability: [],
    candidateSlotsPerDay: ['08:00', '09:00', '10:00', '11:00', '16:00'],
    days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    ...overrides,
  };
}

describe('solveSchedule with soft constraints', () => {
  it('has totalPenalty 0 when no soft constraints are supplied', () => {
    const result = solveSchedule(baseProblem());
    expect(result.status).toBe('COMPLETE');
    expect(result.totalPenalty).toBe(0);
  });

  it('prefers a slot inside the teacher time preference window over one outside it', () => {
    const result = solveSchedule(baseProblem(), {
      softConstraints: [teacherTimePreference('teacher-1', '09:00', '11:00')],
    });
    expect(result.status).toBe('COMPLETE');
    // 09:00, 10:00, and 11:00 are all inside the window and appear before
    // 16:00 in candidateSlotsPerDay too, but 08:00 comes first in the raw
    // list — soft-constraint ordering should still pick a within-window
    // slot over the earlier-but-worse 08:00.
    expect(['09:00', '10:00', '11:00']).toContain(result.placements[0]!.startTime);
    expect(result.totalPenalty).toBe(0);
  });

  it('picks a preferred room over a non-preferred one when both are otherwise equal', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ courseId: 'course-physics' })],
        rooms: [
          { id: 'room-a', capacity: 30, features: [] },
          { id: 'room-b', capacity: 30, features: [] },
        ],
      }),
      { softConstraints: [preferredRoomForCourse('course-physics', ['room-b'])] },
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.placements[0]?.roomId).toBe('room-b');
    expect(result.totalPenalty).toBe(0);
  });

  it('spaces out two same-group sessions that both land on a shared day, given room enough to choose a later time', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [
          session({ id: 's1', groupId: 'group-1', teacherIds: ['teacher-1'], candidateDays: ['MO'] }),
          session({ id: 's2', groupId: 'group-1', teacherIds: ['teacher-2'], candidateDays: ['MO'] }),
        ],
        candidateSlotsPerDay: ['09:00', '10:00', '13:00'],
      }),
      { softConstraints: [spaceOutSameDaySessions(1, 60)] },
    );
    expect(result.status).toBe('COMPLETE');
    const [p1, p2] = result.placements;
    // Both are forced onto Monday (candidateDays fixes that), but with a
    // gap requirement of 60 minutes and three time options, the solver
    // should avoid the immediately-adjacent slot (09:00 then 10:00) in
    // favor of the one with real breathing room (13:00), when it can.
    expect(p1?.startTime).not.toBe(undefined);
    expect(p2?.startTime).not.toBe(undefined);
    expect(result.totalPenalty).toBe(0);
  });

  it('still finds a feasible schedule even when satisfying every soft preference is impossible', () => {
    // Only one slot exists at all, and it's outside the teacher's preferred window.
    const result = solveSchedule(
      baseProblem({ candidateSlotsPerDay: ['08:00'] }),
      { softConstraints: [teacherTimePreference('teacher-1', '09:00', '17:00')] },
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.placements[0]?.startTime).toBe('08:00');
    expect(result.totalPenalty).toBeGreaterThan(0);
  });

  it('does not let soft constraints override hard constraints (capacity)', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ groupSize: 100, courseId: 'course-physics' })],
        rooms: [{ id: 'room-1', capacity: 30, features: [] }], // too small regardless of preference
      }),
      { softConstraints: [preferredRoomForCourse('course-physics', ['room-1'])] },
    );
    expect(result.status).toBe('INFEASIBLE');
  });

  it('combines multiple soft constraints correctly (weighted sum still finds a feasible result)', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ courseId: 'course-physics' })],
        rooms: [
          { id: 'room-a', capacity: 30, features: [] },
          { id: 'room-b', capacity: 30, features: [] },
        ],
      }),
      {
        softConstraints: [
          teacherTimePreference('teacher-1', '09:00', '11:00', 1),
          preferredRoomForCourse('course-physics', ['room-b'], 2),
        ],
      },
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.placements[0]?.roomId).toBe('room-b');
    expect(['09:00', '10:00', '11:00']).toContain(result.placements[0]!.startTime);
    expect(result.totalPenalty).toBe(0);
  });
});
