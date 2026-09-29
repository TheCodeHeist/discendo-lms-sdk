import { describe, it, expect } from 'bun:test';
import { computeFinalGrade, toLetterGrade, applyLatePolicy } from '../src/domains/grading/index.js';
import type { GradeEntry } from '../src/domains/grading/index.js';

function entry(score: number, maxScore: number): GradeEntry {
  return {
    id: crypto.randomUUID(),
    submissionId: 's1',
    userId: 'u1',
    score,
    maxScore,
    graderId: 'g1',
    gradedAt: new Date(),
  };
}

describe('computeFinalGrade', () => {
  it('weights categories correctly', () => {
    const byCategory = new Map([
      ['homework', [entry(8, 10), entry(9, 10)]],
      ['exams', [entry(70, 100)]],
    ]);
    const result = computeFinalGrade(byCategory, {
      categories: [
        { name: 'homework', weight: 0.4 },
        { name: 'exams', weight: 0.6 },
      ],
    });
    // homework avg = 0.85, exams avg = 0.70 -> 0.85*0.4 + 0.70*0.6 = 0.76 -> 76
    expect(result).toBeCloseTo(76, 5);
  });

  it('drops lowest N within a category', () => {
    const byCategory = new Map([['homework', [entry(0, 10), entry(10, 10), entry(10, 10)]]]);
    const result = computeFinalGrade(byCategory, {
      categories: [{ name: 'homework', weight: 1, dropLowestN: 1 }],
    });
    expect(result).toBeCloseTo(100, 5);
  });

  it('renormalizes when a category has no grades yet', () => {
    const byCategory = new Map([['homework', [entry(10, 10)]]]);
    const result = computeFinalGrade(byCategory, {
      categories: [
        { name: 'homework', weight: 0.5 },
        { name: 'exams', weight: 0.5 },
      ],
    });
    expect(result).toBeCloseTo(100, 5);
  });
});

describe('toLetterGrade', () => {
  it('picks the correct band', () => {
    const scale = [
      { minPercent: 90, label: 'A' },
      { minPercent: 80, label: 'B' },
      { minPercent: 0, label: 'F' },
    ];
    expect(toLetterGrade(95, scale)).toBe('A');
    expect(toLetterGrade(85, scale)).toBe('B');
    expect(toLetterGrade(50, scale)).toBe('F');
  });
});

describe('applyLatePolicy', () => {
  it('applies flat per-day penalty capped at max', () => {
    const result = applyLatePolicy(100, 100, 5, {
      kind: 'flatPenalty',
      percentPerDay: 10,
      maxPenaltyPercent: 30,
    });
    expect(result).toBe(70); // 5 days * 10% = 50%, capped to 30%
  });

  it('cutoff policy zeroes out after threshold', () => {
    const result = applyLatePolicy(100, 100, 10, { kind: 'cutoff', afterDays: 7 });
    expect(result).toBe(0);
  });
});
