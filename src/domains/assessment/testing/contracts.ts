/**
 * Contract suites for the assessment repositories. See `core/testing/contract.ts` for how to run
 * them with your test runner.
 */
import { check, checkEqual, idsOf, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { QuizRepository, SubmissionRepository } from '../service.js';
import type {
  Criterion,
  PeerReviewRepository,
  QuizAttempt,
  RubricEvaluation,
  RubricEvaluationRepository,
  RubricRepository,
  Submission,
} from '../types.js';

const at = (iso: string) => new Date(iso);

const submission = (over: Partial<Omit<Submission, 'id'>> = {}): Omit<Submission, 'id'> => ({
  contentId: 'hw1',
  userId: 'u1',
  payload: { kind: 'text', content: 'my answer' },
  submittedAt: at('2026-09-10T12:00:00Z'),
  attemptNumber: 1,
  ...over,
});

export function submissionRepositoryContract(make: RepositoryFactory<SubmissionRepository>): ContractCase[] {
  return suite('SubmissionRepository', [
    {
      name: "create stores a submission and countAttempts counts that person's for that content",
      run: async () => {
        const repo = await make();
        const created = await repo.create(submission());
        check(typeof created.id === 'string' && created.id !== '', 'create returns a non-empty id');
        checkEqual(created, { ...submission(), id: created.id }, 'create returns every field');
        await repo.create(submission({ attemptNumber: 2 }));
        await repo.create(submission({ userId: 'u2' }));
        await repo.create(submission({ contentId: 'hw2' }));
        checkEqual(await repo.countAttempts('hw1', 'u1'), 2, 'u1 on hw1');
        checkEqual(await repo.countAttempts('hw1', 'nobody'), 0, 'nobody');
      },
    },
    {
      name: "countGroupAttempts (if implemented) counts the group's submissions for that content",
      run: async () => {
        const repo = await make();
        if (!repo.countGroupAttempts) return;
        await repo.create(submission({ userId: 'u1', groupId: 'g1' }));
        await repo.create(submission({ userId: 'u2', groupId: 'g1', attemptNumber: 2 }));
        await repo.create(submission({ userId: 'u3', groupId: 'g2' }));
        checkEqual(await repo.countGroupAttempts('hw1', 'g1'), 2, 'g1 on hw1');
      },
    },
    {
      name: 'createAttempt (if implemented) numbers attempts 1, 2, 3 and refuses past the limit',
      run: async () => {
        const repo = await make();
        if (!repo.createAttempt) return;
        const { attemptNumber: _, ...draft } = submission();
        checkEqual((await repo.createAttempt(draft, 2))?.attemptNumber, 1, 'first attempt');
        checkEqual((await repo.createAttempt(draft, 2))?.attemptNumber, 2, 'second attempt');
        checkEqual(await repo.createAttempt(draft, 2), null, 'third is past the limit');
        checkEqual(await repo.countAttempts('hw1', 'u1'), 2, 'nothing stored for the refused one');
        checkEqual((await repo.createAttempt(draft))?.attemptNumber, 3, 'with no limit it is always stored');
      },
    },
    {
      name: 'createAttempt (if implemented) is atomic: concurrent calls never exceed the limit or share a number',
      run: async () => {
        const repo = await make();
        if (!repo.createAttempt) return;
        const { attemptNumber: _, ...draft } = submission();
        const results = await Promise.all([1, 2, 3, 4, 5].map(() => repo.createAttempt!(draft, 3)));
        const stored = results.filter((r): r is Submission => r !== null);
        checkEqual(stored.length, 3, 'exactly three of five simultaneous attempts are stored');
        checkEqual(stored.map((s) => s.attemptNumber).sort(), [1, 2, 3], 'numbered 1 to 3, no repeats');
      },
    },
  ]);
}

export function quizRepositoryContract(
  make: (questions: { quizId: string; questions: Array<{ id: string; prompt: string; choices: string[]; correctChoiceIndex: number }> }) =>
    | QuizRepository
    | Promise<QuizRepository>,
): ContractCase[] {
  const seed = {
    quizId: 'quiz1',
    questions: [
      { id: 'q1', prompt: '2+2?', choices: ['3', '4'], correctChoiceIndex: 1 },
      { id: 'q2', prompt: 'Sky?', choices: ['blue', 'green'], correctChoiceIndex: 0 },
    ],
  };
  const attempt = (over: Partial<Omit<QuizAttempt, 'id'>> = {}): Omit<QuizAttempt, 'id'> => ({
    quizId: 'quiz1',
    userId: 'u1',
    questionOrder: ['q2', 'q1'],
    startedAt: at('2026-09-10T09:00:00Z'),
    ...over,
  });
  const close = { submittedAt: at('2026-09-10T09:20:00Z'), score: 1, maxScore: 2, late: false };
  return suite('QuizRepository', [
    {
      name: 'getQuestions returns the questions of that quiz, and none for another',
      run: async () => {
        const repo = await make(seed);
        checkEqual(await repo.getQuestions('quiz1'), seed.questions, 'questions of quiz1');
        checkEqual(await repo.getQuestions('other'), [], 'an unknown quiz has none');
      },
    },
    {
      name: 'createAttempt and findAttempt round-trip, keeping the question order',
      run: async () => {
        const repo = await make(seed);
        const created = await repo.createAttempt(attempt());
        checkEqual(await repo.findAttempt(created.id), created, 'findAttempt');
        checkEqual(created.questionOrder, ['q2', 'q1'], 'question order kept');
        checkEqual(await repo.findAttempt('nope'), null, 'unknown attempt');
      },
    },
    {
      name: 'findOpenAttempt ignores submitted attempts and other people',
      run: async () => {
        const repo = await make(seed);
        const done = await repo.createAttempt(attempt());
        await repo.closeAttempt(done.id, close);
        checkEqual(await repo.findOpenAttempt('quiz1', 'u1'), null, 'no open attempt once submitted');
        const open = await repo.createAttempt(attempt());
        checkEqual((await repo.findOpenAttempt('quiz1', 'u1'))?.id, open.id, 'the open one');
        checkEqual(await repo.findOpenAttempt('quiz1', 'u2'), null, "not someone else's");
      },
    },
    {
      name: 'saveAnswer keeps earlier answers, and concurrent saves do not lose each other',
      run: async () => {
        const repo = await make(seed);
        const a = await repo.createAttempt(attempt());
        await Promise.all([repo.saveAnswer(a.id, 'q1', 1), repo.saveAnswer(a.id, 'q2', 0)]);
        checkEqual((await repo.findAttempt(a.id))?.answers, { q1: 1, q2: 0 }, 'both answers kept');
        checkEqual((await repo.saveAnswer(a.id, 'q1', 0))?.answers, { q1: 0, q2: 0 }, 'an answer can be changed');
      },
    },
    {
      name: 'saveAnswer returns null for an unknown or closed attempt and changes nothing',
      run: async () => {
        const repo = await make(seed);
        checkEqual(await repo.saveAnswer('nope', 'q1', 0), null, 'unknown attempt');
        const a = await repo.createAttempt(attempt());
        await repo.closeAttempt(a.id, close);
        checkEqual(await repo.saveAnswer(a.id, 'q1', 0), null, 'closed attempt');
        checkEqual((await repo.findAttempt(a.id))?.answers ?? {}, {}, 'no answer stored');
      },
    },
    {
      name: 'closeAttempt closes once: a second (or concurrent) close returns null',
      run: async () => {
        const repo = await make(seed);
        const a = await repo.createAttempt(attempt());
        const results = await Promise.all([repo.closeAttempt(a.id, close), repo.closeAttempt(a.id, { ...close, score: 2 })]);
        checkEqual(results.filter((r) => r !== null).length, 1, 'exactly one close wins');
        const stored = await repo.findAttempt(a.id);
        checkEqual(stored?.submittedAt, close.submittedAt, 'submittedAt stored');
        checkEqual(await repo.closeAttempt('nope', close), null, 'unknown attempt');
      },
    },
    {
      name: 'saveAnswer stores every kind of answer as given: a list, a boolean, text, a number',
      run: async () => {
        const repo = await make(seed);
        const a = await repo.createAttempt(attempt());
        await repo.saveAnswer(a.id, 'mc', [0, 2]);
        await repo.saveAnswer(a.id, 'tf', false);
        await repo.saveAnswer(a.id, 'sa', 'Paris');
        await repo.saveAnswer(a.id, 'num', 9.81);
        checkEqual((await repo.findAttempt(a.id))?.answers, { mc: [0, 2], tf: false, sa: 'Paris', num: 9.81 }, 'answers round-trip');
      },
    },
    {
      name: 'updateAttempt merges a rescore (score, maxScore, pendingReview, manualScores) and keeps the rest',
      run: async () => {
        const repo = await make(seed);
        const a = await repo.createAttempt(attempt());
        await repo.closeAttempt(a.id, { ...close, pendingReview: true });
        checkEqual((await repo.findAttempt(a.id))?.pendingReview, true, 'closeAttempt stores pendingReview');
        const updated = await repo.updateAttempt(a.id, { score: 2, maxScore: 2, pendingReview: false, manualScores: { q1: 1 } });
        checkEqual([updated.score, updated.pendingReview, updated.manualScores], [2, false, { q1: 1 }], 'rescore stored');
        checkEqual(updated.submittedAt, close.submittedAt, 'submittedAt kept');
      },
    },
    {
      name: 'saveManualScore (if implemented) only scores a submitted attempt, and keeps the other hand scores',
      run: async () => {
        const repo = await make(seed);
        if (!repo.saveManualScore) return;
        const a = await repo.createAttempt(attempt());
        checkEqual(await repo.saveManualScore(a.id, 'q1', 1), null, 'refused while open');
        await repo.closeAttempt(a.id, close);
        await Promise.all([repo.saveManualScore(a.id, 'q1', 1), repo.saveManualScore(a.id, 'q2', 0.5)]);
        checkEqual((await repo.findAttempt(a.id))?.manualScores, { q1: 1, q2: 0.5 }, 'both hand scores kept');
        checkEqual(await repo.saveManualScore('nope', 'q1', 1), null, 'unknown attempt');
      },
    },
    {
      name: 'updateAttempt records the submission and grade ids',
      run: async () => {
        const repo = await make(seed);
        const a = await repo.createAttempt(attempt());
        const updated = await repo.updateAttempt(a.id, { submissionId: 'sub-1', gradeEntryId: 'grade-1' });
        checkEqual([updated.submissionId, updated.gradeEntryId], ['sub-1', 'grade-1'], 'ids recorded');
        checkEqual(updated.questionOrder, a.questionOrder, 'the rest kept');
      },
    },
  ]);
}

export function rubricRepositoryContract(make: RepositoryFactory<RubricRepository>): ContractCase[] {
  const criteria: Criterion[] = [
    { id: 'c1', description: 'Clarity', maxPoints: 5, levels: [{ points: 0, description: 'poor' }, { points: 5, description: 'good' }] },
  ];
  return suite('RubricRepository', [
    {
      name: 'save and findByContentId round-trip; the latest save is the one found',
      run: async () => {
        const repo = await make();
        await repo.save({ contentId: 'hw1', title: 'v1', criteria });
        const v2 = await repo.save({ contentId: 'hw1', title: 'v2', criteria });
        checkEqual((await repo.findByContentId('hw1'))?.id, v2.id, 'the latest rubric');
        checkEqual(await repo.findByContentId('hw2'), null, 'none for other content');
      },
    },
    {
      name: 'deleteByContentId returns true when there was one, then false',
      run: async () => {
        const repo = await make();
        await repo.save({ contentId: 'hw1', criteria });
        checkEqual(await repo.deleteByContentId('hw1'), true, 'first delete');
        checkEqual(await repo.findByContentId('hw1'), null, 'gone');
        checkEqual(await repo.deleteByContentId('hw1'), false, 'second delete');
      },
    },
  ]);
}

export function rubricEvaluationRepositoryContract(make: RepositoryFactory<RubricEvaluationRepository>): ContractCase[] {
  const evaluation = (over: Partial<Omit<RubricEvaluation, 'id'>> = {}): Omit<RubricEvaluation, 'id'> => ({
    rubricId: 'r1',
    contentId: 'hw1',
    submissionId: 'sub1',
    evaluatorId: 'teacher',
    criterionScores: { c1: 5 },
    totalScore: 5,
    evaluatedAt: at('2026-09-12T00:00:00Z'),
    ...over,
  });
  return suite('RubricEvaluationRepository', [
    {
      name: 'create, findById and findBySubmission (optionally by evaluator)',
      run: async () => {
        const repo = await make();
        const a = await repo.create(evaluation());
        const b = await repo.create(evaluation({ evaluatorId: 'peer' }));
        await repo.create(evaluation({ submissionId: 'sub2' }));
        checkEqual(await repo.findById(a.id), a, 'findById');
        checkEqual(idsOf(await repo.findBySubmission('sub1')), idsOf([a, b]), 'all evaluations of sub1');
        checkEqual(idsOf(await repo.findBySubmission('sub1', 'peer')), [b.id], "only the peer's");
        checkEqual(await repo.findById('nope'), null, 'unknown id');
      },
    },
  ]);
}

export function peerReviewRepositoryContract(make: RepositoryFactory<PeerReviewRepository>): ContractCase[] {
  const assignment = (reviewer: string, submissionId: string, contentId = 'hw1') => ({
    contentId,
    submissionId,
    reviewerUserId: reviewer,
    authorUserId: `author-of-${submissionId}`,
    assignedAt: at('2026-09-11T00:00:00Z'),
  });
  return suite('PeerReviewRepository', [
    {
      name: 'createAssignments stores all of them, findable by reviewer (optionally by content), submission and id',
      run: async () => {
        const repo = await make();
        const [a, b, c] = await repo.createAssignments([
          assignment('r1', 'sub1'),
          assignment('r1', 'sub2', 'hw2'),
          assignment('r2', 'sub1'),
        ]);
        check(a && b && c, 'three assignments returned');
        checkEqual(idsOf(await repo.findAssignmentsForReviewer('r1')), idsOf([a, b]), "r1's assignments");
        checkEqual(idsOf(await repo.findAssignmentsForReviewer('r1', 'hw2')), [b.id], "r1's for hw2");
        checkEqual(idsOf(await repo.findAssignmentsForSubmission('sub1')), idsOf([a, c]), 'for sub1');
        checkEqual(await repo.findAssignmentById(a.id), a, 'by id');
        checkEqual(await repo.findAssignmentById('nope'), null, 'unknown id');
      },
    },
    {
      name: 'markAssignmentCompleted sets completedAt',
      run: async () => {
        const repo = await make();
        const [a] = await repo.createAssignments([assignment('r1', 'sub1')]);
        const done = at('2026-09-12T00:00:00Z');
        await repo.markAssignmentCompleted(a!.id, done);
        checkEqual((await repo.findAssignmentById(a!.id))?.completedAt, done, 'completedAt');
      },
    },
    {
      name: 'createReview, findReviewsForSubmission and findReviewByAssignmentId',
      run: async () => {
        const repo = await make();
        const review = await repo.createReview({
          assignmentId: 'pra1',
          submissionId: 'sub1',
          reviewerUserId: 'r1',
          comments: 'nice',
          submittedAt: at('2026-09-12T00:00:00Z'),
        });
        checkEqual(idsOf(await repo.findReviewsForSubmission('sub1')), [review.id], 'reviews of sub1');
        checkEqual(await repo.findReviewByAssignmentId('pra1'), review, 'by assignment');
        checkEqual(await repo.findReviewByAssignmentId('pra2'), null, 'none for another assignment');
      },
    },
  ]);
}

export interface AssessmentRepositoryFactories {
  submissions?: RepositoryFactory<SubmissionRepository>;
  quizzes?: Parameters<typeof quizRepositoryContract>[0];
  rubrics?: RepositoryFactory<RubricRepository>;
  rubricEvaluations?: RepositoryFactory<RubricEvaluationRepository>;
  peerReviews?: RepositoryFactory<PeerReviewRepository>;
}

/** The contracts for whichever assessment repositories you pass a factory for. */
export function assessmentRepositoryContracts(f: AssessmentRepositoryFactories): ContractCase[] {
  return [
    ...(f.submissions ? submissionRepositoryContract(f.submissions) : []),
    ...(f.quizzes ? quizRepositoryContract(f.quizzes) : []),
    ...(f.rubrics ? rubricRepositoryContract(f.rubrics) : []),
    ...(f.rubricEvaluations ? rubricEvaluationRepositoryContract(f.rubricEvaluations) : []),
    ...(f.peerReviews ? peerReviewRepositoryContract(f.peerReviews) : []),
  ];
}
