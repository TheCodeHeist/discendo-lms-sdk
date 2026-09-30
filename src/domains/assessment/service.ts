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

export class AssessmentService {
  constructor(
    private readonly submissions: SubmissionRepository,
    private readonly quizzes: QuizRepository,
    private readonly plagiarismHook?: PlagiarismCheckHook,
  ) {}

  async submit(
    contentId: string,
    userId: string,
    payload: SubmissionPayload,
    maxAttempts?: number,
  ): Promise<Submission> {
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

    return submission;
  }

  async attemptsRemaining(
    contentId: string,
    userId: string,
    maxAttempts: number,
  ): Promise<number> {
    const used = await this.submissions.countAttempts(contentId, userId);
    return Math.max(0, maxAttempts - used);
  }

  /** Generates a per-user quiz attempt, handling randomization at generation time. */
  async generateAttempt(
    quizId: string,
    userId: string,
    randomize = true,
  ): Promise<QuizAttempt> {
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
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
}
