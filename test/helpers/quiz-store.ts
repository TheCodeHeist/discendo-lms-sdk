import type { QuizAttempt, QuizQuestion, QuizRepository } from '../../src/domains/assessment/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));

/** An in-memory quiz repository for tests, with the atomic `closeAttempt` / `saveAnswer` the contract asks for. */
export function makeQuizStore(
  questions: QuizQuestion[] = [],
  opts: { slow?: boolean; slowQuestions?: boolean; seed?: Array<Partial<QuizAttempt> & Pick<QuizAttempt, 'quizId' | 'userId'>> } = {},
) {
  const attempts: QuizAttempt[] = [];
  let seq = 0;
  const calls = { createAttempt: 0, closeAttempt: 0, updateAttempt: 0, saveAnswer: 0, findAttempt: 0 };
  const make = (a: Partial<QuizAttempt> & Pick<QuizAttempt, 'quizId' | 'userId'>): QuizAttempt => ({
    id: `attempt-${++seq}`,
    questionOrder: questions.map((q) => q.id),
    startedAt: new Date(),
    ...a,
  });
  for (const s of opts.seed ?? []) attempts.push(make(s));

  const repo: QuizRepository = {
    getQuestions: async () => {
      if (opts.slowQuestions) await sleep();
      return questions;
    },
    createAttempt: async (a) => {
      calls.createAttempt++;
      const row = { ...a, id: `attempt-${++seq}` };
      attempts.push(row);
      return row;
    },
    findAttempt: async (id) => {
      calls.findAttempt++;
      const found = attempts.find((a) => a.id === id);
      return found ? { ...found, ...(found.answers ? { answers: { ...found.answers } } : {}) } : null;
    },
    findOpenAttempt: async (quizId, userId) =>
      [...attempts].reverse().find((a) => a.quizId === quizId && a.userId === userId && a.submittedAt === undefined) ?? null,
    saveAnswer: async (attemptId, questionId, choiceIndex) => {
      calls.saveAnswer++;
      const a = attempts.find((x) => x.id === attemptId);
      if (!a || a.submittedAt !== undefined) return null;
      a.answers = { ...(a.answers ?? {}), [questionId]: choiceIndex };
      return { ...a };
    },
    closeAttempt: async (attemptId, result) => {
      calls.closeAttempt++;
      if (opts.slow) await sleep();
      const a = attempts.find((x) => x.id === attemptId);
      if (!a || a.submittedAt !== undefined) return null;
      Object.assign(a, result);
      return { ...a };
    },
    updateAttempt: async (attemptId, patch) => {
      calls.updateAttempt++;
      const a = attempts.find((x) => x.id === attemptId)!;
      Object.assign(a, patch);
      return { ...a };
    },
  };
  return { repo, attempts, calls };
}

/**
 * For tests about something else: the answering half of the repository is never touched, and
 * `findOpenAttempt` says nobody has an open attempt, so `generateAttempt` always starts a new one.
 */
export const unusedQuizAttempts: Pick<
  QuizRepository,
  'findAttempt' | 'findOpenAttempt' | 'saveAnswer' | 'closeAttempt' | 'updateAttempt'
> = {
  findAttempt: async () => {
    throw new Error('not used in this test');
  },
  findOpenAttempt: async () => null,
  saveAnswer: async () => {
    throw new Error('not used in this test');
  },
  closeAttempt: async () => {
    throw new Error('not used in this test');
  },
  updateAttempt: async () => {
    throw new Error('not used in this test');
  },
};
