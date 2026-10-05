import { describe, it, expect } from 'bun:test';
import { CommunicationService } from '../src/services/communication/index.js';
import type {
  Announcement,
  Thread,
  ThreadPost,
  NotificationEvent,
  NotificationSink,
} from '../src/services/communication/index.js';
import { createRolePolicy, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
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

type World = ReturnType<typeof buildWorld>;

/**
 * sec-1 and sec-2 belong to org-a. In sec-1: teacher (instructor), ta (enr-3), stu and stu-2
 * (active), plus a dropped, a waitlisted and a completed student. Guardians: `parent` (ward stu,
 * scopes grades + announcements), `parent-noscope` (ward stu, grades only), `parent-dropped`
 * (ward stu-dropped, all scopes), `parent-2` (ward stu-2).
 * Threads: thr-1 is in sec-1, thr-2 in sec-2.
 */
function buildWorld(opts: { policy?: PermissionPolicy; grants?: TaGrant[]; sink?: NotificationSink; onDeliveryError?: (e: unknown, a: Announcement) => void; enforce?: boolean } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  add('teacher', ['instructor']);
  add('teacher-2', ['instructor']);
  add('ta', ['ta']);
  for (const id of ['stu', 'stu-2', 'stu-sec2', 'stu-dropped', 'stu-wait', 'stu-done', 'outsider']) add(id, ['student']);
  for (const id of ['parent', 'parent-noscope', 'parent-dropped', 'parent-2', 'parent-done']) add(id, ['student']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');
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

  const link = (id: string, guardianId: string, wardId: string, scopes: GuardianScope[], status: GuardianLink['status'] = 'active'): GuardianLink => ({
    id, guardianId, wardId, orgId: 'org-a', scopes, status, createdAt: new Date(),
  });
  const links = [
    link('l1', 'parent', 'stu', ['grades', 'announcements']),
    link('l2', 'parent-noscope', 'stu', ['grades']),
    link('l3', 'parent-dropped', 'stu-dropped', ['grades', 'announcements']),
    link('l4', 'parent-2', 'stu-2', ['announcements']),
    link('l5', 'parent-done', 'stu-done', ['grades', 'announcements']),
  ];

  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'guardianLinks' | 'delegations'> = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : null),
      findSection: async (id) =>
        ['sec-1', 'sec-2'].includes(id)
          ? { id, courseId: 'course-a', status: 'published' as const }
          : id === 'sec-orphan'
            ? { id, courseId: 'missing-course', status: 'published' as const }
            : null,
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

  const calls = { created: 0, listed: 0, threadLookups: 0, posts: 0 };
  const stored: Announcement[] = [
    { id: 'a-stu', sectionId: 'sec-1', title: 'For students', body: 'x', postedAt: new Date(), audience: 'students' },
    { id: 'a-gua', sectionId: 'sec-1', title: 'For guardians', body: 'x', postedAt: new Date(), audience: 'guardians' },
    { id: 'a-legacy', sectionId: 'sec-1', title: 'Old, no audience', body: 'x', postedAt: new Date() } as Announcement,
    { id: 'a-other', sectionId: 'sec-2', title: 'Other section', body: 'x', postedAt: new Date(), audience: 'students' },
  ];
  const announcements = {
    create: async (a: Omit<Announcement, 'id'>) => {
      calls.created++;
      const row = { ...a, id: `a-new-${calls.created}` };
      stored.push(row);
      return row;
    },
    listBySection: async (sectionId: string) => (calls.listed++, stored.filter((a) => a.sectionId === sectionId)),
  };

  const threads = new Map<string, Thread>([
    ['thr-1', { id: 'thr-1', sectionId: 'sec-1', title: 'Q&A', posts: [] }],
    ['thr-2', { id: 'thr-2', sectionId: 'sec-2', title: 'Other', posts: [] }],
  ]);
  const threadRepo = {
    create: async (t: Omit<Thread, 'id' | 'posts'>) => ({ ...t, id: 'thr-new', posts: [] }),
    findById: async (id: string) => (calls.threadLookups++, threads.get(id) ?? null),
    addPost: async (threadId: string, post: Omit<ThreadPost, 'id'>) => {
      calls.posts++;
      const row = { ...post, id: `p-${calls.posts}` };
      threads.get(threadId)!.posts.push(row);
      return row;
    },
  };

  const dispatched: NotificationEvent[] = [];
  const sink: NotificationSink = opts.sink ?? { dispatch: async (e) => void dispatched.push(e) };
  const policy = opts.policy ?? createRolePolicy();
  const service = new CommunicationService(announcements, threadRepo, sink, {
    ...(opts.enforce === false ? {} : { enforcement: { policy, repos } }),
    ...(opts.onDeliveryError ? { onDeliveryError: opts.onDeliveryError } : {}),
  });
  return { service, calls, stored, dispatched, threads };
}

const grant = (action: string, over: Partial<TaGrant> = {}): TaGrant => ({
  id: `g-${action}`,
  enrollmentId: 'enr-3',
  sectionId: 'sec-1',
  action,
  grantedBy: 'teacher',
  grantedAt: new Date(),
  ...over,
});
const ids = (list: Announcement[]) => list.map((a) => a.id);
const spyPolicy = () => {
  const seen: Array<{ action: string; ctx: PermissionContext }> = [];
  const policy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
  return { seen, policy };
};

describe('CommunicationService.postAnnouncement with enforcement', () => {
  it('lets an instructor post to the students, who are the default audience', async () => {
    const w = buildWorld();
    const a = await w.service.postAnnouncement('sec-1', 'Hello', 'Body', undefined, as('teacher'));
    expect(a).toMatchObject({ sectionId: 'sec-1', title: 'Hello', body: 'Body', audience: 'students' });
    expect(w.dispatched).toEqual([{ type: 'announcementCreated', sectionId: 'sec-1', title: 'Hello', audience: 'students' }]);
  });

  it.each(['teacher', 'root'])('lets %s post to the guardians, and the notification says so', async (who) => {
    const w = buildWorld();
    const a = await w.service.postAnnouncement('sec-1', 'Parents', 'Body', 'guardians', as(who));
    expect(a.audience).toBe('guardians');
    expect(w.dispatched).toEqual([{ type: 'announcementCreated', sectionId: 'sec-1', title: 'Parents', audience: 'guardians' }]);
  });

  it.each(['stu', 'stu-dropped', 'stu-done', 'parent', 'ta', 'teacher-2', 'root-b', 'stu-b', 'outsider', 'nobody'])(
    'refuses %s on either channel, stores nothing and notifies no one',
    async (who) => {
      const w = buildWorld();
      for (const audience of ['students', 'guardians'] as const) {
        await expect(w.service.postAnnouncement('sec-1', 'T', 'B', audience, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      }
      expect(w.calls.created).toBe(0);
      expect(w.dispatched).toEqual([]);
    },
  );

  it('lets a TA post to the students once postAnnouncement is delegated, but never to the guardians', async () => {
    const w = buildWorld({ grants: [grant('communication.postAnnouncement')] });
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('ta'))).resolves.toMatchObject({ audience: 'students' });
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B', 'guardians', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('ignores a stored delegation of the guardian action: it is not delegable', async () => {
    const w = buildWorld({ grants: [grant('communication.postGuardianAnnouncement')] });
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B', 'guardians', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('ignores a delegation that is revoked, or for another section', async () => {
    const revoked = buildWorld({ grants: [grant('communication.postAnnouncement', { revokedAt: new Date() })] });
    await expect(revoked.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const other = buildWorld({ grants: [grant('communication.postAnnouncement', { sectionId: 'sec-2' })] });
    await expect(other.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = buildWorld();
    await expect(w.service.postAnnouncement(sectionId, 'T', 'B', 'students', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.created).toBe(0);
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.created).toBe(0);
  });

  it('refuses an audience that is not one of the two channels, before anything else', async () => {
    const w = buildWorld();
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B', 'everyone' as never, as('root'))).rejects.toThrow('audience');
    expect(w.calls.created).toBe(0);
  });

  it('asks the policy for the action that matches the channel, in the right section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('teacher')).catch(() => {});
    await w.service.postAnnouncement('sec-1', 'T', 'B', 'guardians', as('teacher')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['communication.postAnnouncement', 'communication.postGuardianAnnouncement']);
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section?.role).toBe('instructor');
  });
});

describe('a failing notification sink never fails an announcement that is already stored', () => {
  it('keeps the announcement and reports the failure to onDeliveryError', async () => {
    const errors: Array<{ e: unknown; a: Announcement }> = [];
    const boom = new Error('push service down');
    const w = buildWorld({ sink: { dispatch: async () => { throw boom; } }, onDeliveryError: (e, a) => errors.push({ e, a }) });
    const a = await w.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('teacher'));
    expect(a.id).toBeDefined();
    expect(w.stored.some((s) => s.id === a.id)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.e).toBe(boom);
    expect(errors[0]!.a.id).toBe(a.id);
  });

  it('also copes with a sink that throws synchronously, and with no onDeliveryError at all', async () => {
    const sync = buildWorld({ sink: { dispatch: (() => { throw new Error('sync'); }) as never } });
    await expect(sync.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('teacher'))).resolves.toBeDefined();
  });

  it('a throwing onDeliveryError cannot fail the post either', async () => {
    const w = buildWorld({ sink: { dispatch: async () => { throw new Error('x'); } }, onDeliveryError: () => { throw new Error('handler bug'); } });
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('teacher'))).resolves.toBeDefined();
  });

  it('behaves the same without enforcement', async () => {
    const errors: unknown[] = [];
    const w = buildWorld({ enforce: false, sink: { dispatch: async () => { throw new Error('x'); } }, onDeliveryError: (e) => errors.push(e) });
    await expect(w.service.postAnnouncement('sec-1', 'T', 'B')).resolves.toMatchObject({ audience: 'students' });
    expect(errors).toHaveLength(1);
  });

  it('does not call the sink at all for a refused post', async () => {
    let calls = 0;
    const w = buildWorld({ sink: { dispatch: async () => void calls++ } });
    await w.service.postAnnouncement('sec-1', 'T', 'B', 'students', as('stu')).catch(() => {});
    expect(calls).toBe(0);
  });
});

describe('CommunicationService.listAnnouncements: two separate channels', () => {
  it.each(['stu', 'stu-2'])('gives %s only the student channel (an old record with no audience counts as students)', async (who) => {
    const w = buildWorld();
    expect(ids(await w.service.listAnnouncements('sec-1', as(who)))).toEqual(['a-stu', 'a-legacy']);
  });

  it.each(['teacher', 'ta', 'root'])('gives %s (staff) both channels', async (who) => {
    const w = buildWorld();
    expect(ids(await w.service.listAnnouncements('sec-1', as(who)))).toEqual(['a-stu', 'a-gua', 'a-legacy']);
  });

  it('gives a guardian who names their ward only the guardian channel', async () => {
    const w = buildWorld();
    expect(ids(await w.service.listAnnouncements('sec-1', as('parent'), { wardId: 'stu' }))).toEqual(['a-gua']);
    expect(ids(await w.service.listAnnouncements('sec-1', as('parent-2'), { wardId: 'stu-2' }))).toEqual(['a-gua']);
  });

  it('gives staff who name a ward the guardian channel only', async () => {
    const w = buildWorld();
    expect(ids(await w.service.listAnnouncements('sec-1', as('teacher'), { wardId: 'stu' }))).toEqual(['a-gua']);
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'outsider', 'parent', 'parent-noscope', 'teacher-2', 'root-b', 'stu-b', 'nobody'])(
    'refuses %s the student channel, and does not even read the announcements',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.listAnnouncements('sec-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.listed).toBe(0);
    },
  );

  it.each([
    ['a guardian whose link lacks the announcements scope', 'parent-noscope', 'stu'],
    ['a guardian whose ward has dropped the section', 'parent-dropped', 'stu-dropped'],
    ['a guardian naming a ward they are not linked to', 'parent', 'stu-2'],
    ['a student naming another student as "ward"', 'stu-2', 'stu'],
    ['a student naming themselves as "ward"', 'stu', 'stu'],
    ['a stranger', 'outsider', 'stu'],
    ['a guardian of another organization', 'root-b', 'stu'],
  ])('refuses the guardian channel to %s', async (_label, who, wardId) => {
    const w = buildWorld();
    await expect(w.service.listAnnouncements('sec-1', as(who), { wardId })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.listed).toBe(0);
  });

  it('refuses a guardian a section their ward is not in', async () => {
    const w = buildWorld();
    await expect(w.service.listAnnouncements('sec-2', as('parent'), { wardId: 'stu' })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = buildWorld();
    await expect(w.service.listAnnouncements(sectionId, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('requires an actor and reads nothing without one', async () => {
    const w = buildWorld();
    await expect(w.service.listAnnouncements('sec-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.listed).toBe(0);
  });

  it('asks the policy about the student channel, or about the guardian channel for the named ward', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.listAnnouncements('sec-1', as('stu')).catch(() => {});
    await w.service.listAnnouncements('sec-1', as('parent'), { wardId: 'stu' }).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['communication.viewAnnouncements', 'communication.viewGuardianAnnouncements']);
    expect(seen[0]!.ctx.resourceOwnerId).toBeUndefined();
    expect(seen[1]!.ctx.resourceOwnerId).toBe('stu');
    expect(seen[1]!.ctx.guardian).toMatchObject({ wardId: 'stu' });
  });
});

describe('completion does not widen communication: it stays for active students and their guardians', () => {
  it('refuses the guardian of a completed ward the guardian channel, and a completed student the students\' channel', async () => {
    const w = buildWorld();
    await expect(w.service.listAnnouncements('sec-1', as('parent-done'), { wardId: 'stu-done' })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.listAnnouncements('sec-1', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.getThread('thr-1', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.reply('thr-1', 'stu-done', 'hi', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('gives a custom policy no completion context at all: the service never opts in', async () => {
    const seen: Array<{ action: string; ctx: PermissionContext }> = [];
    const policy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
    const w = buildWorld({ policy });
    await w.service.listAnnouncements('sec-1', as('parent-done'), { wardId: 'stu-done' }).catch(() => {});
    await w.service.listAnnouncements('sec-1', as('stu-done')).catch(() => {});
    expect(seen).toHaveLength(2);
    for (const { ctx } of seen) {
      expect(ctx.section?.completedRole).toBeUndefined();
      expect(ctx.guardian).toBeUndefined();
    }
  });
});

describe('CommunicationService.reply and getThread with enforcement', () => {
  it.each(['stu', 'teacher', 'ta', 'root'])('lets %s reply as themselves', async (who) => {
    const w = buildWorld();
    await expect(w.service.reply('thr-1', who, 'hi', as(who))).resolves.toMatchObject({ authorId: who, body: 'hi' });
    expect(w.threads.get('thr-1')!.posts).toHaveLength(1);
  });

  it.each([
    ['a student writing as another student', 'stu', 'stu-2'],
    ['a student writing as the teacher', 'stu', 'teacher'],
    ['the teacher writing as a student', 'teacher', 'stu'],
    ['an admin writing as the teacher', 'root', 'teacher'],
  ])('refuses %s: the author is always the actor', async (_label, actor, authorId) => {
    const w = buildWorld();
    await expect(w.service.reply('thr-1', authorId, 'hi', as(actor))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.posts).toBe(0);
  });

  it.each(['parent', 'stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'outsider', 'teacher-2', 'root-b', 'stu-b', 'nobody'])(
    'refuses %s a reply and a read, and stores nothing',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.reply('thr-1', who, 'hi', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(w.service.getThread('thr-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.posts).toBe(0);
    },
  );

  it('takes the section from the stored thread: a section 1 student cannot reach a section 2 thread', async () => {
    const w = buildWorld();
    await expect(w.service.reply('thr-2', 'stu', 'hi', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.getThread('thr-2', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.getThread('thr-2', as('teacher-2'))).resolves.toMatchObject({ id: 'thr-2' });
  });

  it('refuses an unknown thread exactly like a forbidden one', async () => {
    const w = buildWorld();
    const unknown = await w.service.reply('no-such', 'root', 'hi', as('root')).catch((e: unknown) => e);
    const forbidden = await w.service.reply('thr-1', 'nobody', 'hi', as('nobody')).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(PermissionDeniedError);
    expect((unknown as Error).message).toBe((forbidden as Error).message);
    await expect(w.service.getThread('no-such', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('lets members read the thread with its posts', async () => {
    const w = buildWorld();
    await w.service.reply('thr-1', 'stu', 'hi', as('stu'));
    const thread = await w.service.getThread('thr-1', as('stu-2'));
    expect(thread.posts.map((p) => p.authorId)).toEqual(['stu']);
  });

  it('requires an actor and looks nothing up without one', async () => {
    const w = buildWorld();
    await expect(w.service.reply('thr-1', 'stu', 'hi')).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.getThread('thr-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.threadLookups).toBe(0);
  });

  it('asks the policy about communication.participate in the thread\'s section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.reply('thr-2', 'stu', 'hi', as('stu')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['communication.participate']);
    expect(seen[0]!.ctx.section?.role).toBeUndefined(); // stu is not in sec-2, where thr-2 lives
  });
});

describe('CommunicationService without enforcement', () => {
  it('behaves as before: no actor, no checks, the audience is stored, the author is taken as given', async () => {
    const w = buildWorld({ enforce: false });
    await expect(w.service.postAnnouncement('anywhere', 'T', 'B', 'guardians')).resolves.toMatchObject({ audience: 'guardians' });
    expect(w.dispatched).toEqual([{ type: 'announcementCreated', sectionId: 'anywhere', title: 'T', audience: 'guardians' }]);
    await expect(w.service.reply('thr-1', 'whoever', 'hi')).resolves.toMatchObject({ authorId: 'whoever' });
    expect(w.calls.threadLookups).toBe(0);
  });

  it('lists and reads whatever the repository has, with no channel filtering', async () => {
    const w = buildWorld({ enforce: false });
    expect(ids(await w.service.listAnnouncements('sec-1'))).toEqual(['a-stu', 'a-gua', 'a-legacy']);
    await expect(w.service.getThread('thr-1')).resolves.toMatchObject({ id: 'thr-1' });
    await expect(w.service.getThread('no-such')).rejects.toThrow('Thread no-such not found');
  });
});
