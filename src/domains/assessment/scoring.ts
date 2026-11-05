import { InvalidQuizQuestionError, questionTypeOf } from './types.js';
import type { QuestionResult, QuizAnswer, QuizQuestion, QuizScore } from './types.js';

/**
 * Throws `InvalidQuizQuestionError` if a question cannot be scored: no prompt, invalid `points` or
 * `penalty`, an answer key that does not fit its choices, an empty list of accepted answers, and so
 * on. `scoreQuiz` runs it on every question it scores; call it yourself when a quiz is authored, to
 * refuse a broken question before any student meets it.
 */
export function validateQuizQuestion(q: QuizQuestion): void {
  const bad = (reason: string): never => {
    throw new InvalidQuizQuestionError(String((q as { id?: unknown })?.id), reason);
  };
  if (typeof q?.id !== 'string' || q.id === '') bad('it needs an id');
  if (typeof q.prompt !== 'string') bad('it needs a prompt');
  if (q.points !== undefined && !nonNegative(q.points)) bad('points must be a finite number from 0 up');
  if (q.penalty !== undefined && !nonNegative(q.penalty)) bad('penalty must be a finite number from 0 up');

  switch (q.type ?? 'single_choice') {
    case 'single_choice': {
      const c = q as Extract<QuizQuestion, { correctChoiceIndex: number }>;
      if (!validChoices(c.choices)) bad('it needs a list of choices');
      if (!isIndex(c.correctChoiceIndex, c.choices.length)) bad('correctChoiceIndex must be one of its choices');
      return;
    }
    case 'multiple_choice': {
      const c = q as Extract<QuizQuestion, { type: 'multiple_choice' }>;
      if (!validChoices(c.choices)) bad('it needs a list of choices');
      const key = c.correctChoiceIndexes;
      if (!Array.isArray(key) || key.length === 0) bad('correctChoiceIndexes needs at least one choice');
      if (!key.every((i) => isIndex(i, c.choices.length))) bad('every correct choice must be one of its choices');
      if (new Set(key).size !== key.length) bad('correctChoiceIndexes has a repeat');
      if (c.scoring !== undefined && c.scoring !== 'all_or_nothing' && c.scoring !== 'partial') bad("scoring must be 'all_or_nothing' or 'partial'");
      return;
    }
    case 'true_false': {
      if (typeof (q as { correctAnswer?: unknown }).correctAnswer !== 'boolean') bad('correctAnswer must be true or false');
      return;
    }
    case 'short_answer': {
      const c = q as Extract<QuizQuestion, { type: 'short_answer' }>;
      if (!Array.isArray(c.acceptedAnswers) || c.acceptedAnswers.length === 0 || !c.acceptedAnswers.every((a) => typeof a === 'string' && a.trim() !== '')) {
        bad('acceptedAnswers needs at least one non-empty answer');
      }
      if (c.maxLength !== undefined && !positiveInteger(c.maxLength)) bad('maxLength must be a whole number above 0');
      return;
    }
    case 'numeric': {
      const c = q as Extract<QuizQuestion, { type: 'numeric' }>;
      if (typeof c.correctValue !== 'number' || !Number.isFinite(c.correctValue)) bad('correctValue must be a finite number');
      if (c.tolerance !== undefined && !nonNegative(c.tolerance)) bad('tolerance must be a finite number from 0 up');
      return;
    }
    case 'essay': {
      const c = q as Extract<QuizQuestion, { type: 'essay' }>;
      if (c.maxLength !== undefined && !positiveInteger(c.maxLength)) bad('maxLength must be a whole number above 0');
      return;
    }
    default:
      bad(`unknown question type '${String((q as { type?: unknown }).type)}'`);
  }
}

/**
 * Scores a quiz attempt. Pure: no repository, no clock.
 *
 * Each question earns up to its `points` (default 1), according to its type (see `QuizQuestion`).
 * A wrong answer to a question with a `penalty` earns minus that penalty. An unanswered question
 * earns 0, never less. The total (`score`) never goes below 0.
 *
 * `manualScores` (question id to points) replace the automatic result for those questions. An
 * `essay` question has no automatic result: without a manual score it is `pending`, earns 0 for
 * now, and is counted in `pendingReview`.
 *
 * Only the questions in `order` (the attempt's own list, in its order) are scored, and a question
 * since removed from the quiz is skipped, so `maxScore` is what this attempt could have earned.
 * Without `order` every question counts, in the order given.
 */
export function scoreQuiz(
  questions: QuizQuestion[],
  answers: Record<string, QuizAnswer>,
  order?: string[],
  manualScores: Record<string, number> = {},
): QuizScore {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const scored = order ? order.map((id) => byId.get(id)).filter((q): q is QuizQuestion => q !== undefined) : questions;

  const results: QuestionResult[] = [];
  let total = 0;
  let maxScore = 0;
  let pendingReview = 0;
  for (const q of scored) {
    validateQuizQuestion(q);
    const result = scoreQuestion(q, answers[q.id], manualScores[q.id]);
    if (result.status === 'pending') pendingReview++;
    total += result.earned;
    maxScore += result.points;
    results.push(result);
  }
  return { score: Math.max(0, tidy(total)), maxScore: tidy(maxScore), pendingReview, questions: results };
}

/**
 * Scores one question (already validated). `manual`, when given, is the hand score and wins over
 * the automatic result.
 */
function scoreQuestion(q: QuizQuestion, answer: QuizAnswer | undefined, manual: number | undefined): QuestionResult {
  const type = questionTypeOf(q);
  const points = q.points ?? 1;
  const key = answerKey(q);
  const base = {
    questionId: q.id,
    type,
    points,
    ...(answer !== undefined ? { answer: structuredClone(answer) } : {}),
    ...(key !== undefined ? { correctAnswer: key } : {}),
    ...(type === 'single_choice'
      ? {
          ...(typeof answer === 'number' ? { selectedChoiceIndex: answer } : {}),
          correctChoiceIndex: (q as { correctChoiceIndex: number }).correctChoiceIndex,
        }
      : {}),
  };

  if (manual !== undefined) {
    return { ...base, status: 'graded', correct: manual === points, earned: manual };
  }
  if (type === 'essay') {
    return { ...base, status: answer === undefined ? 'unanswered' : 'pending', correct: false, earned: 0 };
  }
  if (answer === undefined) {
    return { ...base, status: 'unanswered', correct: false, earned: 0 };
  }

  const fraction = creditFor(q, answer);
  if (fraction >= 1) return { ...base, status: 'correct', correct: true, earned: points };
  if (fraction > 0) return { ...base, status: 'partial', correct: false, earned: tidy(points * fraction) };
  return { ...base, status: 'incorrect', correct: false, earned: q.penalty ? -q.penalty : 0 };
}

/** The share of the points an answer earns, from 0 to 1. An answer of the wrong kind earns 0. */
function creditFor(q: QuizQuestion, answer: QuizAnswer): number {
  switch (q.type ?? 'single_choice') {
    case 'single_choice':
      return answer === (q as { correctChoiceIndex: number }).correctChoiceIndex ? 1 : 0;
    case 'multiple_choice': {
      const c = q as Extract<QuizQuestion, { type: 'multiple_choice' }>;
      if (!Array.isArray(answer)) return 0;
      const picked = new Set(answer);
      const right = new Set(c.correctChoiceIndexes);
      const hits = [...picked].filter((i) => right.has(i)).length;
      const misses = picked.size - hits;
      if (c.scoring === 'partial') return Math.max(0, (hits - misses) / right.size);
      return hits === right.size && misses === 0 ? 1 : 0;
    }
    case 'true_false':
      return answer === (q as { correctAnswer: boolean }).correctAnswer ? 1 : 0;
    case 'short_answer': {
      const c = q as Extract<QuizQuestion, { type: 'short_answer' }>;
      if (typeof answer !== 'string') return 0;
      const norm = (text: string) => {
        const spaced = text.trim().replace(/\s+/g, ' ');
        return c.caseSensitive ? spaced : spaced.toLocaleLowerCase();
      };
      const given = norm(answer);
      return c.acceptedAnswers.some((a) => norm(a) === given) ? 1 : 0;
    }
    case 'numeric': {
      const c = q as Extract<QuizQuestion, { type: 'numeric' }>;
      if (typeof answer !== 'number' || !Number.isFinite(answer)) return 0;
      // A hair of slack, so a tolerance of 0.1 accepts 1.1 for 1.0 despite floating point.
      return Math.abs(answer - c.correctValue) <= (c.tolerance ?? 0) + 1e-9 ? 1 : 0;
    }
    default:
      return 0;
  }
}

/** The key as a result shows it; undefined for an essay. */
function answerKey(q: QuizQuestion): QuestionResult['correctAnswer'] {
  switch (q.type ?? 'single_choice') {
    case 'single_choice':
      return (q as { correctChoiceIndex: number }).correctChoiceIndex;
    case 'multiple_choice':
      return [...(q as { correctChoiceIndexes: number[] }).correctChoiceIndexes].sort((a, b) => a - b);
    case 'true_false':
      return (q as { correctAnswer: boolean }).correctAnswer;
    case 'short_answer':
      return [...(q as { acceptedAnswers: string[] }).acceptedAnswers];
    case 'numeric':
      return (q as { correctValue: number }).correctValue;
    default:
      return undefined;
  }
}

/** Rounds away floating-point dust (0.1 + 0.2), keeping six decimals. */
function tidy(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const nonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const positiveInteger = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
const isIndex = (i: unknown, length: number): boolean => Number.isInteger(i) && (i as number) >= 0 && (i as number) < length;
const validChoices = (choices: unknown): choices is string[] =>
  Array.isArray(choices) && choices.length > 0 && choices.every((c) => typeof c === 'string');
