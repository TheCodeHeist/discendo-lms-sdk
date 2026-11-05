import { describe, expect, it } from 'bun:test';
import { PermissionDeniedError, createRolePolicy } from '../src/core/index.js';
import { AdminService } from '../src/services/admin/index.js';
import type { AuditEntry, AuditRepository } from '../src/services/admin/index.js';
import { InMemoryAuditRepository, InMemoryUserRepository } from '../src/testing/index.js';

const as = (actorId: string) => ({ actorId });
const at = (iso: string) => new Date(iso);

function world() {
  const users = new InMemoryUserRepository().seed(
    { id: 'admin-a', roles: ['admin'], orgId: 'a' },
    { id: 'admin-b', roles: ['admin'], orgId: 'b' },
    { id: 'head-a', roles: ['instructor'], orgId: 'a', adminOfDepartments: ['sci'] },
    { id: 'teacher-a', roles: ['instructor'], orgId: 'a' },
  );
  const audit = new InMemoryAuditRepository();
  const admin = new AdminService(audit, { enforcement: { policy: createRolePolicy(), repos: { users } } });
  return { audit, admin, users };
}

async function seed(audit: InMemoryAuditRepository) {
  const rows: Array<Omit<AuditEntry, 'id'>> = [];
  for (let day = 1; day <= 9; day++) {
    rows.push({ actorId: day % 2 ? 'teacher-a' : 'admin-a', orgId: 'a', action: day === 5 ? 'grading.record' : 'content.publish', targetId: `t${day}`, timestamp: at(`2026-09-0${day}T12:00:00Z`) });
  }
  rows.push({ actorId: 'admin-b', orgId: 'b', action: 'content.publish', targetId: 't1', timestamp: at('2026-09-05T12:00:00Z') });
  for (const r of rows) await audit.append(r);
}

describe('AdminService.searchAudit', () => {
  it('searches by actor, action and dates in the admin\'s own organization, newest first, a page at a time', async () => {
    const { audit, admin } = await world();
    await seed(audit);
    const first = await admin.searchAudit({ actorId: 'teacher-a', limit: 2 }, as('admin-a'));
    expect(first.entries.map((e) => e.targetId)).toEqual(['t9', 't7']);
    const second = await admin.searchAudit({ actorId: 'teacher-a', limit: 2, cursor: first.nextCursor! }, as('admin-a'));
    expect(second.entries.map((e) => e.targetId)).toEqual(['t5', 't3']);
    const last = await admin.searchAudit({ actorId: 'teacher-a', limit: 2, cursor: second.nextCursor! }, as('admin-a'));
    expect(last).toEqual({ entries: [expect.objectContaining({ targetId: 't1' })] });

    expect((await admin.searchAudit({ action: 'grading.record' }, as('admin-a'))).entries.map((e) => e.targetId)).toEqual(['t5']);
    const window = await admin.searchAudit({ from: at('2026-09-03T00:00:00Z'), to: at('2026-09-04T23:59:59Z') }, as('admin-a'));
    expect(window.entries.map((e) => e.targetId)).toEqual(['t4', 't3']);
  });

  it('never leaves the admin\'s organization, whatever orgId the query names', async () => {
    const { audit, admin } = await world();
    await seed(audit);
    const fromB = await admin.searchAudit({ orgId: 'a' }, as('admin-b'));
    expect(fromB.entries.map((e) => [e.actorId, e.orgId])).toEqual([['admin-b', 'b']]);
  });

  it('re-checks the organization of what the repository returns', async () => {
    const { audit, users } = await world();
    await seed(audit);
    const leaky: AuditRepository = {
      append: (e) => audit.append(e),
      listForTarget: (t) => audit.listForTarget(t),
      query: async ({ orgId: _ignored, ...rest }) => audit.query(rest), // ignores the organization
    };
    const admin = new AdminService(leaky, { enforcement: { policy: createRolePolicy(), repos: { users } } });
    const page = await admin.searchAudit({ limit: 500 }, as('admin-b'));
    expect(page.entries.every((e) => e.orgId === 'b')).toBe(true);
  });

  it('is for organization admins only: not instructors, not department admins', async () => {
    const { admin } = await world();
    await expect(admin.searchAudit({}, as('teacher-a'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(admin.searchAudit({}, as('head-a'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses a limit out of range and dates in the wrong order', async () => {
    const { admin } = await world();
    await expect(admin.searchAudit({ limit: 0 }, as('admin-a'))).rejects.toThrow('limit');
    await expect(admin.searchAudit({ limit: 501 }, as('admin-a'))).rejects.toThrow('limit');
    await expect(admin.searchAudit({ from: at('2026-09-02'), to: at('2026-09-01') }, as('admin-a'))).rejects.toThrow('from');
  });

  it('needs a repository that can search', async () => {
    const { audit } = await world();
    const plain = new AdminService({ append: (e) => audit.append(e), listForTarget: (t) => audit.listForTarget(t) });
    await expect(plain.searchAudit({})).rejects.toThrow('AuditRepository.query');
  });
});
