import { describe, it, expect } from 'bun:test';
import {
  AssessmentService,
} from '../src/domains/assessment/index.js';
import type {
  Submission,
  SubmissionRepository,
  QuizRepository,
} from '../src/domains/assessment/index.js';
import type {
  ActorContext,
  ContentNode,
  Course,
  CourseSection,
  Enrollment,
  GroupRepository,
  Identity,
  SectionGroup,
  GroupMember,
} from '../src/core/index.js';
import {
  createRolePolicy,
  PermissionDeniedError,
} from '../src/core/index.js';

const as = (actorId: string): ActorContext => ({ actorId });

describe('AssessmentService - Group Submissions', () => {
  function buildWorld(customMembers?: GroupMember[]) {
    const defaultMembers: GroupMember[] = [
      { id: 'gm-1', groupId: 'grp-1', userId: 'student-1', joinedAt: new Date() },
      { id: 'gm-other', groupId: 'grp-other', userId: 'student-1', joinedAt: new Date() },
    ];
    const groupMembers = customMembers ?? defaultMembers;
    const users = new Map<string, Identity>([
      ['student-1', { id: 'student-1', roles: ['student'], orgId: 'org-1' }],
      ['student-2', { id: 'student-2', roles: ['student'], orgId: 'org-1' }],
      ['student-outsider', { id: 'student-outsider', roles: ['student'], orgId: 'org-1' }],
    ]);

    const section: CourseSection = { id: 'sec-1', courseId: 'crs-1', status: 'published' };
    const course: Course = { id: 'crs-1', title: 'Course 1', orgId: 'org-1' };
    const node: ContentNode = {
      id: 'assign-group',
      sectionId: 'sec-1',
      kind: 'assignment',
      title: 'Group Project',
      orderIndex: 0,
      published: true,
      version: 1,
    };

    const enrollments: Enrollment[] = [
      { id: 'e1', userId: 'student-1', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
      { id: 'e2', userId: 'student-2', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
    ];

    const group: SectionGroup = { id: 'grp-1', sectionId: 'sec-1', name: 'Team Alpha' };
    const groupOtherSec: SectionGroup = { id: 'grp-other', sectionId: 'sec-other', name: 'Other Group' };


    const groupsRepo: GroupRepository = {
      create: async (g) => ({ ...g, id: 'grp-1' }),
      findById: async (id) => (id === 'grp-1' ? group : id === 'grp-other' ? groupOtherSec : null),
      listBySection: async () => [group],
      delete: async () => true,
      addMember: async (m) => ({ ...m, id: 'gm-1' }),
      removeMember: async () => true,
      listMembers: async () => groupMembers,
      findMember: async (gid, uid) => groupMembers.find((m) => m.groupId === gid && m.userId === uid) ?? null,
      listGroupsForUser: async () => [group],
    };

    const submissionsStore: Submission[] = [];
    const submissionsRepo: SubmissionRepository = {
      create: async (s) => {
        const stored: Submission = { ...s, id: `sub-${submissionsStore.length + 1}` };
        submissionsStore.push(stored);
        return stored;
      },
      countAttempts: async (cid, uid) => submissionsStore.filter((s) => s.contentId === cid && s.userId === uid).length,
      countGroupAttempts: async (cid, gid) => submissionsStore.filter((s) => s.contentId === cid && s.groupId === gid).length,
    };

    const quizzesRepo: QuizRepository = {
      getQuestions: async () => [],
      createAttempt: async (a) => ({ ...a, id: 'qa-1' }),
      findAttempt: async () => null,
      findOpenAttempt: async () => null,
      saveAnswer: async () => null,
      closeAttempt: async () => null,
      updateAttempt: async (id, p) => ({ id, quizId: 'q', userId: 'u', questionOrder: [], startedAt: new Date(), ...p }),
    };

    const service = new AssessmentService(
      submissionsRepo,
      quizzesRepo,
      undefined,
      undefined,
      {
        policy: createRolePolicy(),
        repos: {
          content: { findById: async (id) => (id === 'assign-group' ? node : null), listBySection: async () => [], create: async () => ({} as never), update: async () => ({} as never), reorder: async () => {} },
          groups: groupsRepo,
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
      },
    );

    return { service, submissionsStore };
  }

  it('allows a group member to submit work on behalf of the group', async () => {
    const { service } = buildWorld();
    const sub = await service.submit(
      'assign-group',
      'student-1',
      { kind: 'text', content: 'Our group project' },
      2,
      as('student-1'),
      { groupId: 'grp-1' },
    );

    expect(sub.id).toBe('sub-1');
    expect(sub.groupId).toBe('grp-1');
    expect(sub.userId).toBe('student-1');
    expect(sub.attemptNumber).toBe(1);
  });

  it('refuses submission if the actor is not a member of the group', async () => {
    const { service } = buildWorld();
    // student-outsider is not in grp-1
    await expect(
      service.submit(
        'assign-group',
        'student-outsider',
        { kind: 'text', content: 'Infiltrator' },
        2,
        as('student-outsider'),
        { groupId: 'grp-1' },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses submission if the enrolled student is not a member of the group', async () => {
    const { service } = buildWorld();
    // student-2 is enrolled in sec-1, but not in grp-1
    await expect(
      service.submit(
        'assign-group',
        'student-2',
        { kind: 'text', content: 'Not my group' },
        2,
        as('student-2'),
        { groupId: 'grp-1' },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses submission if the group belongs to a different section', async () => {
    const { service } = buildWorld();
    await expect(
      service.submit(
        'assign-group',
        'student-1',
        { kind: 'text', content: 'Wrong section' },
        2,
        as('student-1'),
        { groupId: 'grp-other' },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('counts attempts by group so a second member consumes the shared attempt', async () => {
    const { service } = buildWorld([
      { id: 'gm-1', groupId: 'grp-1', userId: 'student-1', joinedAt: new Date() },
      { id: 'gm-2', groupId: 'grp-1', userId: 'student-2', joinedAt: new Date() },
    ]);
    // Member 1 submits attempt 1
    await service.submit(
      'assign-group',
      'student-1',
      { kind: 'text', content: 'First try' },
      2,
      as('student-1'),
      { groupId: 'grp-1' },
    );

    // Member 2 submits attempt 2
    const sub2 = await service.submit(
      'assign-group',
      'student-2',
      { kind: 'text', content: 'Second try' },
      2,
      as('student-2'),
      { groupId: 'grp-1' },
    );
    expect(sub2.attemptNumber).toBe(2);

    // Group is capped at 2 attempts; attempt 3 is refused
    await expect(
      service.submit(
        'assign-group',
        'student-1',
        { kind: 'text', content: 'Third try' },
        2,
        as('student-1'),
        { groupId: 'grp-1' },
      ),
    ).rejects.toThrow('No attempts remaining');
  });
});
