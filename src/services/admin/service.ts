export interface AuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  timestamp: Date;
  diff?: Record<string, { before: unknown; after: unknown }>;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry>;
  listForTarget(targetId: string): Promise<AuditEntry[]>;
}

/**
 * Wrap this around any mutation in the host app to get audit logging
 * without scattering log calls through every service:
 *
 *   await withAudit(auditRepo, 'grade.update', gradeId, actorId, () =>
 *     gradingService.recordGrade(...)
 *   );
 */
export async function withAudit<T>(
  audit: AuditRepository,
  action: string,
  targetId: string,
  actorId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();
  await audit.append({ actorId, action, targetId, timestamp: new Date() });
  return result;
}

export class AdminService {
  constructor(private readonly audit: AuditRepository) {}

  async history(targetId: string): Promise<AuditEntry[]> {
    return this.audit.listForTarget(targetId);
  }
}
