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
}

export interface Criterion {
  description: string;
  maxPoints: number;
}

export interface Rubric {
  contentId: string;
  criteria: Criterion[];
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  choices: string[];
  correctChoiceIndex: number;
  /** What a right answer earns. Default 1. A finite number from 0 up. */
  points?: number;
}

export interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[]; // supports randomization per-attempt
  startedAt: Date;
  /** Set when the attempt is submitted; an attempt without it is still open. */
  submittedAt?: Date;
  /** The student's choice for each question they answered: question id to choice index. */
  answers?: Record<string, number>;
  /** Set on submission. */
  score?: number;
  maxScore?: number;
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
}

/** A question as a student sees it: no answer key. */
export interface QuizQuestionView {
  id: string;
  prompt: string;
  choices: string[];
  points?: number;
  /** The choice the student has saved so far, if any. */
  selectedChoiceIndex?: number;
}

/** One question's outcome in a scored attempt. */
export interface QuestionResult {
  questionId: string;
  /** Absent when the student left it unanswered. */
  selectedChoiceIndex?: number;
  correctChoiceIndex: number;
  correct: boolean;
  points: number;
  earned: number;
}

export interface QuizScore {
  score: number;
  maxScore: number;
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
  recordSystemGrade(
    submissionId: string,
    userId: string,
    score: number,
    maxScore: number,
    source: string,
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

/** The answer does not fit the attempt: a question it does not have, or a choice that does not exist. */
export class InvalidAnswerError extends Error {
  constructor(readonly reason: 'question-not-in-attempt' | 'choice-out-of-range') {
    super(
      reason === 'question-not-in-attempt'
        ? 'That question is not part of this attempt'
        : 'The choice must be a whole number that is one of the question\'s choices',
    );
    this.name = 'InvalidAnswerError';
  }
}

/** Seam for plagiarism/integrity checks — SDK doesn't implement detection itself. */
export type PlagiarismCheckResult = { flagged: boolean; score?: number; details?: string };
export type PlagiarismCheckHook = (submission: Submission) => Promise<PlagiarismCheckResult>;
