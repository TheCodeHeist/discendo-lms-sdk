import { toLetterGrade } from './calculations.js';
import type { GradeScale } from './types.js';

/**
 * Letter to grade points. A letter mapped to `null` (pass, withdrawn, incomplete) is **left out** of the
 * GPA, credits included. A letter that is not in the scale at all is an error, so a typo is caught.
 */
export type GpaScale = Record<string, number | null>;

/** The US four-point scale with pluses and minuses (A+ counts as 4.0). Frozen; spread it to extend it. */
export const STANDARD_GPA_SCALE: Readonly<GpaScale> = Object.freeze({
  'A+': 4.0,
  A: 4.0,
  'A-': 3.7,
  'B+': 3.3,
  B: 3.0,
  'B-': 2.7,
  'C+': 2.3,
  C: 2.0,
  'C-': 1.7,
  'D+': 1.3,
  D: 1.0,
  'D-': 0.7,
  F: 0.0,
});

/** One course's contribution: its credits and a final grade given either as a `letter` or a `percent` (not both). */
export interface GpaCourse {
  credits: number;
  letter?: string;
  percent?: number;
  /**
   * Extra points for a weighted course (honors, AP), added only when the course earned more than 0 points,
   * so an F stays 0. A finite number from 0 up. Default 0.
   */
  bonus?: number;
}

export interface GpaOptions {
  /** Needed when a course gives a `percent`: the bands that turn it into a letter (as for `toLetterGrade`). */
  letterScale?: GradeScale;
  /** Round the result to this many decimals (0 to 10). Default: no rounding. */
  decimals?: number;
}

/** The grade points for `letter`, or `null` if the scale excludes it. Throws for a letter the scale does not have. */
export function toGpaPoints(letter: string, scale: GpaScale): number | null {
  if (!Object.prototype.hasOwnProperty.call(scale, letter)) {
    throw new Error(`The GPA scale has no letter '${letter}'`);
  }
  const points = scale[letter];
  if (points === null) return null;
  if (typeof points !== 'number' || !Number.isFinite(points) || points < 0) {
    throw new Error(`The GPA scale gives '${letter}' invalid points: they must be a finite number from 0 up, or null`);
  }
  return points;
}

/**
 * Credit-weighted grade point average. Pure. Courses with an excluded letter, and courses worth zero
 * credits, count for nothing; if nothing counts the result is `null`, not 0. Every course is checked first,
 * so a bad letter, credit value or bonus throws even on a course that would not count.
 *
 * The SDK does not know a course's credits or which attempt of a repeated course should count: gather each
 * section's final grade (`computeFinalGradeForUser`, or its letter) and credits yourself and pass them in.
 */
export function computeGpa(courses: GpaCourse[], scale: GpaScale, options: GpaOptions = {}): number | null {
  const decimals = options.decimals;
  if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 10)) {
    throw new Error('decimals must be a whole number from 0 to 10');
  }

  let weighted = 0;
  let credits = 0;
  for (const course of courses) {
    if (typeof course.credits !== 'number' || !Number.isFinite(course.credits) || course.credits < 0) {
      throw new Error('credits must be a finite number from 0 up');
    }
    const bonus = course.bonus ?? 0;
    if (typeof bonus !== 'number' || !Number.isFinite(bonus) || bonus < 0) {
      throw new Error('bonus must be a finite number from 0 up');
    }
    if ((course.letter === undefined) === (course.percent === undefined)) {
      throw new Error('each course needs exactly one of letter or percent');
    }
    let letter = course.letter;
    if (letter === undefined) {
      if (!options.letterScale) throw new Error('a course given as a percent needs the letterScale option');
      letter = toLetterGrade(course.percent!, options.letterScale);
    }
    const points = toGpaPoints(letter, scale);
    if (points === null) continue; // excluded letters count for nothing; so do zero credits, which weigh nothing
    weighted += (points > 0 ? points + bonus : points) * course.credits;
    credits += course.credits;
  }
  if (credits === 0) return null;
  const gpa = weighted / credits;
  if (decimals === undefined) return gpa;
  const factor = 10 ** decimals;
  return Math.round(gpa * factor) / factor;
}
