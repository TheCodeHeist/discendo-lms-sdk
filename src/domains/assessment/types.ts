export type SubmissionPayload =
  | { kind: 'text'; content: string }
  | { kind: 'file'; ref: string }
  | { kind: 'url'; href: string }
  | { kind: 'none' } // offline/manually graded work
  | { kind: 'quiz'; attemptId: string }; // a submitted quiz attempt (see AssessmentService.submitAttempt)

export interface Submission {
  id: string;
  contentId: string;
  userId: string;
  payload: SubmissionPayload;
  submittedAt: Date;
  attemptNumber: number;
  /**
   * Who recorded this on the student's behalf (`AssessmentService.recordOffline`). Absent on
   * a submission the student made themselves, so it also tells the two apart.
   */
  recordedBy?: string;
  groupId?: string;
}

export interface CriterionLevel {
  points: number;
  description: string;
}

export interface Criterion {
  id: string;
  description: string;
  maxPoints: number;
  levels?: CriterionLevel[];
}

export interface Rubric {
  id: string;
  contentId: string;
  title?: string;
  criteria: Criterion[];
}

export interface RubricScore {
  totalScore: number;
  maxScore: number;
  criterionScores: Record<string, number>;
}

export interface RubricEvaluation {
  id: string;
  rubricId: string;
  contentId: string;
  submissionId: string;
  evaluatorId: string;
  criterionScores: Record<string, number>;
  feedback?: string;
  criterionFeedback?: Record<string, string>;
  totalScore: number;
  evaluatedAt: Date;
}

export class InvalidRubricError extends Error {
  constructor(message: string) {
    super(`Invalid rubric: ${message}`);
    this.name = "InvalidRubricError";
  }
}

export class InvalidRubricScoreError extends Error {
  constructor(message: string) {
    super(`Invalid rubric score: ${message}`);
    this.name = "InvalidRubricScoreError";
  }
}

export class RubricNotFoundError extends Error {
  constructor(contentId: string) {
    super(`Rubric for content ${contentId} not found`);
    this.name = "RubricNotFoundError";
  }
}

export interface RubricRepository {
  save(rubric: Omit<Rubric, "id">): Promise<Rubric>;
  findByContentId(contentId: string): Promise<Rubric | null>;
  deleteByContentId(contentId: string): Promise<boolean>;
}

export interface RubricEvaluationRepository {
  create(evaluation: Omit<RubricEvaluation, "id">): Promise<RubricEvaluation>;
  findBySubmission(submissionId: string, evaluatorId?: string): Promise<RubricEvaluation[]>;
  findById(id: string): Promise<RubricEvaluation | null>;
}

export interface PeerReviewAssignment {
  id: string;
  contentId: string;
  submissionId: string;
  reviewerUserId: string;
  authorUserId: string;
  assignedAt: Date;
  completedAt?: Date;
}

export interface PeerReview {
  id: string;
  assignmentId: string;
  submissionId: string;
  reviewerUserId: string;
  rubricEvaluationId?: string;
  comments?: string;
  submittedAt: Date;
}

export class PeerReviewAssignmentError extends Error {
  constructor(message: string) {
    super(`Peer review assignment error: ${message}`);
    this.name = 'PeerReviewAssignmentError';
  }
}

export class PeerReviewNotFoundError extends Error {
  constructor(id: string) {
    super(`Peer review assignment ${id} not found`);
    this.name = 'PeerReviewNotFoundError';
  }
}

export interface PeerReviewRepository {
  createAssignments(assignments: Omit<PeerReviewAssignment, 'id'>[]): Promise<PeerReviewAssignment[]>;
  findAssignmentsForReviewer(reviewerUserId: string, contentId?: string): Promise<PeerReviewAssignment[]>;
  findAssignmentsForSubmission(submissionId: string): Promise<PeerReviewAssignment[]>;
  findAssignmentById(id: string): Promise<PeerReviewAssignment | null>;
  markAssignmentCompleted(id: string, completedAt: Date): Promise<void>;
  createReview(review: Omit<PeerReview, 'id'>): Promise<PeerReview>;
  findReviewsForSubmission(submissionId: string): Promise<PeerReview[]>;
  findReviewByAssignmentId(assignmentId: string): Promise<PeerReview | null>;
}

/**
 * The kinds of quiz question. A question without a `type` is `single_choice`, which is what every
 * question was before the other types existed, so stored quizzes keep working unchanged.
 */
export type QuizQuestionType = 'single_choice' | 'multiple_choice' | 'true_false' | 'short_answer' | 'numeric' | 'essay';

interface QuizQuestionBase {
  id: string;
  prompt: string;
  /** What a fully right answer earns. Default 1. A finite number from 0 up. */
  points?: number;
  /**
   * Negative marking: what a wrong answer COSTS (a finite number from 0 up, default 0). Only an
   * answer that earns nothing is penalised, never an unanswered question, so leaving a question
   * blank is the safe choice. The quiz total never goes below 0. Ignored on `essay` questions.
   */
  penalty?: number;
}

/** Pick exactly one choice. The answer is the choice's index. */
export interface SingleChoiceQuestion extends QuizQuestionBase {
  type?: 'single_choice';
  choices: string[];
  correctChoiceIndex: number;
}

/** Pick every right choice. The answer is a list of choice indexes. */
export interface MultipleChoiceQuestion extends QuizQuestionBase {
  type: 'multiple_choice';
  choices: string[];
  /** The right choices: at least one, no repeats. */
  correctChoiceIndexes: number[];
  /**
   * `all_or_nothing` (default): full points only for exactly the right set. `partial`: each right
   * choice picked earns its share of the points and each wrong choice picked takes one share away,
   * down to 0 for the question. A partial result is never penalised.
   */
  scoring?: 'all_or_nothing' | 'partial';
}

/** The answer is `true` or `false`. */
export interface TrueFalseQuestion extends QuizQuestionBase {
  type: 'true_false';
  correctAnswer: boolean;
}

/**
 * A typed answer, right if it matches one of `acceptedAnswers`. Leading and trailing spaces are
 * ignored and runs of spaces count as one; case is ignored unless `caseSensitive`.
 */
export interface ShortAnswerQuestion extends QuizQuestionBase {
  type: 'short_answer';
  /** At least one. */
  acceptedAnswers: string[];
  caseSensitive?: boolean;
  /** The longest answer accepted, in characters. Default 1000. */
  maxLength?: number;
}

/** A number, right if it is within `tolerance` (default 0) of `correctValue`. */
export interface NumericQuestion extends QuizQuestionBase {
  type: 'numeric';
  correctValue: number;
  /** How far off an answer may be and still be right, as an absolute amount. Default 0. */
  tolerance?: number;
}

/**
 * A written answer that a person scores. The quiz is submitted with this question pending, and
 * the attempt waits for review (`QuizAttempt.pendingReview`) until staff score it with
 * `AssessmentService.gradeQuizQuestion`. The automatic grade is recorded only then.
 */
export interface EssayQuestion extends QuizQuestionBase {
  type: 'essay';
  /** The longest answer accepted, in characters. Default: no limit. */
  maxLength?: number;
}

export type QuizQuestion =
  | SingleChoiceQuestion
  | MultipleChoiceQuestion
  | TrueFalseQuestion
  | ShortAnswerQuestion
  | NumericQuestion
  | EssayQuestion;

/**
 * A student's answer to one question: a choice index (`single_choice`), a list of choice indexes
 * (`multiple_choice`), a boolean (`true_false`), a number (`numeric`) or text (`short_answer`,
 * `essay`).
 */
export type QuizAnswer = number | number[] | boolean | string;

/** The type of a question, with the `single_choice` default filled in. */
export function questionTypeOf(question: QuizQuestion): QuizQuestionType {
  return question.type ?? 'single_choice';
}

export interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[]; // supports randomization per-attempt
  startedAt: Date;
  /** Set when the attempt is submitted; an attempt without it is still open. */
  submittedAt?: Date;
  /** The student's answer to each question they answered, by question id (see `QuizAnswer`). */
  answers?: Record<string, QuizAnswer>;
  /** Set on submission, and updated when staff score a question by hand. */
  score?: number;
  maxScore?: number;
  /**
   * Points given by hand, by question id (`AssessmentService.gradeQuizQuestion`). They replace the
   * automatic result for that question; an `essay` question has no other.
   */
  manualScores?: Record<string, number>;
  /**
   * True while a submitted attempt still has a question waiting to be scored by hand. Its `score`
   * counts those questions as 0 for now, and no automatic grade is recorded until it is false.
   */
  pendingReview?: boolean;
  /** Set on submission: it came in after the time limit the host gave. */
  late?: boolean;
  /** The `Submission` stored for this attempt, so grading can attach to it. */
  submissionId?: string;
  /** The grade entry `autoGrade` recorded for it. */
  gradeEntryId?: string;
}

/** What the repository stores when an attempt is closed. */
export interface QuizAttemptClose {
  submittedAt: Date;
  score: number;
  maxScore: number;
  late: boolean;
  /** Set (true) when the attempt has questions to score by hand. Absent otherwise. */
  pendingReview?: boolean;
}

/** A question as a student sees it: no answer key. */
export interface QuizQuestionView {
  id: string;
  type: QuizQuestionType;
  prompt: string;
  /** The choices, for `single_choice` and `multiple_choice`; an empty list for the other types. */
  choices: string[];
  points?: number;
  /** What a wrong answer costs, when the question has negative marking. */
  penalty?: number;
  /** The longest answer accepted, for `short_answer` and `essay` questions that have a limit. */
  maxLength?: number;
  /** What the student has saved so far, if anything. */
  answer?: QuizAnswer;
  /** The same as `answer`, for `single_choice` questions only. Kept for existing callers. */
  selectedChoiceIndex?: number;
}

/** One question's outcome in a scored attempt. */
export interface QuestionResult {
  questionId: string;
  type: QuizQuestionType;
  /**
   * `correct`, `partial` (some credit), `incorrect`, `unanswered`; for a question scored by hand,
   * `pending` until it is and `graded` after.
   */
  status: 'correct' | 'partial' | 'incorrect' | 'unanswered' | 'pending' | 'graded';
  /** What the student answered. Absent when they left it unanswered. */
  answer?: QuizAnswer;
  /**
   * The answer key: the right choice index, the right choice indexes, the right boolean, the
   * accepted answers or the right number. Absent for an `essay`, which has none.
   */
  correctAnswer?: number | number[] | boolean | string[];
  /** Full points: true only for `correct` (and for a hand score of full points). */
  correct: boolean;
  points: number;
  /** What it earned. Negative when a penalty applied. */
  earned: number;
  /** For `single_choice` questions only, as before: the choice made. */
  selectedChoiceIndex?: number;
  /** For `single_choice` questions only, as before: the right choice. */
  correctChoiceIndex?: number;
}

export interface QuizScore {
  /** The sum of what every question earned, but never below 0. */
  score: number;
  maxScore: number;
  /** How many questions still wait to be scored by hand. */
  pendingReview: number;
  questions: QuestionResult[];
}

/** The outcome of a submitted attempt. `questions` (the answer key) is present only when it may be shown. */
export interface QuizResult {
  attemptId: string;
  quizId: string;
  userId: string;
  score: number;
  maxScore: number;
  submittedAt: Date;
  late: boolean;
  /** True while a question still waits to be scored by hand; `score` counts it as 0 until then. */
  pendingReview: boolean;
  submissionId?: string;
  gradeEntryId?: string;
  questions?: QuestionResult[];
}

/** What the host passes when a quiz has a time limit. */
export interface QuizTimingOptions {
  /** Seconds from `startedAt`. Answers are refused after it; a submission after it is flagged `late`. */
  timeLimitSeconds?: number;
}

export interface SubmitQuizOptions extends QuizTimingOptions {
  /** Include the per-question breakdown, with the correct answers, in the result. Default false. */
  revealAnswers?: boolean;
}

export interface QuizResultOptions {
  /** Show a student their own breakdown. Staff always see it (with enforcement on). Default false. */
  revealAnswers?: boolean;
}

/**
 * Where `AssessmentService` posts a quiz's score as a grade. `GradingService` fits as it is, if it was
 * built with `systemGraders` that include the source.
 */
export interface QuizGradeSink {
  /**
   * `previousEntryId` is passed when a quiz already graded is scored again (a question was scored
   * by hand afterwards): the new grade must replace that entry. `GradingService` supersedes it.
   */
  recordSystemGrade(
    submissionId: string,
    userId: string,
    score: number,
    maxScore: number,
    source: string,
    previousEntryId?: string,
  ): Promise<{ id: string }>;
}

/**
 * Where to look up a student's extra time. `AccommodationService`'s `extensions` repository fits
 * as it is.
 */
export interface ExtensionSource {
  findActive(userId: string, contentId: string): Promise<{ extraSeconds: number } | null>;
}

export interface AssessmentOptions {
  /**
   * When set, a student's active extension on the quiz is added to the `timeLimitSeconds` you pass, in
   * `saveAnswer` and `submitAttempt`. It does nothing when you pass no limit: the quiz is untimed.
   */
  extensions?: ExtensionSource;
  /**
   * Turns on automatic grading: when a quiz is submitted, its score is recorded as a grade for its
   * submission. `source` is the grader name, default `'system:quiz'`.
   */
  autoGrade?: { grading: QuizGradeSink; source?: string };
}

/** The attempt is already submitted, so it takes no more answers. */
export class AttemptClosedError extends Error {
  constructor(readonly attemptId: string) {
    super(`Quiz attempt ${attemptId} is already submitted`);
    this.name = 'AttemptClosedError';
  }
}

/** The time limit has passed, so no more answers are accepted (the attempt can still be submitted). */
export class AttemptExpiredError extends Error {
  constructor(readonly attemptId: string) {
    super(`The time limit for quiz attempt ${attemptId} has passed`);
    this.name = 'AttemptExpiredError';
  }
}

/** A result was asked for before the attempt was submitted. */
export class AttemptNotSubmittedError extends Error {
  constructor(readonly attemptId: string) {
    super(`Quiz attempt ${attemptId} has not been submitted yet`);
    this.name = 'AttemptNotSubmittedError';
  }
}

export type InvalidAnswerReason =
  | 'question-not-in-attempt'
  | 'choice-out-of-range'
  | 'wrong-answer-type'
  | 'answer-too-long';

const INVALID_ANSWER_MESSAGES: Record<InvalidAnswerReason, string> = {
  'question-not-in-attempt': 'That question is not part of this attempt',
  'choice-out-of-range': "The choice must be a whole number that is one of the question's choices",
  'wrong-answer-type': 'That is not the kind of answer this question takes',
  'answer-too-long': 'The answer is longer than this question allows',
};

/**
 * The answer does not fit the attempt: a question it does not have, a choice that does not exist,
 * the wrong kind of answer for the question's type, or text that is too long.
 */
export class InvalidAnswerError extends Error {
  constructor(readonly reason: InvalidAnswerReason) {
    super(INVALID_ANSWER_MESSAGES[reason]);
    this.name = 'InvalidAnswerError';
  }
}

/** A quiz question is malformed: a missing key, an impossible choice, invalid points or penalty. */
export class InvalidQuizQuestionError extends Error {
  constructor(
    readonly questionId: string,
    reason: string,
  ) {
    super(`Question ${questionId}: ${reason}`);
    this.name = 'InvalidQuizQuestionError';
  }
}

/** The student has used every attempt the host allows for this quiz (`generateAttempt`'s `maxAttempts`). */
export class AttemptLimitReachedError extends Error {
  constructor(
    readonly quizId: string,
    readonly maxAttempts: number,
  ) {
    super('No attempts remaining');
    this.name = 'AttemptLimitReachedError';
  }
}

/** The content is the wrong kind for the call: a quiz attempt on something that is not a quiz, say. */
export class WrongContentKindError extends Error {
  constructor(
    readonly contentId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Content ${contentId} is a ${actual}, not a ${expected}`);
    this.name = 'WrongContentKindError';
  }
}

/** A hand score is not possible for the question: outside 0 to its points, or on an attempt not yet submitted. */
export class InvalidManualScoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidManualScoreError';
  }
}

/** Seam for plagiarism/integrity checks — SDK doesn't implement detection itself. */
export type PlagiarismCheckResult = { flagged: boolean; score?: number; details?: string };
export type PlagiarismCheckHook = (submission: Submission) => Promise<PlagiarismCheckResult>;
