import type { EventBus } from '../../core/events.js';
import type { RepositoryContext } from '../../core/repositories.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError, effectiveRoles } from '../../core/permissions.js';
import { authorizeInSection } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import type {
  Submission,
  SubmissionPayload,
  QuizQuestion,
  QuizAttempt,
  PlagiarismCheckHook,
} from './types.js';

export interface SubmissionRepository {
  create(sub: Omit<Submission, 'id'>): Promise<Submission>;
  countAttempts(contentId: string, userId: string): Promise<number>;
}

export interface QuizRepository {
  getQuestions(quizId: string): Promise<QuizQuestion[]>;
  createAttempt(attempt: Omit<QuizAttempt, 'id'>): Promise<QuizAttempt>;
}

/**
 * Everything needed to turn permission enforcement on, bundled so none of it can be forgotten.
 * The section of every call comes from the content node itself (`repos.content`), never from
 * the caller, so for a quiz the `quizId` has to be the id of the quiz's content node.
 */
export interface AssessmentEnforcement {
  policy: PermissionPolicy;
  repos: AuthorizationRepos & Pick<RepositoryContext, 'content'>;
}

export class AssessmentService {
  constructor(
    private readonly submissions: SubmissionRepository,
    private readonly quizzes: QuizRepository,
    private readonly plagiarismHook?: PlagiarismCheckHook,
    private readonly events?: EventBus,
    /**
     * Turns on permission enforcement. Once set, every public method requires an `{ actorId }`
     * argument and refuses to run without one. Leave it unset and the service behaves as it
     * always has: no actor, no permission checks.
     */
    private readonly enforcement?: AssessmentEnforcement,
  ) {}

  /**
   * Records a submission. With enforcement on (`actor` required), only the student themselves
   * may submit (`assessment.submit`, own work only) and only to content that is published and
   * in a section where they are an active student. The permission check comes before the
   * attempt limit, so nobody learns how many attempts someone else has used.
   */
  async submit(
    contentId: string,
    userId: string,
    payload: SubmissionPayload,
    maxAttempts?: number,
    actor?: ActorContext,
  ): Promise<Submission> {
    await this.authorizeOn('assessment.submit', actor, contentId, userId);

    const priorAttempts = await this.submissions.countAttempts(contentId, userId);
    if (maxAttempts !== undefined && priorAttempts >= maxAttempts) {
      throw new Error('No attempts remaining');
    }

    const submission = await this.submissions.create({
      contentId,
      userId,
      payload,
      submittedAt: new Date(),
      attemptNumber: priorAttempts + 1,
    });

    if (this.plagiarismHook) {
      // Fire-and-forget by design — don't block submission on a slow external check.
      void this.plagiarismHook(submission);
    }

    // Fire-and-forget: a slow or failing listener must never delay or fail a submission.
    void this.events?.emit({
      type: 'assessment.submissionReceived',
      submissionId: submission.id,
      contentId: submission.contentId,
      userId: submission.userId,
      attemptNumber: submission.attemptNumber,
    });

    return submission;
  }

  /**
   * With enforcement on: a student may see their own count, staff (`assessment.viewAttempts`)
   * anyone's. Students only see content that is published.
   */
  async attemptsRemaining(
    contentId: string,
    userId: string,
    maxAttempts: number,
    actor?: ActorContext,
  ): Promise<number> {
    await this.authorizeOn('assessment.viewAttempts', actor, contentId, userId);
    const used = await this.submissions.countAttempts(contentId, userId);
    return Math.max(0, maxAttempts - used);
  }

  /**
   * Generates a per-user quiz attempt, handling randomization at generation time. With
   * enforcement on, only the student themselves may start one (`assessment.startAttempt`),
   * on a published quiz of a section where they are an active student.
   */
  async generateAttempt(
    quizId: string,
    userId: string,
    randomize = true,
    actor?: ActorContext,
  ): Promise<QuizAttempt> {
    await this.authorizeOn('assessment.startAttempt', actor, quizId, userId);
    const questions = await this.quizzes.getQuestions(quizId);
    const order = questions.map((q) => q.id);
    if (randomize) shuffle(order);

    return this.quizzes.createAttempt({
      quizId,
      userId,
      questionOrder: order,
      startedAt: new Date(),
    });
  }

  /**
   * A no-op without enforcement. With it: finds the section from the content node (an unknown
   * node is refused exactly like a forbidden one), asks the policy, and keeps anyone who is not
   * staff away from content that is not published yet.
   */
  private async authorizeOn(
    action: Action,
    actor: ActorContext | undefined,
    contentId: string,
    ownerId: string,
  ): Promise<void> {
    const e = this.enforcement;
    if (!e) return;
    // Only needed to find out which section this is about; skipped without an actor so the
    // caller gets "actor required" before anything about the content is looked up.
    const node = actor ? await e.repos.content.findById(contentId) : null;
    const auth = await authorizeInSection(e.policy, e.repos, action, actor, {
      sectionId: node?.sectionId,
      ownerId,
    });
    const isStaff = effectiveRoles(auth.ctx).some((r) => r === 'admin' || r === 'instructor' || r === 'ta');
    if (node && !node.published && !isStaff) throw new PermissionDeniedError(action);
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
}
