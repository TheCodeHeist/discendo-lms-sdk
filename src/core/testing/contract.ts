/**
 * The plumbing shared by every repository contract suite and in-memory repository in the SDK.
 *
 * A contract suite is a plain list of `ContractCase`s: each has a name and an async `run` that
 * throws on failure. That keeps the suites free of any test runner, so a host can run them under
 * whatever it already uses:
 *
 * ```ts
 * import { describe, it } from 'vitest'; // or 'bun:test', or Jest's globals
 * import { enrollmentRepositoryContract } from 'discendo-sdk/testing';
 *
 * describe('my Postgres EnrollmentRepository', () => {
 *   for (const c of enrollmentRepositoryContract(async () => makeRepoOnAFreshSchema())) it(c.name, c.run);
 * });
 * ```
 */

/** One check a repository implementation must pass. `run` throws `ContractViolation` on failure. */
export interface ContractCase {
  name: string;
  run: () => Promise<void>;
}

/** Thrown by a contract case whose expectation was not met. */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

/** A factory for a fresh, empty repository. Called once per case, so cases cannot leak into each other. */
export type RepositoryFactory<R> = () => R | Promise<R>;

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractViolation(message);
}

export function checkEqual<T>(actual: T, expected: T, message: string): void {
  if (!deepEqual(actual, expected)) {
    throw new ContractViolation(`${message}\n  expected: ${show(expected)}\n  actual:   ${show(actual)}`);
  }
}

/** Ids as a set, for checking the result of a list without depending on its order. */
export function idsOf(rows: ReadonlyArray<{ id: string }>): string[] {
  return rows.map((r) => r.id).sort();
}

/** Prefixes every case's name, so a host's test report shows which suite a failure came from. */
export function suite(prefix: string, cases: ContractCase[]): ContractCase[] {
  return cases.map((c) => ({ name: `${prefix}: ${c.name}`, run: c.run }));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  // Undefined-valued keys count as absent, as they would after a round trip through a database.
  const keys = (o: object) => Object.keys(o).filter((k) => (o as Record<string, unknown>)[k] !== undefined).sort();
  const ka = keys(a);
  const kb = keys(b);
  return deepEqual(ka, kb) && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A per-instance id generator for in-memory repositories: `prefix-1`, `prefix-2`, ... Each
 * repository instance gets its own, so two stores never depend on each other's counters.
 */
export function idSequence(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/**
 * A deep copy, so a caller that mutates what a repository returned cannot change what is stored,
 * which is what a real database guarantees too. Dates stay Dates.
 */
export function copy<T>(value: T): T {
  return structuredClone(value);
}
