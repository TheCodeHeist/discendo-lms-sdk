/** Contract suites for the admin repositories. See `core/testing/contract.ts` for how to run them. */
import { check, checkEqual, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { AuditRepository } from '../service.js';

const at = (iso: string) => new Date(iso);

export function auditRepositoryContract(make: RepositoryFactory<AuditRepository>): ContractCase[] {
  return suite('AuditRepository', [
    {
      name: 'append stores every field, diff and outcome included',
      run: async () => {
        const repo = await make();
        const entry = {
          actorId: 'admin',
          orgId: 'org-a',
          action: 'grading.record',
          targetId: 'sub1',
          timestamp: at('2026-09-12T00:00:00Z'),
          diff: { score: { before: 7, after: 9 } },
        };
        const stored = await repo.append(entry);
        check(typeof stored.id === 'string' && stored.id !== '', 'append returns a non-empty id');
        checkEqual(stored, { ...entry, id: stored.id }, 'append returns the entry');
        const { diff: _diff, ...withoutDiff } = entry;
        const denied = await repo.append({ ...withoutDiff, outcome: 'denied' });
        checkEqual(denied.outcome, 'denied', 'outcome stored');
      },
    },
    {
      name: "listForTarget returns that target's entries, oldest first",
      run: async () => {
        const repo = await make();
        const base = { actorId: 'admin', action: 'x', targetId: 't1' };
        await repo.append({ ...base, timestamp: at('2026-09-01') });
        await repo.append({ ...base, timestamp: at('2026-09-02') });
        await repo.append({ ...base, targetId: 't2', timestamp: at('2026-09-03') });
        const listed = await repo.listForTarget('t1');
        checkEqual(listed.map((e) => e.timestamp.toISOString().slice(0, 10)), ['2026-09-01', '2026-09-02'], 't1, oldest first');
      },
    },
  ]);
}
