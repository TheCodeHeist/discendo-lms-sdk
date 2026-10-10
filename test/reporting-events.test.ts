import { describe, it, expect } from 'bun:test';
import { ReportingService } from '../src/services/reporting/index.js';
import type { AttendanceRecord, AttendanceRepository, SessionLocator } from '../src/services/reporting/index.js';
import { createRolePolicy, EventBus } from '../src/core/index.js';
import type {
  Enrollment,
  Identity,
  PermissionPolicy,
  RepositoryContext,
  Role,
  LmsEvent,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const sleep = () => new Promise((r) => setTimeout(r, 0));

function buildWorld(opts: { noBus?: boolean; enforce?: boolean } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  add('teacher', ['instructor']);
  add('stu', ['student']);

  const enrollments: Enrollment[] = [
    { id: 'enr-1', userId: 'teacher', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() },
    { id: 'enr-2', userId: 'stu', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
  ];

  const repos: RepositoryContext = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : null),
      findSection: async (id) => (id === 'sec-1' ? { id, courseId: 'course-a', status: 'published' as const } : null),
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => ({ ...e, id: 'e1' }),
      update: async (id, patch) => ({ id, userId: 'u', sectionId: 's', role: 'student', status: 'active', enrolledAt: new Date(), ...patch }),
      findById: async () => null,
      findByUserAndSection: async (userId, sectionId) =>
        enrollments.find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => enrollments.filter((e) => e.sectionId === sectionId),
      countActive: async () => 0,
    },
    content: {
      findById: async () => null,
      listBySection: async () => [],
      create: async (x) => ({ ...x, id: 'c', version: 1 }),
      update: async (id, patch) => ({ id, sectionId: 's', kind: 'page', title: '', orderIndex: 0, published: false, version: 1, ...patch }),
      reorder: async () => {},
    },
    terms: { findById: async () => null },
  };

  const records: AttendanceRecord[] = [];
  const attendance: AttendanceRepository = {
    record: async (e) => { records.push(e); },
    listForSession: async (sessionId) => records.filter((r) => r.sessionId === sessionId),
  };

  const sessions: SessionLocator = {
    sectionOf: async (sessionId) => (sessionId === 'sess-1' ? 'sec-1' : null),
    sessionsInSection: async (sectionId) => (sectionId === 'sec-1' ? ['sess-1'] : []),
  };

  const bus = opts.noBus ? undefined : new EventBus();
  const events: LmsEvent[] = [];
  if (bus) {
    bus.on('*', (e) => events.push(e));
  }

  const policy = createRolePolicy();
  const service = new ReportingService(attendance, {
    sessions,
    events: bus,
    ...(opts.enforce !== false ? { enforcement: { policy, repos } } : {}),
  });

  return { service, events, records };
}

describe('ReportingService event emission', () => {
  it('emits reporting.attendanceRecorded with enforcement on', async () => {
    const { service, events } = buildWorld({ enforce: true });
    await service.recordAttendance(
      {
        sessionId: 'sess-1',
        userId: 'stu',
        status: 'present',
        recordedAt: new Date(),
      },
      as('teacher'),
    );
    await sleep();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'reporting.attendanceRecorded',
      sessionId: 'sess-1',
      userId: 'stu',
      status: 'present',
      recordedBy: 'teacher',
      sectionId: 'sec-1',
      orgId: 'org-a',
    });
  });

  it('emits reporting.attendanceRecorded without enforcement', async () => {
    const { service, events } = buildWorld({ enforce: false });
    const at = new Date();
    await service.recordAttendance({
      sessionId: 'sess-1',
      userId: 'stu',
      status: 'late',
      recordedAt: at,
      recordedBy: 'manual-recorder',
    });
    await sleep();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'reporting.attendanceRecorded',
      sessionId: 'sess-1',
      userId: 'stu',
      status: 'late',
      recordedBy: 'manual-recorder',
    });
  });

  it('works with no EventBus configured', async () => {
    const { service, records } = buildWorld({ noBus: true, enforce: true });
    await service.recordAttendance(
      {
        sessionId: 'sess-1',
        userId: 'stu',
        status: 'present',
        recordedAt: new Date(),
      },
      as('teacher'),
    );
    expect(records).toHaveLength(1);
  });
});
