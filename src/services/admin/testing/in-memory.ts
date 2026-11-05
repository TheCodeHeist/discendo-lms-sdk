/** In-memory audit log, kept in this process only. */
import { InMemoryTable } from '../../../core/testing/table.js';
import type { AuditEntry, AuditPage, AuditQuery, AuditRepository } from '../service.js';

/** Append-only: there is no way to change or remove an entry. `listForTarget` is oldest first. */
export class InMemoryAuditRepository implements AuditRepository {
  private readonly entries = new InMemoryTable<AuditEntry>('audit', 'Audit entry');

  async append(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry> {
    return this.entries.insert(entry);
  }

  async listForTarget(targetId: string): Promise<AuditEntry[]> {
    return this.entries.where((e) => e.targetId === targetId);
  }

  /** Keyset pagination over (timestamp, id), newest first; the cursor is the last entry's key. */
  async query(q: AuditQuery & { limit: number }): Promise<AuditPage> {
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const matches = this.entries
      .where(
        (e) =>
          (q.orgId === undefined || (q.orgId === null ? e.orgId === undefined : e.orgId === q.orgId)) &&
          (q.actorId === undefined || e.actorId === q.actorId) &&
          (q.targetId === undefined || e.targetId === q.targetId) &&
          (q.action === undefined || e.action === q.action) &&
          (q.outcome === undefined || (q.outcome === 'denied' ? e.outcome === 'denied' : e.outcome === undefined)) &&
          (q.from === undefined || e.timestamp.getTime() >= q.from.getTime()) &&
          (q.to === undefined || e.timestamp.getTime() <= q.to.getTime()),
      )
      .sort(newestFirst)
      .filter((e) => !after || newestFirst(e, after) > 0);
    const entries = matches.slice(0, q.limit);
    const last = entries[entries.length - 1];
    return matches.length > q.limit && last ? { entries, nextCursor: encodeCursor(last) } : { entries };
  }
}

function newestFirst(a: Pick<AuditEntry, 'timestamp' | 'id'>, b: Pick<AuditEntry, 'timestamp' | 'id'>): number {
  return b.timestamp.getTime() - a.timestamp.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function encodeCursor(e: AuditEntry): string {
  return `${e.timestamp.getTime()}:${e.id}`;
}

function decodeCursor(cursor: string): Pick<AuditEntry, 'timestamp' | 'id'> {
  const at = cursor.indexOf(':');
  const time = Number(cursor.slice(0, at));
  if (at < 0 || !Number.isFinite(time)) throw new Error('Invalid audit cursor');
  return { timestamp: new Date(time), id: cursor.slice(at + 1) };
}
