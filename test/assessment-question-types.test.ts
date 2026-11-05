import { describe, expect, it } from 'bun:test';
import {
  AttemptLimitReachedError,
  InvalidAnswerError,
  InvalidManualScoreError,
  InvalidQuizQuestionError,
  WrongContentKindError,
  scoreQuiz,
  validateQuizQuestion,
} from '../src/domains/assessment/index.js';
import type { QuizQuestion } from '../src/domains/assessment/index.js';
import { PermissionDeniedError } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';
import { createInMemoryLms } from '../src/testing/index.js';

const MC: QuizQuestion = { id: 'mc', type: 'multiple_choice', prompt: 'Primes?', choices: ['2', '3', '4', '5'], correctChoiceIndexes: [0, 1, 3], points: 3 };
const MC_PARTIAL: QuizQuestion = { ...MC, id: 'mcp', scoring: 'partial' } as QuizQuestion;
const TF: QuizQuestion = { id: 'tf', type: 'true_false', prompt: 'The sun is a star.', correctAnswer: true };
const SA: QuizQuestion = { id: 'sa', type: 'short_answer', prompt: 'Capital of France?', acceptedAnswers: ['Paris'] };
const NUM: QuizQuestion = { id: 'num', type: 'numeric', prompt: 'g in m/s²?', correctValue: 9.81, tolerance: 0.05, points: 2 };
const ESSAY: QuizQuestion = { id: 'essay', type: 'essay', prompt: 'Explain photosynthesis.', points: 5, maxLength: 2000 };

const one = (q: QuizQuestion, answer: unknown, manual?: number) =>
  scoreQuiz([q], answer === undefined ? {} : { [q.id]: answer as never }, undefined, manual === undefined ? {} : { [q.id]: manual }).questions[0]!;

describe('scoreQuiz: every question type', () => {
  it('multiple choice, all or nothing: only exactly the right set scores, in any order', () => {
    expect(one(MC, [3, 0, 1])).toMatchObject({ status: 'correct', earned: 3, correctAnswer: [0, 1, 3] });
    expect(one(MC, [0, 1])).toMatchObject({ status: 'incorrect', earned: 0 });
    expect(one(MC, [0, 1, 2, 3])).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('multiple choice, partial: a share per right pick, minus a share per wrong pick, never below 0', () => {
    expect(one(MC_PARTIAL, [0, 1])).toMatchObject({ status: 'partial', earned: 2 });
    expect(one(MC_PARTIAL, [0, 1, 2])).toMatchObject({ status: 'partial', earned: 1 });
    expect(one(MC_PARTIAL, [0, 2])).toMatchObject({ status: 'incorrect', earned: 0 });
    expect(one(MC_PARTIAL, [2])).toMatchObject({ status: 'incorrect', earned: 0 });
    expect(one(MC_PARTIAL, [0, 1, 3])).toMatchObject({ status: 'correct', earned: 3, correct: true });
  });

  it('true/false', () => {
    expect(one(TF, true)).toMatchObject({ status: 'correct', earned: 1, correctAnswer: true });
    expect(one(TF, false)).toMatchObject({ status: 'incorrect', earned: 0 });
  });

  it('short answer ignores case, surrounding spaces and repeated spaces; caseSensitive turns case back on', () => {
    expect(one(SA, '  paris ')).toMatchObject({ status: 'correct', correctAnswer: ['Paris'] });
    expect(one({ ...SA, acceptedAnswers: ['New York'] } as QuizQuestion, 'new   york')).toMatchObject({ status: 'correct' });
    expect(one({ ...SA, caseSensitive: true } as QuizQuestion, 'paris')).toMatchObject({ status: 'incorrect' });
    expect(one(SA, 'Lyon')).toMatchObject({ status: 'incorrect' });
  });

  it('numeric accepts anything within the tolerance, edges included', () => {
    expect(one(NUM, 9.81)).toMatchObject({ status: 'correct', earned: 2 });
    expect(one(NUM, 9.86)).toMatchObject({ status: 'correct' });
    expect(one(NUM, 9.87)).toMatchObject({ status: 'incorrect' });
    const exact: QuizQuestion = { id: 'exact', type: 'numeric', prompt: '?', correctValue: 9.81 };
    expect(one(exact, 9.8)).toMatchObject({ status: 'incorrect' });
  });

  it('an essay is pending until scored by hand, and has no answer key', () => {
    const pending = one(ESSAY, 'Plants make sugar from light.');
    expect(pending).toMatchObject({ status: 'pending', earned: 0, points: 5 });
    expect(pending.correctAnswer).toBeUndefined();
    expect(one(ESSAY, undefined)).toMatchObject({ status: 'unanswered' });
    expect(one(ESSAY, 'text', 4)).toMatchObject({ status: 'graded', earned: 4, correct: false });
    expect(scoreQuiz([ESSAY, TF], { essay: 'x', tf: true })).toMatchObject({ score: 1, maxScore: 6, pendingReview: 1 });
  });

  it('a hand score replaces the automatic result of any type', () => {
    expect(one(SA, 'Pariss', 1)).toMatchObject({ status: 'graded', earned: 1, correct: true });
  });

  it('keeps single choice exactly as before, and treats a question with no type as single choice', () => {
    const q: QuizQuestion = { id: 'q', prompt: '?', choices: ['a', 'b'], correctChoiceIndex: 1 };
    expect(one(q, 1)).toMatchObject({ type: 'single_choice', status: 'correct', selectedChoiceIndex: 1, correctChoiceIndex: 1 });
  });

  it('an answer of the wrong kind earns nothing rather than throwing (the service refuses it earlier)', () => {
    expect(one(MC, 1)).toMatchObject({ status: 'incorrect', earned: 0 });
    expect(one(NUM, '9.81')).toMatchObject({ status: 'incorrect', earned: 0 });
  });
});

describe('scoreQuiz: negative marking', () => {
  const penalised = (q: QuizQuestion) => ({ ...q, penalty: 0.5 }) as QuizQuestion;

  it('takes the penalty for a wrong answer only: never for a blank, a partial or an essay', () => {
    expect(one(penalised(TF), false)).toMatchObject({ status: 'incorrect', earned: -0.5 });
    expect(one(penalised(TF), undefined)).toMatchObject({ status: 'unanswered', earned: 0 });
    expect(one(penalised(MC_PARTIAL), [0])).toMatchObject({ status: 'partial', earned: 1 });
    expect(one(penalised(ESSAY), 'x')).toMatchObject({ status: 'pending', earned: 0 });
  });

  it('never lets the total go below 0', () => {
    const qs = [penalised(TF), penalised({ ...TF, id: 'tf2' } as QuizQuestion)];
    expect(scoreQuiz(qs, { tf: false, tf2: false })).toMatchObject({ score: 0, maxScore: 2 });
    expect(scoreQuiz(qs, { tf: true, tf2: false })).toMatchObject({ score: 0.5 });
  });
});

describe('validateQuizQuestion', () => {
  const bad: Array<[string, unknown]> = [
    ['no choices', { id: 'x', prompt: '?', choices: [], correctChoiceIndex: 0 }],
    ['a key outside the choices', { id: 'x', prompt: '?', choices: ['a'], correctChoiceIndex: 1 }],
    ['an empty multiple-choice key', { id: 'x', type: 'multiple_choice', prompt: '?', choices: ['a'], correctChoiceIndexes: [] }],
    ['a repeated multiple-choice key', { id: 'x', type: 'multiple_choice', prompt: '?', choices: ['a', 'b'], correctChoiceIndexes: [1, 1] }],
    ['an unknown scoring mode', { id: 'x', type: 'multiple_choice', prompt: '?', choices: ['a'], correctChoiceIndexes: [0], scoring: 'some' }],
    ['a non-boolean true/false key', { id: 'x', type: 'true_false', prompt: '?', correctAnswer: 'yes' }],
    ['no accepted answers', { id: 'x', type: 'short_answer', prompt: '?', acceptedAnswers: [] }],
    ['a blank accepted answer', { id: 'x', type: 'short_answer', prompt: '?', acceptedAnswers: ['  '] }],
    ['a non-finite numeric key', { id: 'x', type: 'numeric', prompt: '?', correctValue: Number.NaN }],
    ['a negative tolerance', { id: 'x', type: 'numeric', prompt: '?', correctValue: 1, tolerance: -1 }],
    ['negative points', { id: 'x', type: 'true_false', prompt: '?', correctAnswer: true, points: -1 }],
    ['a negative penalty', { id: 'x', type: 'true_false', prompt: '?', correctAnswer: true, penalty: -1 }],
    ['an unknown type', { id: 'x', type: 'matching', prompt: '?' }],
  ];
  for (const [what, q] of bad) {
    it(`refuses ${what}`, () => {
      expect(() => validateQuizQuestion(q as QuizQuestion)).toThrow(InvalidQuizQuestionError);
    });
  }
  it('accepts every well-formed type', () => {
    for (const q of [MC, MC_PARTIAL, TF, SA, NUM, ESSAY]) expect(() => validateQuizQuestion(q)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Through the service, on a fully wired in-memory LMS
// ---------------------------------------------------------------------------------------------

const as = (actorId: string) => ({ actorId });
const QUIZ: QuizQuestion[] = [
  { id: 'sc', prompt: 'Pick b', choices: ['a', 'b'], correctChoiceIndex: 1 },
  MC,
  TF,
  SA,
  NUM,
  ESSAY,
];

async function world(questions: QuizQuestion[] = QUIZ) {
  const lms = createInMemoryLms();
  const events: LmsEvent[] = [];
  lms.bus.on('*', (e) => void events.push(e));
  lms.repos.users.seed(
    { id: 'admin', roles: ['admin'] },
    { id: 'teacher', roles: ['instructor'] },
    { id: 'stu', roles: ['student'] },
    { id: 'other', roles: ['student'] },
  );
  lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
  for (const [userId, role] of [['teacher', 'instructor'], ['stu', 'student'], ['other', 'student']] as const) {
    await lms.services.enrollment.enroll({ userId, sectionId: 's', role }, as('admin'));
  }
  const quiz = await lms.services.content.createNode({ sectionId: 's', kind: 'quiz', title: 'Quiz', orderIndex: 0, published: true }, as('teacher'));
  lms.repos.quizzes.seedQuestions(quiz.id, questions);
  const quizEvents = () => events.filter((e) => e.type.startsWith('assessment.quiz'));
  return { lms, quiz, s: lms.services.assessment, quizEvents };
}

/** Every grade entry recorded for an attempt's submission. */
async function gradesOf(lms: ReturnType<typeof createInMemoryLms>, submissionId: string) {
  return lms.repos.grades.listForSubmission(submissionId);
}

describe('AssessmentService with every question type', () => {
  it('shows each question with its type and never its key', async () => {
    const { s, quiz } = await world();
    const a = await s.generateAttempt(quiz.id, 'stu', false, as('stu'));
    const views = await s.getAttemptQuestions(a.id, as('stu'));
    expect(views.map((v) => v.type)).toEqual(['single_choice', 'multiple_choice', 'true_false', 'short_answer', 'numeric', 'essay']);
    expect(views.find((v) => v.id === 'essay')).toEqual({ id: 'essay', type: 'essay', prompt: 'Explain photosynthesis.', choices: [], points: 5, maxLength: 2000 });
    const json = JSON.stringify(views);
    for (const secret of ['correctChoiceIndex', 'correctChoiceIndexes', 'correctAnswer', 'acceptedAnswers', 'Paris', 'correctValue', '9.81']) {
      expect(json).not.toContain(secret);
    }
  });

  it('refuses an answer of the wrong kind or outside the question, and normalizes a multiple-choice answer', async () => {
    const { s, quiz } = await world();
    const a = await s.generateAttempt(quiz.id, 'stu', false, as('stu'));
    const refused = async (q: string, answer: unknown, reason: string) => {
      const error = await s.saveAnswer(a.id, q, answer as never, as('stu')).catch((e) => e);
      expect(error).toBeInstanceOf(InvalidAnswerError);
      expect(error.reason).toBe(reason);
    };
    await refused('sc', 'b', 'wrong-answer-type');
    await refused('sc', 5, 'choice-out-of-range');
    await refused('mc', 0, 'wrong-answer-type');
    await refused('mc', [], 'wrong-answer-type');
    await refused('mc', [0, 0], 'choice-out-of-range');
    await refused('mc', [9], 'choice-out-of-range');
    await refused('tf', 'true', 'wrong-answer-type');
    await refused('num', Number.POSITIVE_INFINITY, 'wrong-answer-type');
    await refused('sa', 42, 'wrong-answer-type');
    await refused('sa', 'x'.repeat(1001), 'answer-too-long');
    await refused('essay', 'x'.repeat(2001), 'answer-too-long');

    const saved = await s.saveAnswer(a.id, 'mc', [3, 0, 1], as('stu'));
    expect(saved.answers?.mc).toEqual([0, 1, 3]);
    const views = await s.getAttemptQuestions(a.id, as('stu'));
    expect(views.find((v) => v.id === 'mc')?.answer).toEqual([0, 1, 3]);
  });

  it('runs the whole essay review: pending on submit, no grade, then scored by hand and graded once', async () => {
    const { lms, s, quiz, quizEvents } = await world();
    const a = await s.generateAttempt(quiz.id, 'stu', false, as('stu'));
    for (const [q, answer] of [['sc', 1], ['mc', [0, 1, 3]], ['tf', true], ['sa', 'paris'], ['num', 9.8], ['essay', 'Light becomes sugar.']] as const) {
      await s.saveAnswer(a.id, q, answer as never, as('stu'));
    }
    const submitted = await s.submitAttempt(a.id, as('stu'));
    expect(submitted).toMatchObject({ score: 8, maxScore: 13, pendingReview: true });
    expect(submitted.gradeEntryId).toBeUndefined();
    expect(await gradesOf(lms, submitted.submissionId!)).toHaveLength(0);
    expect(quizEvents()[0]).toMatchObject({ type: 'assessment.quizSubmitted', score: 8, pendingReview: true });

    // a student cannot score it, not even their own
    await expect(s.gradeQuizQuestion(a.id, 'essay', 5, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    // the score must fit the question
    await expect(s.gradeQuizQuestion(a.id, 'essay', 6, as('teacher'))).rejects.toBeInstanceOf(InvalidManualScoreError);
    await expect(s.gradeQuizQuestion(a.id, 'nope', 1, as('teacher'))).rejects.toBeInstanceOf(InvalidAnswerError);

    const reviewed = await s.gradeQuizQuestion(a.id, 'essay', 4, as('teacher'));
    expect(reviewed).toMatchObject({ score: 12, maxScore: 13, pendingReview: false });
    expect(reviewed.questions?.find((q) => q.questionId === 'essay')).toMatchObject({ status: 'graded', earned: 4 });
    const grades = await gradesOf(lms, submitted.submissionId!);
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({ score: 12, maxScore: 13, graderId: 'system:quiz' });
    expect(quizEvents()[1]).toMatchObject({
      type: 'assessment.quizQuestionGraded',
      questionId: 'essay',
      points: 4,
      score: 12,
      pendingReview: false,
      graderId: 'teacher',
    });

    // the student now sees the final score
    expect(await s.getResult(a.id, as('stu'))).toMatchObject({ score: 12, pendingReview: false, gradeEntryId: grades[0]!.id });
  });

  it('replaces the automatic grade when a question is rescored, keeping the old one as history', async () => {
    const { lms, s, quiz } = await world([SA, TF]);
    const a = await s.generateAttempt(quiz.id, 'stu', false, as('stu'));
    await s.saveAnswer(a.id, 'sa', 'Pariss', as('stu'));
    await s.saveAnswer(a.id, 'tf', true, as('stu'));
    const first = await s.submitAttempt(a.id, as('stu'));
    expect(first).toMatchObject({ score: 1, maxScore: 2, pendingReview: false });

    const fixed = await s.gradeQuizQuestion(a.id, 'sa', 1, as('teacher')); // accept the misspelling
    expect(fixed.score).toBe(2);
    const grades = await gradesOf(lms, first.submissionId!);
    expect(grades.map((g) => [g.score, g.supersededBy === undefined])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(await lms.services.grading.computeFinalGradeForUser('stu', 's', { categories: [{ name: 'quiz', weight: 1 }] }, as('stu'))).toBe(100);
  });

  it('cannot score an attempt that has not been submitted', async () => {
    const { s, quiz } = await world();
    const a = await s.generateAttempt(quiz.id, 'stu', false, as('stu'));
    await expect(s.gradeQuizQuestion(a.id, 'essay', 1, as('teacher'))).rejects.toBeInstanceOf(InvalidManualScoreError);
  });

  it('limits attempts with maxAttempts, but always resumes an open one', async () => {
    const { s, quiz } = await world([TF]);
    const first = await s.generateAttempt(quiz.id, 'stu', false, as('stu'), { maxAttempts: 2 });
    expect((await s.generateAttempt(quiz.id, 'stu', false, as('stu'), { maxAttempts: 1 })).id).toBe(first.id);
    await s.submitAttempt(first.id, as('stu'));
    const second = await s.generateAttempt(quiz.id, 'stu', false, as('stu'), { maxAttempts: 2 });
    await s.submitAttempt(second.id, as('stu'));
    const refused = await s.generateAttempt(quiz.id, 'stu', false, as('stu'), { maxAttempts: 2 }).catch((e) => e);
    expect(refused).toBeInstanceOf(AttemptLimitReachedError);
    expect(refused.message).toBe('No attempts remaining');
    // the limit is per student
    await expect(s.generateAttempt(quiz.id, 'other', false, as('other'), { maxAttempts: 2 })).resolves.toBeDefined();
    await expect(s.generateAttempt(quiz.id, 'other', false, as('other'), { maxAttempts: 0 })).rejects.toThrow('maxAttempts');
  });

  it('refuses to start a quiz attempt on content that is not a quiz', async () => {
    const { lms, s } = await world();
    const page = await lms.services.content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW', orderIndex: 1, published: true }, as('teacher'));
    const error = await s.generateAttempt(page.id, 'stu', false, as('stu')).catch((e) => e);
    expect(error).toBeInstanceOf(WrongContentKindError);
    expect(error).toMatchObject({ expected: 'quiz', actual: 'assignment' });
  });
});
