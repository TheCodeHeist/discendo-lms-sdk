import { describe, it, expect } from 'bun:test';
import {
  GradingService,
} from '../src/domains/grading/index.js';
import type {
  GradeEntry,
  GradeRepository,
  GradingEnforcement,
} from '../src/domains/grading/index.js';
import {
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
} from '../src/core/index.js';
import type {
  ActorContext,
  Course,
  CourseSection,
  Enrollment,
  Identity,
} from '../src/core/index.js';

const as = (actorId: string): ActorContext => ({ actorId });

describe('GradingService - Group Grades', () => {
  function buildService() {
    const gradesStore: GradeEntry[] = [];
    const gradesRepo: GradeRepository = {
      create: async (e) => {
        const stored: GradeEntry = { ...e, id: `g-${gradesStore.length + 1}` };
        gradesStore.push(stored);
        return stored;
      },
      findById: async (id: string) => gradesStore.find((g) => g.id === id) ?? null,
      markSuperseded: async (id: string, byId: string) => {
        const found = gradesStore.find((g) => g.id === id);
        if (found) found.supersededBy = byId;
      },
      listForUserInSection: async () => [],
    };

    const service = new GradingService(gradesRepo);
    return { service, gradesStore };
  }

  it('records shared grade for all group members', async () => {
    const { service, gradesStore } = buildService();
    const members = ['student-1', 'student-2', 'student-3'];

    const entries = await service.recordGroupGrade(
      'sub-group-1',
      members,
      88,
      100,
      'instructor-1',
    );

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.userId)).toEqual(members);
    for (const e of entries) {
      expect(e.score).toBe(88);
      expect(e.maxScore).toBe(100);
      expect(e.submissionId).toBe('sub-group-1');
      expect(e.graderId).toBe('instructor-1');
    }
    expect(gradesStore).toHaveLength(3);
  });

  it('refuses if memberUserIds is empty', async () => {
    const { service } = buildService();
    await expect(
      service.recordGroupGrade('sub-1', [], 90, 100, 'inst-1'),
    ).rejects.toThrow('memberUserIds must contain at least one user');
  });

  it('supports superseding previous entries on regrade', async () => {
    const { service, gradesStore } = buildService();
    const members = ['student-1', 'student-2'];

    const initial = await service.recordGroupGrade('sub-group-1', members, 80, 100, 'inst-1');
    expect(initial).toHaveLength(2);

    const prevMap: Record<string, string> = {
      'student-1': initial[0]!.id,
      'student-2': initial[1]!.id,
    };

    const regrade = await service.recordGroupGrade(
      'sub-group-1',
      members,
      95,
      100,
      'inst-1',
      { previousEntryIds: prevMap },
    );

    expect(regrade).toHaveLength(2);
    expect(gradesStore[0]!.supersededBy).toBe(regrade[0]!.id);
    expect(gradesStore[1]!.supersededBy).toBe(regrade[1]!.id);
  });
});

describe('GradingService - Group Grades with enforcement', () => {
  function buildEnforcedWorld() {
    const users = new Map<string, Identity>([
      ['inst-1', { id: 'inst-1', roles: ['instructor'], orgId: 'org-1' }],
      ['student-1', { id: 'student-1', roles: ['student'], orgId: 'org-1' }],
      ['student-2', { id: 'student-2', roles: ['student'], orgId: 'org-1' }],
    ]);

    const section: CourseSection = { id: 'sec-1', courseId: 'crs-1', status: 'published' };
    const course: Course = { id: 'crs-1', title: 'Course 1', orgId: 'org-1' };

    const enrollments: Enrollment[] = [
      { id: 'e1', userId: 'inst-1', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() },
      { id: 'e2', userId: 'student-1', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
      { id: 'e3', userId: 'student-2', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
    ];

    const gradesStore: GradeEntry[] = [];
    const gradesRepo: GradeRepository = {
      create: async (e) => {
        const stored: GradeEntry = { ...e, id: `g-${gradesStore.length + 1}` };
        gradesStore.push(stored);
        return stored;
      },
      findById: async (id: string) => gradesStore.find((g) => g.id === id) ?? null,
      markSuperseded: async (id: string, byId: string) => {
        const found = gradesStore.find((g) => g.id === id);
        if (found) found.supersededBy = byId;
      },
      listForUserInSection: async () => [],
    };

    const enforcement: GradingEnforcement = {
      policy: createRolePolicy(),
      submissions: {
        locate: async (subId) => ({ sectionId: 'sec-1', userId: 'student-1' }),
      },
      repos: {
        users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
        courses: { findCourse: async (id) => (id === 'crs-1' ? course : null), findSection: async (id) => (id === 'sec-1' ? section : null), listSections: async () => [section] },
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
    };

    const service = new GradingService(gradesRepo, undefined, enforcement);
    return { service, gradesStore };
  }

  it('allows staff to record group grade and requires actor', async () => {
    const { service } = buildEnforcedWorld();
    await expect(
      service.recordGroupGrade('sub-1', ['student-1'], 90, 100, 'inst-1', {}, as('inst-1')),
    ).resolves.toHaveLength(1);

    await expect(
      service.recordGroupGrade('sub-1', ['student-1'], 90, 100, 'inst-1'),
    ).rejects.toBeInstanceOf(ActorRequiredError);

    await expect(
      service.recordGroupGrade('sub-1', ['student-1'], 90, 100, 'student-1', {}, as('student-1')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
