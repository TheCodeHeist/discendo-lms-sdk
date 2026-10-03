import { describe, it, expect } from 'bun:test';
import { AssessmentService } from '../src/domains/assessment/index.js';
import type { SubmissionRepository, QuizRepository, Submission } from '../src/domains/assessment/index.js';
import { createRolePolicy, EventBus, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
import type {
  ContentNode,
  Enrollment,
  GuardianLink,
  Identity,
  PermissionContext,
  PermissionPolicy,
  RepositoryContext,
  Role,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const text = { kind: 'text', content: 'my answer' } as const;

/**
 * Sections sec-1 and sec-2 belong to org-a, sec-open belongs to a course with no organization.
 * Content: assign-1 and quiz-1 are published, the *-draft ones are not.
 */
async function buildWorld(opts: { policy?: PermissionPolicy } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  add('teacher', ['instructor']);
  add('teacher-2', ['instructor']);
  add('ta', ['ta']);
  for (const id of ['stu', 'stu-2', 'stu-sec2', 'stu-dropped', 'stu-wait', 'stu-done', 'parent']) add(id, ['student']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');
  add('stu-b', ['student'], 'org-b');
  users.set('free-stu', { id: 'free-stu', roles: ['student'] }); // belongs to no organization

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
  seed('stu', 'sec-open', 'student'); // an org-a student placed in a course with no organization
  seed('free-stu', 'sec-open', 'student');

  const node = (id: string, sectionId: string, kind: ContentNode['kind'], published = true): ContentNode => ({
    id,
    sectionId,
    kind,
    title: id,
    orderIndex: 0,
    published,
    version: 1,
  });
  const nodes = new Map(
    [
      node('assign-1', 'sec-1', 'assignment'),
      node('assign-draft', 'sec-1', 'assignment', false),
      node('assign-2', 'sec-2', 'assignment'),
      node('quiz-1', 'sec-1', 'quiz'),
      node('quiz-draft', 'sec-1', 'quiz', false),
      node('assign-open', 'sec-open', 'assignment'),
    ].map((n) => [n.id, n]),
  );

  const links: GuardianLink[] = [
    {
      id: 'link-1',
      guardianId: 'parent',
      wardId: 'stu',
      orgId: 'org-a',
      scopes: ['grades', 'attendance', 'schedule'],
      status: 'active',
      createdAt: new Date(),
    },
  ];

  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'content' | 'guardianLinks'> = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) =>
        id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : id === 'course-open' ? { id, title: 'Open' } : null,
      findSection: async (id) =>
        ['sec-1', 'sec-2'].includes(id)
          ? { id, courseId: 'course-a', status: 'published' as const }
          : id === 'sec-open'
            ? { id, courseId: 'course-open', status: 'published' as const }
            : null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => {
        const entry: Enrollment = { ...e, id: `enr-${++en}` };
        enrollments.push(entry);
        return entry;
      },
      findById: async (id) => enrollments.find((e) => e.id === id) ?? null,
      update: async (id, patch) => ({ ...enrollments.find((e) => e.id === id)!, ...patch }),
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments].reverse().find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => enrollments.filter((e) => e.sectionId === sectionId),
      countActive: async () => 0,
    },
    content: {
      findById: async (id) => (calls.contentLookups++, nodes.get(id) ?? null),
      listBySection: async () => [],
      create: async (x) => ({ ...x, id: 'c', version: 1 }),
      update: async (id, patch) => ({ ...nodes.get(id)!, ...patch }),
      reorder: async () => {},
    },
    guardianLinks: {
      findActive: async (g, w) => links.find((l) => l.guardianId === g && l.wardId === w && l.status === 'active') ?? null,
    },
  };

  const store: Submission[] = [];
  const calls = { create: 0, attempt: 0, contentLookups: 0 };
  const submissions: SubmissionRepository = {
    create: async (s) => {
      calls.create++;
      const sub: Submission = { ...s, id: `sub-${store.length + 1}` };
      store.push(sub);
      return sub;
    },
    countAttempts: async (contentId, userId) => store.filter((s) => s.contentId === contentId && s.userId === userId).length,
  };
  const quizzes: QuizRepository = {
    getQuestions: async () => ['q1', 'q2', 'q3'].map((id) => ({ id, prompt: id, choices: ['a', 'b'], correctChoiceIndex: 0 })),
    createAttempt: async (a) => {
      calls.attempt++;
      return { ...a, id: `attempt-${calls.attempt}` };
    },
  };

  const bus = new EventBus();
  const received: string[] = [];
  bus.on('assessment.submissionReceived', (e) => received.push(e.userId));
  const policy = opts.policy ?? createRolePolicy();
  const service = new AssessmentService(submissions, quizzes, undefined, bus, { policy, repos });
  return { service, calls, received, store, links, users };
}

describe('AssessmentService.submit with enforcement', () => {
  it('lets a student submit their own work and records it as theirs', async () => {
    const w = await buildWorld();
    const sub = await w.service.submit('assign-1', 'stu', text, undefined, as('stu'));
    expect(sub).toMatchObject({ contentId: 'assign-1', userId: 'stu', attemptNumber: 1 });
    expect(w.calls.create).toBe(1);
  });

  it('refuses without an actor, and creates nothing', async () => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-1', 'stu', text)).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.create).toBe(0);
  });

  it.each(['stu-2', 'parent', 'teacher', 'ta', 'root', 'root-b', 'stu-b', 'nobody'])(
    'refuses %s submitting on behalf of stu, and creates nothing',
    async (who) => {
      const w = await buildWorld();
      await expect(w.service.submit('assign-1', 'stu', text, undefined, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.create).toBe(0);
      expect(w.received).toEqual([]);
    },
  );

  it.each(['teacher', 'ta', 'root'])('refuses %s even submitting as themselves (only students submit)', async (who) => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-1', who, text, undefined, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-done'])('refuses a student whose enrollment is %s', async (who) => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-1', who, text, undefined, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('refuses a student of another section, using the section of the content, not any the caller names', async () => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-1', 'stu-sec2', text, undefined, as('stu-sec2'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.submit('assign-2', 'stu', text, undefined, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('answers unknown content exactly like a forbidden submission', async () => {
    const w = await buildWorld();
    const missing = await w.service.submit('no-such', 'stu', text, undefined, as('stu')).catch((e: unknown) => e);
    const forbidden = await w.service.submit('assign-2', 'stu', text, undefined, as('stu')).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect((missing as Error).message).toBe((forbidden as Error).message);
  });

  it('refuses a student on content that is not published', async () => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-draft', 'stu', text, undefined, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('refuses a guardian whatever the link allows', async () => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-1', 'stu', text, undefined, as('parent'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('keeps the tenant wall: an org student in a course with no organization is refused, a no-org one is not', async () => {
    const w = await buildWorld();
    await expect(w.service.submit('assign-open', 'stu', text, undefined, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.submit('assign-open', 'free-stu', text, undefined, as('free-stu'))).resolves.toMatchObject({
      userId: 'free-stu',
    });
  });

  it('still enforces the attempt limit, but only after the permission check', async () => {
    const w = await buildWorld();
    await w.service.submit('assign-1', 'stu', text, 1, as('stu'));
    await expect(w.service.submit('assign-1', 'stu', text, 1, as('stu'))).rejects.toThrow('No attempts remaining');
    // someone with no right to submit learns nothing about the attempts used
    const err = await w.service.submit('assign-1', 'stu', text, 1, as('stu-2')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
  });

  it('emits the submission event only for an allowed submission', async () => {
    const w = await buildWorld();
    await w.service.submit('assign-1', 'stu', text, undefined, as('stu-2')).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(w.received).toEqual([]);
    await w.service.submit('assign-1', 'stu', text, undefined, as('stu'));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.received).toEqual(['stu']);
  });

  it('asks the policy about assessment.submit, in the content\'s section, about the submitting user', async () => {
    const seen: Array<{ action: string; ctx: PermissionContext }> = [];
    const spy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
    const w = await buildWorld({ policy: spy });
    await w.service.submit('assign-2', 'stu', text, undefined, as('stu')).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toBe('assessment.submit');
    expect(seen[0]!.ctx.resourceOwnerId).toBe('stu');
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section?.role).toBeUndefined(); // stu is not in sec-2, which is where assign-2 lives
  });
});

describe('AssessmentService.attemptsRemaining with enforcement', () => {
  const used = async (w: Awaited<ReturnType<typeof buildWorld>>) => {
    await w.service.submit('assign-1', 'stu', text, undefined, as('stu'));
  };

  it('lets a student see their own count', async () => {
    const w = await buildWorld();
    await used(w);
    await expect(w.service.attemptsRemaining('assign-1', 'stu', 3, as('stu'))).resolves.toBe(2);
  });

  it.each(['teacher', 'ta', 'root'])('lets %s see any student\'s count', async (who) => {
    const w = await buildWorld();
    await used(w);
    await expect(w.service.attemptsRemaining('assign-1', 'stu', 3, as(who))).resolves.toBe(2);
  });

  it.each(['stu-2', 'parent', 'teacher-2', 'root-b', 'stu-b', 'nobody', 'stu-dropped'])('refuses %s', async (who) => {
    const w = await buildWorld();
    await expect(w.service.attemptsRemaining('assign-1', 'stu', 3, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses without an actor', async () => {
    const w = await buildWorld();
    await expect(w.service.attemptsRemaining('assign-1', 'stu', 3)).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('refuses a student on unpublished content, but lets staff see it', async () => {
    const w = await buildWorld();
    await expect(w.service.attemptsRemaining('assign-draft', 'stu', 3, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    for (const staff of ['teacher', 'ta', 'root']) {
      await expect(w.service.attemptsRemaining('assign-draft', 'stu', 3, as(staff)), staff).resolves.toBe(3);
    }
  });

  it('answers unknown content exactly like a forbidden request', async () => {
    const w = await buildWorld();
    const missing = await w.service.attemptsRemaining('no-such', 'stu', 3, as('stu')).catch((e: unknown) => e);
    const forbidden = await w.service.attemptsRemaining('assign-1', 'stu', 3, as('stu-2')).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect((missing as Error).message).toBe((forbidden as Error).message);
  });
});

describe('AssessmentService.generateAttempt with enforcement', () => {
  it('lets a student start their own attempt, with every question once', async () => {
    const w = await buildWorld();
    const attempt = await w.service.generateAttempt('quiz-1', 'stu', true, as('stu'));
    expect(attempt).toMatchObject({ quizId: 'quiz-1', userId: 'stu' });
    expect([...attempt.questionOrder].sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it.each(['stu-2', 'parent', 'teacher', 'ta', 'root', 'root-b', 'nobody', 'stu-dropped', 'stu-sec2'])(
    'refuses %s starting an attempt for stu, and creates nothing',
    async (who) => {
      const w = await buildWorld();
      await expect(w.service.generateAttempt('quiz-1', 'stu', true, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.attempt).toBe(0);
    },
  );

  it('refuses without an actor', async () => {
    const w = await buildWorld();
    await expect(w.service.generateAttempt('quiz-1', 'stu')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.attempt).toBe(0);
  });

  it('refuses a student on an unpublished quiz', async () => {
    const w = await buildWorld();
    await expect(w.service.generateAttempt('quiz-draft', 'stu', true, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.attempt).toBe(0);
  });

  it('answers an unknown quiz exactly like a forbidden one', async () => {
    const w = await buildWorld();
    const missing = await w.service.generateAttempt('no-such', 'stu', true, as('stu')).catch((e: unknown) => e);
    const forbidden = await w.service.generateAttempt('quiz-1', 'stu', true, as('stu-2')).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect((missing as Error).message).toBe((forbidden as Error).message);
  });

  it('asks the policy about assessment.startAttempt', async () => {
    const seen: string[] = [];
    const spy: PermissionPolicy = { can: (action) => (seen.push(action), false) };
    const w = await buildWorld({ policy: spy });
    await w.service.generateAttempt('quiz-1', 'stu', true, as('stu')).catch(() => {});
    expect(seen).toEqual(['assessment.startAttempt']);
  });
});

describe('AssessmentService: nothing is looked up before the actor is known', () => {
  it('does not touch the content for a call without an actor', async () => {
    const w = await buildWorld();
    await w.service.submit('assign-1', 'stu', text).catch(() => {});
    await w.service.attemptsRemaining('assign-1', 'stu', 3).catch(() => {});
    await w.service.generateAttempt('quiz-1', 'stu').catch(() => {});
    expect(w.calls.contentLookups).toBe(0);
    await w.service.submit('assign-1', 'stu', text, undefined, as('stu'));
    expect(w.calls.contentLookups).toBe(1);
  });
});

describe('AssessmentService without enforcement', () => {
  it('behaves as before: no actor, no checks, no content lookup', async () => {
    const w = await buildWorld();
    const plain = new AssessmentService(
      { create: async (s) => ({ ...s, id: 's1' }), countAttempts: async () => 0 },
      { getQuestions: async () => [], createAttempt: async (a) => ({ ...a, id: 'a1' }) },
    );
    await expect(plain.submit('anything', 'anyone', text)).resolves.toMatchObject({ userId: 'anyone' });
    await expect(plain.attemptsRemaining('anything', 'anyone', 2)).resolves.toBe(2);
    await expect(plain.generateAttempt('anything', 'anyone')).resolves.toMatchObject({ userId: 'anyone' });
    expect(w.calls.create).toBe(0);
  });
});
