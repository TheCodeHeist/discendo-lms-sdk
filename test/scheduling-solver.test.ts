import { describe, it, expect } from 'bun:test';
import { solveSchedule } from '../src/domains/scheduling/index.js';
import type { SchedulingProblem, UnscheduledSession } from '../src/domains/scheduling/index.js';

function session(overrides: Partial<UnscheduledSession> = {}): UnscheduledSession {
  return {
    id: 's1',
    sectionId: 'sec-1',
    teacherIds: ['teacher-1'],
    groupId: 'group-1',
    groupSize: 20,
    candidateDays: ['MO', 'WE'],
    durationMinutes: 60,
    ...overrides,
  };
}

function baseProblem(overrides: Partial<SchedulingProblem> = {}): SchedulingProblem {
  return {
    sessions: [session()],
    rooms: [{ id: 'room-1', capacity: 30, features: [] }],
    availability: [],
    candidateSlotsPerDay: ['09:00', '10:00', '11:00'],
    days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    ...overrides,
  };
}

describe('solveSchedule', () => {
  it('places a single session with no conflicts, on every one of its candidate days', () => {
    const result = solveSchedule(baseProblem());
    expect(result.status).toBe('COMPLETE');
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]?.roomId).toBe('room-1');
    expect(result.placements[0]?.days.sort()).toEqual(['MO', 'WE']);
    expect(result.placements[0]?.startTime).toBeDefined();
  });

  it('reports INFEASIBLE when no room has enough capacity', () => {
    const problem = baseProblem({
      sessions: [session({ groupSize: 100 })],
      rooms: [{ id: 'room-1', capacity: 30, features: [] }],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('INFEASIBLE');
    expect(result.unplaced).toHaveLength(1);
  });

  it('reports INFEASIBLE when a required room feature is missing everywhere', () => {
    const problem = baseProblem({
      sessions: [session({ requiredRoomFeatures: ['lab'] })],
      rooms: [{ id: 'room-1', capacity: 30, features: [] }],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('INFEASIBLE');
  });

  it('does not create a candidate if the room/time fails on even one of the candidate days', () => {
    const problem = baseProblem({
      sessions: [session({ candidateDays: ['MO', 'WE'] })],
      availability: [
        { resourceType: 'teacher', resourceId: 'teacher-1', day: 'MO', startTime: '09:00', endTime: '10:00' },
      ],
      candidateSlotsPerDay: ['09:00'],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('INFEASIBLE');
  });

  it('avoids double-booking the same teacher across two sessions sharing a day', () => {
    const problem = baseProblem({
      sessions: [
        session({ id: 's1', teacherIds: ['teacher-1'], groupId: 'group-1', candidateDays: ['MO'] }),
        session({ id: 's2', teacherIds: ['teacher-1'], groupId: 'group-2', candidateDays: ['MO'] }),
      ],
      rooms: [
        { id: 'room-1', capacity: 30, features: [] },
        { id: 'room-2', capacity: 30, features: [] },
      ],
      candidateSlotsPerDay: ['09:00'],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('PARTIAL');
    expect(result.placements).toHaveLength(1);
  });

  it('resolves teacher contention by using a different day when available', () => {
    const problem = baseProblem({
      sessions: [
        session({ id: 's1', teacherIds: ['teacher-1'], groupId: 'group-1', candidateDays: ['MO'] }),
        session({ id: 's2', teacherIds: ['teacher-1'], groupId: 'group-2', candidateDays: ['TU'] }),
      ],
      rooms: [{ id: 'room-1', capacity: 30, features: [] }],
      candidateSlotsPerDay: ['09:00'],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('COMPLETE');
  });

  it('respects teacher availability windows', () => {
    const problem = baseProblem({
      sessions: [session({ candidateDays: ['MO'] })],
      availability: [
        { resourceType: 'teacher', resourceId: 'teacher-1', day: 'MO', startTime: '09:00', endTime: '09:30' },
      ],
      candidateSlotsPerDay: ['10:00'],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('INFEASIBLE');
  });

  it('does not double-book a room across two different groups/teachers', () => {
    const problem = baseProblem({
      sessions: [
        session({ id: 's1', teacherIds: ['teacher-1'], groupId: 'group-1', candidateDays: ['MO'] }),
        session({ id: 's2', teacherIds: ['teacher-2'], groupId: 'group-2', candidateDays: ['TU'] }),
      ],
      rooms: [{ id: 'room-1', capacity: 30, features: [] }],
      candidateSlotsPerDay: ['09:00'],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('COMPLETE');
    const byDayTime = new Map<string, number>();
    for (const p of result.placements) {
      for (const day of p.days) {
        const key = `${day}|${p.startTime}|${p.roomId}`;
        byDayTime.set(key, (byDayTime.get(key) ?? 0) + 1);
      }
    }
    for (const count of byDayTime.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it('places the more constrained session first (fewer valid rooms)', () => {
    const problem = baseProblem({
      sessions: [
        session({ id: 'easy', requiredRoomFeatures: [] }),
        session({ id: 'hard', requiredRoomFeatures: ['lab'] }),
      ],
      rooms: [
        { id: 'room-1', capacity: 30, features: [] },
        { id: 'room-lab', capacity: 30, features: ['lab'] },
      ],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('COMPLETE');
    const hardPlacement = result.placements.find((p) => p.sessionId === 'hard');
    expect(hardPlacement?.roomId).toBe('room-lab');
  });

  it('returns PARTIAL (not a crash) when only some sessions can be placed', () => {
    const problem = baseProblem({
      sessions: [session({ id: 's1' }), session({ id: 's2', groupSize: 999 })],
      rooms: [{ id: 'room-1', capacity: 30, features: [] }],
    });
    const result = solveSchedule(problem);
    expect(result.status).toBe('PARTIAL');
    expect(result.placements).toHaveLength(1);
    expect(result.unplaced).toHaveLength(1);
    expect(result.unplaced[0]?.sessionId).toBe('s2');
  });
});
