/** In-memory audit log, kept in this process only. */
import { InMemoryTable } from '../../../core/testing/table.js';
import type { AuditEntry, AuditRepository } from '../service.js';

/** Append-only: there is no way to change or remove an entry. `listForTarget` is oldest first. */
export class InMemoryAuditRepository implements AuditRepository {
  private readonly entries = new InMemoryTable<AuditEntry>('audit', 'Audit entry');

  async append(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry> {
    return this.entries.insert(entry);
  }

  async listForTarget(targetId: string): Promise<AuditEntry[]> {
    return this.entries.where((e) => e.targetId === targetId);
  }
}
