import { describe, it, expect } from 'bun:test';
import {
  SchedulingService,
  SchedulingTargetNotFoundError,
  InvalidSchedulingSettingsError,
  InvalidSchedulingPlanError,
} from '../src/domains/scheduling/index.js';
import type { ClassOccurrence, ClassSessionTemplate } from '../src/domains/scheduling/index.js';
import { InMemorySchedulingRepository } from '../src/domains/scheduling/testing/in-memory-repository.js';
import { createRolePolicy, EventBus, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
import type {
  Enrollment,
  GuardianLink,
  GuardianScope,
  Identity,
  PermissionContext,
  PermissionPolicy,
  RepositoryContext,
  Role,
  TaGrant,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const sleep = () => new Promise((r) => setTimeout(r, 0));
const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * org-a: root (admin), teacher (instructor of sec-1), teacher-2 (instructor of sec-2), ta (enr-3 in
 * sec-1), students stu / stu-2 (active in sec-1), stu-dropped, stu-wait, stu-done, stu-sec2 (sec-2),
 * parents parent (ward stu, schedule) / parent-noscope, outsider. org-b: root-b, teacher-b (sec-b).
 * Rooms: room-a1, room-a2 (org-a), room-b1 (org-b), room-free (no organization). Templates tpl-1
 * (sec-1), tpl-2 (sec-2), tpl-b (sec-b).
 */
function buildWorld(
  opts: {
    policy?: PermissionPolicy;
    grants?: TaGrant[];
    enforce?: boolean;
    settings?: boolean;
    roomCapacity?: number; // capacity of the org-a rooms (the other organizations' rooms are always big)
  } = {},
) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId?: string) => users.set(id, { id, roles, ...(orgId ? { orgId } : {}) });
  add('root', ['admin'], 'org-a');
  add('teacher', ['instructor'], 'org-a');
  add('teacher-2', ['instructor'], 'org-a');
  add('ta', ['ta'], 'org-a');
  for (const id of ['stu', 'stu-2', 'stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'parent', 'parent-noscope', 'outsider']) {
    add(id, ['student'], 'org-a');
  }
  add('root-b', ['admin'], 'org-b');
  add('teacher-b', ['instructor'], 'org-b');
  add('stu-b', ['student'], 'org-b');

  const enrollments: Enrollment[] = [];
  let en = 0;
  const seed = (userId: string, sectionId: string, role: Role, status: Enrollment['status'] = 'active') =>
    enrollments.push({ id: `enr-${++en}`, userId, sectionId, role, status, enrolledAt: new Date() });
  seed('teacher', 'sec-1', 'instructor');
  seed('teacher-2', 'sec-2', 'instructor');
  seed('ta', 'sec-1', 'ta');
  seed('stu', 'sec-1', 'student');
  seed('stu-2', 'sec-1', 'student');
  seed('stu-sec2', 'sec-2', 'student');
  seed('stu-dropped', 'sec-1', 'student', 'dropped');
  seed('stu-wait', 'sec-1', 'student', 'waitlisted');
  seed('stu-done', 'sec-1', 'student', 'completed');
  seed('teacher-b', 'sec-b', 'instructor');
  seed('stu-b', 'sec-b', 'student');

  const link = (id: string, guardianId: string, wardId: string, scopes: GuardianScope[]): GuardianLink => ({
    id, guardianId, wardId, orgId: 'org-a', scopes, status: 'active', createdAt: new Date(),
  });
  const links = [link('l1', 'parent', 'stu', ['schedule']), link('l2', 'parent-noscope', 'stu', ['grades'])];

  const courses: Record<string, { id: string; title: string; orgId?: string }> = {
    'course-a': { id: 'course-a', title: 'A', orgId: 'org-a' },
    'course-a2': { id: 'course-a2', title: 'A2', orgId: 'org-a' },
    'course-b': { id: 'course-b', title: 'B', orgId: 'org-b' },
    'course-free': { id: 'course-free', title: 'Free' },
  };
  const sectionCourse: Record<string, string> = { 'sec-1': 'course-a', 'sec-2': 'course-a', 'sec-b': 'course-b', 'sec-orphan': 'missing-course' };
  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'guardianLinks' | 'delegations'> = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => courses[id] ?? null,
      findSection: async (id) => (sectionCourse[id] ? { id, courseId: sectionCourse[id]!, status: 'published' as const } : null),
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => ({ ...e, id: `enr-${++en}` }),
      findById: async (id) => enrollments.find((e) => e.id === id) ?? null,
      update: async (id, patch) => ({ ...enrollments.find((e) => e.id === id)!, ...patch }),
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments].reverse().find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => enrollments.filter((e) => e.sectionId === sectionId),
      countActive: async () => 0,
    },
    guardianLinks: {
      findActive: async (g, w) => links.find((l) => l.guardianId === g && l.wardId === w && l.status === 'active') ?? null,
    },
    delegations: {
      create: async (g) => ({ ...g, id: 'grant-x' }),
      findById: async (id) => (opts.grants ?? []).find((g) => g.id === id) ?? null,
      listActiveForEnrollment: async (enrollmentId) =>
        (opts.grants ?? []).filter((g) => g.enrollmentId === enrollmentId && g.revokedAt === undefined),
      revoke: async (id, at) => ({ ...(opts.grants ?? [])[0]!, revokedAt: at }),
    },
  };

  const repo = new InMemorySchedulingRepository();
  const tpl = (over: Partial<ClassSessionTemplate> & Pick<ClassSessionTemplate, 'id' | 'sectionId' | 'teacherIds' | 'groupId'>): ClassSessionTemplate => ({
    courseId: 'course-a',
    rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] },
    startTime: '09:00',
    endTime: '10:00',
    timezone: 'UTC',
    validFrom: D('2026-10-01'),
    ...over,
  });
  repo.seedTemplate(tpl({ id: 'tpl-1', sectionId: 'sec-1', teacherIds: ['teacher'], groupId: 'grp-1', roomId: 'room-a1' }));
  repo.seedTemplate(tpl({ id: 'tpl-2', sectionId: 'sec-2', teacherIds: ['teacher-2'], groupId: 'grp-2', roomId: 'room-a2' }));
  repo.seedTemplate(tpl({ id: 'tpl-b', sectionId: 'sec-b', courseId: 'course-b', teacherIds: ['teacher-b'], groupId: 'grp-b', roomId: 'room-b1' }));
  repo.seedGroup({ id: 'grp-1', sectionId: 'sec-1', size: 20 });
  repo.seedGroup({ id: 'grp-2', sectionId: 'sec-2', size: 15 });
  repo.seedGroup({ id: 'grp-b', sectionId: 'sec-b', size: 10 });
  const cap = opts.roomCapacity ?? 30;
  repo.seedRoom({ id: 'room-a1', name: 'A1', capacity: cap, features: [], orgId: 'org-a' });
  repo.seedRoom({ id: 'room-a2', name: 'A2', capacity: cap, features: [], orgId: 'org-a' });
  repo.seedRoom({ id: 'room-b1', name: 'B1', capacity: 100, features: [], orgId: 'org-b' });
  repo.seedRoom({ id: 'room-free', name: 'Free', capacity: 100, features: [] });
  const occ = (id: string, templateId: string, date: string, over: Partial<ClassOccurrence> = {}): ClassOccurrence => ({
    id, templateId, date: D(date), status: 'scheduled', ...over,
  });
  repo.seedOccurrence(occ('occ-1', 'tpl-1', '2026-10-12', { roomId: 'room-a1', startTime: '09:00', endTime: '10:00' }));
  repo.seedOccurrence(occ('occ-1c', 'tpl-1', '2026-10-19', { status: 'cancelled' }));
  repo.seedOccurrence(occ('occ-1b', 'tpl-1', '2026-10-26'));
  repo.seedOccurrence(occ('occ-2', 'tpl-2', '2026-10-12'));
  repo.seedOccurrence(occ('occ-b', 'tpl-b', '2026-10-12'));
  repo.seedOccurrence(occ('occ-orphan', 'tpl-missing', '2026-10-12'));

  const bus = new EventBus();
  const cancelled: Array<Record<string, unknown>> = [];
  const moved: Array<Record<string, unknown>> = [];
  bus.on('scheduling.occurrenceCancelled', (e) => void cancelled.push(e as never));
  bus.on('scheduling.occurrenceRescheduled', (e) => void moved.push(e as never));
  const recorded: Array<{ sessionId: string; userId: string; status: string }> = [];
  const recorder = {
    record: async (e: { sessionId: string; userId: string; status: string }) => void recorded.push(e),
    listForSession: async () => [],
  };

  const policy = opts.policy ?? createRolePolicy();
  const service = new SchedulingService(repo, recorder as never, bus, {
    ...(opts.enforce === false ? {} : { enforcement: { policy, repos } }),
    ...(opts.settings === false ? {} : { settings: repo }),
  });
  return { service, repo, cancelled, moved, recorded, repos, policy };
}
type World = ReturnType<typeof buildWorld>;

const grant = (action: string, over: Partial<TaGrant> = {}): TaGrant => ({
  id: `g-${action}`, enrollmentId: 'enr-3', sectionId: 'sec-1', action, grantedBy: 'teacher', grantedAt: new Date(), ...over,
});
const spyPolicy = () => {
  const seen: Array<{ action: string; ctx: PermissionContext }> = [];
  const policy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
  return { seen, policy };
};
const resources = (over: Partial<{ teacherIds: string[]; roomId: string; groupId: string }> = {}) => ({
  teacherIds: ['teacher'], roomId: 'room-a1', groupId: 'grp-1', startTime: '09:00', endTime: '10:00', ...over,
});
const candidate = async (w: World, id = 'occ-1') => (await w.repo.findOccurrence(id))!;
const rule = (over = {}) => ({
  rule: { freq: 'WEEKLY' as const, interval: 1, byDay: ['MO' as const, 'WE' as const] },
  startTime: '09:00', endTime: '12:00', timezone: 'UTC', validFrom: D('2026-10-01'), ...over,
});

describe('every method needs an actor once enforcement is on', () => {
  it('refuses with ActorRequiredError and touches nothing', async () => {
    const w = buildWorld();
    const c = await candidate(w);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['checkConflicts', () => w.service.checkConflicts(c, resources())],
      ['checkAvailabilityForResources', () => w.service.checkAvailabilityForResources(D('2026-10-12'), resources())],
      ['checkRoomForOccurrence', () => w.service.checkRoomForOccurrence('room-a1', { groupSize: 10 } as never)],
      ['checkAll', () => w.service.checkAll(c, resources())],
      ['materializeOccurrences', () => w.service.materializeOccurrences('tpl-1', D('2026-11-01'), D('2026-11-30'))],
      ['cancelOccurrence', () => w.service.cancelOccurrence('occ-1')],
      ['rescheduleOccurrence', () => w.service.rescheduleOccurrence('occ-1', { startTime: '10:00' })],
      ['recordAttendanceForOccurrence', () => w.service.recordAttendanceForOccurrence('occ-1', 'stu', 'present')],
      ['canRecordAttendance', () => w.service.canRecordAttendance('occ-1')],
      ['planAutoSchedule', () => w.service.planAutoSchedule(['tpl-1'], { candidateSlotsPerDay: ['09:00'], days: ['MO'] })],
      ['applyAutoSchedulePlan', () => w.service.applyAutoSchedulePlan({ status: 'COMPLETE', placements: [], unplaced: [], totalPenalty: 0 })],
      ['listOccurrences', () => w.service.listOccurrences('sec-1', D('2026-10-01'), D('2026-12-01'))],
      ['setAvailability', () => w.service.setAvailability('teacher', 'teacher', [])],
      ['getAvailability', () => w.service.getAvailability('teacher', 'teacher')],
      ['setTeacherPreferences', () => w.service.setTeacherPreferences('teacher', {})],
      ['getTeacherPreferences', () => w.service.getTeacherPreferences('teacher')],
      ['setTeacherQualification', () => w.service.setTeacherQualification('teacher', [])],
      ['getTeacherQualification', () => w.service.getTeacherQualification('teacher')],
    ];
    for (const [name, call] of calls) {
      await expect(call(), name).rejects.toBeInstanceOf(ActorRequiredError);
    }
    expect(w.cancelled).toEqual([]);
    expect(w.recorded).toEqual([]);
  });
});

describe('cancelOccurrence: an instructor\'s class, an instructor\'s call', () => {
  it('lets the section\'s instructor cancel, and tells whoever listens exactly who did what', async () => {
    const w = buildWorld();
    const updated = await w.service.cancelOccurrence('occ-1', 'Sick today', as('teacher'));
    expect(updated).toMatchObject({ id: 'occ-1', status: 'cancelled', note: 'Sick today' });
    await sleep();
    expect(w.cancelled).toEqual([
      {
        type: 'scheduling.occurrenceCancelled',
        occurrenceId: 'occ-1',
        templateId: 'tpl-1',
        sectionId: 'sec-1',
        actorId: 'teacher',
        actorRole: 'instructor',
        previousStatus: 'scheduled',
        note: 'Sick today',
      },
    ]);
  });

  it('says it was an admin when an admin did it, and has no note key without a note', async () => {
    const w = buildWorld();
    await w.service.cancelOccurrence('occ-1', undefined, as('root'));
    await sleep();
    expect(w.cancelled[0]).toMatchObject({ actorId: 'root', actorRole: 'admin', sectionId: 'sec-1' });
    expect('note' in w.cancelled[0]!).toBe(false);
  });

  it('lets a TA do it once manageOccurrence is delegated to them, and says so', async () => {
    const w = buildWorld({ grants: [grant('scheduling.manageOccurrence')] });
    await w.service.cancelOccurrence('occ-1', undefined, as('ta'));
    await sleep();
    expect(w.cancelled[0]).toMatchObject({ actorId: 'ta', actorRole: 'ta' });
  });

  it.each(['ta', 'stu', 'stu-dropped', 'stu-done', 'parent', 'teacher-2', 'root-b', 'teacher-b', 'outsider', 'nobody'])(
    'refuses %s: nothing changes and nobody is told',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.cancelOccurrence('occ-1', 'x', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      await sleep();
      expect((await w.repo.findOccurrence('occ-1'))!.status).toBe('scheduled');
      expect(w.cancelled).toEqual([]);
    },
  );

  it('ignores a delegation that is revoked, for another section, or for another action', async () => {
    for (const g of [
      grant('scheduling.manageOccurrence', { revokedAt: new Date() }),
      grant('scheduling.manageOccurrence', { sectionId: 'sec-2' }),
      grant('scheduling.recordAttendance'),
    ]) {
      const w = buildWorld({ grants: [g] });
      await expect(w.service.cancelOccurrence('occ-1', undefined, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('takes the section from the stored occurrence, so another section\'s instructor cannot cancel it', async () => {
    const w = buildWorld();
    await expect(w.service.cancelOccurrence('occ-2', undefined, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.cancelOccurrence('occ-2', undefined, as('teacher-2'))).resolves.toMatchObject({ status: 'cancelled' });
  });

  it.each(['no-such-occurrence', 'occ-orphan'])('refuses %s (unknown, or its template is gone) even for an admin', async (id) => {
    const w = buildWorld();
    await expect(w.service.cancelOccurrence(id, undefined, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('asks the policy about scheduling.manageOccurrence in the occurrence\'s section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.cancelOccurrence('occ-1', undefined, as('teacher')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['scheduling.manageOccurrence']);
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section?.role).toBe('instructor');
  });
});

describe('rescheduleOccurrence', () => {
  it('lets the instructor move their class, and the event says what moved from where, and who did it', async () => {
    const w = buildWorld();
    const moved = await w.service.rescheduleOccurrence('occ-1', { roomId: 'room-a2', startTime: '10:00', endTime: '11:00' }, as('teacher'));
    expect(moved).toMatchObject({ status: 'moved', roomId: 'room-a2', startTime: '10:00', endTime: '11:00' });
    await sleep();
    expect(w.moved).toEqual([
      {
        type: 'scheduling.occurrenceRescheduled',
        occurrenceId: 'occ-1',
        templateId: 'tpl-1',
        date: D('2026-10-12'),
        roomId: 'room-a2',
        startTime: '10:00',
        endTime: '11:00',
        sectionId: 'sec-1',
        actorId: 'teacher',
        actorRole: 'instructor',
        from: { date: D('2026-10-12'), status: 'scheduled', roomId: 'room-a1', startTime: '09:00', endTime: '10:00' },
      },
    ]);
  });

  it('lets an admin, and a TA with the delegated action', async () => {
    await expect(buildWorld().service.rescheduleOccurrence('occ-1', { startTime: '10:00' }, as('root'))).resolves.toBeDefined();
    const w = buildWorld({ grants: [grant('scheduling.manageOccurrence')] });
    await expect(w.service.rescheduleOccurrence('occ-1', { startTime: '10:00' }, as('ta'))).resolves.toBeDefined();
  });

  it.each(['ta', 'stu', 'parent', 'teacher-2', 'root-b', 'outsider', 'nobody'])('refuses %s, and changes nothing', async (who) => {
    const w = buildWorld();
    await expect(w.service.rescheduleOccurrence('occ-1', { startTime: '10:00' }, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await w.repo.findOccurrence('occ-1'))!.status).toBe('scheduled');
    expect(w.moved).toEqual([]);
  });

  it.each(['room-b1', 'room-free', 'no-such-room'])('refuses a room that is %s, saying the same for all three, and changes nothing', async (roomId) => {
    const w = buildWorld();
    const err = await w.service.rescheduleOccurrence('occ-1', { roomId }, as('teacher')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchedulingTargetNotFoundError);
    expect((err as Error).message).toBe('Scheduling resource not found in this organization');
    expect((await w.repo.findOccurrence('occ-1'))!.roomId).toBe('room-a1');
    expect(w.moved).toEqual([]);
  });

  it('checks permission before the room, so a stranger learns nothing about other organizations\' rooms', async () => {
    const w = buildWorld();
    await expect(w.service.rescheduleOccurrence('occ-1', { roomId: 'room-b1' }, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('works without a room in the patch', async () => {
    const w = buildWorld();
    await expect(w.service.rescheduleOccurrence('occ-1', { date: D('2026-10-14') }, as('teacher'))).resolves.toMatchObject({ status: 'moved' });
  });
});

describe('the planning checks', () => {
  it('lets the instructor of the candidate\'s section run every check', async () => {
    const w = buildWorld();
    const c = await candidate(w);
    await expect(w.service.checkConflicts(c, resources(), as('teacher'))).resolves.toBeDefined();
    await expect(w.service.checkAvailabilityForResources(c.date, resources(), as('teacher'))).resolves.toBeDefined();
    await expect(w.service.checkAll(c, resources(), { groupSize: 10 } as never, as('teacher'))).resolves.toMatchObject({ ok: expect.any(Boolean) });
  });

  it.each(['ta', 'stu', 'parent', 'teacher-2', 'root-b', 'outsider', 'nobody'])('refuses %s, and does not read anyone\'s bookings', async (who) => {
    const w = buildWorld();
    let reads = 0;
    const original = w.repo.listOccurrencesForResource.bind(w.repo);
    w.repo.listOccurrencesForResource = async (...a) => (reads++, original(...a));
    const c = await candidate(w);
    await expect(w.service.checkConflicts(c, resources(), as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.checkAll(c, resources(), undefined, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(reads).toBe(0);
  });

  it.each([
    ['a teacher of another organization', { teacherIds: ['teacher', 'teacher-b'] }],
    ['an unknown teacher', { teacherIds: ['ghost'] }],
    ['a room of another organization', { roomId: 'room-b1' }],
    ['a room with no organization', { roomId: 'room-free' }],
    ['a group of another organization', { groupId: 'grp-b' }],
    ['an unknown group', { groupId: 'grp-none' }],
  ])('refuses %s, and does not read anyone\'s bookings', async (_label, over) => {
    const w = buildWorld();
    let reads = 0;
    const original = w.repo.listOccurrencesForResource.bind(w.repo);
    w.repo.listOccurrencesForResource = async (...a) => (reads++, original(...a));
    const c = await candidate(w);
    await expect(w.service.checkConflicts(c, resources(over), as('teacher'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
    await expect(w.service.checkAvailabilityForResources(c.date, resources(over), as('teacher'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
    expect(reads).toBe(0);
  });

  it('takes the candidate\'s section from its stored template, not from what the caller passes in', async () => {
    const w = buildWorld();
    const forged = { ...(await candidate(w, 'occ-2')), templateId: 'tpl-1' }; // claims to be sec-1's, carries sec-2's data
    await expect(w.service.checkConflicts(forged, resources(), as('teacher-2'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.checkConflicts(forged, resources(), as('teacher'))).resolves.toBeDefined();
  });

  it('checkAvailabilityForResources has no candidate to tie to a section, so it is organization-wide: instructors and admins, resources of their own organization', async () => {
    const w = buildWorld();
    const other = resources({ groupId: 'grp-2', teacherIds: ['teacher-2'], roomId: 'room-a2' });
    await expect(w.service.checkAvailabilityForResources(D('2026-10-12'), other, as('teacher'))).resolves.toBeDefined();
    await expect(w.service.checkAvailabilityForResources(D('2026-10-12'), other, as('root'))).resolves.toBeDefined();
    for (const who of ['ta', 'stu', 'parent', 'nobody']) {
      await expect(w.service.checkAvailabilityForResources(D('2026-10-12'), other, as(who)), who).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.checkAvailabilityForResources(D('2026-10-12'), resources(), as('root-b'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
  });

  it('checkRoomForOccurrence: an instructor or admin, a room of their own organization', async () => {
    const w = buildWorld();
    await expect(w.service.checkRoomForOccurrence('room-a1', { groupSize: 10 } as never, as('teacher'))).resolves.toBeUndefined();
    await expect(w.service.checkRoomForOccurrence('room-a1', { groupSize: 10 } as never, as('root'))).resolves.toBeUndefined();
    await expect(w.service.checkRoomForOccurrence('room-a1', { groupSize: 10 } as never, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.checkRoomForOccurrence('room-b1', { groupSize: 10 } as never, as('teacher'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
    await expect(w.service.checkRoomForOccurrence('room-free', { groupSize: 10 } as never, as('teacher'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
    await expect(w.service.checkRoomForOccurrence('no-such-room', { groupSize: 10 } as never, as('teacher'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
  });
});

describe('materializeOccurrences', () => {
  it('is for admins only, in the template\'s section', async () => {
    const w = buildWorld();
    const made = await w.service.materializeOccurrences('tpl-1', D('2026-11-01'), D('2026-11-30'), as('root'));
    expect(made.length).toBeGreaterThan(0);
    for (const who of ['teacher', 'ta', 'stu', 'root-b', 'nobody']) {
      await expect(w.service.materializeOccurrences('tpl-1', D('2026-12-01'), D('2026-12-31'), as(who)), who).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('refuses an unknown template for everyone, even an admin, and another organization\'s template', async () => {
    const w = buildWorld();
    await expect(w.service.materializeOccurrences('no-such', D('2026-11-01'), D('2026-11-30'), as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.materializeOccurrences('tpl-b', D('2026-11-01'), D('2026-11-30'), as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('recording attendance', () => {
  it('lets the instructor record it for an active student of the section', async () => {
    const w = buildWorld();
    await w.service.recordAttendanceForOccurrence('occ-1', 'stu', 'present', as('teacher'));
    expect(w.recorded).toMatchObject([{ sessionId: 'occ-1', userId: 'stu', status: 'present' }]);
  });

  it('stamps who recorded it, and says nothing about it when enforcement is off', async () => {
    const w = buildWorld();
    await w.service.recordAttendanceForOccurrence('occ-1', 'stu', 'present', as('teacher'));
    expect(w.recorded[0]).toMatchObject({ userId: 'stu', recordedBy: 'teacher' });
    const plain = buildWorld({ enforce: false });
    await plain.service.recordAttendanceForOccurrence('occ-1', 'stu', 'present');
    expect('recordedBy' in plain.recorded[0]!).toBe(false);
  });

  it('lets an admin, and a TA with the delegated action', async () => {
    await expect(buildWorld().service.recordAttendanceForOccurrence('occ-1', 'stu', 'present', as('root'))).resolves.toBeUndefined();
    const w = buildWorld({ grants: [grant('scheduling.recordAttendance')] });
    await expect(w.service.recordAttendanceForOccurrence('occ-1', 'stu', 'late', as('ta'))).resolves.toBeUndefined();
    const other = buildWorld({ grants: [grant('scheduling.manageOccurrence')] });
    await expect(other.service.recordAttendanceForOccurrence('occ-1', 'stu', 'late', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['ta', 'stu', 'stu-2', 'parent', 'teacher-2', 'root-b', 'outsider', 'nobody'])('refuses %s, and records nothing', async (who) => {
    const w = buildWorld();
    await expect(w.service.recordAttendanceForOccurrence('occ-1', 'stu', 'present', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.recorded).toEqual([]);
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'stu-b', 'teacher', 'ta', 'root', 'ghost'])(
    'refuses to record it for %s, who is not an active student of that section',
    async (target) => {
      const w = buildWorld();
      await expect(w.service.recordAttendanceForOccurrence('occ-1', target, 'present', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.recorded).toEqual([]);
    },
  );

  it('takes the section from the stored occurrence', async () => {
    const w = buildWorld();
    await expect(w.service.recordAttendanceForOccurrence('occ-2', 'stu-sec2', 'present', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.recordAttendanceForOccurrence('occ-2', 'stu-sec2', 'present', as('teacher-2'))).resolves.toBeUndefined();
  });

  it.each(['no-such', 'occ-orphan'])('refuses %s (unknown, or its template is gone) like a forbidden one', async (id) => {
    const w = buildWorld();
    await expect(w.service.recordAttendanceForOccurrence(id, 'stu', 'present', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('still refuses a cancelled occurrence, after the permission check', async () => {
    const w = buildWorld();
    await expect(w.service.recordAttendanceForOccurrence('occ-1c', 'stu', 'present', as('teacher'))).rejects.toThrow('cancelled');
    await expect(w.service.recordAttendanceForOccurrence('occ-1c', 'stu', 'present', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.recorded).toEqual([]);
  });

  it('canRecordAttendance needs the same permission, and still reports why not', async () => {
    const w = buildWorld();
    expect(await w.service.canRecordAttendance('occ-1', as('teacher'))).toBeUndefined();
    expect(await w.service.canRecordAttendance('occ-1c', as('teacher'))).toMatchObject({ reason: 'occurrence-cancelled' });
    await expect(w.service.canRecordAttendance('occ-1', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('auto-scheduling stays inside the organization', () => {
  const grid = { candidateSlotsPerDay: ['09:00', '13:00'], days: ['MO' as const] };

  it('plans only with the organization\'s own rooms: a bigger room of another organization is never used', async () => {
    const w = buildWorld({ roomCapacity: 10 }); // group of 20 fits only the (foreign) 100-seat rooms
    const { result } = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
    expect(result.placements).toEqual([]);
    expect(result.unplaced).toHaveLength(1);
  });

  it('plans normally with its own rooms, and only those', async () => {
    const w = buildWorld();
    const { result } = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
    expect(result.status).toBe('COMPLETE');
    expect(['room-a1', 'room-a2']).toContain(result.placements[0]!.roomId);
  });

  it.each(['teacher', 'ta', 'stu', 'root-b', 'nobody'])('refuses %s: planning is for admins', async (who) => {
    const w = buildWorld();
    await expect(w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each([
    ['another organization\'s template', ['tpl-1', 'tpl-b']],
    ['an unknown template', ['tpl-1', 'tpl-none']],
  ])('refuses a plan that includes %s, as a whole', async (_label, ids) => {
    const w = buildWorld();
    await expect(w.service.planAutoSchedule(ids, grid, {}, undefined, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each([
    ['a teacher of another organization', { teacherIds: ['teacher', 'teacher-b'] }],
    ['a group of another organization', { groupId: 'grp-b' }],
    ['a room of another organization already on it', { roomId: 'room-b1' }],
  ])('refuses to plan a template of this organization that carries %s', async (_label, over) => {
    const w = buildWorld();
    await w.repo.updateTemplate('tpl-1', over);
    await expect(w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
  });

  it('needs an admin even when there is nothing to plan: an empty plan is no way around the check', async () => {
    const w = buildWorld();
    await expect(w.service.planAutoSchedule([], grid)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.planAutoSchedule([], grid, {}, undefined, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.planAutoSchedule([], grid, {}, undefined, as('root'))).resolves.toBeDefined();
    await expect(w.service.applyAutoSchedulePlan({ status: 'COMPLETE', placements: [], unplaced: [], totalPenalty: 0 }, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.applyAutoSchedulePlan({ status: 'COMPLETE', placements: [], unplaced: [], totalPenalty: 0 }, as('root'))).resolves.toEqual([]);
  });

  it('applies a genuine plan', async () => {
    const w = buildWorld();
    const { result } = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
    const [updated] = await w.service.applyAutoSchedulePlan(result, as('root'));
    expect(updated!.id).toBe('tpl-1');
    expect(['room-a1', 'room-a2']).toContain(updated!.roomId as string);
  });

  it.each(['teacher', 'ta', 'stu', 'root-b', 'nobody'])('refuses %s applying a plan', async (who) => {
    const w = buildWorld();
    const { result } = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
    await expect(w.service.applyAutoSchedulePlan(result, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await w.repo.findTemplate('tpl-1'))!.roomId).toBe('room-a1');
  });

  describe('a plan is untrusted input: it is checked placement by placement before anything is written', () => {
    const placement = (sessionId: string, roomId: string) => ({ sessionId, roomId, days: ['TU' as const], startTime: '13:00', endTime: '14:00' });
    const plan = (...p: Array<ReturnType<typeof placement>>) => ({ status: 'COMPLETE' as const, placements: p as never, unplaced: [], totalPenalty: 0 });

    it('refuses a placement onto another organization\'s template, and writes nothing', async () => {
      const w = buildWorld();
      await expect(w.service.applyAutoSchedulePlan(plan(placement('tpl-1', 'room-a2'), placement('tpl-b', 'room-a2')), as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect((await w.repo.findTemplate('tpl-1'))!.roomId).toBe('room-a1');
    });

    it.each(['room-b1', 'room-free', 'no-such-room'])('refuses a placement into room %s, and writes nothing', async (roomId) => {
      const w = buildWorld();
      await expect(w.service.applyAutoSchedulePlan(plan(placement('tpl-2', 'room-a2'), placement('tpl-1', roomId)), as('root'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
      expect((await w.repo.findTemplate('tpl-2'))!.startTime).toBe('09:00');
      expect((await w.repo.findTemplate('tpl-1'))!.roomId).toBe('room-a1');
    });

    it.each([
      ['a start that is not a time', { startTime: 'noon' }],
      ['an end before the start', { startTime: '14:00', endTime: '13:00' }],
      ['no days', { days: [] }],
      ['a day that does not exist', { days: ['XX'] }],
    ])('refuses a placement with %s, and writes nothing', async (_label, over) => {
      const w = buildWorld();
      await expect(
        w.service.applyAutoSchedulePlan(plan(placement('tpl-2', 'room-a2'), { ...placement('tpl-1', 'room-a2'), ...over } as never), as('root')),
      ).rejects.toBeInstanceOf(InvalidSchedulingPlanError);
      expect((await w.repo.findTemplate('tpl-2'))!.startTime).toBe('09:00');
      expect((await w.repo.findTemplate('tpl-1'))!.roomId).toBe('room-a1');
    });

    it('refuses a placement for a template that does not exist, instead of skipping it', async () => {
      const w = buildWorld();
      await expect(w.service.applyAutoSchedulePlan(plan(placement('tpl-1', 'room-a2'), placement('tpl-none', 'room-a2')), as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect((await w.repo.findTemplate('tpl-1'))!.roomId).toBe('room-a1');
    });
  });

  it('asks the policy about scheduling.manage in each template\'s section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.planAutoSchedule(['tpl-1', 'tpl-2'], grid, {}, undefined, as('root')).catch(() => {});
    expect(seen[0]!.action).toBe('scheduling.manage');
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
  });
});

describe('listOccurrences: who may see the timetable', () => {
  const ids = (list: ClassOccurrence[]) => list.map((o) => o.id).sort();
  const range: [Date, Date] = [D('2026-10-01'), D('2026-12-01')];

  it.each(['stu', 'stu-2', 'teacher', 'ta', 'root'])('shows %s the section\'s occurrences, cancelled ones included, and no other section\'s', async (who) => {
    const w = buildWorld();
    expect(ids(await w.service.listOccurrences('sec-1', ...range, as(who)))).toEqual(['occ-1', 'occ-1b', 'occ-1c']);
  });

  it('respects the range', async () => {
    const w = buildWorld();
    expect(ids(await w.service.listOccurrences('sec-1', D('2026-10-15'), D('2026-10-31'), as('stu')))).toEqual(['occ-1b', 'occ-1c']);
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'outsider', 'parent', 'teacher-2', 'root-b', 'stu-b', 'nobody'])(
    'refuses %s, and does not read the section\'s timetable',
    async (who) => {
      const w = buildWorld();
      let reads = 0;
      const original = w.repo.listTemplatesForSection.bind(w.repo);
      w.repo.listTemplatesForSection = async (id) => (reads++, original(id));
      await expect(w.service.listOccurrences('sec-1', ...range, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(reads).toBe(0);
    },
  );

  it('shows a guardian their ward\'s section timetable when the link has the schedule scope', async () => {
    const w = buildWorld();
    expect(ids(await w.service.listOccurrences('sec-1', ...range, as('parent'), { wardId: 'stu' }))).toEqual(['occ-1', 'occ-1b', 'occ-1c']);
  });

  it.each([
    ['a guardian without the schedule scope', 'parent-noscope', 'stu', 'sec-1'],
    ['a guardian naming a ward they are not linked to', 'parent', 'stu-2', 'sec-1'],
    ['a guardian asking about a section their ward is not in', 'parent', 'stu', 'sec-2'],
    ['a stranger naming a ward', 'outsider', 'stu', 'sec-1'],
  ])('refuses %s', async (_label, who, wardId, sectionId) => {
    const w = buildWorld();
    await expect(w.service.listOccurrences(sectionId, ...range, as(who), { wardId })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = buildWorld();
    await expect(w.service.listOccurrences(sectionId, ...range, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('asks the policy about scheduling.view, naming the ward as the owner', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.listOccurrences('sec-1', ...range, as('parent'), { wardId: 'stu' }).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['scheduling.view']);
    expect(seen[0]!.ctx.resourceOwnerId).toBe('stu');
    expect(seen[0]!.ctx.guardian).toMatchObject({ wardId: 'stu' });
  });
});

describe('settings an instructor manages for themselves (and an admin for anyone)', () => {
  const weekday = rule();

  describe('availability', () => {
    it('lets an instructor replace their own, and read it back', async () => {
      const w = buildWorld();
      const saved = await w.service.setAvailability('teacher', 'teacher', [weekday], as('teacher'));
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ resourceType: 'teacher', resourceId: 'teacher', startTime: '09:00' });
      expect((await w.service.getAvailability('teacher', 'teacher', as('teacher'))).map((r) => r.id)).toEqual(saved.map((r) => r.id));
      await w.service.setAvailability('teacher', 'teacher', [], as('teacher'));
      expect(await w.service.getAvailability('teacher', 'teacher', as('teacher'))).toEqual([]);
    });

    it('lets an admin do it for any teacher of the organization', async () => {
      const w = buildWorld();
      await expect(w.service.setAvailability('teacher', 'teacher-2', [weekday], as('root'))).resolves.toHaveLength(1);
    });

    it.each(['teacher-2', 'ta', 'stu', 'parent', 'nobody'])('refuses %s setting or reading someone else\'s', async (who) => {
      const w = buildWorld();
      await expect(w.service.setAvailability('teacher', 'teacher', [weekday], as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(w.service.getAvailability('teacher', 'teacher', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(await w.repo.listAvailability('teacher', 'teacher')).toEqual([]);
    });

    it('does not let an admin of another organization touch an organization\'s teacher, and says the same as for an unknown one', async () => {
      const w = buildWorld();
      const foreign = await w.service.setAvailability('teacher', 'teacher', [weekday], as('root-b')).catch((e: unknown) => e);
      const unknown = await w.service.setAvailability('teacher', 'ghost', [weekday], as('root')).catch((e: unknown) => e);
      expect(foreign).toBeInstanceOf(SchedulingTargetNotFoundError);
      expect((foreign as Error).message).toBe((unknown as Error).message);
      expect(await w.repo.listAvailability('teacher', 'teacher')).toEqual([]);
    });

    it('rooms and groups are the admin\'s, in their own organization', async () => {
      const w = buildWorld();
      await expect(w.service.setAvailability('room', 'room-a1', [weekday], as('root'))).resolves.toHaveLength(1);
      await expect(w.service.setAvailability('group', 'grp-1', [weekday], as('root'))).resolves.toHaveLength(1);
      for (const who of ['teacher', 'ta', 'stu']) {
        await expect(w.service.setAvailability('room', 'room-a1', [weekday], as(who)), who).rejects.toBeInstanceOf(PermissionDeniedError);
        await expect(w.service.setAvailability('group', 'grp-1', [weekday], as(who)), who).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      await expect(w.service.setAvailability('room', 'room-b1', [weekday], as('root'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
      await expect(w.service.setAvailability('room', 'room-free', [weekday], as('root'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
      await expect(w.service.setAvailability('group', 'grp-b', [weekday], as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(w.service.setAvailability('group', 'grp-1', [weekday], as('root-b'))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(w.service.getAvailability('room', 'room-a1', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it.each([
      ['a time that is not HH:MM', { startTime: '9am' }],
      ['an end that is not after the start', { startTime: '10:00', endTime: '10:00' }],
      ['an hour out of range', { endTime: '25:00' }],
      ['no days', { rule: { freq: 'WEEKLY' as const, interval: 1, byDay: [] } }],
      ['an unknown weekday', { rule: { freq: 'WEEKLY' as const, interval: 1, byDay: ['XX' as never] } }],
      ['an interval below one', { rule: { freq: 'WEEKLY' as const, interval: 0, byDay: ['MO' as const] } }],
      ['no timezone', { timezone: '' }],
      ['an end of validity before its start', { validUntil: D('2026-09-01') }],
    ])('refuses %s, and keeps what was there', async (_label, over) => {
      const w = buildWorld();
      await w.service.setAvailability('teacher', 'teacher', [weekday], as('teacher'));
      await expect(w.service.setAvailability('teacher', 'teacher', [rule(over)], as('teacher'))).rejects.toBeInstanceOf(InvalidSchedulingSettingsError);
      expect(await w.repo.listAvailability('teacher', 'teacher')).toHaveLength(1);
    });

    it('checks permission before validating, so a stranger learns nothing', async () => {
      const w = buildWorld();
      await expect(w.service.setAvailability('teacher', 'teacher', [rule({ startTime: 'x' })], as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('asks the policy about scheduling.manageSettings for a teacher (owner: that teacher) and scheduling.manage for a room', async () => {
      const { seen, policy } = spyPolicy();
      const w = buildWorld({ policy });
      await w.service.setAvailability('teacher', 'teacher', [], as('teacher')).catch(() => {});
      await w.service.setAvailability('room', 'room-a1', [], as('root')).catch(() => {});
      expect(seen.map((s) => s.action)).toEqual(['scheduling.manageSettings', 'scheduling.manage']);
      expect(seen[0]!.ctx.resourceOwnerId).toBe('teacher');
      expect(seen[0]!.ctx.section).toBeUndefined();
    });
  });

  describe('preferences (the solver\'s soft preferences, persisted)', () => {
    const prefs = { preferredStartWindow: { earliest: '13:00', latest: '15:00' } };

    it('lets an instructor save and read their own, and an admin anyone\'s', async () => {
      const w = buildWorld();
      expect(await w.service.getTeacherPreferences('teacher', as('teacher'))).toBeNull();
      await w.service.setTeacherPreferences('teacher', prefs, as('teacher'));
      expect(await w.service.getTeacherPreferences('teacher', as('teacher'))).toEqual({ teacherId: 'teacher', ...prefs });
      await expect(w.service.setTeacherPreferences('teacher-2', prefs, as('root'))).resolves.toMatchObject({ teacherId: 'teacher-2' });
    });

    it('can be cleared by saving none', async () => {
      const w = buildWorld();
      await w.service.setTeacherPreferences('teacher', prefs, as('teacher'));
      await w.service.setTeacherPreferences('teacher', {}, as('teacher'));
      expect(await w.service.getTeacherPreferences('teacher', as('teacher'))).toEqual({ teacherId: 'teacher' });
    });

    it.each(['teacher-2', 'ta', 'stu', 'nobody'])('refuses %s someone else\'s', async (who) => {
      const w = buildWorld();
      await expect(w.service.setTeacherPreferences('teacher', prefs, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(w.service.getTeacherPreferences('teacher', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('finds nobody in another organization', async () => {
      const w = buildWorld();
      await expect(w.service.setTeacherPreferences('teacher', prefs, as('root-b'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
      await expect(w.service.getTeacherPreferences('teacher-b', as('root'))).rejects.toBeInstanceOf(SchedulingTargetNotFoundError);
    });

    it.each([
      ['a window that is not HH:MM', { preferredStartWindow: { earliest: '1pm', latest: '15:00' } }],
      ['a window that ends before it starts', { preferredStartWindow: { earliest: '15:00', latest: '13:00' } }],
    ])('refuses %s', async (_label, bad) => {
      const w = buildWorld();
      await expect(w.service.setTeacherPreferences('teacher', bad, as('teacher'))).rejects.toBeInstanceOf(InvalidSchedulingSettingsError);
      expect(await w.service.getTeacherPreferences('teacher', as('teacher'))).toBeNull();
    });

    it('is what the planner uses: a saved preference moves the placement, and a person\'s own preference only affects their own classes', async () => {
      const grid = { candidateSlotsPerDay: ['09:00', '13:00'], days: ['MO' as const] };
      const w = buildWorld();
      const before = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
      expect(before.result.placements[0]!.startTime).toBe('09:00');
      await w.service.setTeacherPreferences('teacher', prefs, as('teacher'));
      const after = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
      expect(after.result.placements[0]!.startTime).toBe('13:00');
      await w.service.setTeacherPreferences('teacher', {}, as('teacher'));
      await w.service.setTeacherPreferences('teacher-2', prefs, as('teacher-2'));
      const other = await w.service.planAutoSchedule(['tpl-1'], grid, {}, undefined, as('root'));
      expect(other.result.placements[0]!.startTime).toBe('09:00');
    });
  });

  describe('qualifications (admin-only)', () => {
    it('lets an admin set them, and the planner honors them', async () => {
      const w = buildWorld();
      const saved = await w.service.setTeacherQualification('teacher', ['course-a2', 'course-a2'], as('root'));
      expect(saved).toEqual({ teacherId: 'teacher', qualifiedCourseIds: ['course-a2'] });
      const { result } = await w.service.planAutoSchedule(['tpl-1'], { candidateSlotsPerDay: ['09:00'], days: ['MO'] }, {}, undefined, as('root'));
      expect(result.placements).toEqual([]); // tpl-1 is course-a, which the teacher is no longer qualified for
      await w.service.setTeacherQualification('teacher', ['course-a'], as('root'));
      const again = await w.service.planAutoSchedule(['tpl-1'], { candidateSlotsPerDay: ['09:00'], days: ['MO'] }, {}, undefined, as('root'));
      expect(again.result.placements).toHaveLength(1);
    });

    it.each(['teacher', 'teacher-2', 'ta', 'stu', 'root-b', 'nobody'])('refuses %s, an instructor qualifying themselves included', async (who) => {
      const w = buildWorld();
      await expect(w.service.setTeacherQualification('teacher', ['course-a'], as(who))).rejects.toBeInstanceOf(
        who === 'root-b' ? SchedulingTargetNotFoundError : PermissionDeniedError,
      );
      expect(await w.repo.findTeacherQualification('teacher')).toBeNull();
    });

    it.each([
      ['a course of another organization', ['course-b']],
      ['a course with no organization', ['course-free']],
      ['an unknown course', ['course-none']],
    ])('refuses %s, saying the same for all three', async (_label, ids) => {
      const w = buildWorld();
      const err = await w.service.setTeacherQualification('teacher', ids, as('root')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SchedulingTargetNotFoundError);
      expect((err as Error).message).toBe('Scheduling resource not found in this organization');
      expect(await w.repo.findTeacherQualification('teacher')).toBeNull();
    });

    it('lets an instructor read their own, an admin anyone\'s, and nobody else', async () => {
      const w = buildWorld();
      await w.service.setTeacherQualification('teacher', ['course-a'], as('root'));
      expect(await w.service.getTeacherQualification('teacher', as('teacher'))).toEqual({ teacherId: 'teacher', qualifiedCourseIds: ['course-a'] });
      expect(await w.service.getTeacherQualification('teacher', as('root'))).not.toBeNull();
      expect(await w.service.getTeacherQualification('teacher-2', as('root'))).toBeNull();
      await expect(w.service.getTeacherQualification('teacher', as('teacher-2'))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(w.service.getTeacherQualification('teacher', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('asks the policy about scheduling.manageQualifications', async () => {
      const { seen, policy } = spyPolicy();
      const w = buildWorld({ policy });
      await w.service.setTeacherQualification('teacher', [], as('root')).catch(() => {});
      expect(seen.map((s) => s.action)).toEqual(['scheduling.manageQualifications']);
    });
  });

  it('settings methods say what is missing when no SchedulingSettingsRepository was given', async () => {
    const w = buildWorld({ settings: false });
    await expect(w.service.setAvailability('teacher', 'teacher', [], as('teacher'))).rejects.toThrow('SchedulingSettingsRepository');
    await expect(w.service.setTeacherPreferences('teacher', {}, as('teacher'))).rejects.toThrow('SchedulingSettingsRepository');
    await expect(w.service.setTeacherQualification('teacher', [], as('root'))).rejects.toThrow('SchedulingSettingsRepository');
  });
});

describe('without enforcement the service behaves as it always has', () => {
  it('needs no actor, checks nothing, and keeps the old events', async () => {
    const w = buildWorld({ enforce: false });
    await expect(w.service.cancelOccurrence('occ-b', 'x')).resolves.toMatchObject({ status: 'cancelled' });
    await sleep();
    expect(w.cancelled[0]).toEqual({ type: 'scheduling.occurrenceCancelled', occurrenceId: 'occ-b', templateId: 'tpl-b', note: 'x' });
    await expect(w.service.rescheduleOccurrence('occ-1', { roomId: 'room-b1' })).resolves.toMatchObject({ roomId: 'room-b1' });
    await sleep();
    expect('actorId' in w.moved[0]!).toBe(false);
    expect('from' in w.moved[0]!).toBe(false);
    await expect(w.service.recordAttendanceForOccurrence('occ-1', 'anyone', 'present')).resolves.toBeUndefined();
  });

  it('plans with every room, rooms of any organization included', async () => {
    const w = buildWorld({ enforce: false, roomCapacity: 10 });
    const { result } = await w.service.planAutoSchedule(['tpl-1'], { candidateSlotsPerDay: ['09:00'], days: ['MO'] });
    expect(['room-b1', 'room-free']).toContain(result.placements[0]!.roomId);
  });

  it('lists occurrences, and manages settings, with no actor and no checks (still validating)', async () => {
    const w = buildWorld({ enforce: false });
    expect((await w.service.listOccurrences('sec-1', D('2026-10-01'), D('2026-12-01'))).length).toBe(3);
    await expect(w.service.setAvailability('teacher', 'anyone', [rule()])).resolves.toHaveLength(1);
    await expect(w.service.setAvailability('teacher', 'anyone', [rule({ startTime: 'x' })])).rejects.toBeInstanceOf(InvalidSchedulingSettingsError);
    await expect(w.service.setTeacherQualification('anyone', ['whatever'])).resolves.toEqual({ teacherId: 'anyone', qualifiedCourseIds: ['whatever'] });
  });

  it('plans using saved preferences too', async () => {
    const w = buildWorld({ enforce: false });
    await w.service.setTeacherPreferences('teacher', { preferredStartWindow: { earliest: '13:00', latest: '15:00' } });
    const { result } = await w.service.planAutoSchedule(['tpl-1'], { candidateSlotsPerDay: ['09:00', '13:00'], days: ['MO'] });
    expect(result.placements[0]!.startTime).toBe('13:00');
  });
});
