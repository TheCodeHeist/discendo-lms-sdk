import type { QuizQuestion, QuizScore, QuestionResult } from './types.js';

/**
 * Scores a quiz attempt. Pure: no repository, no clock.
 *
 * Each question is worth its `points` (default 1) when the answer is exactly its
 * `correctChoiceIndex`; a wrong or missing answer earns 0, never less. Only the questions in `order`
 * (the attempt's own list, in its order) are scored, and a question that has since been removed from
 * the quiz is skipped, so `maxScore` is what this attempt could have earned. Without `order` every
 * question counts, in the order given.
 */
export function scoreQuiz(
  questions: QuizQuestion[],
  answers: Record<string, number>,
  order?: string[],
): QuizScore {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const scored = order ? order.map((id) => byId.get(id)).filter((q): q is QuizQuestion => q !== undefined) : questions;

  const results: QuestionResult[] = [];
  let score = 0;
  let maxScore = 0;
  for (const q of scored) {
    const points = q.points ?? 1;
    if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) {
      throw new Error(`Question ${q.id} has invalid points: they must be a finite number from 0 up`);
    }
    const selected = answers[q.id];
    const correct = selected === q.correctChoiceIndex;
    const earned = correct ? points : 0;
    score += earned;
    maxScore += points;
    results.push({
      questionId: q.id,
      ...(selected !== undefined ? { selectedChoiceIndex: selected } : {}),
      correctChoiceIndex: q.correctChoiceIndex,
      correct,
      points,
      earned,
    });
  }
  return { score, maxScore, questions: results };
}
