/**
 * In-memory implementations of the assessment repositories: submissions, quizzes, rubrics,
 * rubric evaluations and peer reviews. Complete, including the optional atomic methods, and kept in
 * this process only. For tests, demos and local development, and as a reference for your own.
 */
import { InMemoryTable } from '../../../core/testing/table.js';
import type { QuizRepository, SubmissionRepository } from '../service.js';
import type {
  PeerReview,
  PeerReviewAssignment,
  PeerReviewRepository,
  QuizAnswer,
  QuizAttempt,
  QuizAttemptClose,
  QuizQuestion,
  Rubric,
  RubricEvaluation,
  RubricEvaluationRepository,
  RubricRepository,
  Submission,
} from '../types.js';

/**
 * Includes the optional atomic `createAttempt` and `countGroupAttempts`. A submission made for a
 * group (`groupId` set) uses up the group's attempts; any other uses up the person's own.
 *
 * Also offers `findById` and `listByContent`, which `PeerReviewService` and `RubricService` need
 * and a host usually does too (for example to build the `SubmissionLocator` grading asks for).
 */
export class InMemorySubmissionRepository implements SubmissionRepository {
  private readonly submissions = new InMemoryTable<Submission>('sub', 'Submission');

  async create(sub: Omit<Submission, 'id'>): Promise<Submission> {
    return this.submissions.insert(sub);
  }

  async countAttempts(contentId: string, userId: string): Promise<number> {
    return this.submissions.count((s) => s.contentId === contentId && s.userId === userId);
  }

  async countGroupAttempts(contentId: string, groupId: string): Promise<number> {
    return this.submissions.count((s) => s.contentId === contentId && s.groupId === groupId);
  }

  async createAttempt(draft: Omit<Submission, 'id' | 'attemptNumber'>, maxAttempts?: number): Promise<Submission | null> {
    const used =
      draft.groupId !== undefined
        ? this.submissions.count((s) => s.contentId === draft.contentId && s.groupId === draft.groupId)
        : this.submissions.count((s) => s.contentId === draft.contentId && s.userId === draft.userId);
    if (maxAttempts !== undefined && used >= maxAttempts) return null;
    return this.submissions.insert({ ...draft, attemptNumber: used + 1 });
  }

  async findById(id: string): Promise<Submission | null> {
    return this.submissions.get(id);
  }

  async listByContent(contentId: string, userId?: string): Promise<Submission[]> {
    return this.submissions.where((s) => s.contentId === contentId && (userId === undefined || s.userId === userId));
  }
}

/** Questions are seeded per quiz (`seedQuestions`), since the SDK only reads them. */
export class InMemoryQuizRepository implements QuizRepository {
  private readonly questions = new Map<string, QuizQuestion[]>();
  private readonly attempts = new InMemoryTable<QuizAttempt>('attempt', 'Quiz attempt');

  /** Sets the questions of a quiz (its content id), replacing any it had. */
  seedQuestions(quizId: string, questions: QuizQuestion[]): this {
    this.questions.set(quizId, structuredClone(questions));
    return this;
  }

  async getQuestions(quizId: string): Promise<QuizQuestion[]> {
    return structuredClone(this.questions.get(quizId) ?? []);
  }

  async createAttempt(attempt: Omit<QuizAttempt, 'id'>): Promise<QuizAttempt> {
    return this.attempts.insert(attempt);
  }

  async findAttempt(id: string): Promise<QuizAttempt | null> {
    return this.attempts.get(id);
  }

  async findOpenAttempt(quizId: string, userId: string): Promise<QuizAttempt | null> {
    return this.attempts.last((a) => a.quizId === quizId && a.userId === userId && a.submittedAt === undefined);
  }

  async saveAnswer(attemptId: string, questionId: string, answer: QuizAnswer): Promise<QuizAttempt | null> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.submittedAt !== undefined) return null;
    return this.attempts.update(attemptId, { answers: { ...(attempt.answers ?? {}), [questionId]: answer } });
  }

  async saveManualScore(attemptId: string, questionId: string, points: number): Promise<QuizAttempt | null> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.submittedAt === undefined) return null;
    return this.attempts.update(attemptId, { manualScores: { ...(attempt.manualScores ?? {}), [questionId]: points } });
  }

  async closeAttempt(attemptId: string, close: QuizAttemptClose): Promise<QuizAttempt | null> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.submittedAt !== undefined) return null;
    return this.attempts.update(attemptId, close);
  }

  async updateAttempt(
    attemptId: string,
    patch: Parameters<QuizRepository['updateAttempt']>[1],
  ): Promise<QuizAttempt> {
    return this.attempts.update(attemptId, patch);
  }
}

/**
 * Saving a rubric for content that already has one stores a new rubric (with a new id) that
 * becomes the content's rubric; the old one is kept, so evaluations made against it still point at
 * the rubric they were scored with.
 */
export class InMemoryRubricRepository implements RubricRepository {
  private readonly rubrics = new InMemoryTable<Rubric>('rubric', 'Rubric');

  async save(rubric: Omit<Rubric, 'id'>): Promise<Rubric> {
    return this.rubrics.insert(rubric);
  }

  async findByContentId(contentId: string): Promise<Rubric | null> {
    return this.rubrics.last((r) => r.contentId === contentId);
  }

  async deleteByContentId(contentId: string): Promise<boolean> {
    const found = this.rubrics.where((r) => r.contentId === contentId);
    for (const r of found) this.rubrics.delete(r.id);
    return found.length > 0;
  }
}

export class InMemoryRubricEvaluationRepository implements RubricEvaluationRepository {
  private readonly evaluations = new InMemoryTable<RubricEvaluation>('eval', 'Rubric evaluation');

  async create(evaluation: Omit<RubricEvaluation, 'id'>): Promise<RubricEvaluation> {
    return this.evaluations.insert(evaluation);
  }

  async findBySubmission(submissionId: string, evaluatorId?: string): Promise<RubricEvaluation[]> {
    return this.evaluations.where(
      (e) => e.submissionId === submissionId && (evaluatorId === undefined || e.evaluatorId === evaluatorId),
    );
  }

  async findById(id: string): Promise<RubricEvaluation | null> {
    return this.evaluations.get(id);
  }
}

export class InMemoryPeerReviewRepository implements PeerReviewRepository {
  private readonly assignments = new InMemoryTable<PeerReviewAssignment>('pra', 'Peer review assignment');
  private readonly reviews = new InMemoryTable<PeerReview>('review', 'Peer review');

  async createAssignments(assignments: Omit<PeerReviewAssignment, 'id'>[]): Promise<PeerReviewAssignment[]> {
    return assignments.map((a) => this.assignments.insert(a));
  }

  async findAssignmentsForReviewer(reviewerUserId: string, contentId?: string): Promise<PeerReviewAssignment[]> {
    return this.assignments.where(
      (a) => a.reviewerUserId === reviewerUserId && (contentId === undefined || a.contentId === contentId),
    );
  }

  async findAssignmentsForSubmission(submissionId: string): Promise<PeerReviewAssignment[]> {
    return this.assignments.where((a) => a.submissionId === submissionId);
  }

  async findAssignmentById(id: string): Promise<PeerReviewAssignment | null> {
    return this.assignments.get(id);
  }

  async markAssignmentCompleted(id: string, completedAt: Date): Promise<void> {
    this.assignments.update(id, { completedAt });
  }

  async createReview(review: Omit<PeerReview, 'id'>): Promise<PeerReview> {
    return this.reviews.insert(review);
  }

  async findReviewsForSubmission(submissionId: string): Promise<PeerReview[]> {
    return this.reviews.where((r) => r.submissionId === submissionId);
  }

  async findReviewByAssignmentId(assignmentId: string): Promise<PeerReview | null> {
    return this.reviews.last((r) => r.assignmentId === assignmentId);
  }
}
