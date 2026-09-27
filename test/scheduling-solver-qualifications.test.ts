import { describe, it, expect } from 'bun:test';
import { solveSchedule } from '../src/scheduling/index.js';
import type { SchedulingProblem, UnscheduledSession, TeacherQualification } from '../src/scheduling/index.js';

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

describe('solveSchedule with teacher qualifications', () => {
  it('does not enforce qualification when no courseId is set on the session', () => {
    const result = solveSchedule(
      baseProblem({
        teacherQualifications: [{ teacherId: 'teacher-1', qualifiedCourseIds: [] }],
      }),
    );
    expect(result.status).toBe('COMPLETE');
  });

  it('places a session whose teacher is qualified for its course', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ courseId: 'course-physics' })],
        teacherQualifications: [{ teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'] }],
      }),
    );
    expect(result.status).toBe('COMPLETE');
  });

  it('marks a session unplaced when its teacher is not qualified for its course', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ courseId: 'course-chemistry' })],
        teacherQualifications: [{ teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'] }],
      }),
    );
    expect(result.status).toBe('INFEASIBLE');
    expect(result.unplaced).toHaveLength(1);
    expect(result.unplaced[0]?.reason).toContain('teacher-1');
  });

  it('treats a teacher with no qualification record as qualified for anything', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ courseId: 'course-anything' })],
        teacherQualifications: [], // no record at all for teacher-1
      }),
    );
    expect(result.status).toBe('COMPLETE');
  });

  it('does not let an unqualified session block other, qualified sessions from being placed', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [
          session({ id: 's-bad', teacherIds: ['teacher-1'], groupId: 'group-1', courseId: 'course-chemistry' }),
          session({ id: 's-good', teacherIds: ['teacher-2'], groupId: 'group-2', courseId: 'course-physics' }),
        ],
        teacherQualifications: [
          { teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'] },
          { teacherId: 'teacher-2', qualifiedCourseIds: ['course-physics'] },
        ],
      }),
    );
    expect(result.status).toBe('PARTIAL');
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]?.sessionId).toBe('s-good');
    expect(result.unplaced[0]?.sessionId).toBe('s-bad');
  });

  it('requires ALL co-teachers to be qualified, not just one', () => {
    const result = solveSchedule(
      baseProblem({
        sessions: [session({ teacherIds: ['teacher-1', 'teacher-2'], courseId: 'course-physics' })],
        teacherQualifications: [
          { teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'] },
          { teacherId: 'teacher-2', qualifiedCourseIds: ['course-chemistry'] }, // not qualified
        ],
      }),
    );
    expect(result.status).toBe('INFEASIBLE');
  });
});
