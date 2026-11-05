import { copy, idSequence } from './contract.js';

/**
 * The storage behind every in-memory repository: rows by id, in insertion order, handed out as
 * copies. Exported so a host writing its own in-memory repository (for an interface of its own, or
 * a variant of one of the SDK's) can reuse it.
 *
 * Every method is synchronous, so a repository method that does its check and its write in one
 * call, with no `await` in between, is atomic: nothing else can run in the middle. That is how the
 * in-memory repositories implement the optional atomic methods (`createIfSeatFree` and friends).
 */
export class InMemoryTable<T extends { id: string }> {
  private readonly rows = new Map<string, T>();
  private readonly nextId: () => string;

  constructor(
    prefix: string,
    /** Used in error messages: "<label> x not found". */
    private readonly label: string = prefix,
  ) {
    this.nextId = idSequence(prefix);
  }

  /** Stores a row under a new id and returns a copy of it. */
  insert(row: Omit<T, 'id'>): T {
    const stored = { ...copy(row), id: this.nextId() } as T;
    this.rows.set(stored.id, stored);
    return copy(stored);
  }

  /** Stores a row with the id it already has (seeding), replacing any row with that id. */
  put(row: T): T {
    this.rows.set(row.id, copy(row));
    return copy(row);
  }

  get(id: string): T | null {
    const row = this.rows.get(id);
    return row ? copy(row) : null;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  /** Merges `patch` into the row and returns a copy; throws if there is no such row. */
  update(id: string, patch: Partial<T>): T {
    const row = this.rows.get(id);
    if (!row) throw new Error(`${this.label} ${id} not found`);
    const next = { ...row, ...copy(patch), id } as T;
    this.rows.set(id, next);
    return copy(next);
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  /** Copies of the rows that match, in insertion order. */
  where(predicate: (row: T) => boolean = () => true): T[] {
    const out: T[] = [];
    for (const row of this.rows.values()) if (predicate(row)) out.push(copy(row));
    return out;
  }

  /** Counts rows without copying them. */
  count(predicate: (row: T) => boolean): number {
    let n = 0;
    for (const row of this.rows.values()) if (predicate(row)) n++;
    return n;
  }

  /** The last row that matches, by insertion order (the most recent), or null. */
  last(predicate: (row: T) => boolean): T | null {
    let found: T | undefined;
    for (const row of this.rows.values()) if (predicate(row)) found = row;
    return found ? copy(found) : null;
  }
}
