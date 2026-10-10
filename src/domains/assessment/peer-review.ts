import type {
  ActorContext,
  PermissionPolicy,
} from '../../core/permissions.js';
import {
  ActorRequiredError,
  PermissionDeniedError,
} from '../../core/permissions.js';
import { authorizeInSection, isStaff } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import type { ContentRepository } from '../../core/repositories.js';
import type {
  PeerReview,
  PeerReviewAssignment,
  PeerReviewRepository,
  RubricEvaluationRepository,
  RubricRepository,
  Submission,
} from './types.js';
import {
  PeerReviewAssignmentError,
  PeerReviewNotFoundError,
} from './types.js';
import { scoreRubric } from './rubrics.js';

export type PeerReviewServiceRepos = AuthorizationRepos & {
  peerReviews: PeerReviewRepository;
  submissions: {
    findById(id: string): Promise<Submission | null>;
    listByContent(contentId: string): Promise<Submission[]>;
  };
  content?: Pick<ContentRepository, 'findById'>;
  rubrics?: RubricRepository;
  evaluations?: RubricEvaluationRepository;
};

export interface PeerReviewServiceOptions {
  policy?: PermissionPolicy;
}

export interface AssignPeerReviewsOptions {
  reviewsPerStudent?: number;
}

export interface SubmitPeerReviewParams {
  assignmentId: string;
  comments?: string;
  rubricScores?: Record<string, number>;
}

export interface ListSubmissionReviewsOptions {
  anonymous?: boolean;
}

export class PeerReviewService {
  constructor(
    private readonly repos: PeerReviewServiceRepos,
    private readonly options?: PeerReviewServiceOptions,
  ) {}

  async assignPeerReviews(
    contentId: string,
    options?: AssignPeerReviewsOptions,
    actor?: ActorContext,
  ): Promise<PeerReviewAssignment[]> {
    const policy = this.options?.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('assessment.assignPeerReviews');
      }
      const node = this.repos.content?.findById
        ? await this.repos.content.findById(contentId)
        : null;
      await authorizeInSection(policy, this.repos, 'assessment.assignPeerReviews', actor, {
        sectionId: node?.sectionId,
      });
    }

    const reviewsPerStudent = options?.reviewsPerStudent ?? 1;
    if (reviewsPerStudent < 1) {
      throw new PeerReviewAssignmentError('reviewsPerStudent must be at least 1');
    }

    const submissions = await this.repos.submissions.listByContent(contentId);

    // Group by student and keep their latest submission
    const latestByStudent = new Map<string, Submission>();
    for (const sub of submissions) {
      const existing = latestByStudent.get(sub.userId);
      if (!existing || sub.submittedAt.getTime() > existing.submittedAt.getTime()) {
        latestByStudent.set(sub.userId, sub);
      }
    }

    const distinctAuthors = Array.from(latestByStudent.keys());
    if (distinctAuthors.length < 2) {
      throw new PeerReviewAssignmentError(
        'At least 2 distinct submitters are required to assign peer reviews',
      );
    }

    if (reviewsPerStudent >= distinctAuthors.length) {
      throw new PeerReviewAssignmentError(
        `reviewsPerStudent (${reviewsPerStudent}) cannot be greater than or equal to the number of submitters (${distinctAuthors.length})`,
      );
    }

    // Distribute using cyclic shift offset
    const assignments: Omit<PeerReviewAssignment, 'id'>[] = [];
    const now = new Date();
    const n = distinctAuthors.length;

    for (let step = 1; step <= reviewsPerStudent; step++) {
      for (let i = 0; i < n; i++) {
        const reviewerId = distinctAuthors[i]!;
        const targetAuthorId = distinctAuthors[(i + step) % n]!;
        const targetSubmission = latestByStudent.get(targetAuthorId)!;

        assignments.push({
          contentId,
          submissionId: targetSubmission.id,
          reviewerUserId: reviewerId,
          authorUserId: targetAuthorId,
          assignedAt: now,
        });
      }
    }

    return this.repos.peerReviews.createAssignments(assignments);
  }

  async getAssignedReviews(
    reviewerUserId: string,
    options?: { contentId?: string },
    actor?: ActorContext,
  ): Promise<PeerReviewAssignment[]> {
    const policy = this.options?.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      let sectionId: string | undefined;
      if (options?.contentId && this.repos.content?.findById) {
        const node = await this.repos.content.findById(options.contentId);
        sectionId = node?.sectionId;
      }
      const auth = await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId,
      });
      const staff = isStaff(auth.ctx);
      if (!staff && actor.actorId !== reviewerUserId) {
        throw new PermissionDeniedError('content.view');
      }
    }

    return this.repos.peerReviews.findAssignmentsForReviewer(
      reviewerUserId,
      options?.contentId,
    );
  }

  async submitPeerReview(
    params: SubmitPeerReviewParams,
    actor?: ActorContext,
  ): Promise<PeerReview> {
    const assignment = await this.repos.peerReviews.findAssignmentById(params.assignmentId);
    if (!assignment) {
      throw new PeerReviewNotFoundError(params.assignmentId);
    }

    const policy = this.options?.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('assessment.submitPeerReview');
      }
      let sectionId: string | undefined;
      if (this.repos.content?.findById) {
        const node = await this.repos.content.findById(assignment.contentId);
        sectionId = node?.sectionId;
      }
      await authorizeInSection(policy, this.repos, 'assessment.submitPeerReview', actor, {
        sectionId,
        ownerId: assignment.reviewerUserId,
      });
    }

    const existingReview = await this.repos.peerReviews.findReviewByAssignmentId(params.assignmentId);
    if (existingReview) {
      throw new PeerReviewAssignmentError(
        'Peer review has already been submitted for this assignment',
      );
    }

    let rubricEvaluationId: string | undefined;
    if (params.rubricScores && this.repos.rubrics && this.repos.evaluations) {
      const rubric = await this.repos.rubrics.findByContentId(assignment.contentId);
      if (rubric) {
        const score = scoreRubric(rubric, params.rubricScores);
        const evalRecord = await this.repos.evaluations.create({
          rubricId: rubric.id,
          contentId: assignment.contentId,
          submissionId: assignment.submissionId,
          evaluatorId: assignment.reviewerUserId,
          criterionScores: score.criterionScores,
          totalScore: score.totalScore,
          evaluatedAt: new Date(),
          ...(params.comments !== undefined ? { feedback: params.comments } : {}),
        });
        rubricEvaluationId = evalRecord.id;
      }
    }

    const now = new Date();
    const review = await this.repos.peerReviews.createReview({
      assignmentId: assignment.id,
      submissionId: assignment.submissionId,
      reviewerUserId: assignment.reviewerUserId,
      ...(params.comments !== undefined ? { comments: params.comments } : {}),
      ...(rubricEvaluationId !== undefined ? { rubricEvaluationId } : {}),
      submittedAt: now,
    });

    await this.repos.peerReviews.markAssignmentCompleted(assignment.id, now);

    return review;
  }

  async listReviewsForSubmission(
    submissionId: string,
    options?: ListSubmissionReviewsOptions,
    actor?: ActorContext,
  ): Promise<PeerReview[]> {
    const submission = await this.repos.submissions.findById(submissionId);
    const policy = this.options?.policy;

    let isReviewingStaff = false;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      let sectionId: string | undefined;
      if (submission && this.repos.content?.findById) {
        const node = await this.repos.content.findById(submission.contentId);
        sectionId = node?.sectionId;
      }
      const auth = await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId,
        ownerId: submission?.userId,
      });

      isReviewingStaff = isStaff(auth.ctx);
      if (!isReviewingStaff && submission && submission.userId !== actor.actorId) {
        throw new PermissionDeniedError('content.view');
      }
    }

    const reviews = await this.repos.peerReviews.findReviewsForSubmission(submissionId);

    // Apply anonymous masking: if anonymous is requested and viewer is not staff, mask reviewer id
    if (options?.anonymous && !isReviewingStaff) {
      return reviews.map((r) => ({
        ...r,
        reviewerUserId: 'anonymous',
      }));
    }

    return reviews;
  }
}
