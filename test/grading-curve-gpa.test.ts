import { describe, it, expect } from 'bun:test';
import { applyCurve, curveEntries, computeGpa, toGpaPoints, STANDARD_GPA_SCALE } from '../src/domains/grading/index.js';
import type { GradeScale } from '../src/domains/grading/index.js';

const close = (actual: number[], expected: number[]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
};

describe('applyCurve: flat', () => {
  it('adds the points to everyone, in the same order', () => {
    close(applyCurve([50, 70, 90], { kind: 'flat', points: 5 }), [55, 75, 95]);
  });

  it('caps at 100 by default, and lets `cap: null` run past it', () => {
    close(applyCurve([50, 96], { kind: 'flat', points: 10 }), [60, 100]);
    close(applyCurve([50, 96], { kind: 'flat', points: 10 }, { cap: null }), [60, 106]);
    close(applyCurve([50, 80], { kind: 'flat', points: 10 }, { cap: 85 }), [60, 85]);
  });

  it('leaves a grade alone that is already above the cap, because a curve never lowers anything', () => {
    close(applyCurve([105, 40], { kind: 'flat', points: 5 }), [105, 45]);
  });

  it('refuses points that would lower grades, or are not numbers', () => {
    for (const points of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => applyCurve([50], { kind: 'flat', points })).toThrow(/points/);
    }
    close(applyCurve([50], { kind: 'flat', points: 0 }), [50]);
  });
});

describe('applyCurve: scaleToTop', () => {
  it('scales so the best score becomes 100, keeping zero at zero', () => {
    close(applyCurve([40, 60, 80, 0], { kind: 'scaleToTop' }), [50, 75, 100, 0]);
  });

  it('can aim at another target', () => {
    close(applyCurve([40, 80], { kind: 'scaleToTop', target: 90 }), [45, 90]);
  });

  it('does nothing when the best score is already at or above the target, instead of lowering everyone', () => {
    close(applyCurve([40, 100], { kind: 'scaleToTop' }), [40, 100]);
    close(applyCurve([40, 110], { kind: 'scaleToTop' }), [40, 110]);
  });

  it('does nothing when everyone scored zero', () => {
    close(applyCurve([0, 0], { kind: 'scaleToTop' }), [0, 0]);
  });

  it('refuses a target that is not above zero', () => {
    for (const target of [0, -5, Number.NaN]) expect(() => applyCurve([50], { kind: 'scaleToTop', target })).toThrow(/target/);
  });
});

describe('applyCurve: sqrt', () => {
  it('takes ten times the square root', () => {
    close(applyCurve([0, 25, 36, 64, 100], { kind: 'sqrt' }), [0, 50, 60, 80, 100]);
  });

  it('never lowers a grade above 100', () => {
    close(applyCurve([121], { kind: 'sqrt' }, { cap: null }), [121]);
  });
});

describe('applyCurve: targetMean', () => {
  it('shifts everyone by the same amount so the average reaches the target', () => {
    const out = applyCurve([40, 50, 60], { kind: 'targetMean', mean: 65 });
    close(out, [55, 65, 75]);
    expect(out.reduce((a, b) => a + b, 0) / 3).toBeCloseTo(65, 9);
  });

  it('does nothing when the average is already at or above the target', () => {
    close(applyCurve([60, 70, 80], { kind: 'targetMean', mean: 70 }), [60, 70, 80]);
    close(applyCurve([60, 70, 80], { kind: 'targetMean', mean: 50 }), [60, 70, 80]);
  });

  it('can fall short of the target when the cap bites', () => {
    close(applyCurve([60, 90], { kind: 'targetMean', mean: 85 }), [70, 100]); // shift 10: 90 caps at 100
  });

  it('refuses a target that is not a finite number from zero up', () => {
    for (const mean of [-1, Number.NaN]) expect(() => applyCurve([50], { kind: 'targetMean', mean })).toThrow(/mean/);
  });
});

describe('applyCurve: linear', () => {
  const curve = { kind: 'linear', fromMin: 40, fromMax: 90, toMin: 60, toMax: 100 } as const;

  it('maps one range onto another', () => {
    close(applyCurve([40, 65, 90], curve), [60, 80, 100]);
  });

  it('carries the line on beyond the range, capped like any curve', () => {
    close(applyCurve([20, 100], curve, { cap: null }), [44, 108]); // 60 + (20-40)*0.8, and 60 + (100-40)*0.8
    close(applyCurve([20, 100], curve), [44, 100]);
  });

  it('never lowers a grade, even where the line runs below it', () => {
    const steep = { kind: 'linear', fromMin: 50, fromMax: 100, toMin: 20, toMax: 100 } as const;
    close(applyCurve([10, 50, 100], steep), [10, 50, 100]); // the line gives -44 and 20 for the first two: both below the grade
  });

  it('refuses ranges that do not make a rising line', () => {
    expect(() => applyCurve([50], { ...curve, fromMax: 40 })).toThrow(/range/);
    expect(() => applyCurve([50], { ...curve, toMax: 60 })).toThrow(/range/);
    expect(() => applyCurve([50], { ...curve, toMin: Number.NaN })).toThrow(/range/);
  });
});

describe('applyCurve: rules for every curve', () => {
  it('returns an empty list for no one, and never changes the list it was given', () => {
    expect(applyCurve([], { kind: 'sqrt' })).toEqual([]);
    const input = [25, 36];
    applyCurve(input, { kind: 'sqrt' });
    expect(input).toEqual([25, 36]);
  });

  it('refuses a percentage that is negative or not a number, naming the problem', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => applyCurve([50, bad], { kind: 'flat', points: 1 })).toThrow(/percent/);
    }
  });

  it('rounds the curved value to `decimals`, but a grade the curve does not raise stays exactly as it was', () => {
    expect(applyCurve([50.123, 99.9], { kind: 'flat', points: 1.0449 }, { decimals: 1 })).toEqual([51.2, 100]);
    expect(applyCurve([84.4, 10], { kind: 'flat', points: 0 }, { decimals: 0 })).toEqual([84.4, 10]);
  });

  it('refuses a cap or a number of decimals that makes no sense', () => {
    for (const cap of [0, -1, Number.NaN]) expect(() => applyCurve([50], { kind: 'flat', points: 1 }, { cap })).toThrow(/cap/);
    for (const decimals of [-1, 1.5, 11, Number.NaN]) expect(() => applyCurve([50], { kind: 'flat', points: 1 }, { decimals })).toThrow(/decimals/);
  });

  it('refuses a curve kind it does not know', () => {
    expect(() => applyCurve([50], { kind: 'cubic' } as never)).toThrow(/curve/);
  });
});

describe('curveEntries', () => {
  const entries = [
    { id: 'a', score: 40, maxScore: 50, graderId: 't' },
    { id: 'b', score: 15, maxScore: 20, graderId: 't' },
    { id: 'c', score: 30, maxScore: 30, graderId: 't' },
  ];

  it('curves each entry\'s percentage and returns new entries with the same maximum', () => {
    const out = curveEntries(entries, { kind: 'flat', points: 10 });
    expect(out.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(out.map((e) => e.maxScore)).toEqual([50, 20, 30]);
    close(out.map((e) => e.score), [45, 17, 30]); // 80+10=90% of 50, 75+10=85% of 20, 100% stays
    expect(out[0]).not.toBe(entries[0]);
    expect(out[0]!.graderId).toBe('t');
  });

  it('leaves a score exactly as it was when the curve does not raise it, and does not touch the originals', () => {
    // 0.1 out of 2.9 goes to a percentage and back as 0.10000000000000002 if it is recomputed
    const odd = [{ score: 0.1, maxScore: 2.9 }, { score: 5, maxScore: 10 }];
    const out = curveEntries(odd, { kind: 'flat', points: 0 });
    expect(out[0]!.score).toBe(0.1);
    expect(odd[0]!.score).toBe(0.1);
  });

  it('accepts a score of zero', () => {
    close(curveEntries([{ score: 0, maxScore: 10 }, { score: 5, maxScore: 10 }], { kind: 'flat', points: 10 }).map((e) => e.score), [1, 6]);
  });

  it('uses all the entries together for curves that look at the class', () => {
    const class90 = [
      { score: 40, maxScore: 50 }, // 80%
      { score: 15, maxScore: 20 }, // 75%
      { score: 27, maxScore: 30 }, // 90%, the best: it becomes 100%
    ];
    const out = curveEntries(class90, { kind: 'scaleToTop' });
    close(out.map((e) => e.score), [(80 * 100) / 90 / 2, (75 * 100) / 90 / 5, 30]);
  });

  it('refuses an entry that has no usable maximum or score', () => {
    for (const bad of [{ score: 5, maxScore: 0 }, { score: -1, maxScore: 10 }, { score: Number.NaN, maxScore: 10 }, { score: 5, maxScore: -10 }, { score: 0, maxScore: 0 }]) {
      expect(() => curveEntries([bad], { kind: 'flat', points: 1 })).toThrow(/every entry needs/);
    }
  });
});

describe('STANDARD_GPA_SCALE and toGpaPoints', () => {
  it('is the US four-point scale with pluses and minuses', () => {
    expect(STANDARD_GPA_SCALE).toEqual({
      'A+': 4.0, A: 4.0, 'A-': 3.7, 'B+': 3.3, B: 3.0, 'B-': 2.7, 'C+': 2.3, C: 2.0, 'C-': 1.7, 'D+': 1.3, D: 1.0, 'D-': 0.7, F: 0.0,
    });
    expect(Object.isFrozen(STANDARD_GPA_SCALE)).toBe(true);
  });

  it('looks a letter up, gives null for an excluded one, and throws for one it does not know', () => {
    expect(toGpaPoints('B+', STANDARD_GPA_SCALE)).toBe(3.3);
    expect(toGpaPoints('P', { ...STANDARD_GPA_SCALE, P: null })).toBeNull();
    expect(() => toGpaPoints('b+', STANDARD_GPA_SCALE)).toThrow(/b\+/);
    expect(() => toGpaPoints('toString', STANDARD_GPA_SCALE)).toThrow(/has no letter 'toString'/);
    expect(() => toGpaPoints('__proto__', STANDARD_GPA_SCALE)).toThrow(/has no letter '__proto__'/);
  });

  it('refuses a scale that gives a letter a negative or non-numeric value', () => {
    expect(() => toGpaPoints('A', { A: -1 })).toThrow(/points/);
    expect(() => toGpaPoints('A', { A: Number.NaN })).toThrow(/points/);
  });
});

describe('computeGpa', () => {
  const scale = { ...STANDARD_GPA_SCALE, P: null, W: null };

  it('averages the points weighted by credits', () => {
    const gpa = computeGpa([{ credits: 4, letter: 'A' }, { credits: 3, letter: 'B' }, { credits: 1, letter: 'C' }], scale);
    expect(gpa).toBeCloseTo((4 * 4 + 3 * 3 + 1 * 2) / 8, 9);
  });

  it('leaves out courses whose letter is excluded, credits and all', () => {
    expect(computeGpa([{ credits: 4, letter: 'A' }, { credits: 6, letter: 'P' }, { credits: 3, letter: 'W' }], scale)).toBe(4);
  });

  it('is null when nothing counts: no courses, only excluded letters, or only zero credits', () => {
    expect(computeGpa([], scale)).toBeNull();
    expect(computeGpa([{ credits: 3, letter: 'P' }], scale)).toBeNull();
    expect(computeGpa([{ credits: 0, letter: 'A' }], scale)).toBeNull();
  });

  it('counts an F as zero points, not as missing', () => {
    expect(computeGpa([{ credits: 3, letter: 'A' }, { credits: 3, letter: 'F' }], scale)).toBe(2);
  });

  it('ignores a course with no credits but still checks its letter', () => {
    expect(computeGpa([{ credits: 4, letter: 'B' }, { credits: 0, letter: 'A' }], scale)).toBe(3);
    expect(() => computeGpa([{ credits: 0, letter: 'Z' }], scale)).toThrow(/Z/);
  });

  it('adds a course\'s bonus only when it earned points', () => {
    const gpa = computeGpa([{ credits: 3, letter: 'A', bonus: 1 }, { credits: 3, letter: 'F', bonus: 1 }, { credits: 3, letter: 'B' }], scale);
    expect(gpa).toBeCloseTo((3 * 5 + 3 * 0 + 3 * 3) / 9, 9);
  });

  it('takes a percentage through your letter scale', () => {
    const letters: GradeScale = [{ minPercent: 90, label: 'A' }, { minPercent: 80, label: 'B' }, { minPercent: 0, label: 'F' }];
    const gpa = computeGpa([{ credits: 2, percent: 93 }, { credits: 2, percent: 85 }, { credits: 2, letter: 'C' }], scale, { letterScale: letters });
    expect(gpa).toBeCloseTo((2 * 4 + 2 * 3 + 2 * 2) / 6, 9);
  });

  it('refuses a percentage with no letter scale, or one that falls outside it', () => {
    expect(() => computeGpa([{ credits: 3, percent: 90 }], scale)).toThrow(/letterScale/);
    const high: GradeScale = [{ minPercent: 50, label: 'A' }];
    expect(() => computeGpa([{ credits: 3, percent: 10 }], scale, { letterScale: high })).toThrow(/N\/A/);
  });

  it('wants exactly one of letter or percent on each course', () => {
    const letters: GradeScale = [{ minPercent: 0, label: 'A' }];
    expect(() => computeGpa([{ credits: 3 }], scale)).toThrow(/letter or percent/);
    expect(() => computeGpa([{ credits: 3, letter: 'A', percent: 90 }], scale, { letterScale: letters })).toThrow(/letter or percent/);
  });

  it('refuses credits or a bonus that are negative or not numbers, and a letter that is not in the scale', () => {
    for (const credits of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => computeGpa([{ credits, letter: 'A' }], scale)).toThrow(/credits/);
    }
    for (const bonus of [-1, Number.NaN]) {
      expect(() => computeGpa([{ credits: 3, letter: 'A', bonus }], scale)).toThrow(/bonus/);
    }
    expect(() => computeGpa([{ credits: 3, letter: 'a' }], scale)).toThrow(/a/);
  });

  it('rounds to `decimals` when asked, and not otherwise', () => {
    const courses = [{ credits: 3, letter: 'A' }, { credits: 3, letter: 'B-' }, { credits: 1, letter: 'C' }];
    expect(computeGpa(courses, scale)).toBeCloseTo(22.1 / 7, 9);
    expect(computeGpa(courses, scale, { decimals: 2 })).toBe(3.16);
    expect(computeGpa(courses, scale, { decimals: 0 })).toBe(3);
    expect(() => computeGpa(courses, scale, { decimals: -1 })).toThrow(/decimals/);
    expect(() => computeGpa(courses, scale, { decimals: 1.5 })).toThrow(/decimals/);
  });

  it('works with a scale of your own', () => {
    expect(computeGpa([{ credits: 2, letter: 'Distinction' }, { credits: 2, letter: 'Pass' }], { Distinction: 5, Pass: 3 })).toBe(4);
  });
});
