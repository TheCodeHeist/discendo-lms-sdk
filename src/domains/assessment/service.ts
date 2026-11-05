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
  QuizAnswer,
} from './types.js';
import {
  AttemptClosedError,
  AttemptExpiredError,
  AttemptLimitReachedError,
  AttemptNotSubmittedError,
  InvalidAnswerError,
  InvalidManualScoreError,
  WrongContentKindError,
  questionTypeOf,
} from './types.js';
import { scoreQuiz } from './scoring.js';

export interface SubmissionRepository {
  create(sub: Omit<Submission, 'id'>): Promise<Submission>;
  countAttempts(contentId: string, userId: string): Promise<number>;
  countGroupAttempts?(contentId: string, groupId: string): Promise<number>;
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
   * Set `answers[questionId] = answer` on the attempt, keeping its other answers, **only if the
   * attempt exists and is still open**, and return the updated attempt; otherwise return `null`.
   * Do it as one step in the store (a JSON-path update, say), not read-modify-write, so two answers
   * saved at once do not lose each other. The answer is a `QuizAnswer`: a number, a list of
   * numbers, a boolean or a string, depending on the question's type (the service has already
   * checked it), so store it as JSON.
   */
  saveAnswer(attemptId: string, questionId: string, answer: QuizAnswer): Promise<QuizAttempt | null>;
  /**
   * Close the attempt: set `submittedAt`, `score`, `maxScore` and `late` **only if it exists and is
   * still open**, as ONE atomic step (`UPDATE ... WHERE submittedAt IS NULL`), and return the
   * updated attempt, or `null` if nothing changed. This is what makes a double submit score once.
   */
  closeAttempt(attemptId: string, close: QuizAttemptClose): Promise<QuizAttempt | null>;
  /**
   * OPTIONAL, and recommended if staff score questions by hand: set
   * `manualScores[questionId] = points`, keeping the other hand scores, **only if the attempt exists
   * and has been submitted**, as one step in the store; return the updated attempt, or `null`.
   * Without it the service reads the attempt and writes all of `manualScores` back through
   * `updateAttempt`, so two graders scoring different questions of one attempt at the same moment
   * can lose one of the scores.
   */
  saveManualScore?(attemptId: string, questionId: string, points: number): Promise<QuizAttempt | null>;
  /**
   * Record bookkeeping on an attempt: the `submissionId` and `gradeEntryId` the service attaches,
   * and, when staff score questions by hand, the new `score`, `maxScore`, `pendingReview` and
   * (without `saveManualScore`) `manualScores`. Merge the patch into the stored attempt.
   */
  updateAttempt(
    attemptId: string,
    patch: Partial<Pick<QuizAttempt, 'submissionId' | 'gradeEntryId' | 'score' | 'maxScore' | 'pendingReview' | 'manualScores'>>,
  ): Promise<QuizAttempt>;
}

/**
 * Everything needed to turn permission enforcement on, bundled so none of it can be forgotten.
 * The section of every call comes from the content node itself (`repos.content`), never from
 * the caller, so for a quiz the `quizId` has to be the id of the quiz's content node.
 */
export interface AssessmentEnforcement {
  policy: PermissionPolicy;
  repos: AuthorizationRepos & Pick<RepositoryContext, 'content' | 'groups'>;
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
    options?: { groupId?: string },
  ): Promise<Submission> {
    const authorized = await this.authorizeOn('assessment.submit', actor, contentId, userId);
    // With enforcement, offline work is staff's to record (`recordOffline`), not a student's to
    // claim for themselves. Checked after authorization so a stranger still just hears "refused".
    if (authorized && payload.kind === 'none') {
      throw new Error('A "none" submission is recorded by staff with recordOffline, not submitted');
    }

    if (authorized && options?.groupId) {
      const groupsRepo = this.enforcement?.repos.groups;
      if (!groupsRepo) {
        throw new Error('Group repository is required for group submissions');
      }
      const group = await groupsRepo.findById(options.groupId);
      if (!group || group.sectionId !== authorized.sectionId) {
        throw new PermissionDeniedError('assessment.submit');
      }
      const member = await groupsRepo.findMember(options.groupId, userId);
      if (!member) {
        throw new PermissionDeniedError('assessment.submit');
      }
    }

    let submission: Submission;
    const draft = {
      contentId,
      userId,
      payload,
      submittedAt: new Date(),
      ...(options?.groupId !== undefined ? { groupId: options.groupId } : {}),
    };

    if (this.submissions.createAttempt) {
      // The repository checks the limit and numbers the attempt in one atomic step.
      const stored = await this.submissions.createAttempt(draft, maxAttempts);
      if (!stored) throw new Error('No attempts remaining');
      submission = stored;
    } else {
      let priorAttempts: number;
      if (options?.groupId && this.submissions.countGroupAttempts) {
        priorAttempts = await this.submissions.countGroupAttempts(contentId, options.groupId);
      } else {
        priorAttempts = await this.submissions.countAttempts(contentId, userId);
      }

      if (maxAttempts !== undefined && priorAttempts >= maxAttempts) {
        throw new Error('No attempts remaining');
      }

      submission = await this.submissions.create({
        ...draft,
        attemptNumber: priorAttempts + 1,
      });
    }

    const orgId = authorized?.orgId;
    if (this.plagiarismHook) {
      const hook = this.plagiarismHook;
      void Promise.resolve()
        .then(() => hook(submission))
        .catch((error) => {
          void this.events?.emit({
            type: "assessment.plagiarismCheckFailed",
            submissionId: submission.id,
            contentId: submission.contentId,
            userId: submission.userId,
            error: error instanceof Error ? error.message : String(error),
            ...(orgId !== undefined ? { orgId } : {}),
          });
        });
    }

    // Fire-and-forget: a slow or failing listener must never delay or fail a submission.
    void this.events?.emit({
      type: "assessment.submissionReceived",
      submissionId: submission.id,
      contentId: submission.contentId,
      userId: submission.userId,
      attemptNumber: submission.attemptNumber,
      ...(orgId !== undefined ? { orgId } : {}),
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
    options?: { groupId?: string },
  ): Promise<number> {
    await this.authorizeOn('assessment.viewAttempts', actor, contentId, userId);
    let used: number;
    if (options?.groupId && this.submissions.countGroupAttempts) {
      used = await this.submissions.countGroupAttempts(contentId, options.groupId);
    } else {
      used = await this.submissions.countAttempts(contentId, userId);
    }
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
   *
   * `options.maxAttempts` limits how many attempts the student may submit: once they have submitted
   * that many, a new one is refused with `AttemptLimitReachedError` (an open attempt is still
   * resumed). With enforcement on, the content must be a `quiz` (`WrongContentKindError`).
   */
  async generateAttempt(
    quizId: string,
    userId: string,
    randomize = true,
    actor?: ActorContext,
    options: { maxAttempts?: number } = {},
  ): Promise<QuizAttempt> {
    const auth = await this.authorizeOn('assessment.startAttempt', actor, quizId, userId);
    if (auth && auth.kind !== 'quiz') throw new WrongContentKindError(quizId, 'quiz', auth.kind);
    const max = options.maxAttempts;
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new Error('maxAttempts must be a whole number from 1 up');
    // An attempt that is still open is resumed, not duplicated: starting over is not a way to see the questions again.
    const open = await this.quizzes.findOpenAttempt(quizId, userId);
    if (open) return open;
    // Each submitted attempt stored one quiz submission, so they are counted there.
    if (max !== undefined && (await this.submissions.countAttempts(quizId, userId)) >= max) {
      throw new AttemptLimitReachedError(quizId, max);
    }
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
   * (`QuizQuestionView`) and with `answer` for whatever they have saved. A question
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
      views.push(questionView(q, attempt.answers?.[id]));
    }
    return views;
  }

  /**
   * Saves the student's answer to one question of an open attempt, replacing an earlier answer to
   * the same question. Call it as often as you like while they work, so nothing is lost if they stop
   * before submitting. The question must be part of the attempt, and the answer must be the kind
   * its type takes (`InvalidAnswerError`, see `QuizAnswer`): a choice index that exists, a list of
   * distinct choice indexes, a boolean, a finite number, or text within the question's length
   * limit. A submitted attempt throws `AttemptClosedError`; after `options.timeLimitSeconds` it
   * throws `AttemptExpiredError`. With enforcement on, only the attempt's own student may answer
   * (`assessment.answerQuiz`), on a published quiz. Returns the updated attempt.
   */
  async saveAnswer(
    attemptId: string,
    questionId: string,
    answer: QuizAnswer,
    actor?: ActorContext,
    options: QuizTimingOptions = {},
  ): Promise<QuizAttempt> {
    const attempt = await this.loadAttempt(attemptId, actor);
    await this.authorizeAttempt('assessment.answerQuiz', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);
    const limit = await this.effectiveLimit(attempt, options.timeLimitSeconds);

    if (attempt.submittedAt !== undefined) throw new AttemptClosedError(attempt.id);
    if (isLate(attempt, limit)) throw new AttemptExpiredError(attempt.id);

    const question = attempt.questionOrder.includes(questionId)
      ? (await this.quizzes.getQuestions(attempt.quizId)).find((q) => q.id === questionId)
      : undefined;
    if (!question) throw new InvalidAnswerError('question-not-in-attempt');
    const clean = checkAnswer(question, answer);

    const saved = await this.quizzes.saveAnswer(attempt.id, questionId, clean);
    // Null means the attempt was submitted between our check and the write.
    if (!saved) throw new AttemptClosedError(attempt.id);
    return saved;
  }

  /**
   * Submits an attempt: scores the saved answers (`scoreQuiz`), closes it, stores a `Submission`
   * with payload `{ kind: 'quiz', attemptId }` for grading to attach to, emits
   * `assessment.quizSubmitted`, and, if `autoGrade` is on, records the score as a grade. Unanswered
   * questions score 0. An attempt with a question to be scored by hand (an `essay`) is submitted
   * with `pendingReview: true` and no grade yet; see `gradeQuizQuestion`. Passing `timeLimitSeconds` flags a submission made after it as `late`; it is
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
    const authorized = await this.authorizeAttempt('assessment.submitQuiz', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);
    const limit = await this.effectiveLimit(attempt, options.timeLimitSeconds);

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
        ...(scored.pendingReview > 0 ? { pendingReview: true } : {}),
      });
      if (closed) {
        current = await this.finishAttempt(closed, authorized?.orgId);
      } else {
        // Someone else submitted at the same moment; they finish the job, we report what they stored.
        current = (await this.quizzes.findAttempt(attempt.id)) ?? attempt;
      }
    } else if (this.needsFinishing(attempt)) {
      current = await this.finishAttempt(attempt, authorized?.orgId);
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

  /**
   * Scores one question of a submitted attempt by hand, replacing any earlier hand score for it.
   * This is how an `essay` question gets its points. It also overrides the automatic result of any
   * other type, for example to accept a spelling the key did not list. `points` must be from 0 to the
   * question's points (`InvalidManualScoreError`).
   *
   * The attempt's `score` is then worked out again. Once no question is left pending
   * (`pendingReview` false) and `autoGrade` is on, the score is recorded as a grade, replacing the
   * earlier automatic grade if there was one. With enforcement on this needs `assessment.gradeQuiz`
   * in the quiz's section (staff). Emits `assessment.quizQuestionGraded`. Returns the result with its
   * breakdown.
   */
  async gradeQuizQuestion(
    attemptId: string,
    questionId: string,
    points: number,
    actor?: ActorContext,
  ): Promise<QuizResult> {
    const attempt = await this.loadAttempt(attemptId, actor);
    const auth = await this.authorizeAttempt('assessment.gradeQuiz', actor, attempt);
    if (!attempt) throw new Error(`Quiz attempt ${attemptId} not found`);
    if (attempt.submittedAt === undefined) throw new InvalidManualScoreError('Only a submitted attempt can be scored by hand');

    const questions = await this.quizzes.getQuestions(attempt.quizId);
    const question = attempt.questionOrder.includes(questionId) ? questions.find((q) => q.id === questionId) : undefined;
    if (!question) throw new InvalidAnswerError('question-not-in-attempt');
    const max = question.points ?? 1;
    if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > max) {
      throw new InvalidManualScoreError(`The score must be a number from 0 to ${max}`);
    }

    let saved: QuizAttempt | null;
    if (this.quizzes.saveManualScore) {
      saved = await this.quizzes.saveManualScore(attempt.id, questionId, points);
    } else {
      const current = await this.quizzes.findAttempt(attempt.id);
      saved = current
        ? await this.quizzes.updateAttempt(attempt.id, { manualScores: { ...(current.manualScores ?? {}), [questionId]: points } })
        : null;
    }
    if (!saved) throw new Error(`Quiz attempt ${attemptId} not found`);

    const scored = scoreQuiz(questions, saved.answers ?? {}, saved.questionOrder, saved.manualScores ?? {});
    let current = await this.quizzes.updateAttempt(saved.id, {
      score: scored.score,
      maxScore: scored.maxScore,
      pendingReview: scored.pendingReview > 0,
    });
    // The quiz may have been submitted and never finished (no submission yet): finish it first.
    if (current.submissionId === undefined) current = await this.finishAttempt(current, auth?.orgId);
    else current = await this.recordAutoGrade(current, true);

    void this.events?.emit({
      type: 'assessment.quizQuestionGraded',
      attemptId: current.id,
      quizId: current.quizId,
      questionId,
      userId: current.userId,
      points,
      score: current.score!,
      maxScore: current.maxScore!,
      pendingReview: current.pendingReview === true,
      ...(actor ? { graderId: actor.actorId } : {}),
      ...(auth?.orgId !== undefined ? { orgId: auth.orgId } : {}),
    });
    return this.resultOf(current, true);
  }

  /** The time limit this student really has: the host's limit plus their extension, if there is a source for one. */
  private async effectiveLimit(attempt: QuizAttempt, seconds: number | undefined): Promise<number | undefined> {
    const base = checkedLimit(seconds);
    if (base === undefined || !this.options.extensions) return base;
    const extension = await this.options.extensions.findActive(attempt.userId, attempt.quizId);
    const extra = extension?.extraSeconds;
    return typeof extra === 'number' && Number.isFinite(extra) && extra > 0 ? base + extra : base;
  }

  /** Stores the quiz submission and the automatic grade, each only if it is not there yet. */
  private async finishAttempt(attempt: QuizAttempt, orgId?: string): Promise<QuizAttempt> {
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
        ...(current.pendingReview === true ? { pendingReview: true } : {}),
        ...(orgId !== undefined ? { orgId } : {}),
      });
    }
    return this.recordAutoGrade(current, false);
  }

  /**
   * Records the attempt's score as a grade when `autoGrade` is on, nothing waits for a hand score,
   * and the quiz is worth something (grades need a maximum above zero). With `regrade`, an existing
   * automatic grade is replaced by a new one (its score changed); without, one is only recorded if
   * there is none yet.
   */
  private async recordAutoGrade(attempt: QuizAttempt, regrade: boolean): Promise<QuizAttempt> {
    const auto = this.options.autoGrade;
    if (!auto || attempt.pendingReview === true || !(attempt.maxScore! > 0)) return attempt;
    if (attempt.gradeEntryId !== undefined && !regrade) return attempt;
    const entry = await auto.grading.recordSystemGrade(
      attempt.submissionId!,
      attempt.userId,
      attempt.score!,
      attempt.maxScore!,
      auto.source ?? 'system:quiz',
      ...(attempt.gradeEntryId !== undefined ? [attempt.gradeEntryId] : []),
    );
    return this.quizzes.updateAttempt(attempt.id, { gradeEntryId: entry.id });
  }

  private needsFinishing(attempt: QuizAttempt): boolean {
    if (attempt.submissionId === undefined) return true;
    return (
      this.options.autoGrade !== undefined &&
      attempt.gradeEntryId === undefined &&
      attempt.pendingReview !== true &&
      attempt.maxScore! > 0
    );
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
      pendingReview: attempt.pendingReview === true,
      ...(attempt.submissionId !== undefined ? { submissionId: attempt.submissionId } : {}),
      ...(attempt.gradeEntryId !== undefined ? { gradeEntryId: attempt.gradeEntryId } : {}),
    };
    if (!withAnswers) return result;
    // The breakdown is worked out from the quiz as it is now; the score above is what was stored at submission.
    const questions = await this.quizzes.getQuestions(attempt.quizId);
    const scored = scoreQuiz(questions, attempt.answers ?? {}, attempt.questionOrder, attempt.manualScores ?? {});
    return { ...result, questions: scored.questions };
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
  ): Promise<{ sectionId: string; staff: boolean; kind: string; orgId?: string } | undefined> {
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
    const orgId = auth.ctx.resourceOrgId ?? auth.ctx.actor.orgId;
    return { sectionId: node!.sectionId, staff, kind: node!.kind, ...(orgId !== undefined ? { orgId } : {}) };
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
}

/**
 * A uniformly random whole number in [0, n), from the Web Crypto API (`globalThis.crypto`), which
 * Node 20+, Bun, Deno, browsers and edge runtimes all provide. A `node:crypto` import would tie the
 * SDK to Node. Rejection sampling keeps it unbiased: values from the incomplete last block of 2^32
 * are drawn again.
 */
function randomBelow(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < limit) return value % n;
  }
}

/** A question as the student sees it: everything but the key. */
function questionView(q: QuizQuestion, saved: QuizAnswer | undefined): QuizQuestionView {
  const type = questionTypeOf(q);
  const choices = 'choices' in q && Array.isArray(q.choices) ? [...q.choices] : [];
  const maxLength = q.type === 'short_answer' || q.type === 'essay' ? q.maxLength : undefined;
  return {
    id: q.id,
    type,
    prompt: q.prompt,
    choices,
    ...(q.points !== undefined ? { points: q.points } : {}),
    ...(q.penalty ? { penalty: q.penalty } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(saved !== undefined ? { answer: structuredClone(saved) } : {}),
    ...(type === 'single_choice' && typeof saved === 'number' ? { selectedChoiceIndex: saved } : {}),
  };
}

/** The answer if it fits the question's type, normalized (a multiple-choice list sorted); else `InvalidAnswerError`. */
function checkAnswer(q: QuizQuestion, answer: QuizAnswer): QuizAnswer {
  const inRange = (i: unknown, length: number) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < length;
  switch (questionTypeOf(q)) {
    case 'single_choice': {
      if (typeof answer !== 'number') throw new InvalidAnswerError('wrong-answer-type');
      if (!inRange(answer, (q as { choices: string[] }).choices.length)) throw new InvalidAnswerError('choice-out-of-range');
      return answer;
    }
    case 'multiple_choice': {
      if (!Array.isArray(answer) || answer.length === 0) throw new InvalidAnswerError('wrong-answer-type');
      const length = (q as { choices: string[] }).choices.length;
      if (!answer.every((i) => inRange(i, length)) || new Set(answer).size !== answer.length) {
        throw new InvalidAnswerError('choice-out-of-range');
      }
      return [...answer].sort((a, b) => a - b);
    }
    case 'true_false':
      if (typeof answer !== 'boolean') throw new InvalidAnswerError('wrong-answer-type');
      return answer;
    case 'numeric':
      if (typeof answer !== 'number' || !Number.isFinite(answer)) throw new InvalidAnswerError('wrong-answer-type');
      return answer;
    case 'short_answer':
    case 'essay': {
      if (typeof answer !== 'string') throw new InvalidAnswerError('wrong-answer-type');
      const limit = (q as { maxLength?: number }).maxLength ?? (q.type === 'short_answer' ? 1000 : undefined);
      if (limit !== undefined && answer.length > limit) throw new InvalidAnswerError('answer-too-long');
      return answer;
    }
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
