import type { EventBus } from '../../core/events.js';
import type { RepositoryContext } from '../../core/repositories.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError, activeSectionRole } from '../../core/permissions.js';
import { authorizeInSection, isStaff } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import type {
  Submission,
  SubmissionPayload,
  QuizQuestion,
  QuizAttempt,
  QuizAttemptClose,
  QuizQuestionView,
  QuizResult,
  QuizResultOptions,
  QuizTimingOptions,
  SubmitQuizOptions,
  AssessmentOptions,
  PlagiarismCheckHook,
} from './types.js';
import { AttemptClosedError, AttemptExpiredError, AttemptNotSubmittedError, InvalidAnswerError } from './types.js';
import { scoreQuiz } from './scoring.js';

export interface SubmissionRepository {
  create(sub: Omit<Submission, 'id'>): Promise<Submission>;
  countAttempts(contentId: string, userId: string): Promise<number>;
  /**
   * OPTIONAL, and strongly recommended: store the submission as the person's NEXT attempt, as ONE
   * atomic step (a transaction, a lock, a conditional insert). The repository assigns
   * `attemptNumber` (their existing attempts for this content, plus one), and if `maxAttempts` is
   * given and they already have that many, stores nothing and returns `null`. Without it the
   * service counts and then creates, so two simultaneous submissions can both pass a limit and can
   * share an attempt number. With it, a `null` is reported as "No attempts remaining".
   */
  createAttempt?(
    draft: Omit<Submission, 'id' | 'attemptNumber'>,
    maxAttempts?: number,
  ): Promise<Submission | null>;
}

export interface QuizRepository {
  getQuestions(quizId: string): Promise<QuizQuestion[]>;
  createAttempt(attempt: Omit<QuizAttempt, 'id'>): Promise<QuizAttempt>;
  findAttempt(id: string): Promise<QuizAttempt | null>;
  /** This person's attempt of the quiz that has not been submitted (no `submittedAt`), newest first if several; or null. */
  findOpenAttempt(quizId: string, userId: string): Promise<QuizAttempt | null>;
  /**
   * Set `answers[questionId] = choiceIndex` on the attempt, keeping its other answers, **only if the
   * attempt exists and is still open**, and return the updated attempt; otherwise return `null`.
   * Do it as one step in the store (a JSON-path update, say), not read-modify-write, so two answers
   * saved at once do not lose each other.
   */
  saveAnswer(attemptId: string, questionId: string, choiceIndex: number): Promise<QuizAttempt | null>;
  /**
   * Close the attempt: set `submittedAt`, `score`, `maxScore` and `late` **only if it exists and is
   * still open**, as ONE atomic step (`UPDATE ... WHERE submittedAt IS NULL`), and return the
   * updated attempt, or `null` if nothing changed. This is what makes a double submit score once.
   */
  closeAttempt(attemptId: string, close: QuizAttemptClose): Promise<QuizAttempt | null>;
  /** Record bookkeeping on an attempt: the `submissionId` and `gradeEntryId` the service attaches. */
  updateAttempt(
    attemptId: string,
    patch: Partial<Pick<QuizAttempt, 'submissionId' | 'gradeEntryId'>>,
  ): Promise<QuizAttempt>;
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
    private readonly options: AssessmentOptions = {},
  ) {}

  /**
   * Records a submission. With enforcement on (`actor` required), only the student themselves
   * may submit (`assessment.submit`, own work only) and only to content that is published and
   * in a section where they are an active student. A `{ kind: 'none' }` payload is refused then:
   * staff record offline work with `recordOffline`. The permission check comes before the
   * attempt limit, so nobody learns how many attempts someone else has used.
   */
  async submit(
    contentId: string,
    userId: string,
    payload: SubmissionPayload,
    maxAttempts?: number,
    actor?: ActorContext,
  ): Promise<Submission> {
    const authorized = await this.authorizeOn('assessment.submit', actor, contentId, userId);
    // With enforcement, offline work is staff's to record (`recordOffline`), not a student's to
    // claim for themselves. Checked after authorization so a stranger still just hears "refused".
    if (authorized && payload.kind === 'none') {
      throw new Error('A "none" submission is recorded by staff with recordOffline, not submitted');
    }

    let submission: Submission;
    if (this.submissions.createAttempt) {
      // The repository checks the limit and numbers the attempt in one atomic step.
      const stored = await this.submissions.createAttempt(
        { contentId, userId, payload, submittedAt: new Date() },
        maxAttempts,
      );
      if (!stored) throw new Error('No attempts remaining');
      submission = stored;
    } else {
      const priorAttempts = await this.submissions.countAttempts(contentId, userId);
      if (maxAttempts !== undefined && priorAttempts >= maxAttempts) {
        throw new Error('No attempts remaining');
      }

      submission = await this.submissions.create({
        contentId,
        userId,
        payload,
        submittedAt: new Date(),
        attemptNumber: priorAttempts + 1,
      });
    }

    if (this.plagiarismHook) {
      // Fire-and-forget by design — don't block submission on a slow external check. A hook
      // that throws (synchronously) or rejects must never fail the already-stored submission
      // or surface as an unhandled rejection, so both are swallowed here. The hook owns its
      // own error reporting (see docs/ASSESSMENT.md).
      const hook = this.plagiarismHook;
      void Promise.resolve()
        .then(() => hook(submission))
        .catch(() => {});
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
   * Records work a student did offline, so it can be graded. Stores a `{ kind: 'none' }`
   * submission for the student, tagged with `recordedBy`, and numbers it after the attempts
   * already stored. With enforcement on (`actor` required) the actor needs
   * `assessment.recordOffline` (admins and instructors; a TA only if it was delegated to them),
   * and the student must currently be an *active student* of the content's section: a dropped,
   * waitlisted or completed student, or anyone who is not a student there, is refused exactly
   * like a forbidden call. Not limited by `maxAttempts`, it starts no plagiarism check and emits
   * no event (events are added in one round, later).
   */
  async recordOffline(contentId: string, userId: string, actor?: ActorContext): Promise<Submission> {
    const authorized = await this.authorizeOn('assessment.recordOffline', actor, contentId, userId);
    if (authorized) {
      const membership = await this.enforcement!.repos.enrollments.findByUserAndSection(userId, authorized.sectionId);
      if (activeSectionRole(membership) !== 'student') throw new PermissionDeniedError('assessment.recordOffline');
    }
    const recordedBy = actor ? { recordedBy: actor.actorId } : {};
    if (this.submissions.createAttempt) {
      // Numbered by the repository in one atomic step (no limit: staff are not capped by maxAttempts).
      const stored = await this.submissions.createAttempt(
        { contentId, userId, payload: { kind: 'none' }, submittedAt: new Date(), ...recordedBy },
        undefined,
      );
      // With no limit given the repository has no reason to return null; if it does, say so loudly.
      if (!stored) throw new Error('The submission repository did not store the attempt');
      return stored;
    }
    const attemptNumber = (await this.submissions.countAttempts(contentId, userId)) + 1;
    return this.submissions.create({
      contentId,
      userId,
      payload: { kind: 'none' },
      submittedAt: new Date(),
      attemptNumber,
      ...recordedBy,
    });
  }

  /**
   * Generates a per-user quiz attempt, handling randomization at generation time. With
   * enforcement on, only the student themselves may start one (`assessment.startAttempt`),
   * on a published quiz of a section where they are an active student. If the student already has an
   * open attempt of this quiz, that one is returned instead of a new one; a new attempt can be started
   * once the last one is submitted (`randomize` only matters for a new attempt).
   */
  async generateAttempt(
    quizId: string,
    userId: string,
    randomize = true,
    actor?: ActorContext,
  ): Promise<QuizAttempt> {
    await this.authorizeOn('assessment.startAttempt', actor, quizId, userId);
    // An attempt that is still open is resumed, not duplicated: starting over is not a way to see the questions again.
    const open = await this.quizzes.findOpenAttempt(quizId, userId);
    if (open) return open;
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
   * The attempt's questions as the student sees them, in the attempt's own order, with no answer key
   * (`QuizQuestionView`) and with `selectedChoiceIndex` for whatever they have saved. A question
   * removed from the quiz since the attempt started is left out. Use this, never `getQuestions`, to
   * show a quiz to a student. With enforcement on, only the attempt's own student may ask
   * (`assessment.answerQuiz`); an unknown attempt is refused exactly like a forbidden one.
   */
  async getAttemptQuestions(attemptId: string, actor?: ActorContext): Promise<QuizQuestionView[]> {
    const attempt = await this.loadAttempt(attemptId, actor);
    await this.authorizeAttempt('assessment.answerQuiz', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);

    const byId = new Map((await this.quizzes.getQuestions(attempt.quizId)).map((q) => [q.id, q]));
    const views: QuizQuestionView[] = [];
    for (const id of attempt.questionOrder) {
      const q = byId.get(id);
      if (!q) continue;
      const selected = attempt.answers?.[id];
      views.push({
        id: q.id,
        prompt: q.prompt,
        choices: [...q.choices],
        ...(q.points !== undefined ? { points: q.points } : {}),
        ...(selected !== undefined ? { selectedChoiceIndex: selected } : {}),
      });
    }
    return views;
  }

  /**
   * Saves the student's choice for one question of an open attempt, replacing an earlier choice for
   * the same question. Call it as often as you like while they work, so nothing is lost if they stop
   * before submitting. The question must be part of the attempt (`InvalidAnswerError`) and
   * `choiceIndex` a whole number that is one of its choices. A submitted attempt throws
   * `AttemptClosedError`; after `options.timeLimitSeconds` it throws `AttemptExpiredError`. With
   * enforcement on, only the attempt's own student may answer (`assessment.answerQuiz`), on a
   * published quiz. Returns the updated attempt.
   */
  async saveAnswer(
    attemptId: string,
    questionId: string,
    choiceIndex: number,
    actor?: ActorContext,
    options: QuizTimingOptions = {},
  ): Promise<QuizAttempt> {
    const attempt = await this.loadAttempt(attemptId, actor);
    await this.authorizeAttempt('assessment.answerQuiz', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);
    const limit = checkedLimit(options.timeLimitSeconds);

    if (attempt.submittedAt !== undefined) throw new AttemptClosedError(attempt.id);
    if (isLate(attempt, limit)) throw new AttemptExpiredError(attempt.id);

    const question = attempt.questionOrder.includes(questionId)
      ? (await this.quizzes.getQuestions(attempt.quizId)).find((q) => q.id === questionId)
      : undefined;
    if (!question) throw new InvalidAnswerError('question-not-in-attempt');
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex >= question.choices.length) {
      throw new InvalidAnswerError('choice-out-of-range');
    }

    const saved = await this.quizzes.saveAnswer(attempt.id, questionId, choiceIndex);
    // Null means the attempt was submitted between our check and the write.
    if (!saved) throw new AttemptClosedError(attempt.id);
    return saved;
  }

  /**
   * Submits an attempt: scores the saved answers (`scoreQuiz`), closes it, stores a `Submission`
   * with payload `{ kind: 'quiz', attemptId }` for grading to attach to, emits
   * `assessment.quizSubmitted`, and, if `autoGrade` is on, records the score as a grade. Unanswered
   * questions score 0. Passing `timeLimitSeconds` flags a submission made after it as `late`; it is
   * still scored, from the answers saved in time. The result has no answer key unless
   * `revealAnswers` is true.
   *
   * It is **idempotent**: submitting again returns the same result and scores nothing twice. If it
   * throws after scoring (the submission or the grade could not be stored), the attempt IS
   * submitted and scored; calling it again finishes whatever is missing, once. With enforcement on,
   * only the attempt's own student may submit (`assessment.submitQuiz`), even over an administrator.
   */
  async submitAttempt(
    attemptId: string,
    actor?: ActorContext,
    options: SubmitQuizOptions = {},
  ): Promise<QuizResult> {
    const attempt = await this.loadAttempt(attemptId, actor);
    await this.authorizeAttempt('assessment.submitQuiz', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);
    const limit = checkedLimit(options.timeLimitSeconds);

    let current = attempt;
    if (attempt.submittedAt === undefined) {
      const questions = await this.quizzes.getQuestions(attempt.quizId);
      const scored = scoreQuiz(questions, attempt.answers ?? {}, attempt.questionOrder);
      const now = new Date();
      const closed = await this.quizzes.closeAttempt(attempt.id, {
        submittedAt: now,
        score: scored.score,
        maxScore: scored.maxScore,
        late: isLate(attempt, limit, now),
      });
      if (closed) {
        current = await this.finishAttempt(closed);
      } else {
        // Someone else submitted at the same moment; they finish the job, we report what they stored.
        current = (await this.quizzes.findAttempt(attempt.id)) ?? attempt;
      }
    } else if (this.needsFinishing(attempt)) {
      current = await this.finishAttempt(attempt);
    }
    return this.resultOf(current, options.revealAnswers === true);
  }

  /**
   * The outcome of a submitted attempt (`AttemptNotSubmittedError` before that). The student sees
   * their score; the per-question breakdown with the correct answers is included for staff of the
   * section and for admins, and for the student only when the host passes `revealAnswers: true`
   * (the SDK stores no quiz settings, so whether students may see the key is the host's call). With
   * enforcement on this is `assessment.viewAttempts`: staff, or the attempt's own student. Without it
   * the breakdown is included only when `revealAnswers` is true.
   */
  async getResult(attemptId: string, actor?: ActorContext, options: QuizResultOptions = {}): Promise<QuizResult> {
    const attempt = await this.loadAttempt(attemptId, actor);
    const auth = await this.authorizeAttempt('assessment.viewAttempts', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);
    if (attempt.submittedAt === undefined) throw new AttemptNotSubmittedError(attempt.id);
    return this.resultOf(attempt, options.revealAnswers === true || auth?.staff === true);
  }

  /** Stores the quiz submission and the automatic grade, each only if it is not there yet. */
  private async finishAttempt(attempt: QuizAttempt): Promise<QuizAttempt> {
    let current = attempt;
    if (current.submissionId === undefined) {
      const submission = await this.storeQuizSubmission(current);
      current = await this.quizzes.updateAttempt(current.id, { submissionId: submission.id });
      void this.events?.emit({
        type: 'assessment.quizSubmitted',
        attemptId: current.id,
        quizId: current.quizId,
        submissionId: submission.id,
        userId: current.userId,
        score: current.score!,
        maxScore: current.maxScore!,
        late: current.late === true,
      });
    }
    const auto = this.options.autoGrade;
    // A quiz worth nothing has no grade to record (grades need a maximum above zero).
    if (auto && current.gradeEntryId === undefined && current.maxScore! > 0) {
      const entry = await auto.grading.recordSystemGrade(
        current.submissionId!,
        current.userId,
        current.score!,
        current.maxScore!,
        auto.source ?? 'system:quiz',
      );
      current = await this.quizzes.updateAttempt(current.id, { gradeEntryId: entry.id });
    }
    return current;
  }

  private needsFinishing(attempt: QuizAttempt): boolean {
    if (attempt.submissionId === undefined) return true;
    return this.options.autoGrade !== undefined && attempt.gradeEntryId === undefined && attempt.maxScore! > 0;
  }

  private async storeQuizSubmission(attempt: QuizAttempt): Promise<Submission> {
    const draft = {
      contentId: attempt.quizId,
      userId: attempt.userId,
      payload: { kind: 'quiz', attemptId: attempt.id } as const,
      submittedAt: attempt.submittedAt!,
    };
    if (this.submissions.createAttempt) {
      const stored = await this.submissions.createAttempt(draft, undefined);
      if (!stored) throw new Error('The submission repository did not store the attempt');
      return stored;
    }
    const attemptNumber = (await this.submissions.countAttempts(attempt.quizId, attempt.userId)) + 1;
    return this.submissions.create({ ...draft, attemptNumber });
  }

  private async resultOf(attempt: QuizAttempt, withAnswers: boolean): Promise<QuizResult> {
    const result: QuizResult = {
      attemptId: attempt.id,
      quizId: attempt.quizId,
      userId: attempt.userId,
      score: attempt.score!,
      maxScore: attempt.maxScore!,
      submittedAt: attempt.submittedAt!,
      late: attempt.late === true,
      ...(attempt.submissionId !== undefined ? { submissionId: attempt.submissionId } : {}),
      ...(attempt.gradeEntryId !== undefined ? { gradeEntryId: attempt.gradeEntryId } : {}),
    };
    if (!withAnswers) return result;
    // The breakdown is worked out from the quiz as it is now; the score above is what was stored at submission.
    const questions = await this.quizzes.getQuestions(attempt.quizId);
    return { ...result, questions: scoreQuiz(questions, attempt.answers ?? {}, attempt.questionOrder).questions };
  }

  /** Without enforcement the attempt is simply looked up. With it, nothing is looked up before an actor is known. */
  private async loadAttempt(attemptId: string, actor: ActorContext | undefined): Promise<QuizAttempt | null> {
    if (this.enforcement && !actor) return null;
    return this.quizzes.findAttempt(attemptId);
  }

  /** The attempt's owner and quiz decide the check; an unknown attempt is refused like a forbidden one. */
  private authorizeAttempt(action: Action, actor: ActorContext | undefined, attempt: QuizAttempt | null) {
    return this.authorizeOn(action, actor, attempt?.quizId ?? '', attempt?.userId ?? '');
  }

  /**
   * A no-op without enforcement (returns undefined). With it: finds the section from the content node (an unknown
   * node is refused exactly like a forbidden one), asks the policy, and keeps anyone who is not
   * staff away from content that is not published yet.
   */
  private async authorizeOn(
    action: Action,
    actor: ActorContext | undefined,
    contentId: string,
    ownerId: string,
  ): Promise<{ sectionId: string; staff: boolean } | undefined> {
    const e = this.enforcement;
    if (!e) return undefined;
    // Only needed to find out which section this is about; skipped without an actor so the
    // caller gets "actor required" before anything about the content is looked up.
    const node = actor ? await e.repos.content.findById(contentId) : null;
    const auth = await authorizeInSection(e.policy, e.repos, action, actor, {
      sectionId: node?.sectionId,
      ownerId,
    });
    const staff = isStaff(auth.ctx);
    if (node && !node.published && !staff) throw new PermissionDeniedError(action);
    // authorizeInSection has already refused a missing node, so there is a section here.
    return { sectionId: node!.sectionId, staff };
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
}

function checkedLimit(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('timeLimitSeconds must be a finite number above zero');
  }
  return seconds;
}

function isLate(attempt: QuizAttempt, limitSeconds: number | undefined, now: Date = new Date()): boolean {
  return limitSeconds !== undefined && now.getTime() - attempt.startedAt.getTime() > limitSeconds * 1000;
}
