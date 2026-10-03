import { describe, it, expect } from 'bun:test';
import { GradingService } from '../src/domains/grading/index.js';
import type { GradeRepository, GradeEntry, SubmissionLocation } from '../src/domains/grading/index.js';
import {
  EventBus,
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
} from '../src/core/index.js';
import type {
  RepositoryContext,
  Enrollment,
  Identity,
  Role,
  PermissionPolicy,
  LmsEvent,
} from '../src/core/index.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const as = (actorId: string) => ({ actorId });

/** Two organizations; sec-1 and sec-2 belong to org-a. */
async function buildWorld(policy: PermissionPolicy | null = createRolePolicy()) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId: string) => users.set(id, { id, roles, orgId });
  add('teacher', ['instructor'], 'org-a'); // instructor in sec-1
  add('teacher-2', ['instructor'], 'org-a'); // instructor in sec-2 only
  add('ta', ['ta'], 'org-a');
  add('stu', ['student'], 'org-a');
  add('stu-2', ['student'], 'org-a');
  add('root', ['admin'], 'org-a'); // an admin who is ALSO enrolled as a student in sec-1
  add('root-b', ['admin'], 'org-b');
  add('admin-free', ['admin'], 'org-a'); // same-org admin with no enrollments at all
  users.set('admin-no-org', { id: 'admin-no-org', roles: ['admin'] }); // belongs to no organization

  const store = new Map<string, Enrollment>();
  let en = 0;
  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'> = {
    users: {
      findById: async (id) => users.get(id) ?? null,
      findByExternalRef: async () => null,
    },
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
        store.set(entry.id, entry);
        return entry;
      },
      findById: async (id) => store.get(id) ?? null,
      update: async (id, patch) => ({ ...store.get(id)!, ...patch }),
      findByUserAndSection: async (userId, sectionId) =>
        [...store.values()].find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async () => [],
      countActive: async () => 0,
    },
  };
  const seed = (userId: string, sectionId: string, role: Role) =>
    repos.enrollments.create({ userId, sectionId, role, status: 'active', enrolledAt: new Date() });
  await seed('teacher', 'sec-1', 'instructor');
  await seed('teacher-2', 'sec-2', 'instructor');
  await seed('ta', 'sec-1', 'ta');
  await seed('stu', 'sec-1', 'student');
  await seed('stu-2', 'sec-1', 'student');
  await seed('root', 'sec-1', 'student');

  const submissions = new Map<string, SubmissionLocation>([
    ['sub-1', { sectionId: 'sec-1', userId: 'stu' }],
    ['sub-2', { sectionId: 'sec-1', userId: 'stu-2' }],
    ['sub-root', { sectionId: 'sec-1', userId: 'root' }],
    ['sub-other-section', { sectionId: 'sec-2', userId: 'stu-2' }],
    ['sub-open', { sectionId: 'sec-open', userId: 'stu' }],
  ]);

  const entries = new Map<string, GradeEntry>();
  const calls = { create: 0, markSuperseded: 0, list: 0, locate: 0 };
  let gn = 0;
  const grades: GradeRepository = {
    create: async (e) => {
      calls.create++;
      const entry: GradeEntry = { ...e, id: `grade-${++gn}` };
      entries.set(entry.id, entry);
      return entry;
    },
    findById: async (id) => entries.get(id) ?? null,
    markSuperseded: async (id, byId) => {
      calls.markSuperseded++;
      const existing = entries.get(id);
      if (existing) entries.set(id, { ...existing, supersededBy: byId });
    },
    listForUserInSection: async (userId) => {
      calls.list++;
      return [...entries.values()].filter((e) => e.userId === userId).map((e) => ({ ...e, category: 'default' }));
    },
  };

  const bus = new EventBus();
  const events: LmsEvent[] = [];
  bus.on('*', (e) => events.push(e));

  const locator = {
    locate: async (id: string) => {
      calls.locate++;
      return submissions.get(id) ?? null;
    },
  };
  const service = new GradingService(
    grades,
    bus,
    policy ? { policy, repos, submissions: locator } : undefined,
  );
  return { service, grades, entries, calls, events, users, enrollments: store };
}

const scheme = { categories: [{ name: 'default', weight: 1 }] };
const scale = [
  { minPercent: 90, label: 'A' },
  { minPercent: 0, label: 'F' },
];

describe('GradingService permissions: recordGrade', () => {
  it.each(['teacher', 'ta', 'admin-free'])('lets %s record a grade', async (who) => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 80, 100, who, undefined, as(who))).resolves.toMatchObject({
      graderId: who,
      score: 80,
    });
  });

  it('refuses without an actor, and looks nothing up first', async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 80, 100, 'teacher')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.locate).toBe(0);
    expect(w.calls.create).toBe(0);
  });

  it.each(['stu', 'stu-2', 'teacher-2', 'root-b', 'nobody'])('refuses %s', async (who) => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 100, 100, who, undefined, as(who))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(w.calls.create).toBe(0);
  });

  it('answers an unknown submission exactly like a forbidden one, for every actor', async () => {
    const w = await buildWorld();
    for (const who of ['stu', 'teacher', 'root-b']) {
      const missing = await w.service.recordGrade('no-such', 'stu', 1, 1, who, undefined, as(who)).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(PermissionDeniedError);
      expect((missing as Error).message).toBe('Not permitted: grading.record');
    }
  });

  it("uses the submission's real section: an instructor of sec-2 cannot grade a sec-1 submission", async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 100, 100, 'teacher-2', undefined, as('teacher-2'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('refuses to record under someone else\'s name', async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 100, 100, 'ta', undefined, as('teacher'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(w.calls.create).toBe(0);
  });

  it('refuses anyone grading their own work, even an admin', async () => {
    const w = await buildWorld();
    // root is an admin AND a student in sec-1 with their own submission.
    await expect(w.service.recordGrade('sub-root', 'root', 100, 100, 'root', undefined, as('root'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(w.calls.create).toBe(0);
    // ...but can grade someone else's.
    await expect(w.service.recordGrade('sub-1', 'stu', 90, 100, 'root', undefined, as('root'))).resolves.toBeDefined();
  });

  it('refuses a grade attributed to a student who did not submit the work, and creates nothing', async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu-2', 100, 100, 'teacher', undefined, as('teacher'))).rejects.toThrow(
      'was not submitted by user stu-2',
    );
    expect(w.calls.create).toBe(0);
  });

  it('tells an UNauthorized caller nothing about who submitted what', async () => {
    const w = await buildWorld();
    const err = (await w.service.recordGrade('sub-1', 'stu-2', 1, 1, 'stu', undefined, as('stu')).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err.message).not.toContain('submitted');
  });

  it('leaves no trace when refused: no entry, no supersede, no event', async () => {
    const w = await buildWorld();
    const first = await w.service.recordGrade('sub-1', 'stu', 70, 100, 'teacher', undefined, as('teacher'));
    await flush();
    w.events.length = 0;

    await w.service.recordGrade('sub-1', 'stu', 100, 100, 'stu', first.id, as('stu')).catch(() => {});
    await flush();

    expect(w.events).toEqual([]);
    expect(w.calls.create).toBe(1);
    expect(w.calls.markSuperseded).toBe(0);
    expect(w.entries.get(first.id)!.supersededBy).toBeUndefined();
  });

  it('takes effect immediately when a grader is removed from the section', async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 80, 100, 'ta', undefined, as('ta'))).resolves.toBeDefined();

    for (const e of w.enrollments.values()) if (e.userId === 'ta') e.status = 'dropped';

    await expect(w.service.recordGrade('sub-2', 'stu-2', 80, 100, 'ta', undefined, as('ta'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('takes effect immediately when an admin loses the admin role', async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-1', 'stu', 80, 100, 'admin-free', undefined, as('admin-free'))).resolves.toBeDefined();

    w.users.set('admin-free', { id: 'admin-free', roles: ['student'], orgId: 'org-a' });

    await expect(w.service.recordGrade('sub-2', 'stu-2', 80, 100, 'admin-free', undefined, as('admin-free'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe('GradingService permissions: a section whose course has no organization', () => {
  it('refuses an admin who belongs to an organization, for recording and for viewing', async () => {
    const w = await buildWorld();
    await expect(w.service.recordGrade('sub-open', 'stu', 80, 100, 'admin-free', undefined, as('admin-free'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(w.calls.create).toBe(0);
    await expect(w.service.computeFinalGradeForUser('stu', 'sec-open', scheme, as('admin-free'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('lets an admin with no organization record a grade there', async () => {
    const w = await buildWorld();
    await expect(
      w.service.recordGrade('sub-open', 'stu', 80, 100, 'admin-no-org', undefined, as('admin-no-org')),
    ).resolves.toMatchObject({ graderId: 'admin-no-org' });
  });

  it('refuses an admin with no organization on an organization\'s section', async () => {
    const w = await buildWorld();
    await expect(
      w.service.recordGrade('sub-1', 'stu', 80, 100, 'admin-no-org', undefined, as('admin-no-org')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('GradingService: superseding an entry (integrity, with and without enforcement)', () => {
  for (const mode of ['enforced', 'not enforced'] as const) {
    describe(mode, () => {
      const make = () => buildWorld(mode === 'enforced' ? createRolePolicy() : null);
      const rec = (w: Awaited<ReturnType<typeof buildWorld>>, sub: string, user: string, prev?: string) =>
        mode === 'enforced'
          ? w.service.recordGrade(sub, user, 75, 100, 'teacher', prev, as('teacher'))
          : w.service.recordGrade(sub, user, 75, 100, 'teacher', prev);

      it('supersedes the current entry for the same submission', async () => {
        const w = await make();
        const first = await rec(w, 'sub-1', 'stu');
        const second = await rec(w, 'sub-1', 'stu', first.id);
        expect(w.entries.get(first.id)!.supersededBy).toBe(second.id);
      });

      it("refuses to supersede ANOTHER submission's entry, leaving that grade intact", async () => {
        const w = await make();
        const other = await rec(w, 'sub-2', 'stu-2');
        await expect(rec(w, 'sub-1', 'stu', other.id)).rejects.toThrow('different submission');
        expect(w.entries.get(other.id)!.supersededBy).toBeUndefined();
        expect(w.calls.create).toBe(1);
        expect(w.calls.markSuperseded).toBe(0);
      });

      it('refuses an entry that does not exist', async () => {
        const w = await make();
        await expect(rec(w, 'sub-1', 'stu', 'grade-999')).rejects.toThrow('not found');
        expect(w.calls.create).toBe(0);
      });

      it('refuses to supersede an entry that was already superseded (no forked history)', async () => {
        const w = await make();
        const first = await rec(w, 'sub-1', 'stu');
        await rec(w, 'sub-1', 'stu', first.id);
        await expect(rec(w, 'sub-1', 'stu', first.id)).rejects.toThrow('already been superseded');
        expect(w.calls.create).toBe(2);
      });
    });
  }
});

describe('GradingService permissions: viewing grades', () => {
  async function withGrades() {
    const w = await buildWorld();
    await w.service.recordGrade('sub-1', 'stu', 80, 100, 'teacher', undefined, as('teacher'));
    await w.service.recordGrade('sub-2', 'stu-2', 95, 100, 'teacher', undefined, as('teacher'));
    w.calls.list = 0;
    return w;
  }

  it.each(['teacher', 'ta'])('lets %s view any student in the section', async (who) => {
    const w = await withGrades();
    await expect(w.service.computeFinalGradeForUser('stu', 'sec-1', scheme, as(who))).resolves.toBeCloseTo(80);
    await expect(w.service.computeFinalGradeForUser('stu-2', 'sec-1', scheme, as(who))).resolves.toBeCloseTo(95);
  });

  it('lets a student view their own grade but not a classmate\'s', async () => {
    const w = await withGrades();
    await expect(w.service.computeFinalGradeForUser('stu', 'sec-1', scheme, as('stu'))).resolves.toBeCloseTo(80);
    await expect(w.service.computeFinalGradeForUser('stu-2', 'sec-1', scheme, as('stu'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('applies the same rules to letter grades', async () => {
    const w = await withGrades();
    await expect(w.service.computeLetterGradeForUser('stu-2', 'sec-1', scheme, scale, as('stu-2'))).resolves.toBe('A');
    await expect(w.service.computeLetterGradeForUser('stu-2', 'sec-1', scheme, scale, as('stu'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(w.service.computeLetterGradeForUser('stu-2', 'sec-1', scheme, scale)).rejects.toBeInstanceOf(
      ActorRequiredError,
    );
  });

  it.each(['teacher-2', 'root-b', 'nobody'])('refuses %s', async (who) => {
    const w = await withGrades();
    await expect(w.service.computeFinalGradeForUser('stu', 'sec-1', scheme, as(who))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('refuses without an actor', async () => {
    const w = await withGrades();
    await expect(w.service.computeFinalGradeForUser('stu', 'sec-1', scheme)).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('reads no grades at all before the check passes', async () => {
    const w = await withGrades();
    await w.service.computeFinalGradeForUser('stu', 'sec-1', scheme, as('stu-2')).catch(() => {});
    await w.service.computeLetterGradeForUser('stu', 'sec-1', scheme, scale).catch(() => {});
    expect(w.calls.list).toBe(0);
  });

  it('denies a missing section, admins included', async () => {
    const w = await withGrades();
    await expect(w.service.computeFinalGradeForUser('stu', 'no-such', scheme, as('teacher'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe('GradingService: enforcement is opt-in', () => {
  it('works exactly as before with no enforcement configured (no actor needed)', async () => {
    const w = await buildWorld(null);
    const entry = await w.service.recordGrade('anything', 'anyone', 88, 100, 'anybody');
    expect(entry.score).toBe(88);
    await expect(w.service.computeFinalGradeForUser('anyone', 'any-section', scheme)).resolves.toBeCloseTo(88);
    await expect(w.service.computeLetterGradeForUser('anyone', 'any-section', scheme, scale)).resolves.toBe('F');
  });
});

describe('GradingService permissions: a misbehaving policy never opens the door', () => {
  it.each([[undefined], ['yes'], [1]])('treats a policy answer of %p as a denial', async (answer) => {
    const w = await buildWorld({ can: (() => answer) as never });
    await expect(w.service.recordGrade('sub-1', 'stu', 80, 100, 'teacher', undefined, as('teacher'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect(w.calls.create).toBe(0);
  });

  it('lets a throwing policy stop the grade from being recorded', async () => {
    const w = await buildWorld({
      can: () => {
        throw new Error('policy backend down');
      },
    });
    await expect(w.service.recordGrade('sub-1', 'stu', 80, 100, 'teacher', undefined, as('teacher'))).rejects.toThrow(
      'policy backend down',
    );
    expect(w.calls.create).toBe(0);
  });
});
