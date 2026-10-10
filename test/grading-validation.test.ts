import { describe, it, expect } from 'bun:test';
import { GradingService, InvalidGradeError, computeFinalGrade } from '../src/domains/grading/index.js';
import type { GradeEntry, GradeRepository, GradingScheme } from '../src/domains/grading/index.js';
import { EventBus, PermissionDeniedError, createRolePolicy } from '../src/core/index.js';
import type { Enrollment, Identity, RepositoryContext, Role } from '../src/core/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));

function buildRepo() {
  const rows: GradeEntry[] = [];
  const calls = { create: 0, superseded: 0 };
  let seq = 0;
  const repo: GradeRepository = {
    create: async (e) => {
      calls.create++;
      const row = { ...e, id: `g-${++seq}` } as GradeEntry;
      rows.push(row);
      return row;
    },
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    markSuperseded: async (id, byId) => {
      calls.superseded++;
      const row = rows.find((r) => r.id === id)!;
      rows[rows.indexOf(row)] = { ...row, supersededBy: byId };
    },
    listForUserInSection: async (userId) =>
      rows.filter((r) => r.userId === userId && r.supersededBy === undefined).map((r) => ({ ...r, category: 'hw' })),
  };
  return { repo, rows, calls };
}

const entry = (score: number, maxScore: number): GradeEntry =>
  ({ id: 'x', submissionId: 's', userId: 'u', score, maxScore, graderId: 'g', gradedAt: new Date() }) as GradeEntry;
const scheme: GradingScheme = { categories: [{ name: 'hw', weight: 1 }] };
const final = (entries: GradeEntry[], s: GradingScheme = scheme) => computeFinalGrade(new Map([['hw', entries]]), s);

describe('computeFinalGrade ignores entries that cannot be a grade', () => {
  it.each([
    ['a maximum of zero', entry(50, 0)],
    ['a negative maximum', entry(50, -10)],
    ['a maximum that is not a number', entry(50, Number.NaN)],
    ['an infinite maximum', entry(50, Number.POSITIVE_INFINITY)],
    ['a score that is not a number', entry(Number.NaN, 100)],
    ['an infinite score', entry(Number.POSITIVE_INFINITY, 100)],
    ['a negative score', entry(-5, 100)],
  ])('skips %s, so it cannot turn a whole grade into Infinity or NaN', (_label, bad) => {
    expect(final([entry(80, 100), bad])).toBe(80);
    expect(Number.isFinite(final([bad, entry(60, 100)]))).toBe(true);
  });

  it('treats a category with only unusable entries as having no grades yet, so the other weights carry the result', () => {
    const two: GradingScheme = { categories: [{ name: 'hw', weight: 0.5 }, { name: 'exam', weight: 0.5 }] };
    const grade = computeFinalGrade(new Map([['hw', [entry(50, 0)]], ['exam', [entry(90, 100)]]]), two);
    expect(grade).toBeCloseTo(90);
  });

  it('gives 0 when nothing at all is usable, not NaN', () => {
    expect(final([entry(1, 0), entry(Number.NaN, 5)])).toBe(0);
  });

  it('applies drop-lowest to the usable entries only', () => {
    const dropOne: GradingScheme = { categories: [{ name: 'hw', weight: 1, dropLowestN: 1 }] };
    expect(final([entry(50, 100), entry(90, 100), entry(1, 0)], dropOne)).toBeCloseTo(90);
  });

  it('still counts a score above the maximum as the percentage it is (extra credit is allowed to be stored)', () => {
    expect(final([entry(120, 100)])).toBeCloseTo(120);
  });

  it('counts zero as a real score', () => {
    expect(final([entry(0, 100), entry(100, 100)])).toBeCloseTo(50);
  });
});

describe('GradingService.recordGrade validates the numbers', () => {
  const bad: Array<[string, number, number]> = [
    ['a negative score', -1, 100],
    ['a score that is not a number', Number.NaN, 100],
    ['an infinite score', Number.POSITIVE_INFINITY, 100],
    ['a maximum of zero', 50, 0],
    ['a negative maximum', 50, -10],
    ['a maximum that is not a number', 50, Number.NaN],
    ['an infinite maximum', 50, Number.POSITIVE_INFINITY],
    ['a score above the maximum', 101, 100],
  ];

  it.each(bad)('refuses %s, and stores and announces nothing', async (_label, score, max) => {
    const { repo, calls } = buildRepo();
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.on('grading.gradePosted', (e) => void seen.push(e));
    const service = new GradingService(repo, bus);
    await expect(service.recordGrade('s1', 'u1', score, max, 'g1')).rejects.toBeInstanceOf(InvalidGradeError);
    await sleep();
    expect(calls.create).toBe(0);
    expect(seen).toEqual([]);
  });

  it.each([
    ['zero', 0, 100],
    ['full marks', 100, 100],
    ['a fraction', 0.5, 2.5],
    ['a tiny maximum', 0.1, 0.1],
  ])('accepts %s', async (_label, score, max) => {
    const { repo } = buildRepo();
    await expect(new GradingService(repo).recordGrade('s1', 'u1', score, max, 'g1')).resolves.toMatchObject({ score, maxScore: max });
  });

  it('leaves the current grade alone when a regrade is refused: nothing is superseded', async () => {
    const { repo, rows, calls } = buildRepo();
    const service = new GradingService(repo);
    const first = await service.recordGrade('s1', 'u1', 80, 100, 'g1');
    await expect(service.recordGrade('s1', 'u1', 999, 100, 'g1', first.id)).rejects.toBeInstanceOf(InvalidGradeError);
    expect(calls.superseded).toBe(0);
    expect(rows.filter((r) => r.supersededBy === undefined)).toHaveLength(1);
  });

  it('says what is wrong in the message', async () => {
    const service = new GradingService(buildRepo().repo);
    await expect(service.recordGrade('s1', 'u1', 5, 0, 'g1')).rejects.toThrow('maxScore');
    await expect(service.recordGrade('s1', 'u1', -5, 10, 'g1')).rejects.toThrow('score');
    await expect(service.recordGrade('s1', 'u1', 11, 10, 'g1')).rejects.toThrow('allowExtraCredit');
  });

  describe('extra credit is opt-in', () => {
    it('with allowExtraCredit a score above the maximum is accepted, and is counted as the percentage it is', async () => {
      const { repo } = buildRepo();
      const service = new GradingService(repo, undefined, undefined, { allowExtraCredit: true });
      await expect(service.recordGrade('s1', 'u1', 120, 100, 'g1')).resolves.toMatchObject({ score: 120 });
      expect(await service.computeFinalGradeForUser('u1', 'sec-1', scheme)).toBeCloseTo(120);
    });

    it('still refuses everything else that is invalid', async () => {
      const service = new GradingService(buildRepo().repo, undefined, undefined, { allowExtraCredit: true });
      for (const [score, max] of [[-1, 100], [Number.NaN, 100], [50, 0], [50, -1], [Number.POSITIVE_INFINITY, 100], [50, Number.NaN]] as const) {
        await expect(service.recordGrade('s1', 'u1', score, max, 'g1'), `${score}/${max}`).rejects.toBeInstanceOf(InvalidGradeError);
      }
    });
  });
});

describe('with enforcement the permission check still comes first', () => {
  function enforcedService() {
    const users = new Map<string, Identity>();
    const add = (id: string, roles: Role[]) => users.set(id, { id, roles, orgId: 'org-a' });
    add('teacher', ['instructor']);
    add('stu', ['student']);
    const enrollments: Enrollment[] = [
      { id: 'e1', userId: 'teacher', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() },
      { id: 'e2', userId: 'stu', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
    ];
    const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'> = {
      users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
      courses: {
        findCourse: async (id) => ({ id, title: 'A', orgId: 'org-a' }),
        findSection: async (id) => ({ id, courseId: 'course-a', status: 'published' as const }),
        listSections: async () => [],
      },
      enrollments: {
        create: async (e) => ({ ...e, id: 'x' }),
        findById: async (id) => enrollments.find((e) => e.id === id) ?? null,
        update: async (id, patch) => ({ ...enrollments.find((e) => e.id === id)!, ...patch }),
        findByUserAndSection: async (userId, sectionId) => enrollments.find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
        listBySection: async () => enrollments,
        countActive: async () => 0,
      },
    };
    const { repo, calls } = buildRepo();
    const service = new GradingService(repo, undefined, {
      policy: createRolePolicy(),
      repos,
      submissions: { locate: async (id) => (id === 's1' ? { sectionId: 'sec-1', userId: 'stu' } : null) },
    });
    return { service, calls };
  }

  it('a stranger with bad numbers is told "not permitted", not what is wrong with them', async () => {
    const { service } = enforcedService();
    await expect(service.recordGrade('s1', 'stu', -1, 0, 'stu', undefined, { actorId: 'stu' })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('an authorized grader with bad numbers is told what is wrong, and nothing is stored', async () => {
    const { service, calls } = enforcedService();
    await expect(service.recordGrade('s1', 'stu', 150, 100, 'teacher', undefined, { actorId: 'teacher' })).rejects.toBeInstanceOf(InvalidGradeError);
    expect(calls.create).toBe(0);
    await expect(service.recordGrade('s1', 'stu', 90, 100, 'teacher', undefined, { actorId: 'teacher' })).resolves.toMatchObject({ score: 90 });
  });
});
