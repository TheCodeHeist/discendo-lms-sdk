import { describe, it, expect } from 'bun:test';
import {
  EnrollmentService,
  EnrollmentNotDroppableError,
  SectionNotOpenError,
} from '../src/domains/enrollment/index.js';
import { EventBus, PermissionDeniedError, TenantMismatchError, createRolePolicy } from '../src/core/index.js';
import type { CourseSection, Enrollment, Identity, RepositoryContext, Role } from '../src/core/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));
const as = (actorId: string) => ({ actorId });

/**
 * Sections: sec-pub (published, org-a), sec-draft, sec-arch, sec-cap (published, capacity 1).
 * People (org-a): alice, bob, teacher (instructor of sec-pub), stu (enrolled in sec-pub), stu-2,
 * outsider. org-b: eve. Everything is in org-a's course.
 */
function buildWorld(opts: { enforce?: boolean; preEnrolled?: Array<Partial<Enrollment> & Pick<Enrollment, 'userId' | 'sectionId'>> } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a', externalRef?: string) =>
    users.set(id, { id, roles, orgId, ...(externalRef ? { externalRef } : {}) });
  add('alice', ['student'], 'org-a', 'ext-alice');
  add('bob', ['student'], 'org-a', 'ext-bob');
  add('teacher', ['instructor']);
  add('stu', ['student']);
  add('stu-2', ['student']);
  add('outsider', ['student']);
  add('root', ['admin']);
  add('eve', ['student'], 'org-b', 'ext-eve');

  const sections: Record<string, CourseSection> = {
    'sec-pub': { id: 'sec-pub', courseId: 'course-a', status: 'published' },
    'sec-draft': { id: 'sec-draft', courseId: 'course-a', status: 'draft' },
    'sec-arch': { id: 'sec-arch', courseId: 'course-a', status: 'archived' },
    'sec-cap': { id: 'sec-cap', courseId: 'course-a', status: 'published', capacity: 1 },
  };
  const rows: Enrollment[] = [];
  let seq = 0;
  const calls = { create: 0, update: 0 };
  const seed = (e: Partial<Enrollment> & Pick<Enrollment, 'userId' | 'sectionId'>) =>
    rows.push({ id: `enr-${++seq}`, role: 'student', status: 'active', enrolledAt: new Date('2026-09-01'), ...e });
  seed({ userId: 'teacher', sectionId: 'sec-pub', role: 'instructor' });
  seed({ userId: 'stu', sectionId: 'sec-pub' });
  seed({ userId: 'stu-2', sectionId: 'sec-pub' });
  for (const e of opts.preEnrolled ?? []) seed(e);

  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'> = {
    users: {
      findById: async (id) => users.get(id) ?? null,
      findByExternalRef: async (ref) => [...users.values()].find((u) => u.externalRef === ref) ?? null,
    },
    courses: {
      findCourse: async (id) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : null),
      findSection: async (id) => sections[id] ?? null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => {
        calls.create++;
        const row = { ...e, id: `enr-${++seq}` } as Enrollment;
        rows.push(row);
        return row;
      },
      findById: async (id) => rows.find((r) => r.id === id) ?? null,
      update: async (id, patch) => {
        calls.update++;
        const i = rows.findIndex((r) => r.id === id);
        if (i < 0) throw new Error(`no row ${id}`);
        rows[i] = { ...rows[i]!, ...patch };
        return rows[i]!;
      },
      findByUserAndSection: async (userId, sectionId) =>
        [...rows].reverse().find((r) => r.userId === userId && r.sectionId === sectionId) ?? null,
      listBySection: async (sectionId, status) => rows.filter((r) => r.sectionId === sectionId && (!status || r.status === status)),
      countActive: async (sectionId) => rows.filter((r) => r.sectionId === sectionId && r.status === 'active').length,
    },
  };

  const bus = new EventBus();
  const events: Array<{ type: string }> = [];
  bus.on('*', (e) => void events.push(e as never));
  const service = new EnrollmentService(repos as RepositoryContext, bus, opts.enforce ? { policy: createRolePolicy() } : {});
  const enrollment = (userId: string, sectionId = 'sec-pub') => rows.find((r) => r.userId === userId && r.sectionId === sectionId)!;
  return { service, rows, calls, events, enrollment };
}

describe('EnrollmentService.drop', () => {
  it('drops an active enrollment: status, time, and one event', async () => {
    const w = buildWorld();
    const id = w.enrollment('stu').id;
    const dropped = await w.service.drop(id);
    await sleep();
    expect(dropped).toMatchObject({ id, status: 'dropped' });
    expect(dropped.droppedAt).toBeInstanceOf(Date);
    expect(w.events.filter((e) => e.type === 'enrollment.dropped')).toHaveLength(1);
  });

  it('drops a waitlisted enrollment too', async () => {
    const w = buildWorld({ preEnrolled: [{ userId: 'alice', sectionId: 'sec-pub', status: 'waitlisted' }] });
    await expect(w.service.drop(w.enrollment('alice').id)).resolves.toMatchObject({ status: 'dropped' });
  });

  it('is idempotent: dropping a dropped enrollment returns it unchanged, with no new time and no second event', async () => {
    const w = buildWorld();
    const id = w.enrollment('stu').id;
    const first = await w.service.drop(id);
    await sleep();
    const updates = w.calls.update;
    const second = await w.service.drop(id);
    await sleep();
    expect(w.calls.update).toBe(updates);
    expect(second.droppedAt).toEqual(first.droppedAt);
    expect(w.events.filter((e) => e.type === 'enrollment.dropped')).toHaveLength(1);
  });

  it('refuses to drop a completed enrollment: it is history, and the completion must not be erased', async () => {
    const w = buildWorld({ preEnrolled: [{ userId: 'alice', sectionId: 'sec-pub', status: 'completed' }] });
    const id = w.enrollment('alice').id;
    await expect(w.service.drop(id)).rejects.toBeInstanceOf(EnrollmentNotDroppableError);
    await sleep();
    expect(w.enrollment('alice').status).toBe('completed');
    expect(w.enrollment('alice').droppedAt).toBeUndefined();
    expect(w.events.filter((e) => e.type === 'enrollment.dropped')).toEqual([]);
  });

  it('says it is not found for an unknown enrollment, and does not ask the repository to update it', async () => {
    const w = buildWorld();
    await expect(w.service.drop('no-such-enrollment')).rejects.toThrow('Enrollment no-such-enrollment not found');
    expect(w.calls.update).toBe(0);
  });

  it('a person can enrol again after dropping, as a new enrollment', async () => {
    const w = buildWorld();
    const old = w.enrollment('stu');
    await w.service.drop(old.id);
    const again = await w.service.enroll({ userId: 'stu', sectionId: 'sec-pub', role: 'student' });
    expect(again.id).not.toBe(old.id);
    expect(again.status).toBe('active');
  });

  describe('with enforcement', () => {
    it('lets a student drop their own, and the instructor drop anyone\'s', async () => {
      const w = buildWorld({ enforce: true });
      await expect(w.service.drop(w.enrollment('stu').id, as('stu'))).resolves.toMatchObject({ status: 'dropped' });
      await expect(w.service.drop(w.enrollment('stu-2').id, as('teacher'))).resolves.toMatchObject({ status: 'dropped' });
    });

    it('refuses a student dropping a classmate, and a stranger, and drops nothing', async () => {
      const w = buildWorld({ enforce: true });
      for (const who of ['stu-2', 'outsider', 'nobody']) {
        await expect(w.service.drop(w.enrollment('stu').id, as(who)), who).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      expect(w.enrollment('stu').status).toBe('active');
    });

    it('tells a stranger nothing about an enrollment that is dropped, completed or unknown: all are "not permitted"', async () => {
      const w = buildWorld({ enforce: true, preEnrolled: [{ userId: 'alice', sectionId: 'sec-pub', status: 'completed' }, { userId: 'bob', sectionId: 'sec-pub', status: 'dropped' }] });
      for (const id of [w.enrollment('alice').id, w.enrollment('bob').id, 'no-such-enrollment']) {
        await expect(w.service.drop(id, as('outsider')), id).rejects.toBeInstanceOf(PermissionDeniedError);
      }
    });

    it('refuses staff who try to drop a completed enrollment, after the permission check, with the not-droppable error', async () => {
      const w = buildWorld({ enforce: true, preEnrolled: [{ userId: 'alice', sectionId: 'sec-pub', status: 'completed' }] });
      await expect(w.service.drop(w.enrollment('alice').id, as('teacher'))).rejects.toBeInstanceOf(EnrollmentNotDroppableError);
      expect(w.enrollment('alice').status).toBe('completed');
    });

    it('does not even let the completed student ask: a completed enrollment gives no role to drop with', async () => {
      const w = buildWorld({ enforce: true, preEnrolled: [{ userId: 'alice', sectionId: 'sec-pub', status: 'completed' }] });
      await expect(w.service.drop(w.enrollment('alice').id, as('alice'))).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });
});

describe('EnrollmentService.enroll respects the section\'s status', () => {
  const enroll = (w: ReturnType<typeof buildWorld>, sectionId: string, extra: object = {}) =>
    w.service.enroll({ userId: 'alice', sectionId, role: 'student', ...extra });

  it('enrols into a published section', async () => {
    const w = buildWorld();
    await expect(enroll(w, 'sec-pub')).resolves.toMatchObject({ status: 'active' });
  });

  it('refuses an archived section, creating nothing and announcing nothing', async () => {
    const w = buildWorld();
    const err = await enroll(w, 'sec-arch').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SectionNotOpenError);
    expect((err as SectionNotOpenError).status).toBe('archived');
    expect((err as Error).message).toContain('archived');
    await sleep();
    expect(w.calls.create).toBe(0);
    expect(w.events).toEqual([]);
  });

  it('refuses a draft section by default, and the message says how to pre-load one', async () => {
    const w = buildWorld();
    const err = await enroll(w, 'sec-draft').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SectionNotOpenError);
    expect((err as SectionNotOpenError).status).toBe('draft');
    expect((err as Error).message).toContain('allowDraft');
    expect(w.calls.create).toBe(0);
  });

  it('lets staff pre-load a draft section with allowDraft', async () => {
    const w = buildWorld();
    await expect(enroll(w, 'sec-draft', { allowDraft: true })).resolves.toMatchObject({ status: 'active', sectionId: 'sec-draft' });
  });

  it('never enrols into an archived section, allowDraft or not', async () => {
    const w = buildWorld();
    await expect(enroll(w, 'sec-arch', { allowDraft: true })).rejects.toBeInstanceOf(SectionNotOpenError);
    expect(w.calls.create).toBe(0);
  });

  it('stays idempotent for someone already enrolled, even if the section has since been archived', async () => {
    const w = buildWorld({ preEnrolled: [{ userId: 'alice', sectionId: 'sec-arch' }, { userId: 'bob', sectionId: 'sec-draft', status: 'waitlisted' }] });
    await expect(enroll(w, 'sec-arch')).resolves.toBe(w.enrollment('alice', 'sec-arch'));
    await expect(w.service.enroll({ userId: 'bob', sectionId: 'sec-draft', role: 'student' })).resolves.toBe(w.enrollment('bob', 'sec-draft'));
    expect(w.calls.create).toBe(0);
  });

  it('still refuses someone who dropped out of a section that has since closed', async () => {
    const w = buildWorld({ preEnrolled: [{ userId: 'alice', sectionId: 'sec-arch', status: 'dropped' }] });
    await expect(enroll(w, 'sec-arch')).rejects.toBeInstanceOf(SectionNotOpenError);
  });

  it('checks the organization before the status: a person of another organization is a tenant mismatch, not "closed"', async () => {
    const w = buildWorld();
    await expect(w.service.enroll({ userId: 'eve', sectionId: 'sec-arch', role: 'student' })).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('still waitlists and enforces capacity in a published section', async () => {
    const w = buildWorld();
    await w.service.enroll({ userId: 'alice', sectionId: 'sec-cap', role: 'student' });
    await expect(w.service.enroll({ userId: 'bob', sectionId: 'sec-cap', role: 'student' })).rejects.toThrow('capacity');
    await expect(w.service.enroll({ userId: 'bob', sectionId: 'sec-cap', role: 'student', waitlistIfFull: true })).resolves.toMatchObject({ status: 'waitlisted' });
  });

  it('with enforcement a stranger is told "not permitted", not that the section is closed', async () => {
    const w = buildWorld({ enforce: true });
    await expect(w.service.enroll({ userId: 'alice', sectionId: 'sec-arch', role: 'student' }, as('outsider'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.enroll({ userId: 'alice', sectionId: 'sec-arch', role: 'student' }, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError); // teacher is not in sec-arch either
    await expect(w.service.enroll({ userId: 'alice', sectionId: 'sec-arch', role: 'student' }, as('root'))).rejects.toBeInstanceOf(SectionNotOpenError);
  });
});

describe('EnrollmentService.bulkEnroll respects the section\'s status', () => {
  const rows = [{ userExternalRef: 'ext-alice', role: 'student' as Role }, { userExternalRef: 'ext-bob', role: 'student' as Role }];

  it('fails every row of an archived section, each saying why', async () => {
    const w = buildWorld();
    const report = await w.service.bulkEnroll('sec-arch', rows);
    expect(report.succeeded).toBe(0);
    expect(report.failed).toHaveLength(2);
    for (const f of report.failed) expect(f.reason).toContain('archived');
    expect(w.calls.create).toBe(0);
  });

  it('fails every row of a draft section by default, and enrols them with allowDraft', async () => {
    const w = buildWorld();
    const refused = await w.service.bulkEnroll('sec-draft', rows);
    expect(refused.succeeded).toBe(0);
    expect(refused.failed[0]!.reason).toContain('allowDraft');
    const allowed = await w.service.bulkEnroll('sec-draft', rows, undefined, { allowDraft: true });
    expect(allowed).toEqual({ succeeded: 2, failed: [] });
  });

  it('never enrols into an archived section, even with allowDraft', async () => {
    const w = buildWorld();
    const report = await w.service.bulkEnroll('sec-arch', rows, undefined, { allowDraft: true });
    expect(report.succeeded).toBe(0);
  });

  it('works as before for a published section', async () => {
    const w = buildWorld();
    expect(await w.service.bulkEnroll('sec-pub', rows)).toEqual({ succeeded: 2, failed: [] });
  });
});
