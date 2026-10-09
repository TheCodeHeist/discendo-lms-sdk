import { describe, it, expect } from 'bun:test';
import {
  AccommodationService,
  GradingService,
  effectiveDueAt,
  daysLate,
  applyLatePolicy,
} from '../src/domains/grading/index.js';
import type { Excusal, TimeExtension, GradeEntry, GradeRepository } from '../src/domains/grading/index.js';
import { ActorRequiredError, DEFAULT_RULES, EventBus, PermissionDeniedError, createRolePolicy } from '../src/core/index.js';
import type { ContentNode, Enrollment, Identity, LmsEvent, RepositoryContext, Role, TaGrant } from '../src/core/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));
const as = (actorId: string) => ({ actorId });
const DAY = 86_400_000;

describe('effectiveDueAt and daysLate', () => {
  const due = new Date('2026-10-01T12:00:00Z');

  it('moves the due date by the extension, and leaves it alone with none', () => {
    expect(effectiveDueAt(due, { extraSeconds: 3600 })).toEqual(new Date('2026-10-01T13:00:00Z'));
    expect(effectiveDueAt(due, null)).toEqual(due);
    expect(effectiveDueAt(due)).toEqual(due);
    expect(effectiveDueAt(due, { extraSeconds: 0 })).toEqual(due);
  });

  it('always returns a new date, even with no extension', () => {
    expect(effectiveDueAt(due)).not.toBe(due);
    expect(effectiveDueAt(due, null)).not.toBe(due);
    expect(effectiveDueAt(due, { extraSeconds: 0 })).not.toBe(due);
  });

  it('does not change the date it was given', () => {
    const copy = new Date(due);
    effectiveDueAt(due, { extraSeconds: 10 });
    expect(due).toEqual(copy);
  });

  it('refuses an extension that is negative or not a number', () => {
    for (const extraSeconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => effectiveDueAt(due, { extraSeconds })).toThrow(/extraSeconds/);
    }
  });

  it('counts days late as whole days, started days included, and 0 when on time or exactly at the deadline', () => {
    expect(daysLate(new Date(due.getTime() - 1000), due)).toBe(0);
    expect(daysLate(due, due)).toBe(0);
    expect(daysLate(new Date(due.getTime() + 1000), due)).toBe(1);
    expect(daysLate(new Date(due.getTime() + DAY), due)).toBe(1);
    expect(daysLate(new Date(due.getTime() + DAY + 1), due)).toBe(2);
    expect(daysLate(new Date(due.getTime() + 3 * DAY), due)).toBe(3);
  });

  it('measures lateness against the extended deadline', () => {
    const submitted = new Date(due.getTime() + 2 * DAY - 1);
    expect(daysLate(submitted, due)).toBe(2);
    expect(daysLate(submitted, due, { extraSeconds: 2 * 86_400 })).toBe(0);
    expect(daysLate(submitted, due, { extraSeconds: 86_400 })).toBe(1);
  });

  it('feeds applyLatePolicy', () => {
    const late = daysLate(new Date(due.getTime() + DAY + 1), due);
    expect(applyLatePolicy(100, 100, late, { kind: 'flatPenalty', percentPerDay: 10 })).toBe(80);
    const forgiven = daysLate(new Date(due.getTime() + DAY + 1), due, { extraSeconds: 2 * 86_400 });
    expect(applyLatePolicy(100, 100, forgiven, { kind: 'flatPenalty', percentPerDay: 10 })).toBe(100);
  });
});

/**
 * sec-a: org-a. assign-1 and assign-2 are published, assign-draft is not, assign-b is in sec-b.
 * stu, stu-2 are active students of sec-a; stu-dropped dropped; teacher instructs sec-a; ta is its TA
 * (delegated grading.grantExtension only if `delegate` says so); root is an org-a admin; root-b is org-b's.
 */
function buildWorld(opts: { delegate?: string[]; noBus?: boolean } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  for (const id of ['stu', 'stu-2', 'stu-dropped', 'stu-b']) add(id, ['student']);
  add('teacher', ['instructor']);
  add('ta', ['ta']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');
  add('parent', ['student']);

  const enrollments: Enrollment[] = [];
  let en = 0;
  const seed = (userId: string, sectionId: string, role: Role, status: Enrollment['status'] = 'active') =>
    enrollments.push({ id: `enr-${++en}`, userId, sectionId, role, status, enrolledAt: new Date() });
  seed('teacher', 'sec-a', 'instructor');
  seed('ta', 'sec-a', 'ta');
  seed('stu', 'sec-a', 'student');
  seed('stu-2', 'sec-a', 'student');
  seed('stu-dropped', 'sec-a', 'student', 'dropped');
  seed('stu-b', 'sec-b', 'student');

  const node = (id: string, sectionId: string, published = true): ContentNode => ({
    id, sectionId, kind: 'assignment', title: id, orderIndex: 0, published, version: 1,
  });
  const nodes = new Map([node('assign-1', 'sec-a'), node('assign-2', 'sec-a'), node('assign-draft', 'sec-a', false), node('assign-b', 'sec-b')].map((n) => [n.id, n]));

  const calls = { extCreate: 0, excCreate: 0, contentLookups: 0 };
  const grants: TaGrant[] = (opts.delegate ?? []).map((action, i) => ({
    id: `grant-${i}`, enrollmentId: 'enr-2', sectionId: 'sec-a', action, grantedBy: 'teacher', grantedAt: new Date(),
  }));
  const repos = {
    users: { findById: async (id: string) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id: string) => ({ id, title: id, orgId: id === 'course-b' ? 'org-b' : 'org-a' }),
      findSection: async (id: string) =>
        id === 'sec-a' ? { id, courseId: 'course-a', status: 'published' as const } : id === 'sec-b' ? { id, courseId: 'course-b', status: 'published' as const } : null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e: Omit<Enrollment, 'id'>) => ({ ...e, id: 'x' }),
      findById: async () => null,
      update: async (_i: string, p: Partial<Enrollment>) => p as Enrollment,
      findByUserAndSection: async (u: string, s: string) => enrollments.find((e) => e.userId === u && e.sectionId === s) ?? null,
      listBySection: async () => [],
      countActive: async () => 0,
    },
    content: {
      findById: async (id: string) => {
        calls.contentLookups++;
        return nodes.get(id) ?? null;
      },
      listBySection: async () => [],
      create: async (x: Omit<ContentNode, 'id' | 'version'>) => ({ ...x, id: 'c', version: 1 }),
      update: async (id: string, p: Partial<ContentNode>) => ({ ...nodes.get(id)!, ...p }),
      reorder: async () => {},
    },
    guardianLinks: {
      findActive: async (g: string, w: string) =>
        g === 'parent' && w === 'stu'
          ? { id: 'link-1', guardianId: 'parent', wardId: 'stu', orgId: 'org-a', scopes: ['grades' as const], status: 'active' as const, createdAt: new Date() }
          : null,
    },
    delegations: {
      create: async (g: Omit<TaGrant, 'id'>) => ({ ...g, id: 'g' }),
      findById: async () => null,
      listActiveForEnrollment: async (id: string) => grants.filter((g) => g.enrollmentId === id),
      revoke: async (id: string, at: Date) => ({ ...grants[0]!, id, revokedAt: at }),
    },
  } as unknown as Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'content' | 'guardianLinks' | 'delegations'>;

  const extensions: TimeExtension[] = [];
  const excusals: Excusal[] = [];
  let xid = 0;
  const extensionRepo = {
    create: async (e: Omit<TimeExtension, 'id'>) => {
      calls.extCreate++;
      const row = { ...e, id: `ext-${++xid}` };
      extensions.push(row);
      return row;
    },
    findActive: async (userId: string, contentId: string) =>
      extensions.find((e) => e.userId === userId && e.contentId === contentId && e.revokedAt === undefined) ?? null,
    revoke: async (id: string, at: Date, by: string) => {
      const row = extensions.find((e) => e.id === id)!;
      Object.assign(row, { revokedAt: at, revokedBy: by });
      return { ...row };
    },
    listForContent: async (contentId: string, o?: { includeRevoked?: boolean }) =>
      extensions.filter((e) => e.contentId === contentId && (o?.includeRevoked || e.revokedAt === undefined)),
    listForUser: async (userId: string, sectionId: string, o?: { includeRevoked?: boolean }) =>
      extensions.filter((e) => e.userId === userId && e.sectionId === sectionId && (o?.includeRevoked || e.revokedAt === undefined)),
  };
  const excusalRepo = {
    create: async (e: Omit<Excusal, 'id'>) => {
      calls.excCreate++;
      const row = { ...e, id: `exc-${++xid}` };
      excusals.push(row);
      return row;
    },
    findActive: async (userId: string, contentId: string) =>
      excusals.find((e) => e.userId === userId && e.contentId === contentId && e.revokedAt === undefined) ?? null,
    revoke: async (id: string, at: Date, by: string) => {
      const row = excusals.find((e) => e.id === id)!;
      Object.assign(row, { revokedAt: at, revokedBy: by });
      return { ...row };
    },
    listForContent: async (contentId: string, o?: { includeRevoked?: boolean }) =>
      excusals.filter((e) => e.contentId === contentId && (o?.includeRevoked || e.revokedAt === undefined)),
    listForUser: async (userId: string, sectionId: string, o?: { includeRevoked?: boolean }) =>
      excusals.filter((e) => e.userId === userId && e.sectionId === sectionId && (o?.includeRevoked || e.revokedAt === undefined)),
  };

  const bus = opts.noBus ? undefined : new EventBus();
  const events: LmsEvent[] = [];
  bus?.on('*', (e) => void events.push(e));
  const service = new AccommodationService({ ...repos, extensions: extensionRepo, excusals: excusalRepo }, bus, { policy: createRolePolicy() });
  const ofType = <T extends LmsEvent['type']>(t: T) => events.filter((e) => e.type === t);
  return { service, extensions, excusals, extensionRepo, excusalRepo, calls, events, ofType, repos };
}

describe('grantExtension', () => {
  it('stores extra time for the student on the content, as the actor, and announces it', async () => {
    const w = buildWorld();
    const e = await w.service.grantExtension('assign-1', 'stu', 7200, as('teacher'), { reason: 'accommodation plan' });
    await sleep();
    expect(e).toMatchObject({ userId: 'stu', contentId: 'assign-1', sectionId: 'sec-a', extraSeconds: 7200, reason: 'accommodation plan', grantedBy: 'teacher' });
    expect(e.grantedAt).toBeInstanceOf(Date);
    expect(e.revokedAt).toBeUndefined();
    expect(w.ofType('grading.extensionGranted')).toEqual([
      { type: 'grading.extensionGranted', extensionId: e.id, userId: 'stu', contentId: 'assign-1', sectionId: 'sec-a', extraSeconds: 7200, grantedBy: 'teacher' },
    ]);
  });

  it('is allowed for an instructor, an admin, and a TA only when it was delegated to them', async () => {
    const w = buildWorld({ delegate: ['grading.grantExtension'] });
    for (const who of ['teacher', 'root', 'ta']) {
      await expect(w.service.grantExtension('assign-2', 'stu-2', 60, as(who))).resolves.toBeDefined();
    }
    const plain = buildWorld();
    await expect(plain.service.grantExtension('assign-1', 'stu', 60, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const wrong = buildWorld({ delegate: ['grading.excuse'] }); // another action's grant does not count
    await expect(wrong.service.grantExtension('assign-1', 'stu', 60, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('is refused for students (even for themselves), guardians, other organizations, and with no actor, and stores nothing', async () => {
    const w = buildWorld();
    for (const who of ['stu', 'stu-2', 'parent', 'root-b', 'stu-b']) {
      await expect(w.service.grantExtension('assign-1', 'stu', 60, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    const lookups = w.calls.contentLookups;
    await expect(w.service.grantExtension('assign-1', 'stu', 60)).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.contentLookups).toBe(lookups); // no actor: nothing is looked up
    expect(w.calls.extCreate).toBe(0);
    await sleep();
    expect(w.events).toEqual([]);
  });

  it('refuses unknown content like forbidden content, and checks permission before it looks at the numbers', async () => {
    const w = buildWorld();
    const forbidden = await w.service.grantExtension('assign-1', 'stu', 60, as('stu')).catch((e) => e);
    const missing = await w.service.grantExtension('no-such', 'stu', 60, as('teacher')).catch((e) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect(missing.message).toBe(forbidden.message);
    const strangerBadNumber = await w.service.grantExtension('assign-1', 'stu', -5, as('stu')).catch((e) => e);
    expect(strangerBadNumber).toBeInstanceOf(PermissionDeniedError);
  });

  it('is only for an active student of that section', async () => {
    const w = buildWorld();
    for (const target of ['stu-dropped', 'stu-b', 'teacher', 'ta', 'nobody']) {
      await expect(w.service.grantExtension('assign-1', target, 60, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(w.calls.extCreate).toBe(0);
  });

  it('works on content that is not published yet, for staff', async () => {
    const w = buildWorld();
    await expect(w.service.grantExtension('assign-draft', 'stu', 60, as('teacher'))).resolves.toBeDefined();
  });

  it('refuses extra time that is not a finite number above zero', async () => {
    const w = buildWorld();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(w.service.grantExtension('assign-1', 'stu', bad, as('teacher'))).rejects.toThrow(/extraSeconds/);
    }
    expect(w.calls.extCreate).toBe(0);
  });

  it('is idempotent for the same amount: no new record, no event', async () => {
    const w = buildWorld();
    const first = await w.service.grantExtension('assign-1', 'stu', 600, as('teacher'));
    await sleep();
    const again = await w.service.grantExtension('assign-1', 'stu', 600, as('root'));
    await sleep();
    expect(again.id).toBe(first.id);
    expect(w.extensions).toHaveLength(1);
    expect(w.ofType('grading.extensionGranted')).toHaveLength(1);
  });

  it('replaces the old extension when the amount changes, keeping it as history', async () => {
    const w = buildWorld();
    const first = await w.service.grantExtension('assign-1', 'stu', 600, as('teacher'));
    const second = await w.service.grantExtension('assign-1', 'stu', 1200, as('root'));
    await sleep();
    expect(second.id).not.toBe(first.id);
    expect(w.extensions).toHaveLength(2);
    expect(w.extensions[0]).toMatchObject({ id: first.id, revokedBy: 'root' });
    expect(w.extensions[0]!.revokedAt).toBeInstanceOf(Date);
    expect((await w.extensionRepo.findActive('stu', 'assign-1'))!.id).toBe(second.id);
    expect(w.ofType('grading.extensionGranted')).toMatchObject([{}, { extensionId: second.id, extraSeconds: 1200, replacedExtensionId: first.id }]);
  });

  it('keeps students and content apart', async () => {
    const w = buildWorld();
    await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    await w.service.grantExtension('assign-1', 'stu-2', 90, as('teacher'));
    await w.service.grantExtension('assign-2', 'stu', 120, as('teacher'));
    expect(w.extensions).toHaveLength(3);
    expect(w.extensions.every((e) => e.revokedAt === undefined)).toBe(true);
  });

  it('works without an event bus', async () => {
    const w = buildWorld({ noBus: true });
    await expect(w.service.grantExtension('assign-1', 'stu', 60, as('teacher'))).resolves.toBeDefined();
  });
});

describe('revokeExtension', () => {
  it('ends the active extension, keeps the record, and says who', async () => {
    const w = buildWorld();
    const e = await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    const revoked = await w.service.revokeExtension('assign-1', 'stu', as('root'));
    expect(revoked).toMatchObject({ id: e.id, revokedBy: 'root' });
    expect(revoked!.revokedAt).toBeInstanceOf(Date);
    expect(w.extensions).toHaveLength(1);
    expect(await w.extensionRepo.findActive('stu', 'assign-1')).toBeNull();
  });

  it('returns null when there is nothing to revoke, and is refused for people who may not grant', async () => {
    const w = buildWorld();
    await expect(w.service.revokeExtension('assign-1', 'stu', as('teacher'))).resolves.toBeNull();
    await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    for (const who of ['stu', 'ta', 'root-b']) {
      await expect(w.service.revokeExtension('assign-1', 'stu', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.revokeExtension('assign-1', 'stu')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(await w.extensionRepo.findActive('stu', 'assign-1')).not.toBeNull();
  });

  it('needs the extension grant itself: a TA delegated only the excuse action cannot', async () => {
    const w = buildWorld({ delegate: ['grading.excuse'] });
    await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    await expect(w.service.revokeExtension('assign-1', 'stu', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('lets a delegated TA revoke too', async () => {
    const w = buildWorld({ delegate: ['grading.grantExtension'] });
    await w.service.grantExtension('assign-1', 'stu', 60, as('ta'));
    await expect(w.service.revokeExtension('assign-1', 'stu', as('ta'))).resolves.toMatchObject({ revokedBy: 'ta' });
  });
});

describe('reading extensions', () => {
  it('shows a student their own active extension, a guardian their ward\'s, and staff anyone\'s; nobody else', async () => {
    const w = buildWorld();
    const e = await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    for (const who of ['stu', 'parent', 'teacher', 'ta', 'root']) {
      expect((await w.service.getExtension('assign-1', 'stu', as(who)))!.id).toBe(e.id);
    }
    for (const who of ['stu-2', 'stu-b', 'root-b']) {
      await expect(w.service.getExtension('assign-1', 'stu', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.getExtension('assign-1', 'stu')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(await w.service.getExtension('assign-2', 'stu', as('stu'))).toBeNull();
  });

  it('stops showing a revoked extension', async () => {
    const w = buildWorld();
    await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    await w.service.revokeExtension('assign-1', 'stu', as('teacher'));
    expect(await w.service.getExtension('assign-1', 'stu', as('stu'))).toBeNull();
  });

  it('lists a content item\'s extensions for staff only, optionally with the revoked ones', async () => {
    const w = buildWorld();
    await w.service.grantExtension('assign-1', 'stu', 60, as('teacher'));
    await w.service.grantExtension('assign-1', 'stu-2', 90, as('teacher'));
    await w.service.revokeExtension('assign-1', 'stu', as('teacher'));
    expect((await w.service.listExtensions('assign-1', as('teacher'))).map((e) => e.userId)).toEqual(['stu-2']);
    expect(await w.service.listExtensions('assign-1', as('root'), { includeRevoked: true })).toHaveLength(2);
    for (const who of ['stu', 'stu-2', 'ta', 'parent', 'root-b']) {
      await expect(w.service.listExtensions('assign-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.listExtensions('assign-1')).rejects.toBeInstanceOf(ActorRequiredError);
  });
});

describe('excuse', () => {
  it('records the excusal for the student on the content, as the actor, and announces it', async () => {
    const w = buildWorld();
    const x = await w.service.excuse('assign-1', 'stu', as('teacher'), { reason: 'illness' });
    await sleep();
    expect(x).toMatchObject({ userId: 'stu', contentId: 'assign-1', sectionId: 'sec-a', reason: 'illness', excusedBy: 'teacher' });
    expect(x.excusedAt).toBeInstanceOf(Date);
    expect(w.ofType('grading.excused')).toEqual([
      { type: 'grading.excused', excusalId: x.id, userId: 'stu', contentId: 'assign-1', sectionId: 'sec-a', excusedBy: 'teacher' },
    ]);
  });

  it('has its own permission: an instructor or admin, or a TA with that exact grant', async () => {
    const w = buildWorld({ delegate: ['grading.excuse'] });
    for (const who of ['teacher', 'root', 'ta']) {
      await expect(w.service.excuse('assign-2', 'stu-2', as(who))).resolves.toBeDefined();
    }
    const other = buildWorld({ delegate: ['grading.grantExtension'] });
    await expect(other.service.excuse('assign-1', 'stu', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('is refused for students, guardians, other organizations, no actor, and an unknown or non-student target', async () => {
    const w = buildWorld();
    for (const who of ['stu', 'parent', 'root-b']) {
      await expect(w.service.excuse('assign-1', 'stu', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.excuse('assign-1', 'stu')).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.excuse('no-such', 'stu', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const target of ['stu-dropped', 'teacher', 'stu-b']) {
      await expect(w.service.excuse('assign-1', target, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(w.calls.excCreate).toBe(0);
  });

  it('is idempotent while active: no new record and no event, whoever asks again', async () => {
    const w = buildWorld();
    const first = await w.service.excuse('assign-1', 'stu', as('teacher'), { reason: 'illness' });
    await sleep();
    const again = await w.service.excuse('assign-1', 'stu', as('root'), { reason: 'other' });
    await sleep();
    expect(again.id).toBe(first.id);
    expect(again.reason).toBe('illness');
    expect(w.excusals).toHaveLength(1);
    expect(w.ofType('grading.excused')).toHaveLength(1);
  });

  it('can be excused again after being un-excused, as a new record', async () => {
    const w = buildWorld();
    const first = await w.service.excuse('assign-1', 'stu', as('teacher'));
    const undone = await w.service.unexcuse('assign-1', 'stu', as('root'));
    expect(undone).toMatchObject({ id: first.id, revokedBy: 'root' });
    expect(undone!.revokedAt).toBeInstanceOf(Date);
    const second = await w.service.excuse('assign-1', 'stu', as('teacher'));
    expect(second.id).not.toBe(first.id);
    expect(w.excusals).toHaveLength(2);
  });

  it('unexcuse returns null when nothing is excused, and is refused for people who may not excuse', async () => {
    const w = buildWorld();
    await expect(w.service.unexcuse('assign-1', 'stu', as('teacher'))).resolves.toBeNull();
    await w.service.excuse('assign-1', 'stu', as('teacher'));
    for (const who of ['stu', 'ta', 'root-b']) {
      await expect(w.service.unexcuse('assign-1', 'stu', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(await w.excusalRepo.findActive('stu', 'assign-1')).not.toBeNull();
  });

  it('can be undone only with the excuse action itself: a TA delegated only the extension grant cannot', async () => {
    const w = buildWorld({ delegate: ['grading.grantExtension'] });
    await w.service.excuse('assign-1', 'stu', as('teacher'));
    await expect(w.service.unexcuse('assign-1', 'stu', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const ok = buildWorld({ delegate: ['grading.excuse'] });
    await ok.service.excuse('assign-1', 'stu', as('teacher'));
    await expect(ok.service.unexcuse('assign-1', 'stu', as('ta'))).resolves.toMatchObject({ revokedBy: 'ta' });
  });

  it('is visible to the student, their guardian and staff, and listed for staff only', async () => {
    const w = buildWorld();
    const x = await w.service.excuse('assign-1', 'stu', as('teacher'));
    for (const who of ['stu', 'parent', 'teacher', 'ta', 'root']) {
      expect((await w.service.getExcusal('assign-1', 'stu', as(who)))!.id).toBe(x.id);
    }
    await expect(w.service.getExcusal('assign-1', 'stu', as('stu-2'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await w.service.listExcusals('assign-1', as('teacher'))).toHaveLength(1);
    await expect(w.service.listExcusals('assign-1', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await w.service.unexcuse('assign-1', 'stu', as('teacher'));
    expect(await w.service.listExcusals('assign-1', as('teacher'))).toEqual([]);
    expect(await w.service.listExcusals('assign-1', as('teacher'), { includeRevoked: true })).toHaveLength(1);
  });
});

describe('the new actions', () => {
  it('are for admin and instructor, delegable to a TA, with no student or guardian shortcut', () => {
    for (const name of ['grading.grantExtension', 'grading.excuse'] as const) {
      const rule = DEFAULT_RULES[name];
      expect([...rule.roles].sort()).toEqual(['admin', 'instructor']);
      expect(rule.delegable).toBe(true);
      expect('ownRoles' in rule).toBe(false);
      expect('guardianScope' in rule).toBe(false);
    }
  });
});

describe('final grades leave out excused work', () => {
  type Row = GradeEntry & { category: string; contentId?: string };
  const row = (id: string, contentId: string | undefined, score: number, category = 'homework', extra: Partial<Row> = {}): Row => ({
    id, submissionId: `sub-${id}`, userId: 'stu', score, maxScore: 100, graderId: 'teacher', gradedAt: new Date(), category,
    ...(contentId !== undefined ? { contentId } : {}), ...extra,
  });
  const scheme = { categories: [{ name: 'homework', weight: 0.5 }, { name: 'exam', weight: 0.5, dropLowestN: 0 }] };

  function gradingWith(rows: Row[], excusals: Excusal[] | null) {
    const grades: GradeRepository = {
      create: async (e) => ({ ...e, id: 'new' }),
      findById: async () => null,
      markSuperseded: async () => {},
      listForUserInSection: async () => rows,
    };
    const repo = excusals
      ? { listForUser: async (userId: string, sectionId: string) => excusals.filter((x) => x.userId === userId && x.sectionId === sectionId) } // returns revoked ones too: the service must not count them
      : undefined;
    return new GradingService(grades, undefined, undefined, repo ? { excusals: repo } : {});
  }
  const excusal = (contentId: string, extra: Partial<Excusal> = {}): Excusal => ({
    id: `x-${contentId}`, userId: 'stu', contentId, sectionId: 'sec-a', excusedBy: 'teacher', excusedAt: new Date(), ...extra,
  });

  it('ignores a graded item that is excused for the student, instead of counting it as zero', async () => {
    const rows = [row('1', 'hw-1', 100), row('2', 'hw-2', 0), row('3', 'ex-1', 80, 'exam')];
    const plain = gradingWith(rows, []);
    expect(await plain.computeFinalGradeForUser('stu', 'sec-a', scheme)).toBe(65); // (50 + 80) / 2
    const excused = gradingWith(rows, [excusal('hw-2')]);
    expect(await excused.computeFinalGradeForUser('stu', 'sec-a', scheme)).toBe(90); // (100 + 80) / 2
  });

  it('applies to the letter grade too, and to the drop-lowest rule on what is left', async () => {
    const rows = [row('1', 'hw-1', 100), row('2', 'hw-2', 0), row('3', 'hw-3', 60)];
    const dropping = { categories: [{ name: 'homework', weight: 1, dropLowestN: 1 }] };
    const g = gradingWith(rows, [excusal('hw-2')]);
    // hw-2 is gone, then the lowest of (100, 60) is dropped, leaving 100
    expect(await g.computeFinalGradeForUser('stu', 'sec-a', dropping)).toBe(100);
    expect(await g.computeLetterGradeForUser('stu', 'sec-a', dropping, [{ minPercent: 90, label: 'A' }, { minPercent: 0, label: 'F' }])).toBe('A');
  });

  it('leaves everything counting when the excusal is for another student, another section, or has been revoked', async () => {
    const rows = [row('1', 'hw-1', 100), row('2', 'hw-2', 0)];
    const all = { categories: [{ name: 'homework', weight: 1 }] };
    for (const x of [excusal('hw-2', { userId: 'stu-2' }), excusal('hw-2', { sectionId: 'sec-z' }), excusal('hw-2', { revokedAt: new Date() })]) {
      expect(await gradingWith(rows, [x]).computeFinalGradeForUser('stu', 'sec-a', all)).toBe(50);
    }
  });

  it('is a no-op when no excusal source is configured, even if the rows carry no contentId', async () => {
    const rows = [row('1', undefined, 100), row('2', undefined, 0)];
    expect(await gradingWith(rows, null).computeFinalGradeForUser('stu', 'sec-a', { categories: [{ name: 'homework', weight: 1 }] })).toBe(50);
  });

  it('is a no-op when the student has no excusals, even if the rows carry no contentId', async () => {
    const rows = [row('1', undefined, 100), row('2', undefined, 0)];
    expect(await gradingWith(rows, []).computeFinalGradeForUser('stu', 'sec-a', { categories: [{ name: 'homework', weight: 1 }] })).toBe(50);
  });

  it('says so loudly when excusals exist but the gradebook rows cannot be matched to content', async () => {
    const rows = [row('1', undefined, 100)];
    await expect(gradingWith(rows, [excusal('hw-2')]).computeFinalGradeForUser('stu', 'sec-a', { categories: [{ name: 'homework', weight: 1 }] })).rejects.toThrow(/contentId/);
  });

  it('ignores superseded entries first, as always', async () => {
    const rows = [row('1', 'hw-1', 100), row('2', 'hw-1', 0, 'homework', { supersededBy: '1' })];
    expect(await gradingWith(rows, [excusal('hw-9')]).computeFinalGradeForUser('stu', 'sec-a', { categories: [{ name: 'homework', weight: 1 }] })).toBe(100);
  });
});
