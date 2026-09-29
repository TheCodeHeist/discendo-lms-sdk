export type SubmissionPayload =
  | { kind: 'text'; content: string }
  | { kind: 'file'; ref: string }
  | { kind: 'url'; href: string }
  | { kind: 'none' }; // offline/manually graded work

export interface Submission {
  id: string;
  contentId: string;
  userId: string;
  payload: SubmissionPayload;
  submittedAt: Date;
  attemptNumber: number;
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
}

export interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[]; // supports randomization per-attempt
  startedAt: Date;
  submittedAt?: Date;
}

/** Seam for plagiarism/integrity checks — SDK doesn't implement detection itself. */
export type PlagiarismCheckResult = { flagged: boolean; score?: number; details?: string };
export type PlagiarismCheckHook = (submission: Submission) => Promise<PlagiarismCheckResult>;
