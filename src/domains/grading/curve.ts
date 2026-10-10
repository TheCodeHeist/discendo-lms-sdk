/**
 * Curving. Pure: no repository, no clock, no side effects. A curve works on **percentages** (0 and up,
 * normally 0 to 100) and returns new percentages in the same order. It never lowers anyone: a grade the
 * curve would not raise comes back exactly as it was.
 */
export type Curve =
  /** Add `points` percentage points to everyone. `points` must be a finite number from 0 up. */
  | { kind: 'flat'; points: number }
  /** Scale so the best score becomes `target` (default 100). Does nothing if the best score is already there. */
  | { kind: 'scaleToTop'; target?: number }
  /** `10 * sqrt(percent)`: 36 becomes 60, 100 stays 100. */
  | { kind: 'sqrt' }
  /** Shift everyone by the same amount so the class average reaches `mean`. Does nothing if it is already there. */
  | { kind: 'targetMean'; mean: number }
  /** Map the range `fromMin..fromMax` onto `toMin..toMax` along a straight line, which carries on beyond both ends. */
  | { kind: 'linear'; fromMin: number; fromMax: number; toMin: number; toMax: number };

export interface CurveOptions {
  /**
   * The most a curve may raise anyone to. Default 100. `null` removes the cap, for courses with extra
   * credit. A grade already above the cap is left as it is.
   */
  cap?: number | null;
  /** Round each curved value to this many decimals (0 to 10). Default: no rounding. */
  decimals?: number;
}

/**
 * Curves a class's percentages for one piece of work. Pass everyone who counts (curves such as
 * `scaleToTop` and `targetMean` look at the whole class) and nobody who does not. Returns a new list;
 * the input is not changed. Throws on a percentage that is negative or not finite, and on a curve or
 * option that makes no sense.
 *
 * Nothing is stored: to record the result, regrade through `GradingService.recordGrade` with
 * `previousEntryId`, which keeps the audit trail.
 */
export function applyCurve(percents: number[], curve: Curve, options: CurveOptions = {}): number[] {
  for (const p of percents) {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) {
      throw new Error('percents must be finite numbers from 0 up');
    }
  }
  const cap = options.cap === undefined ? 100 : options.cap;
  if (cap !== null && (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0)) {
    throw new Error('cap must be a finite number above zero, or null for no cap');
  }
  const decimals = options.decimals;
  if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 10)) {
    throw new Error('decimals must be a whole number from 0 to 10');
  }

  const curved = curvedValues(percents, curve);
  const factor = decimals === undefined ? undefined : 10 ** decimals;
  return percents.map((p, i) => {
    let value = curved[i]!;
    if (cap !== null) value = Math.min(value, cap);
    if (factor !== undefined) value = Math.round(value * factor) / factor;
    // Never lower: a grade the curve does not raise (including one above the cap) stays exactly as it was.
    return Math.max(p, value);
  });
}

/**
 * `applyCurve` for grade entries (anything with a `score` and a `maxScore`): each entry's percentage is
 * curved and the entry comes back as a copy with a new `score` and the same `maxScore`. An entry the
 * curve does not raise keeps its exact score. Throws on an entry with a negative or non-finite score or
 * a maximum that is not above zero. Nothing is stored.
 */
export function curveEntries<T extends { score: number; maxScore: number }>(
  entries: T[],
  curve: Curve,
  options: CurveOptions = {},
): T[] {
  const percents = entries.map((e) => {
    if (!Number.isFinite(e.score) || e.score < 0 || !Number.isFinite(e.maxScore) || e.maxScore <= 0) {
      throw new Error('every entry needs a score from 0 up and a maxScore above zero');
    }
    return (e.score / e.maxScore) * 100;
  });
  const out = applyCurve(percents, curve, options);
  return entries.map((e, i) => ({ ...e, score: out[i] === percents[i] ? e.score : (out[i]! / 100) * e.maxScore }));
}

function curvedValues(percents: number[], curve: Curve): number[] {
  switch (curve.kind) {
    case 'flat': {
      if (typeof curve.points !== 'number' || !Number.isFinite(curve.points) || curve.points < 0) {
        throw new Error('flat curve: points must be a finite number from 0 up (a curve never lowers grades)');
      }
      return percents.map((p) => p + curve.points);
    }
    case 'scaleToTop': {
      const target = curve.target ?? 100;
      if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
        throw new Error('scaleToTop curve: target must be a finite number above zero');
      }
      const top = Math.max(0, ...percents);
      return top > 0 ? percents.map((p) => (p * target) / top) : percents.slice();
    }
    case 'sqrt':
      return percents.map((p) => 10 * Math.sqrt(p));
    case 'targetMean': {
      if (typeof curve.mean !== 'number' || !Number.isFinite(curve.mean) || curve.mean < 0) {
        throw new Error('targetMean curve: mean must be a finite number from 0 up');
      }
      // An average already at or above the target gives a shift of zero or less, which the never-lower rule in `applyCurve` ignores.
      const current = percents.reduce((a, b) => a + b, 0) / percents.length;
      const shift = curve.mean - current;
      return percents.map((p) => p + shift);
    }
    case 'linear': {
      const { fromMin, fromMax, toMin, toMax } = curve;
      if (![fromMin, fromMax, toMin, toMax].every((n) => typeof n === 'number' && Number.isFinite(n)) || fromMax <= fromMin || toMax <= toMin) {
        throw new Error('linear curve: each range must be finite and rise (min below max)');
      }
      const slope = (toMax - toMin) / (fromMax - fromMin);
      return percents.map((p) => toMin + (p - fromMin) * slope);
    }
    default:
      throw new Error(`Unknown curve: ${String((curve as { kind?: unknown }).kind)}`);
  }
}
