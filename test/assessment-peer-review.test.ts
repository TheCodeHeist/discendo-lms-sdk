import { describe, it, expect } from 'bun:test';
import {
  PeerReviewService,
  PeerReviewAssignmentError,
  PeerReviewNotFoundError,
  RubricService,
} from '../src/domains/assessment/index.js';
import type {
  PeerReviewAssignment,
  PeerReview,
  PeerReviewRepository,
  Submission,
  RubricRepository,
  RubricEvaluationRepository,
  RubricEvaluation,
  Rubric,
  Criterion,
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
  CourseSection,
  Enrollment,
  Identity,
} from '../src/core/index.js';

const as = (actorId: string): ActorContext => ({ actorId });

describe('PeerReviewService - Distribution Logic', () => {
  function buildTestService(submissions: Submission[]) {
    const assignmentsStore: PeerReviewAssignment[] = [];
    const reviewsStore: PeerReview[] = [];

    const peerReviewsRepo: PeerReviewRepository = {
      createAssignments: async (assignments) => {
        const created = assignments.map((a, idx) => ({
          ...a,
          id: `asg-${assignmentsStore.length + idx + 1}`,
        }));
        assignmentsStore.push(...created);
        return created;
      },
      findAssignmentsForReviewer: async (reviewerId, contentId) =>
        assignmentsStore.filter(
          (a) => a.reviewerUserId === reviewerId && (!contentId || a.contentId === contentId),
        ),
      findAssignmentsForSubmission: async (subId) =>
        assignmentsStore.filter((a) => a.submissionId === subId),
      findAssignmentById: async (id) => assignmentsStore.find((a) => a.id === id) ?? null,
      markAssignmentCompleted: async (id, completedAt) => {
        const found = assignmentsStore.find((a) => a.id === id);
        if (found) found.completedAt = completedAt;
      },
      createReview: async (review) => {
        const created: PeerReview = { ...review, id: `rev-${reviewsStore.length + 1}` };
        reviewsStore.push(created);
        return created;
      },
      findReviewsForSubmission: async (subId) =>
        reviewsStore.filter((r) => r.submissionId === subId),
      findReviewByAssignmentId: async (asgId) =>
        reviewsStore.find((r) => r.assignmentId === asgId) ?? null,
    };

    const service = new PeerReviewService({
      peerReviews: peerReviewsRepo,
      submissions: {
        findById: async (id) => submissions.find((s) => s.id === id) ?? null,
        listByContent: async (cid) => submissions.filter((s) => s.contentId === cid),
      },
      users: { findById: async () => null, findByExternalRef: async () => null },
      courses: { findCourse: async () => null, findSection: async () => null, listSections: async () => [] },
      enrollments: { create: async () => ({} as never), findById: async () => null, update: async () => ({} as never), findByUserAndSection: async () => null, listBySection: async () => [], countActive: async () => 0 },
      guardianLinks: { findActive: async () => null },
      delegations: { create: async () => ({} as never), findById: async () => null, listActiveForEnrollment: async () => [], revoke: async () => ({} as never) },
    });

    return { service, assignmentsStore, reviewsStore };
  }

  it('refuses assignment when fewer than 2 distinct submitters exist', async () => {
    const subs: Submission[] = [
      { id: 'sub-1', contentId: 'c1', userId: 'user-1', payload: { kind: 'text', content: 'hi' }, submittedAt: new Date(), attemptNumber: 1 },
    ];
    const { service } = buildTestService(subs);
    await expect(service.assignPeerReviews('c1')).rejects.toThrow('At least 2 distinct submitters are required to assign peer reviews');
  });

  it('refuses assignment when reviewsPerStudent is less than 1', async () => {
    const subs: Submission[] = [
      { id: 'sub-1', contentId: 'c1', userId: 'user-1', payload: { kind: 'text', content: '1' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 'sub-2', contentId: 'c1', userId: 'user-2', payload: { kind: 'text', content: '2' }, submittedAt: new Date(), attemptNumber: 1 },
    ];
    const { service } = buildTestService(subs);
    await expect(service.assignPeerReviews('c1', { reviewsPerStudent: 0 })).rejects.toThrow(PeerReviewAssignmentError);
  });

  it('refuses assignment when reviewsPerStudent is greater than or equal to number of submitters', async () => {
    const subs: Submission[] = [
      { id: 'sub-1', contentId: 'c1', userId: 'user-1', payload: { kind: 'text', content: '1' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 'sub-2', contentId: 'c1', userId: 'user-2', payload: { kind: 'text', content: '2' }, submittedAt: new Date(), attemptNumber: 1 },
    ];
    const { service } = buildTestService(subs);
    await expect(service.assignPeerReviews('c1', { reviewsPerStudent: 2 })).rejects.toThrow(PeerReviewAssignmentError);
  });

  it('distributes 1 review per student with no self-assignments', async () => {
    const subs: Submission[] = [
      { id: 's1', contentId: 'c1', userId: 'u1', payload: { kind: 'text', content: '1' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 's2', contentId: 'c1', userId: 'u2', payload: { kind: 'text', content: '2' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 's3', contentId: 'c1', userId: 'u3', payload: { kind: 'text', content: '3' }, submittedAt: new Date(), attemptNumber: 1 },
    ];
    const { service } = buildTestService(subs);
    const assigned = await service.assignPeerReviews('c1', { reviewsPerStudent: 1 });
    expect(assigned).toHaveLength(3);

    for (const a of assigned) {
      expect(a.reviewerUserId).not.toBe(a.authorUserId);
    }

    // Each user is reviewer exactly once
    const reviewers = assigned.map((a) => a.reviewerUserId);
    expect(new Set(reviewers).size).toBe(3);

    // Each submission is assigned exactly once
    const authors = assigned.map((a) => a.authorUserId);
    expect(new Set(authors).size).toBe(3);
  });

  it('distributes 2 reviews per student among 4 submitters', async () => {
    const subs: Submission[] = [
      { id: 's1', contentId: 'c1', userId: 'u1', payload: { kind: 'text', content: '1' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 's2', contentId: 'c1', userId: 'u2', payload: { kind: 'text', content: '2' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 's3', contentId: 'c1', userId: 'u3', payload: { kind: 'text', content: '3' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 's4', contentId: 'c1', userId: 'u4', payload: { kind: 'text', content: '4' }, submittedAt: new Date(), attemptNumber: 1 },
    ];
    const { service } = buildTestService(subs);
    const assigned = await service.assignPeerReviews('c1', { reviewsPerStudent: 2 });
    expect(assigned).toHaveLength(8);

    for (const a of assigned) {
      expect(a.reviewerUserId).not.toBe(a.authorUserId);
    }

    // Each user has 2 distinct assignments to review
    for (const u of ['u1', 'u2', 'u3', 'u4']) {
      const userReviews = assigned.filter((a) => a.reviewerUserId === u);
      expect(userReviews).toHaveLength(2);
      expect(userReviews[0]!.authorUserId).not.toBe(userReviews[1]!.authorUserId);
    }
  });

  it('uses the latest attempt when a student submitted multiple times', async () => {
    const subs: Submission[] = [
      { id: 's1-old', contentId: 'c1', userId: 'u1', payload: { kind: 'text', content: 'old' }, submittedAt: new Date(1000), attemptNumber: 1 },
      { id: 's1-new', contentId: 'c1', userId: 'u1', payload: { kind: 'text', content: 'new' }, submittedAt: new Date(2000), attemptNumber: 2 },
      { id: 's2', contentId: 'c1', userId: 'u2', payload: { kind: 'text', content: '2' }, submittedAt: new Date(1500), attemptNumber: 1 },
    ];
    const { service } = buildTestService(subs);
    const assigned = await service.assignPeerReviews('c1', { reviewsPerStudent: 1 });
    const u1Sub = assigned.find((a) => a.authorUserId === 'u1');
    expect(u1Sub?.submissionId).toBe('s1-new');
  });
});

describe('PeerReviewService (without enforcement)', () => {
  function buildService() {
    const assignmentsStore: PeerReviewAssignment[] = [
      {
        id: 'asg-1',
        contentId: 'c1',
        submissionId: 's-author',
        reviewerUserId: 'student-reviewer',
        authorUserId: 'student-author',
        assignedAt: new Date(),
      },
    ];
    const reviewsStore: PeerReview[] = [];
    const rubricsStore = new Map<string, Rubric>();
    const evalStore: RubricEvaluation[] = [];

    const rubricsRepo: RubricRepository = {
      save: async (r) => {
        const stored = { ...r, id: 'rub-1' };
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

    const peerReviewsRepo: PeerReviewRepository = {
      createAssignments: async (assignments) => {
        const created = assignments.map((a, idx) => ({ ...a, id: `asg-${idx + 1}` }));
        assignmentsStore.push(...created);
        return created;
      },
      findAssignmentsForReviewer: async (reviewerId, contentId) =>
        assignmentsStore.filter(
          (a) => a.reviewerUserId === reviewerId && (!contentId || a.contentId === contentId),
        ),
      findAssignmentsForSubmission: async (subId) =>
        assignmentsStore.filter((a) => a.submissionId === subId),
      findAssignmentById: async (id) => assignmentsStore.find((a) => a.id === id) ?? null,
      markAssignmentCompleted: async (id, completedAt) => {
        const found = assignmentsStore.find((a) => a.id === id);
        if (found) found.completedAt = completedAt;
      },
      createReview: async (review) => {
        const created: PeerReview = { ...review, id: `rev-${reviewsStore.length + 1}` };
        reviewsStore.push(created);
        return created;
      },
      findReviewsForSubmission: async (subId) =>
        reviewsStore.filter((r) => r.submissionId === subId),
      findReviewByAssignmentId: async (asgId) =>
        reviewsStore.find((r) => r.assignmentId === asgId) ?? null,
    };

    const service = new PeerReviewService({
      peerReviews: peerReviewsRepo,
      submissions: {
        findById: async (id) =>
          id === 's-author'
            ? { id: 's-author', contentId: 'c1', userId: 'student-author', payload: { kind: 'text', content: 'essay' }, submittedAt: new Date(), attemptNumber: 1 }
            : null,
        listByContent: async () => [],
      },
      rubrics: rubricsRepo,
      evaluations: evalRepo,
      users: { findById: async () => null, findByExternalRef: async () => null },
      courses: { findCourse: async () => null, findSection: async () => null, listSections: async () => [] },
      enrollments: { create: async () => ({} as never), findById: async () => null, update: async () => ({} as never), findByUserAndSection: async () => null, listBySection: async () => [], countActive: async () => 0 },
      guardianLinks: { findActive: async () => null },
      delegations: { create: async () => ({} as never), findById: async () => null, listActiveForEnrollment: async () => [], revoke: async () => ({} as never) },
    });

    return { service, assignmentsStore, reviewsStore, rubricsRepo };
  }

  it('submits a peer review and marks assignment completed', async () => {
    const { service, assignmentsStore } = buildService();
    const review = await service.submitPeerReview({
      assignmentId: 'asg-1',
      comments: 'Well structured and clear argument!',
    });

    expect(review.assignmentId).toBe('asg-1');
    expect(review.comments).toBe('Well structured and clear argument!');
    expect(review.reviewerUserId).toBe('student-reviewer');
    expect(assignmentsStore[0]!.completedAt).toBeDefined();
  });

  it('refuses duplicate review submissions for the same assignment', async () => {
    const { service } = buildService();
    await service.submitPeerReview({ assignmentId: 'asg-1', comments: 'First' });
    await expect(
      service.submitPeerReview({ assignmentId: 'asg-1', comments: 'Second' }),
    ).rejects.toThrow(PeerReviewAssignmentError);
  });

  it('throws PeerReviewNotFoundError for non-existent assignment id', async () => {
    const { service } = buildService();
    await expect(
      service.submitPeerReview({ assignmentId: 'non-existent', comments: 'None' }),
    ).rejects.toThrow(PeerReviewNotFoundError);
  });

  it('submits a peer review with rubric scores when rubric is available', async () => {
    const { service, rubricsRepo } = buildService();
    await rubricsRepo.save({
      contentId: 'c1',
      criteria: [{ id: 'crit-1', description: 'Logic', maxPoints: 10 }],
    });

    const review = await service.submitPeerReview({
      assignmentId: 'asg-1',
      comments: 'Great logic',
      rubricScores: { 'crit-1': 9 },
    });

    expect(review.rubricEvaluationId).toBeDefined();
  });

  it('lists reviews for submission and masks reviewer when anonymous is requested', async () => {
    const { service } = buildService();
    await service.submitPeerReview({
      assignmentId: 'asg-1',
      comments: 'Constructive review',
    });

    const identified = await service.listReviewsForSubmission('s-author');
    expect(identified).toHaveLength(1);
    expect(identified[0]!.reviewerUserId).toBe('student-reviewer');

    const anonymous = await service.listReviewsForSubmission('s-author', { anonymous: true });
    expect(anonymous).toHaveLength(1);
    expect(anonymous[0]!.reviewerUserId).toBe('anonymous');
  });
});

describe('PeerReviewService (with permission enforcement)', () => {
  function buildEnforcedWorld() {
    const users = new Map<string, Identity>([
      ['admin-1', { id: 'admin-1', roles: ['admin'], orgId: 'org-1' }],
      ['inst-1', { id: 'inst-1', roles: ['instructor'], orgId: 'org-1' }],
      ['ta-1', { id: 'ta-1', roles: ['ta'], orgId: 'org-1' }],
      ['student-1', { id: 'student-1', roles: ['student'], orgId: 'org-1' }],
      ['student-2', { id: 'student-2', roles: ['student'], orgId: 'org-1' }],
      ['student-3', { id: 'student-3', roles: ['student'], orgId: 'org-1' }],
    ]);

    const section: CourseSection = { id: 'sec-1', courseId: 'crs-1', status: 'published' };
    const course: Course = { id: 'crs-1', title: 'Course 1', orgId: 'org-1' };

    const nodes = new Map<string, ContentNode>([
      ['c1', { id: 'c1', sectionId: 'sec-1', kind: 'assignment', title: 'Peer Assignment', orderIndex: 0, published: true, version: 1 }],
    ]);

    const enrollments: Enrollment[] = [
      { id: 'e1', userId: 'inst-1', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() },
      { id: 'e2', userId: 'ta-1', sectionId: 'sec-1', role: 'ta', status: 'active', enrolledAt: new Date() },
      { id: 'e3', userId: 'student-1', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
      { id: 'e4', userId: 'student-2', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
      { id: 'e5', userId: 'student-3', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
    ];

    const submissionsStore: Submission[] = [
      { id: 'sub-s1', contentId: 'c1', userId: 'student-1', payload: { kind: 'text', content: '1' }, submittedAt: new Date(), attemptNumber: 1 },
      { id: 'sub-s2', contentId: 'c1', userId: 'student-2', payload: { kind: 'text', content: '2' }, submittedAt: new Date(), attemptNumber: 1 },
    ];

    const assignmentsStore: PeerReviewAssignment[] = [
      {
        id: 'asg-1',
        contentId: 'c1',
        submissionId: 'sub-s1',
        reviewerUserId: 'student-2',
        authorUserId: 'student-1',
        assignedAt: new Date(),
      },
    ];

    const reviewsStore: PeerReview[] = [];

    const peerReviewsRepo: PeerReviewRepository = {
      createAssignments: async (assignments) => {
        const created = assignments.map((a, idx) => ({ ...a, id: `asg-${assignmentsStore.length + idx + 1}` }));
        assignmentsStore.push(...created);
        return created;
      },
      findAssignmentsForReviewer: async (reviewerId, contentId) =>
        assignmentsStore.filter(
          (a) => a.reviewerUserId === reviewerId && (!contentId || a.contentId === contentId),
        ),
      findAssignmentsForSubmission: async (subId) =>
        assignmentsStore.filter((a) => a.submissionId === subId),
      findAssignmentById: async (id) => assignmentsStore.find((a) => a.id === id) ?? null,
      markAssignmentCompleted: async (id, completedAt) => {
        const found = assignmentsStore.find((a) => a.id === id);
        if (found) found.completedAt = completedAt;
      },
      createReview: async (review) => {
        const created: PeerReview = { ...review, id: `rev-${reviewsStore.length + 1}` };
        reviewsStore.push(created);
        return created;
      },
      findReviewsForSubmission: async (subId) =>
        reviewsStore.filter((r) => r.submissionId === subId),
      findReviewByAssignmentId: async (asgId) =>
        reviewsStore.find((r) => r.assignmentId === asgId) ?? null,
    };

    const service = new PeerReviewService(
      {
        peerReviews: peerReviewsRepo,
        submissions: {
          findById: async (id) => submissionsStore.find((s) => s.id === id) ?? null,
          listByContent: async (cid) => submissionsStore.filter((s) => s.contentId === cid),
        },
        content: { findById: async (id) => nodes.get(id) ?? null },
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

    return { service, assignmentsStore };
  }

  it('requires an actor on every enforced call', async () => {
    const { service } = buildEnforcedWorld();
    await expect(service.assignPeerReviews('c1')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'assessment.assignPeerReviews',
    });
    await expect(service.getAssignedReviews('student-2')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'content.view',
    });
    await expect(
      service.submitPeerReview({ assignmentId: 'asg-1', comments: 'Good' }),
    ).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'assessment.submitPeerReview',
    });
    await expect(service.listReviewsForSubmission('sub-s1')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'content.view',
    });
  });

  it('allows admin and instructor to assign peer reviews, refusing TA and student', async () => {
    const { service } = buildEnforcedWorld();
    await expect(service.assignPeerReviews('c1', {}, as('inst-1'))).resolves.toBeDefined();
    await expect(service.assignPeerReviews('c1', {}, as('admin-1'))).resolves.toBeDefined();

    await expect(service.assignPeerReviews('c1', {}, as('ta-1'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'assessment.assignPeerReviews',
    });
    await expect(service.assignPeerReviews('c1', {}, as('student-1'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'assessment.assignPeerReviews',
    });
  });

  it('allows assigned reviewer to submit review, refusing other students', async () => {
    const { service } = buildEnforcedWorld();
    // student-2 is the assigned reviewer on asg-1
    await expect(
      service.submitPeerReview({ assignmentId: 'asg-1', comments: 'Good work!' }, as('student-2')),
    ).resolves.toMatchObject({ reviewerUserId: 'student-2' });

    // student-3 tries to submit on student-2's assignment
    await expect(
      service.submitPeerReview({ assignmentId: 'asg-1', comments: 'Hacked' }, as('student-3')),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'assessment.submitPeerReview',
    });
  });

  it('lets staff and submission author view reviews, refusing unrelated classmates', async () => {
    const { service } = buildEnforcedWorld();
    await service.submitPeerReview({ assignmentId: 'asg-1', comments: 'Great' }, as('student-2'));

    // Instructor can view
    const staffViews = await service.listReviewsForSubmission('sub-s1', { anonymous: true }, as('inst-1'));
    expect(staffViews).toHaveLength(1);
    expect(staffViews[0]!.reviewerUserId).toBe('student-2'); // staff sees real reviewer even when anonymous

    // Author (student-1) can view (anonymous masking applied)
    const authorViews = await service.listReviewsForSubmission('sub-s1', { anonymous: true }, as('student-1'));
    expect(authorViews).toHaveLength(1);
    expect(authorViews[0]!.reviewerUserId).toBe('anonymous');

    // Unrelated classmate (student-3) cannot view
    await expect(
      service.listReviewsForSubmission('sub-s1', {}, as('student-3')),
    ).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'content.view',
    });
  });
});
