import { describe, it, expect } from 'bun:test';
import {
  teacherTimePreference,
  preferredRoomForCourse,
  spaceOutSameDaySessions,
  scoreCandidate,
} from '../src/domains/scheduling/index.js';
import type { CandidateContext, UnscheduledSession, PlacedSession } from '../src/domains/scheduling/index.js';

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

function ctx(overrides: Partial<CandidateContext> = {}): CandidateContext {
  return {
    session: session(),
    roomId: 'room-1',
    days: ['MO'],
    startTime: '10:00',
    endTime: '11:00',
    placedSoFar: new Map(),
    sessionsById: new Map(),
    ...overrides,
  };
}

describe('teacherTimePreference', () => {
  it('has zero penalty inside the preferred window', () => {
    const c = teacherTimePreference('teacher-1', '09:00', '15:00');
    expect(c.penalty(ctx({ startTime: '10:00' }))).toBe(0);
  });

  it('penalizes proportionally to distance before the window', () => {
    const c = teacherTimePreference('teacher-1', '09:00', '15:00');
    expect(c.penalty(ctx({ startTime: '08:00' }))).toBe(60);
    expect(c.penalty(ctx({ startTime: '08:30' }))).toBe(30);
  });

  it('penalizes proportionally to distance after the window', () => {
    const c = teacherTimePreference('teacher-1', '09:00', '15:00');
    expect(c.penalty(ctx({ startTime: '16:00' }))).toBe(60);
  });

  it('ignores a session whose teacher does not match', () => {
    const c = teacherTimePreference('teacher-9', '09:00', '15:00');
    expect(c.penalty(ctx({ startTime: '02:00', session: session({ teacherIds: ['teacher-1'] }) }))).toBe(0);
  });
});

describe('preferredRoomForCourse', () => {
  it('has zero penalty when the candidate room is preferred', () => {
    const c = preferredRoomForCourse('course-physics', ['room-lab']);
    expect(
      c.penalty(ctx({ roomId: 'room-lab', session: session({ courseId: 'course-physics' }) })),
    ).toBe(0);
  });

  it('penalizes a non-preferred room for the matching course', () => {
    const c = preferredRoomForCourse('course-physics', ['room-lab']);
    expect(
      c.penalty(ctx({ roomId: 'room-other', session: session({ courseId: 'course-physics' }) })),
    ).toBeGreaterThan(0);
  });

  it('ignores sessions for a different course', () => {
    const c = preferredRoomForCourse('course-physics', ['room-lab']);
    expect(
      c.penalty(ctx({ roomId: 'room-other', session: session({ courseId: 'course-chemistry' }) })),
    ).toBe(0);
  });

  it('ignores a session with no courseId at all', () => {
    const c = preferredRoomForCourse('course-physics', ['room-lab']);
    expect(c.penalty(ctx({ roomId: 'room-other', session: session() }))).toBe(0);
  });
});

describe('spaceOutSameDaySessions', () => {
  const constraint = spaceOutSameDaySessions(1, 30);

  it('has zero penalty with nothing placed yet', () => {
    expect(constraint.penalty(ctx())).toBe(0);
  });

  it('has zero penalty when the candidate does not share a day with any placed session', () => {
    const placedSession = session({ id: 's-other', groupId: 'group-1' });
    const placed: PlacedSession = { sessionId: 's-other', roomId: 'room-1', days: ['TU'], startTime: '09:00', endTime: '10:00' };
    const result = constraint.penalty(
      ctx({
        days: ['MO'],
        startTime: '09:00',
        endTime: '10:00',
        session: session({ id: 's1', groupId: 'group-1' }),
        placedSoFar: new Map([['s-other', placed]]),
        sessionsById: new Map([['s-other', placedSession]]),
      }),
    );
    expect(result).toBe(0);
  });

  it('penalizes a candidate placed immediately back-to-back with another same-group session on a shared day', () => {
    const placedSession = session({ id: 's-other', groupId: 'group-1' });
    const placed: PlacedSession = { sessionId: 's-other', roomId: 'room-1', days: ['MO'], startTime: '09:00', endTime: '10:00' };
    const result = constraint.penalty(
      ctx({
        days: ['MO'],
        startTime: '10:00', // starts exactly when the other one ends -> 0 gap
        endTime: '11:00',
        session: session({ id: 's1', groupId: 'group-1' }),
        placedSoFar: new Map([['s-other', placed]]),
        sessionsById: new Map([['s-other', placedSession]]),
      }),
    );
    expect(result).toBeGreaterThan(0);
  });

  it('has zero penalty once the gap meets minGapMinutes', () => {
    const placedSession = session({ id: 's-other', groupId: 'group-1' });
    const placed: PlacedSession = { sessionId: 's-other', roomId: 'room-1', days: ['MO'], startTime: '09:00', endTime: '10:00' };
    const result = constraint.penalty(
      ctx({
        days: ['MO'],
        startTime: '10:30', // exactly a 30-minute gap
        endTime: '11:30',
        session: session({ id: 's1', groupId: 'group-1' }),
        placedSoFar: new Map([['s-other', placed]]),
        sessionsById: new Map([['s-other', placedSession]]),
      }),
    );
    expect(result).toBe(0);
  });

  it('ignores placed sessions belonging to a different group', () => {
    const placedSession = session({ id: 's-other', groupId: 'group-2' });
    const placed: PlacedSession = { sessionId: 's-other', roomId: 'room-1', days: ['MO'], startTime: '09:00', endTime: '10:00' };
    const result = constraint.penalty(
      ctx({
        days: ['MO'],
        startTime: '10:00',
        endTime: '11:00',
        session: session({ id: 's1', groupId: 'group-1' }),
        placedSoFar: new Map([['s-other', placed]]),
        sessionsById: new Map([['s-other', placedSession]]),
      }),
    );
    expect(result).toBe(0);
  });

  it('does not penalize an actual overlap (that is a hard conflict, not this constraint\'s job)', () => {
    const placedSession = session({ id: 's-other', groupId: 'group-1' });
    const placed: PlacedSession = { sessionId: 's-other', roomId: 'room-1', days: ['MO'], startTime: '09:00', endTime: '10:00' };
    const result = constraint.penalty(
      ctx({
        days: ['MO'],
        startTime: '09:30', // overlaps the placed session
        endTime: '10:30',
        session: session({ id: 's1', groupId: 'group-1' }),
        placedSoFar: new Map([['s-other', placed]]),
        sessionsById: new Map([['s-other', placedSession]]),
      }),
    );
    expect(result).toBe(0);
  });
});

describe('scoreCandidate', () => {
  it('sums weighted penalties across multiple constraints', () => {
    const constraints = [
      teacherTimePreference('teacher-1', '09:00', '15:00', 1),
      preferredRoomForCourse('course-physics', ['room-lab'], 2),
    ];
    const result = scoreCandidate(
      constraints,
      ctx({
        startTime: '16:00', // 60 min past window -> penalty 60 * weight 1 = 60
        roomId: 'room-other', // not preferred -> penalty 1 * weight 2 = 2
        session: session({ teacherIds: ['teacher-1'], courseId: 'course-physics' }),
      }),
    );
    expect(result).toBe(62);
  });

  it('returns 0 for an empty constraint list', () => {
    expect(scoreCandidate([], ctx())).toBe(0);
  });
});
