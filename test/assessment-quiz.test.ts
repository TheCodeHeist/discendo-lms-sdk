import { describe, it, expect } from 'bun:test';
import {
  AssessmentService,
  scoreQuiz,
  AttemptClosedError,
  AttemptExpiredError,
  AttemptNotSubmittedError,
  InvalidAnswerError,
} from '../src/domains/assessment/index.js';
import type { QuizQuestion, QuizGradeSink, Submission, SubmissionRepository } from '../src/domains/assessment/index.js';
import { ActorRequiredError, DEFAULT_RULES, EventBus, PermissionDeniedError, createRolePolicy } from '../src/core/index.js';
import type { ContentNode, Enrollment, Identity, LmsEvent, RepositoryContext, Role } from '../src/core/index.js';
import { makeQuizStore } from './helpers/quiz-store.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));
const as = (actorId: string) => ({ actorId });

/** q1: 3 choices, answer 0, 1 point. q2: answer 1, 2 points. q3: answer 2, 1 point. Total 4. */
const QUESTIONS: QuizQuestion[] = [
  { id: 'q1', prompt: 'One?', choices: ['a', 'b', 'c'], correctChoiceIndex: 0 },
  { id: 'q2', prompt: 'Two?', choices: ['a', 'b'], correctChoiceIndex: 1, points: 2 },
  { id: 'q3', prompt: 'Three?', choices: ['a', 'b', 'c'], correctChoiceIndex: 2 },
];

describe('scoreQuiz', () => {
  it('scores each right answer by its points; wrong and missing answers earn nothing, never less', () => {
    const r = scoreQuiz(QUESTIONS, { q1: 0, q2: 0 });
    expect(r.score).toBe(1);
    expect(r.maxScore).toBe(4);
    expect(r.questions).toEqual([
      { questionId: 'q1', selectedChoiceIndex: 0, correctChoiceIndex: 0, correct: true, points: 1, earned: 1 },
      { questionId: 'q2', selectedChoiceIndex: 0, correctChoiceIndex: 1, correct: false, points: 2, earned: 0 },
      { questionId: 'q3', correctChoiceIndex: 2, correct: false, points: 1, earned: 0 },
    ]);
  });

  it('gives full marks for all correct, and counts a question with no `points` as one point', () => {
    expect(scoreQuiz(QUESTIONS, { q1: 0, q2: 1, q3: 2 })).toMatchObject({ score: 4, maxScore: 4 });
    expect(scoreQuiz([QUESTIONS[0]!], { q1: 0 })).toMatchObject({ score: 1, maxScore: 1 });
  });

  it('honors fractional and zero points', () => {
    const qs: QuizQuestion[] = [
      { id: 'a', prompt: '', choices: ['x', 'y'], correctChoiceIndex: 0, points: 0.5 },
      { id: 'b', prompt: '', choices: ['x', 'y'], correctChoiceIndex: 0, points: 0 },
    ];
    expect(scoreQuiz(qs, { a: 0, b: 0 })).toMatchObject({ score: 0.5, maxScore: 0.5 });
  });

  it('scores only the questions of the attempt, in the attempt\'s order, and ignores the rest', () => {
    const r = scoreQuiz(QUESTIONS, { q1: 0, q2: 1, q3: 2, ghost: 0 }, ['q3', 'q1', 'gone']);
    expect(r.questions.map((q) => q.questionId)).toEqual(['q3', 'q1']);
    expect(r).toMatchObject({ score: 2, maxScore: 2 });
  });

  it('is 0 out of 0 for a quiz with no questions', () => {
    expect(scoreQuiz([], {})).toEqual({ score: 0, maxScore: 0, questions: [] });
  });

  it('treats a choice index that is not exactly the answer as wrong, whatever it is', () => {
    expect(scoreQuiz(QUESTIONS, { q1: 0.0001, q2: -1, q3: 99 }).score).toBe(0);
  });

  it('refuses questions whose points are not a finite number from zero up', () => {
    for (const points of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scoreQuiz([{ ...QUESTIONS[0]!, points }], {})).toThrow(/points/);
    }
  });
});

/**
 * sec-a: published course in org-a. quiz-1 is published, quiz-draft is not, quiz-b is in another section.
 * People: stu, stu-2 (students of sec-a), stu-b (student of sec-b), teacher (instructor of sec-a),
 * ta (TA of sec-a), root (admin, org-a), root-b (admin, org-b).
 */
function buildWorld(
  opts: {
    enforce?: boolean;
    questions?: QuizQuestion[];
    slow?: boolean;
    autoGrade?: boolean;
    gradeSource?: string;
    gradeFailsOnce?: boolean;
    slowQuestions?: boolean;
    atomicSubmissions?: boolean | 'refuses';
    submissionFailsOnce?: boolean;
    seed?: Parameters<typeof makeQuizStore>[1] extends infer O ? (O extends { seed?: infer S } ? S : never) : never;
  } = {},
) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  for (const id of ['stu', 'stu-2']) add(id, ['student']);
  add('stu-b', ['student']);
  add('teacher', ['instructor']);
  add('ta', ['ta']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');

  const enrollments: Enrollment[] = [];
  let en = 0;
  const seedE = (userId: string, sectionId: string, role: Role) =>
    enrollments.push({ id: `enr-${++en}`, userId, sectionId, role, status: 'active', enrolledAt: new Date() });
  seedE('teacher', 'sec-a', 'instructor');
  seedE('ta', 'sec-a', 'ta');
  seedE('stu', 'sec-a', 'student');
  seedE('stu-2', 'sec-a', 'student');
  seedE('stu-b', 'sec-b', 'student');

  const node = (id: string, sectionId: string, published = true): ContentNode => ({
    id,
    sectionId,
    kind: 'quiz',
    title: id,
    orderIndex: 0,
    published,
    version: 1,
  });
  const nodes = new Map([node('quiz-1', 'sec-a'), node('quiz-draft', 'sec-a', false), node('quiz-b', 'sec-b')].map((n) => [n.id, n]));

  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'content' | 'guardianLinks' | 'delegations'> = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => ({ id, title: id, orgId: 'org-a' }),
      findSection: async (id) => (['sec-a', 'sec-b'].includes(id) ? { id, courseId: 'course-a', status: 'published' as const } : null),
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => ({ ...e, id: 'x' }),
      findById: async () => null,
      update: async (_id, p) => p as Enrollment,
      findByUserAndSection: async (u, s) => enrollments.find((e) => e.userId === u && e.sectionId === s) ?? null,
      listBySection: async () => [],
      countActive: async () => 0,
    },
    content: {
      findById: async (id) => nodes.get(id) ?? null,
      listBySection: async () => [],
      create: async (x) => ({ ...x, id: 'c', version: 1 }),
      update: async (id, patch) => ({ ...nodes.get(id)!, ...patch }),
      reorder: async () => {},
    },
    guardianLinks: { findActive: async () => null },
    delegations: {
      create: async (g) => ({ ...g, id: 'g' }),
      findById: async () => null,
      listActiveForEnrollment: async () => [],
      revoke: async (id, at) => ({ id, revokedAt: at }) as never,
    },
  };
  // org-b's admin is in a different organization than course-a
  repos.courses = { ...repos.courses, findCourse: async (id) => ({ id, title: id, orgId: 'org-a' }) };

  const subs: Submission[] = [];
  const subCalls = { create: 0, createAttempt: 0 };
  let failSubmission = opts.submissionFailsOnce === true;
  const submissions: SubmissionRepository = {
    ...(opts.atomicSubmissions
      ? {
          createAttempt: async (draft: Omit<Submission, 'id' | 'attemptNumber'>) => {
            subCalls.createAttempt++;
            if (opts.atomicSubmissions === 'refuses') return null;
            const sub: Submission = { ...draft, id: `sub-${subs.length + 1}`, attemptNumber: subs.length + 1 };
            subs.push(sub);
            return sub;
          },
        }
      : {}),
    create: async (s) => {
      subCalls.create++;
      if (failSubmission) {
        failSubmission = false;
        throw new Error('submission store is down');
      }
      const sub: Submission = { ...s, id: `sub-${subs.length + 1}` };
      subs.push(sub);
      return sub;
    },
    countAttempts: async (contentId, userId) => subs.filter((s) => s.contentId === contentId && s.userId === userId).length,
  };

  const store = makeQuizStore(opts.questions ?? QUESTIONS, {
    ...(opts.slow ? { slow: true } : {}),
    ...(opts.slowQuestions ? { slowQuestions: true } : {}),
    ...(opts.seed ? { seed: opts.seed } : {}),
  });

  const grades: Array<{ submissionId: string; userId: string; score: number; maxScore: number; source: string }> = [];
  let failGrade = opts.gradeFailsOnce === true;
  const grading: QuizGradeSink = {
    recordSystemGrade: async (submissionId, userId, score, maxScore, source) => {
      if (failGrade) {
        failGrade = false;
        throw new Error('gradebook is down');
      }
      grades.push({ submissionId, userId, score, maxScore, source });
      return { id: `grade-${grades.length}` };
    },
  };

  const bus = new EventBus();
  const events: LmsEvent[] = [];
  bus.on('*', (e) => void events.push(e));
  const policy = createRolePolicy();
  const service = new AssessmentService(
    submissions,
    store.repo,
    undefined,
    bus,
    opts.enforce === false ? undefined : { policy, repos },
    opts.autoGrade ? { autoGrade: { grading, ...(opts.gradeSource ? { source: opts.gradeSource } : {}) } } : {},
  );
  const ofType = <T extends LmsEvent['type']>(type: T) => events.filter((e) => e.type === type);
  return { service, store, subs, subCalls, grades, events, ofType, nodes };
}

/** Starts an attempt for `stu` on quiz-1 in a fixed question order and returns it. */
async function start(w: ReturnType<typeof buildWorld>, userId = 'stu', quiz = 'quiz-1') {
  return w.service.generateAttempt(quiz, userId, false, as(userId));
}

describe('generateAttempt: resuming', () => {
  it('hands back the open attempt instead of starting another one', async () => {
    const w = buildWorld();
    const first = await start(w);
    const again = await start(w);
    expect(again.id).toBe(first.id);
    expect(w.store.calls.createAttempt).toBe(1);
  });

  it('starts a new attempt once the last one is submitted, and keeps people and quizzes apart', async () => {
    const w = buildWorld();
    const first = await start(w);
    expect((await start(w, 'stu-2')).id).not.toBe(first.id);
    await w.service.submitAttempt(first.id, as('stu'));
    const next = await start(w);
    expect(next.id).not.toBe(first.id);
    expect(next.submittedAt).toBeUndefined();
  });
});

describe('getAttemptQuestions', () => {
  it('shows the questions in the attempt\'s own order, and never the answer key', async () => {
    const w = buildWorld();
    const a = await w.service.generateAttempt('quiz-1', 'stu', true, as('stu'));
    const views = await w.service.getAttemptQuestions(a.id, as('stu'));
    expect(views.map((v) => v.id)).toEqual(a.questionOrder);
    expect(JSON.stringify(views)).not.toContain('correctChoiceIndex');
    expect(views.find((v) => v.id === 'q2')).toEqual({ id: 'q2', prompt: 'Two?', choices: ['a', 'b'], points: 2 });
  });

  it('shows what the student has answered so far, so a page can pick up where it left off', async () => {
    const w = buildWorld();
    const a = await start(w);
    await w.service.saveAnswer(a.id, 'q1', 2, as('stu'));
    const views = await w.service.getAttemptQuestions(a.id, as('stu'));
    expect(views.find((v) => v.id === 'q1')!.selectedChoiceIndex).toBe(2);
    expect(views.find((v) => v.id === 'q2')).not.toHaveProperty('selectedChoiceIndex');
  });

  it('skips a question that has since been removed from the quiz', async () => {
    const w = buildWorld({ seed: [{ quizId: 'quiz-1', userId: 'stu', questionOrder: ['q1', 'gone', 'q2'] }] });
    const [a] = w.store.attempts;
    const views = await w.service.getAttemptQuestions(a!.id, as('stu'));
    expect(views.map((v) => v.id)).toEqual(['q1', 'q2']);
  });

  it('is for the student alone: no staff, no other student, no actor, and an unknown attempt looks like a forbidden one', async () => {
    const w = buildWorld();
    const a = await start(w);
    const refusals = await Promise.all(
      ['stu-2', 'teacher', 'ta', 'root', 'stu-b'].map((who) => w.service.getAttemptQuestions(a.id, as(who)).catch((e) => e)),
    );
    for (const e of refusals) expect(e).toBeInstanceOf(PermissionDeniedError);
    const missing = await w.service.getAttemptQuestions('nope', as('stu')).catch((e) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect(missing.message).toBe(refusals[0].message);
    await expect(w.service.getAttemptQuestions(a.id)).rejects.toBeInstanceOf(ActorRequiredError);
  });
});

describe('saveAnswer', () => {
  it('stores the choice, replaces it when the student changes their mind, and keeps the other answers', async () => {
    const w = buildWorld();
    const a = await start(w);
    await w.service.saveAnswer(a.id, 'q1', 1, as('stu'));
    await w.service.saveAnswer(a.id, 'q2', 0, as('stu'));
    const saved = await w.service.saveAnswer(a.id, 'q1', 2, as('stu'));
    expect(saved.answers).toEqual({ q1: 2, q2: 0 });
    expect(w.store.attempts[0]!.answers).toEqual({ q1: 2, q2: 0 });
  });

  it('refuses a question that is not part of the attempt, or was removed from the quiz', async () => {
    const w = buildWorld({ seed: [{ quizId: 'quiz-1', userId: 'stu', questionOrder: ['q1', 'gone'] }] });
    const [a] = w.store.attempts;
    await expect(w.service.saveAnswer(a!.id, 'q2', 0, as('stu'))).rejects.toMatchObject({ name: 'InvalidAnswerError', reason: 'question-not-in-attempt' });
    await expect(w.service.saveAnswer(a!.id, 'gone', 0, as('stu'))).rejects.toBeInstanceOf(InvalidAnswerError);
    expect(a!.answers).toBeUndefined();
  });

  it('refuses a choice that is not an integer inside that question\'s choices', async () => {
    const w = buildWorld();
    const a = await start(w);
    for (const bad of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(w.service.saveAnswer(a.id, 'q1', bad, as('stu'))).rejects.toMatchObject({ reason: 'choice-out-of-range' });
    }
    await expect(w.service.saveAnswer(a.id, 'q2', 2, as('stu'))).rejects.toMatchObject({ reason: 'choice-out-of-range' }); // q2 has two choices
    await expect(w.service.saveAnswer(a.id, 'q1', 2, as('stu'))).resolves.toBeDefined();
    expect(w.store.calls.saveAnswer).toBe(1);
  });

  it('refuses once the attempt is submitted', async () => {
    const w = buildWorld();
    const a = await start(w);
    await w.service.submitAttempt(a.id, as('stu'));
    const writes = w.store.calls.saveAnswer;
    await expect(w.service.saveAnswer(a.id, 'q1', 0, as('stu'))).rejects.toBeInstanceOf(AttemptClosedError);
    expect(w.store.calls.saveAnswer).toBe(writes); // refused before touching the store
  });

  it('refuses when the attempt is submitted between the check and the write', async () => {
    const w = buildWorld({ slowQuestions: true });
    const a = await start(w);
    const pending = w.service.saveAnswer(a.id, 'q1', 0, as('stu')).catch((e) => e);
    await w.store.repo.closeAttempt(a.id, { submittedAt: new Date(), score: 0, maxScore: 4, late: false });
    expect(await pending).toBeInstanceOf(AttemptClosedError);
    expect(w.store.attempts[0]!.answers).toBeUndefined();
  });

  it('refuses after the time limit, and not before it', async () => {
    const w = buildWorld({ seed: [{ quizId: 'quiz-1', userId: 'stu', startedAt: new Date(Date.now() - 120_000) }] });
    const [a] = w.store.attempts;
    await expect(w.service.saveAnswer(a!.id, 'q1', 0, as('stu'), { timeLimitSeconds: 60 })).rejects.toBeInstanceOf(AttemptExpiredError);
    await expect(w.service.saveAnswer(a!.id, 'q1', 0, as('stu'), { timeLimitSeconds: 600 })).resolves.toBeDefined();
    await expect(w.service.saveAnswer(a!.id, 'q2', 0, as('stu'))).resolves.toBeDefined(); // no limit given: none applies
  });

  it('refuses a time limit that makes no sense', async () => {
    const w = buildWorld();
    const a = await start(w);
    for (const bad of [0, -5, Number.NaN]) {
      await expect(w.service.saveAnswer(a.id, 'q1', 0, as('stu'), { timeLimitSeconds: bad })).rejects.toThrow(/timeLimitSeconds/);
    }
  });

  it('is for the attempt\'s own student alone', async () => {
    const w = buildWorld();
    const a = await start(w);
    for (const who of ['stu-2', 'teacher', 'ta', 'root', 'stu-b', 'root-b']) {
      await expect(w.service.saveAnswer(a.id, 'q1', 0, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    const lookups = w.store.calls.findAttempt;
    await expect(w.service.saveAnswer(a.id, 'q1', 0)).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.store.calls.findAttempt).toBe(lookups); // no actor: nothing is looked up
    await expect(w.service.saveAnswer('nope', 'q1', 0, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.store.calls.saveAnswer).toBe(0);
  });

  it('keeps students out of an unpublished quiz', async () => {
    const w = buildWorld({ seed: [{ quizId: 'quiz-draft', userId: 'stu' }] });
    const [a] = w.store.attempts;
    await expect(w.service.saveAnswer(a!.id, 'q1', 0, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('without enforcement works with no actor, and says plainly when the attempt does not exist', async () => {
    const w = buildWorld({ enforce: false });
    const a = await w.service.generateAttempt('quiz-1', 'stu', false);
    await expect(w.service.saveAnswer(a.id, 'q1', 0)).resolves.toBeDefined();
    await expect(w.service.saveAnswer('nope', 'q1', 0)).rejects.toThrow('Quiz attempt nope not found');
  });
});

describe('submitAttempt: scoring and recording', () => {
  const answered = async (w: ReturnType<typeof buildWorld>, answers: Record<string, number>) => {
    const a = await start(w);
    for (const [q, c] of Object.entries(answers)) await w.service.saveAnswer(a.id, q, c, as('stu'));
    return a;
  };

  it('scores the saved answers, closes the attempt, and returns the result without the answer key', async () => {
    const w = buildWorld();
    const a = await answered(w, { q1: 0, q2: 1, q3: 0 });
    const r = await w.service.submitAttempt(a.id, as('stu'));
    expect(r).toMatchObject({ attemptId: a.id, quizId: 'quiz-1', userId: 'stu', score: 3, maxScore: 4, late: false });
    expect(r.submittedAt).toBeInstanceOf(Date);
    expect(r).not.toHaveProperty('questions');
    expect(w.store.attempts[0]).toMatchObject({ score: 3, maxScore: 4, late: false });
    expect(w.store.attempts[0]!.submittedAt).toBeInstanceOf(Date);
  });

  it('scores an attempt with no answers as 0', async () => {
    const w = buildWorld();
    const a = await start(w);
    await expect(w.service.submitAttempt(a.id, as('stu'))).resolves.toMatchObject({ score: 0, maxScore: 4 });
  });

  it('shows the per-question breakdown only when the host asks for it', async () => {
    const w = buildWorld();
    const a = await answered(w, { q1: 0, q2: 0 });
    const r = await w.service.submitAttempt(a.id, as('stu'), { revealAnswers: true });
    expect(r.questions).toEqual([
      { questionId: 'q1', selectedChoiceIndex: 0, correctChoiceIndex: 0, correct: true, points: 1, earned: 1 },
      { questionId: 'q2', selectedChoiceIndex: 0, correctChoiceIndex: 1, correct: false, points: 2, earned: 0 },
      { questionId: 'q3', correctChoiceIndex: 2, correct: false, points: 1, earned: 0 },
    ]);
  });

  it('stores a quiz submission for grading, numbered with the student\'s other submissions, and announces it once', async () => {
    const w = buildWorld();
    const a = await answered(w, { q1: 0 });
    const r = await w.service.submitAttempt(a.id, as('stu'));
    await sleep();
    expect(w.subs).toHaveLength(1);
    expect(w.subs[0]).toMatchObject({ contentId: 'quiz-1', userId: 'stu', payload: { kind: 'quiz', attemptId: a.id }, attemptNumber: 1 });
    expect(w.subs[0]!.submittedAt).toEqual(r.submittedAt);
    expect(r.submissionId).toBe('sub-1');
    expect(w.store.attempts[0]!.submissionId).toBe('sub-1');
    expect(w.ofType('assessment.quizSubmitted')).toEqual([
      { type: 'assessment.quizSubmitted', attemptId: a.id, quizId: 'quiz-1', submissionId: 'sub-1', userId: 'stu', score: 1, maxScore: 4, late: false },
    ]);
    expect(w.ofType('assessment.submissionReceived')).toEqual([]);
    expect(await w.service.attemptsRemaining('quiz-1', 'stu', 3, as('stu'))).toBe(2);
  });

  it('is idempotent: submitting again returns the same result, with no second submission and no second event', async () => {
    const w = buildWorld();
    const a = await answered(w, { q1: 0, q2: 1 });
    const first = await w.service.submitAttempt(a.id, as('stu'));
    await sleep();
    const again = await w.service.submitAttempt(a.id, as('stu'));
    await sleep();
    expect(again).toEqual(first);
    expect(w.subs).toHaveLength(1);
    expect(w.ofType('assessment.quizSubmitted')).toHaveLength(1);
    expect(w.store.calls.closeAttempt).toBe(1);
  });

  it('two simultaneous submits record one submission and one event, and both callers get the result', async () => {
    const w = buildWorld({ slow: true });
    const a = await answered(w, { q1: 0 });
    const [x, y] = await Promise.all([w.service.submitAttempt(a.id, as('stu')), w.service.submitAttempt(a.id, as('stu'))]);
    await sleep();
    expect(x).toMatchObject({ score: 1, maxScore: 4 });
    expect(y).toMatchObject({ score: 1, maxScore: 4 });
    expect(w.subs).toHaveLength(1);
    expect(w.ofType('assessment.quizSubmitted')).toHaveLength(1);
  });

  it('flags a submission after the time limit as late, but still scores what was saved in time', async () => {
    const w = buildWorld({ seed: [{ quizId: 'quiz-1', userId: 'stu', startedAt: new Date(Date.now() - 120_000), answers: { q1: 0 } }] });
    const [a] = w.store.attempts;
    const r = await w.service.submitAttempt(a!.id, as('stu'), { timeLimitSeconds: 60 });
    expect(r).toMatchObject({ late: true, score: 1, maxScore: 4 });
    await sleep();
    expect(w.ofType('assessment.quizSubmitted')).toMatchObject([{ late: true }]);
    const w2 = buildWorld({ seed: [{ quizId: 'quiz-1', userId: 'stu', startedAt: new Date(Date.now() - 120_000) }] });
    await expect(w2.service.submitAttempt(w2.store.attempts[0]!.id, as('stu'), { timeLimitSeconds: 600 })).resolves.toMatchObject({ late: false });
  });

  it('is for the attempt\'s own student alone, even for an administrator', async () => {
    const w = buildWorld();
    const a = await start(w);
    for (const who of ['stu-2', 'teacher', 'ta', 'root', 'stu-b']) {
      await expect(w.service.submitAttempt(a.id, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.submitAttempt(a.id)).rejects.toBeInstanceOf(ActorRequiredError);
    const missing = await w.service.submitAttempt('nope', as('stu')).catch((e) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect(w.store.calls.closeAttempt).toBe(0);
    expect(w.subs).toEqual([]);
  });

  it('works without enforcement, and without a bus', async () => {
    const w = buildWorld({ enforce: false });
    const a = await w.service.generateAttempt('quiz-1', 'stu', false);
    await w.service.saveAnswer(a.id, 'q2', 1);
    await expect(w.service.submitAttempt(a.id)).resolves.toMatchObject({ score: 2, maxScore: 4 });
    await expect(w.service.submitAttempt('nope')).rejects.toThrow('Quiz attempt nope not found');
  });
});

describe('submitAttempt: numbering the submission', () => {
  it('uses the submission repository\'s atomic createAttempt when it has one', async () => {
    const w = buildWorld({ atomicSubmissions: true });
    const a = await start(w);
    const r = await w.service.submitAttempt(a.id, as('stu'));
    expect(w.subCalls.createAttempt).toBe(1);
    expect(w.subCalls.create).toBe(0);
    expect(w.subs[0]).toMatchObject({ payload: { kind: 'quiz', attemptId: a.id }, attemptNumber: 1 });
    expect(r.submissionId).toBe('sub-1');
  });

  it('says loudly if that repository stores nothing, and leaves the quiz submitted so a retry can finish', async () => {
    const w = buildWorld({ atomicSubmissions: 'refuses' });
    const a = await start(w);
    await expect(w.service.submitAttempt(a.id, as('stu'))).rejects.toThrow(/did not store/);
    expect(w.store.attempts[0]!.submittedAt).toBeInstanceOf(Date);
    expect(w.store.attempts[0]!.submissionId).toBeUndefined();
  });

  it('numbers a second quiz attempt after the first', async () => {
    const w = buildWorld();
    const a1 = await start(w);
    await w.service.submitAttempt(a1.id, as('stu'));
    const a2 = await start(w);
    await w.service.submitAttempt(a2.id, as('stu'));
    expect(w.subs.map((s) => s.attemptNumber)).toEqual([1, 2]);
  });
});

describe('submitAttempt: finishing a half-done submission', () => {
  it('when storing the submission fails, the quiz stays submitted and scored, and trying again finishes the job once', async () => {
    const w = buildWorld({ submissionFailsOnce: true });
    const a = await start(w);
    await w.service.saveAnswer(a.id, 'q1', 0, as('stu'));
    await expect(w.service.submitAttempt(a.id, as('stu'))).rejects.toThrow('submission store is down');
    expect(w.store.attempts[0]).toMatchObject({ score: 1, maxScore: 4 });
    expect(w.store.attempts[0]!.submittedAt).toBeInstanceOf(Date);
    expect(w.subs).toEqual([]);
    await sleep();
    expect(w.ofType('assessment.quizSubmitted')).toEqual([]);
    await expect(w.service.saveAnswer(a.id, 'q2', 1, as('stu'))).rejects.toBeInstanceOf(AttemptClosedError);

    const r = await w.service.submitAttempt(a.id, as('stu'));
    await sleep();
    expect(r).toMatchObject({ score: 1, maxScore: 4, submissionId: 'sub-1' });
    expect(w.subs).toHaveLength(1);
    expect(w.ofType('assessment.quizSubmitted')).toHaveLength(1);
    expect(w.store.calls.closeAttempt).toBe(1);
  });
});

describe('submitAttempt: automatic grading', () => {
  it('is off unless asked for: no grade is recorded', async () => {
    const w = buildWorld();
    const a = await start(w);
    const r = await w.service.submitAttempt(a.id, as('stu'));
    expect(w.grades).toEqual([]);
    expect(r.gradeEntryId).toBeUndefined();
  });

  it('records the score as a grade for the quiz submission, as the quiz grader, and says which entry it made', async () => {
    const w = buildWorld({ autoGrade: true });
    const a = await start(w);
    await w.service.saveAnswer(a.id, 'q2', 1, as('stu'));
    const r = await w.service.submitAttempt(a.id, as('stu'));
    expect(w.grades).toEqual([{ submissionId: 'sub-1', userId: 'stu', score: 2, maxScore: 4, source: 'system:quiz' }]);
    expect(r.gradeEntryId).toBe('grade-1');
    expect(w.store.attempts[0]!.gradeEntryId).toBe('grade-1');
  });

  it('uses the grader name the host chose', async () => {
    const w = buildWorld({ autoGrade: true, gradeSource: 'system:midterm' });
    const a = await start(w);
    await w.service.submitAttempt(a.id, as('stu'));
    expect(w.grades[0]!.source).toBe('system:midterm');
  });

  it('records no grade for a quiz worth 0 points, but still records the submission', async () => {
    const w = buildWorld({ autoGrade: true, questions: [] });
    const a = await start(w);
    const r = await w.service.submitAttempt(a.id, as('stu'));
    expect(r).toMatchObject({ score: 0, maxScore: 0 });
    expect(w.subs).toHaveLength(1);
    expect(w.grades).toEqual([]);
  });

  it('grades once: submitting again does not grade again', async () => {
    const w = buildWorld({ autoGrade: true });
    const a = await start(w);
    await w.service.submitAttempt(a.id, as('stu'));
    await w.service.submitAttempt(a.id, as('stu'));
    expect(w.grades).toHaveLength(1);
    expect(w.subs).toHaveLength(1);
  });

  it('when the gradebook fails, the quiz stays submitted and trying again grades it without a second submission', async () => {
    const w = buildWorld({ autoGrade: true, gradeFailsOnce: true });
    const a = await start(w);
    await w.service.saveAnswer(a.id, 'q1', 0, as('stu'));
    await expect(w.service.submitAttempt(a.id, as('stu'))).rejects.toThrow('gradebook is down');
    expect(w.subs).toHaveLength(1);
    expect(w.grades).toEqual([]);
    const r = await w.service.submitAttempt(a.id, as('stu'));
    await sleep();
    expect(r.gradeEntryId).toBe('grade-1');
    expect(w.subs).toHaveLength(1);
    expect(w.grades).toHaveLength(1);
    expect(w.ofType('assessment.quizSubmitted')).toHaveLength(1);
  });
});

describe('getResult', () => {
  const submitted = async (w: ReturnType<typeof buildWorld>) => {
    const a = await start(w);
    await w.service.saveAnswer(a.id, 'q1', 0, as('stu'));
    await w.service.submitAttempt(a.id, as('stu'));
    return a;
  };

  it('shows the owner their score, without the answers, unless the host reveals them', async () => {
    const w = buildWorld();
    const a = await submitted(w);
    const r = await w.service.getResult(a.id, as('stu'));
    expect(r).toMatchObject({ attemptId: a.id, score: 1, maxScore: 4, late: false, userId: 'stu' });
    expect(r).not.toHaveProperty('questions');
    const revealed = await w.service.getResult(a.id, as('stu'), { revealAnswers: true });
    expect(revealed.questions).toHaveLength(3);
    expect(revealed.questions![0]).toMatchObject({ questionId: expect.any(String), correctChoiceIndex: expect.any(Number) });
  });

  it('shows staff of the section, and admins, the full breakdown', async () => {
    const w = buildWorld();
    const a = await submitted(w);
    for (const who of ['teacher', 'ta', 'root']) {
      const r = await w.service.getResult(a.id, as(who));
      expect(r.questions).toHaveLength(3);
      expect(r.score).toBe(1);
    }
  });

  it('refuses other students, another section\'s student, another organization\'s admin, no actor, and an unknown attempt, all alike', async () => {
    const w = buildWorld();
    const a = await submitted(w);
    const refusals = await Promise.all(['stu-2', 'stu-b', 'root-b'].map((who) => w.service.getResult(a.id, as(who)).catch((e) => e)));
    const missing = await w.service.getResult('nope', as('stu')).catch((e) => e);
    for (const e of [...refusals, missing]) expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(new Set([...refusals, missing].map((e) => e.message)).size).toBe(1);
    await expect(w.service.getResult(a.id)).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('refuses an attempt that has not been submitted yet', async () => {
    const w = buildWorld();
    const a = await start(w);
    await expect(w.service.getResult(a.id, as('stu'))).rejects.toBeInstanceOf(AttemptNotSubmittedError);
    await expect(w.service.getResult(a.id, as('teacher'))).rejects.toBeInstanceOf(AttemptNotSubmittedError);
  });

  it('without enforcement, shows the breakdown only when asked', async () => {
    const w = buildWorld({ enforce: false });
    const a = await w.service.generateAttempt('quiz-1', 'stu', false);
    await w.service.submitAttempt(a.id);
    expect(await w.service.getResult(a.id)).not.toHaveProperty('questions');
    expect((await w.service.getResult(a.id, undefined, { revealAnswers: true })).questions).toHaveLength(3);
  });
});

describe('the new actions', () => {
  it('are for the owning student only: no staff roles, not delegable', () => {
    for (const name of ['assessment.answerQuiz', 'assessment.submitQuiz'] as const) {
      const rule = DEFAULT_RULES[name];
      expect(rule.ownRoles).toEqual(['student']);
      expect('roles' in rule).toBe(false);
      expect('delegable' in rule).toBe(false);
    }
  });
});
