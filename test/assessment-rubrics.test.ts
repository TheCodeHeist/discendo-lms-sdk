import { describe, it, expect } from 'bun:test';
import {
  scoreRubric,
  RubricService,
  InvalidRubricError,
  InvalidRubricScoreError,
  RubricNotFoundError,
} from '../src/domains/assessment/index.js';
import type {
  Rubric,
  Criterion,
  RubricRepository,
  RubricEvaluationRepository,
  RubricEvaluation,
} from '../src/domains/assessment/index.js';
import {
  DEFAULT_RULES,
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
} from '../src/core/index.js';
import type {
  ActorContext,
  ContentNode,
  Course,
  Enrollment,
  Identity,
  Role,
  CourseSection,
} from '../src/core/index.js';

const as = (actorId: string): ActorContext => ({ actorId });

describe('scoreRubric (pure function)', () => {
  const rubric: Rubric = {
    id: 'rub-1',
    contentId: 'assign-1',
    title: 'Essay Rubric',
    criteria: [
      { id: 'crit-thesis', description: 'Clear thesis statement', maxPoints: 10 },
      { id: 'crit-evidence', description: 'Strong supporting evidence', maxPoints: 20 },
      { id: 'crit-clarity', description: 'Grammar and style', maxPoints: 10 },
    ],
  };

  it('scores each criterion and calculates total and maxScore', () => {
    const result = scoreRubric(rubric, {
      'crit-thesis': 8,
      'crit-evidence': 18,
      'crit-clarity': 9,
    });
    expect(result).toEqual({
      totalScore: 35,
      maxScore: 40,
      criterionScores: {
        'crit-thesis': 8,
        'crit-evidence': 18,
        'crit-clarity': 9,
      },
    });
  });

  it('treats missing criteria as zero score', () => {
    const result = scoreRubric(rubric, {
      'crit-thesis': 10,
    });
    expect(result.totalScore).toBe(10);
    expect(result.maxScore).toBe(40);
    expect(result.criterionScores['crit-thesis']).toBe(10);
    expect(result.criterionScores['crit-evidence']).toBe(0);
    expect(result.criterionScores['crit-clarity']).toBe(0);
  });

  it('refuses scores that exceed the criterion maxPoints', () => {
    expect(() =>
      scoreRubric(rubric, { 'crit-thesis': 11 }),
    ).toThrow(InvalidRubricScoreError);
  });

  it('refuses negative scores', () => {
    expect(() =>
      scoreRubric(rubric, { 'crit-thesis': -1 }),
    ).toThrow(InvalidRubricScoreError);
  });

  it('refuses non-finite numbers', () => {
    expect(() =>
      scoreRubric(rubric, { 'crit-thesis': Number.NaN }),
    ).toThrow(InvalidRubricScoreError);
    expect(() =>
      scoreRubric(rubric, { 'crit-thesis': Number.POSITIVE_INFINITY }),
    ).toThrow(InvalidRubricScoreError);
  });

  it('refuses unknown criterion ids', () => {
    expect(() =>
      scoreRubric(rubric, { 'non-existent': 5 }),
    ).toThrow(InvalidRubricScoreError);
  });
});

describe('RubricService (without enforcement)', () => {
  function buildService() {
    const rubricsStore = new Map<string, Rubric>();
    const evalStore: RubricEvaluation[] = [];

    const rubricsRepo: RubricRepository = {
      save: async (r) => {
        const stored: Rubric = { ...r, id: `rub-${rubricsStore.size + 1}` };
        rubricsStore.set(r.contentId, stored);
        return stored;
      },
      findByContentId: async (cid) => rubricsStore.get(cid) ?? null,
      deleteByContentId: async (cid) => rubricsStore.delete(cid),
    };

    const evalRepo: RubricEvaluationRepository = {
      create: async (e) => {
        const stored: RubricEvaluation = { ...e, id: `eval-${evalStore.length + 1}` };
        evalStore.push(stored);
        return stored;
      },
      findBySubmission: async (sid) => evalStore.filter((e) => e.submissionId === sid),
      findById: async (id) => evalStore.find((e) => e.id === id) ?? null,
    };

    const contentRepo = {
      findById: async (id: string): Promise<ContentNode | null> => ({
        id,
        sectionId: 'sec-1',
        kind: 'assignment',
        title: id,
        orderIndex: 0,
        published: true,
        version: 1,
      }),
    };

    const service = new RubricService({
      rubrics: rubricsRepo,
      evaluations: evalRepo,
      content: contentRepo,
      users: { findById: async () => null, findByExternalRef: async () => null },
      courses: { findCourse: async () => null, findSection: async () => null, listSections: async () => [] },
      enrollments: { create: async () => ({} as never), findById: async () => null, update: async () => ({} as never), findByUserAndSection: async () => null, listBySection: async () => [], countActive: async () => 0 },
      guardianLinks: { findActive: async () => null },
      delegations: { create: async () => ({} as never), findById: async () => null, listActiveForEnrollment: async () => [], revoke: async () => ({} as never) },
    });

    return { service, rubricsStore, evalStore };
  }

  const validCriteria: Criterion[] = [
    { id: 'c1', description: 'Originality', maxPoints: 10 },
    { id: 'c2', description: 'Execution', maxPoints: 20 },
  ];

  it('saves and retrieves a rubric', async () => {
    const { service } = buildService();
    const created = await service.saveRubric('assign-1', validCriteria, 'Project Rubric');
    expect(created.contentId).toBe('assign-1');
    expect(created.criteria).toHaveLength(2);

    const fetched = await service.getRubric('assign-1');
    expect(fetched).toEqual(created);
  });

  it('refuses empty criteria or duplicate criterion ids', async () => {
    const { service } = buildService();
    await expect(service.saveRubric('assign-1', [])).rejects.toThrow(InvalidRubricError);
    await expect(
      service.saveRubric('assign-1', [
        { id: 'dup', description: 'A', maxPoints: 5 },
        { id: 'dup', description: 'B', maxPoints: 5 },
      ]),
    ).rejects.toThrow(InvalidRubricError);
  });

  it('refuses criteria with invalid maxPoints', async () => {
    const { service } = buildService();
    await expect(
      service.saveRubric('assign-1', [{ id: 'c1', description: 'A', maxPoints: -1 }]),
    ).rejects.toThrow(InvalidRubricError);
    await expect(
      service.saveRubric('assign-1', [{ id: 'c1', description: 'A', maxPoints: 0 }]),
    ).rejects.toThrow(InvalidRubricError);
  });

  it('deletes a rubric', async () => {
    const { service } = buildService();
    await service.saveRubric('assign-1', validCriteria);
    expect(await service.deleteRubric('assign-1')).toBe(true);
    expect(await service.getRubric('assign-1')).toBeNull();
  });

  it('evaluates a submission against a saved rubric', async () => {
    const { service } = buildService();
    await service.saveRubric('assign-1', validCriteria);
    const evaluation = await service.evaluateSubmission({
      contentId: 'assign-1',
      submissionId: 'sub-100',
      evaluatorId: 'teacher-1',
      scores: { c1: 9, c2: 17 },
      feedback: 'Great job!',
    });

    expect(evaluation.totalScore).toBe(26);
    expect(evaluation.feedback).toBe('Great job!');
    expect(evaluation.evaluatorId).toBe('teacher-1');

    const evals = await service.listEvaluations('sub-100');
    expect(evals).toHaveLength(1);
    expect(evals[0]!.id).toBe(evaluation.id);
  });

  it('throws RubricNotFoundError when evaluating without a rubric on file', async () => {
    const { service } = buildService();
    await expect(
      service.evaluateSubmission({
        contentId: 'assign-none',
        submissionId: 'sub-1',
        evaluatorId: 'teacher-1',
        scores: { c1: 5 },
      }),
    ).rejects.toThrow(RubricNotFoundError);
  });
});

describe('RubricService (with permission enforcement)', () => {
  function buildEnforcedWorld() {
    const users = new Map<string, Identity>([
      ['admin-1', { id: 'admin-1', roles: ['admin'], orgId: 'org-1' }],
      ['inst-1', { id: 'inst-1', roles: ['instructor'], orgId: 'org-1' }],
      ['ta-1', { id: 'ta-1', roles: ['ta'], orgId: 'org-1' }],
      ['student-1', { id: 'student-1', roles: ['student'], orgId: 'org-1' }],
      ['student-2', { id: 'student-2', roles: ['student'], orgId: 'org-1' }],
      ['outsider', { id: 'outsider', roles: ['instructor'], orgId: 'org-2' }],
    ]);

    const section: CourseSection = { id: 'sec-1', courseId: 'crs-1', status: 'published' };
    const course: Course = { id: 'crs-1', title: 'Course 1', orgId: 'org-1' };

    const nodes = new Map<string, ContentNode>([
      ['assign-pub', { id: 'assign-pub', sectionId: 'sec-1', kind: 'assignment', title: 'Public Assignment', orderIndex: 0, published: true, version: 1 }],
      ['assign-draft', { id: 'assign-draft', sectionId: 'sec-1', kind: 'assignment', title: 'Draft Assignment', orderIndex: 1, published: false, version: 1 }],
    ]);

    const enrollments: Enrollment[] = [
      { id: 'e1', userId: 'inst-1', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() },
      { id: 'e2', userId: 'ta-1', sectionId: 'sec-1', role: 'ta', status: 'active', enrolledAt: new Date() },
      { id: 'e3', userId: 'student-1', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
      { id: 'e4', userId: 'student-2', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
    ];

    const rubricsStore = new Map<string, Rubric>();
    const evalStore: RubricEvaluation[] = [];

    const rubricsRepo: RubricRepository = {
      save: async (r) => {
        const stored: Rubric = { ...r, id: `rub-${rubricsStore.size + 1}` };
        rubricsStore.set(r.contentId, stored);
        return stored;
      },
      findByContentId: async (cid) => rubricsStore.get(cid) ?? null,
      deleteByContentId: async (cid) => rubricsStore.delete(cid),
    };

    const evalRepo: RubricEvaluationRepository = {
      create: async (e) => {
        const stored: RubricEvaluation = { ...e, id: `eval-${evalStore.length + 1}` };
        evalStore.push(stored);
        return stored;
      },
      findBySubmission: async (sid) => evalStore.filter((e) => e.submissionId === sid),
      findById: async (id) => evalStore.find((e) => e.id === id) ?? null,
    };

    const submissionsStore = new Map<string, { id: string; contentId: string; userId: string }>([
      ['sub-1', { id: 'sub-1', contentId: 'assign-pub', userId: 'student-1' }],
    ]);

    const service = new RubricService(
      {
        rubrics: rubricsRepo,
        evaluations: evalRepo,
        content: { findById: async (id) => nodes.get(id) ?? null },
        submissions: {
          countAttempts: async () => 1,
          findById: async (id) => submissionsStore.get(id) as never ?? null,
        },
        users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
        courses: {
          findCourse: async (id) => (id === 'crs-1' ? course : null),
          findSection: async (id) => (id === 'sec-1' ? section : null),
          listSections: async () => [section],
        },
        enrollments: {
          create: async () => ({} as never),
          findById: async () => null,
          update: async () => ({} as never),
          findByUserAndSection: async (u, s) => enrollments.find((e) => e.userId === u && e.sectionId === s) ?? null,
          listBySection: async () => enrollments,
          countActive: async () => enrollments.length,
        },
        guardianLinks: { findActive: async () => null },
        delegations: { create: async () => ({} as never), findById: async () => null, listActiveForEnrollment: async () => [], revoke: async () => ({} as never) },
      },
      { policy: createRolePolicy() },
    );

    return { service };
  }

  const criteria: Criterion[] = [
    { id: 'c1', description: 'Quality', maxPoints: 10 },
  ];

  it('requires an actor on every call', async () => {
    const { service } = buildEnforcedWorld();
    await expect(service.saveRubric('assign-pub', criteria)).rejects.toMatchObject({ name: 'ActorRequiredError', action: 'assessment.manageRubric' });
    await expect(service.getRubric('assign-pub')).rejects.toMatchObject({ name: 'ActorRequiredError', action: 'content.view' });
    await expect(service.deleteRubric('assign-pub')).rejects.toMatchObject({ name: 'ActorRequiredError', action: 'assessment.manageRubric' });
    await expect(service.evaluateSubmission({ contentId: 'assign-pub', submissionId: 'sub-1', scores: { c1: 8 } })).rejects.toMatchObject({ name: 'ActorRequiredError', action: 'grading.record' });
    await expect(service.listEvaluations('sub-1')).rejects.toMatchObject({ name: 'ActorRequiredError', action: 'content.view' });
  });

  it('lets admin and instructor save a rubric, but refuses student and TA', async () => {
    const { service } = buildEnforcedWorld();
    await expect(service.saveRubric('assign-pub', criteria, 'T', as('inst-1'))).resolves.toBeDefined();
    await expect(service.saveRubric('assign-pub', criteria, 'T', as('admin-1'))).resolves.toBeDefined();

    await expect(service.saveRubric('assign-pub', criteria, 'T', as('student-1'))).rejects.toMatchObject({ name: 'PermissionDeniedError', action: 'assessment.manageRubric' });
    await expect(service.saveRubric('assign-pub', criteria, 'T', as('ta-1'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(service.saveRubric('assign-pub', criteria, 'T', as('outsider'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('allows students to view rubric for published content, but keeps them out of drafts', async () => {
    const { service } = buildEnforcedWorld();
    await service.saveRubric('assign-pub', criteria, 'Pub', as('admin-1'));
    await service.saveRubric('assign-draft', criteria, 'Draft', as('admin-1'));

    await expect(service.getRubric('assign-pub', as('student-1'))).resolves.toBeDefined();
    await expect(service.getRubric('assign-draft', as('student-1'))).rejects.toBeInstanceOf(PermissionDeniedError);
    // staff can see draft rubric
    await expect(service.getRubric('assign-draft', as('inst-1'))).resolves.toBeDefined();
  });

  it('lets staff evaluate a submission and refuses students', async () => {
    const { service } = buildEnforcedWorld();
    await service.saveRubric('assign-pub', criteria, 'Pub', as('admin-1'));

    await expect(
      service.evaluateSubmission(
        { contentId: 'assign-pub', submissionId: 'sub-1', scores: { c1: 8 } },
        as('inst-1'),
      ),
    ).resolves.toMatchObject({ totalScore: 8, evaluatorId: 'inst-1' });

    await expect(
      service.evaluateSubmission(
        { contentId: 'assign-pub', submissionId: 'sub-1', scores: { c1: 8 } },
        as('ta-1'),
      ),
    ).resolves.toMatchObject({ totalScore: 8, evaluatorId: 'ta-1' });

    await expect(
      service.evaluateSubmission(
        { contentId: 'assign-pub', submissionId: 'sub-1', scores: { c1: 8 } },
        as('student-2'),
      ),
    ).rejects.toMatchObject({ name: 'PermissionDeniedError', action: 'grading.record' });
  });

  it('lets staff and submission owner list evaluations, refusing other students', async () => {
    const { service } = buildEnforcedWorld();
    await service.saveRubric('assign-pub', criteria, 'Pub', as('admin-1'));
    await service.evaluateSubmission(
      { contentId: 'assign-pub', submissionId: 'sub-1', scores: { c1: 8 } },
      as('inst-1'),
    );

    // staff can list
    await expect(service.listEvaluations('sub-1', as('inst-1'))).resolves.toHaveLength(1);
    // submission author can list
    await expect(service.listEvaluations('sub-1', as('student-1'))).resolves.toHaveLength(1);
    // classmate cannot list
    await expect(service.listEvaluations('sub-1', as('student-2'))).rejects.toMatchObject({ name: 'PermissionDeniedError', action: 'content.view' });
  });
});
