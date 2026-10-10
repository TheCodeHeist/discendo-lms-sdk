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
  Criterion,
  Rubric,
  RubricEvaluation,
  RubricEvaluationRepository,
  RubricRepository,
  RubricScore,
  Submission,
} from './types.js';
import type { SubmissionRepository } from './service.js';
import {
  InvalidRubricError,
  InvalidRubricScoreError,
  RubricNotFoundError,
} from './types.js';

export function scoreRubric(
  rubric: Rubric,
  criterionScores: Record<string, number>,
): RubricScore {
  const criteriaMap = new Map<string, Criterion>();
  for (const c of rubric.criteria) {
    criteriaMap.set(c.id, c);
  }

  // Verify all scored criteria exist in rubric
  for (const criterionId of Object.keys(criterionScores)) {
    if (!criteriaMap.has(criterionId)) {
      throw new InvalidRubricScoreError(
        `Scored criterion "${criterionId}" is not part of rubric "${rubric.id}"`,
      );
    }
  }

  let totalScore = 0;
  let maxScore = 0;
  const scoredCriteria: Record<string, number> = {};

  for (const criterion of rubric.criteria) {
    maxScore += criterion.maxPoints;
    const score = criterionScores[criterion.id];
    if (score !== undefined) {
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new InvalidRubricScoreError(
          `Score for criterion "${criterion.id}" must be a finite number`,
        );
      }
      if (score < 0) {
        throw new InvalidRubricScoreError(
          `Score for criterion "${criterion.id}" cannot be negative (got ${score})`,
        );
      }
      if (score > criterion.maxPoints) {
        throw new InvalidRubricScoreError(
          `Score for criterion "${criterion.id}" exceeds max points of ${criterion.maxPoints} (got ${score})`,
        );
      }
      scoredCriteria[criterion.id] = score;
      totalScore += score;
    } else {
      scoredCriteria[criterion.id] = 0;
    }
  }

  return {
    totalScore,
    maxScore,
    criterionScores: scoredCriteria,
  };
}

function validateRubricCriteria(criteria: Criterion[]): void {
  if (!criteria || criteria.length === 0) {
    throw new InvalidRubricError('A rubric must contain at least one criterion');
  }
  const seenIds = new Set<string>();
  for (const c of criteria) {
    if (!c.id || typeof c.id !== 'string') {
      throw new InvalidRubricError('Each criterion must have a valid non-empty id');
    }
    if (seenIds.has(c.id)) {
      throw new InvalidRubricError(`Duplicate criterion id: "${c.id}"`);
    }
    seenIds.add(c.id);
    if (typeof c.maxPoints !== 'number' || !Number.isFinite(c.maxPoints) || c.maxPoints <= 0) {
      throw new InvalidRubricError(
        `Criterion "${c.id}" maxPoints must be a positive number, got ${c.maxPoints}`,
      );
    }
    if (c.levels) {
      for (const level of c.levels) {
        if (typeof level.points !== 'number' || !Number.isFinite(level.points) || level.points < 0) {
          throw new InvalidRubricError(
            `Criterion "${c.id}" level points must be a non-negative number`,
          );
        }
      }
    }
  }
}

export type RubricServiceRepos = AuthorizationRepos & {
  rubrics: RubricRepository;
  evaluations: RubricEvaluationRepository;
  content?: Pick<ContentRepository, 'findById'>;
  submissions?: Pick<SubmissionRepository, 'countAttempts'> & {
    findById?(id: string): Promise<Submission | null>;
  };
};

export interface RubricServiceOptions {
  policy?: PermissionPolicy;
}

export interface EvaluateSubmissionParams {
  contentId: string;
  submissionId: string;
  scores: Record<string, number>;
  evaluatorId?: string;
  feedback?: string;
  criterionFeedback?: Record<string, string>;
}

export class RubricService {
  constructor(
    private readonly repos: RubricServiceRepos,
    private readonly options?: RubricServiceOptions,
  ) {}

  async saveRubric(
    contentId: string,
    criteria: Criterion[],
    titleOrActor?: string | ActorContext,
    actor?: ActorContext,
  ): Promise<Rubric> {
    const title = typeof titleOrActor === 'string' ? titleOrActor : undefined;
    const actualActor =
      typeof titleOrActor === 'object' && titleOrActor !== null && 'actorId' in titleOrActor
        ? titleOrActor
        : actor;

    validateRubricCriteria(criteria);

    const policy = this.options?.policy;
    if (policy) {
      if (!actualActor) {
        throw new ActorRequiredError('assessment.manageRubric');
      }
      const node = this.repos.content?.findById
        ? await this.repos.content.findById(contentId)
        : null;
      await authorizeInSection(policy, this.repos, 'assessment.manageRubric', actualActor, {
        sectionId: node?.sectionId,
      });
    }

    return this.repos.rubrics.save({
      contentId,
      criteria,
      ...(title !== undefined ? { title } : {}),
    });
  }

  async getRubric(
    contentId: string,
    actor?: ActorContext,
  ): Promise<Rubric | null> {
    const policy = this.options?.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      const node = this.repos.content?.findById
        ? await this.repos.content.findById(contentId)
        : null;
      const auth = await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId: node?.sectionId,
      });
      const staff = isStaff(auth.ctx);
      if (node && !node.published && !staff) {
        throw new PermissionDeniedError('content.view');
      }
    }

    return this.repos.rubrics.findByContentId(contentId);
  }

  async deleteRubric(
    contentId: string,
    actor?: ActorContext,
  ): Promise<boolean> {
    const policy = this.options?.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('assessment.manageRubric');
      }
      const node = this.repos.content?.findById
        ? await this.repos.content.findById(contentId)
        : null;
      await authorizeInSection(policy, this.repos, 'assessment.manageRubric', actor, {
        sectionId: node?.sectionId,
      });
    }
    return this.repos.rubrics.deleteByContentId(contentId);
  }

  async evaluateSubmission(
    params: EvaluateSubmissionParams,
    actor?: ActorContext,
  ): Promise<RubricEvaluation> {
    const policy = this.options?.policy;
    let actualEvaluatorId = params.evaluatorId;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('grading.record');
      }
      const node = this.repos.content?.findById
        ? await this.repos.content.findById(params.contentId)
        : null;
      const auth = await authorizeInSection(policy, this.repos, 'grading.record', actor, {
        sectionId: node?.sectionId,
      });
      actualEvaluatorId = auth.ctx.actor.id;
    }

    if (!actualEvaluatorId) {
      actualEvaluatorId = 'unknown';
    }

    const rubric = await this.repos.rubrics.findByContentId(params.contentId);
    if (!rubric) {
      throw new RubricNotFoundError(params.contentId);
    }

    const scored = scoreRubric(rubric, params.scores);

    const draft: Omit<RubricEvaluation, 'id'> = {
      rubricId: rubric.id,
      contentId: params.contentId,
      submissionId: params.submissionId,
      evaluatorId: actualEvaluatorId,
      criterionScores: scored.criterionScores,
      totalScore: scored.totalScore,
      evaluatedAt: new Date(),
      ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      ...(params.criterionFeedback !== undefined
        ? { criterionFeedback: params.criterionFeedback }
        : {}),
    };

    return this.repos.evaluations.create(draft);
  }

  async listEvaluations(
    submissionId: string,
    actor?: ActorContext,
  ): Promise<RubricEvaluation[]> {
    const policy = this.options?.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      let sectionId: string | undefined;
      let ownerId: string | undefined;
      if (this.repos.submissions?.findById) {
        const sub = await this.repos.submissions.findById(submissionId);
        if (sub) {
          ownerId = sub.userId;
          if (this.repos.content?.findById) {
            const node = await this.repos.content.findById(sub.contentId);
            sectionId = node?.sectionId;
          }
        }
      }
      const auth = await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId,
        ownerId,
      });
      const staff = isStaff(auth.ctx);
      if (!staff && ownerId !== undefined && ownerId !== actor.actorId) {
        throw new PermissionDeniedError('content.view');
      }
    }

    return this.repos.evaluations.findBySubmission(submissionId);
  }
}
