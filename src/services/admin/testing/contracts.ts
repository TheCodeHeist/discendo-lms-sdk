/** Contract suites for the admin repositories. See `core/testing/contract.ts` for how to run them. */
import { check, checkEqual, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { AuditEntry, AuditPage, AuditRepository } from '../service.js';

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
    {
      name: 'query (if implemented) filters by every field, newest first, and "no organization" is null',
      run: async () => {
        const repo = await make();
        if (!repo.query) return;
        const add = (over: Partial<Omit<AuditEntry, 'id'>>) =>
          repo.append({ actorId: 'a1', action: 'grade', targetId: 't1', timestamp: at('2026-09-01T00:00:00Z'), orgId: 'o1', ...over });
        const e1 = await add({});
        const e2 = await add({ timestamp: at('2026-09-02T00:00:00Z'), actorId: 'a2' });
        const e3 = await add({ timestamp: at('2026-09-03T00:00:00Z'), outcome: 'denied' });
        const e4 = await repo.append({ actorId: 'a1', action: 'grade', targetId: 't1', timestamp: at('2026-09-04T00:00:00Z') });
        const ids = async (q: Parameters<NonNullable<AuditRepository['query']>>[0]) => (await repo.query!(q)).entries.map((e) => e.id);
        checkEqual(await ids({ orgId: 'o1', limit: 10 }), [e3.id, e2.id, e1.id], 'o1, newest first');
        checkEqual(await ids({ orgId: null, limit: 10 }), [e4.id], 'no organization');
        checkEqual(await ids({ actorId: 'a2', limit: 10 }), [e2.id], 'by actor');
        checkEqual(await ids({ outcome: 'denied', limit: 10 }), [e3.id], 'refusals');
        checkEqual(await ids({ outcome: 'allowed', orgId: 'o1', limit: 10 }), [e2.id, e1.id], 'actions that happened');
        checkEqual(await ids({ from: at('2026-09-02T00:00:00Z'), to: at('2026-09-03T00:00:00Z'), limit: 10 }), [e3.id, e2.id], 'dates, inclusive');
      },
    },
    {
      name: 'query (if implemented) pages through everything exactly once, even with entries at the same instant',
      run: async () => {
        const repo = await make();
        if (!repo.query) return;
        const same = at('2026-09-01T00:00:00Z');
        const stored = [];
        for (let i = 0; i < 7; i++) stored.push(await repo.append({ actorId: 'a', action: 'x', targetId: `t${i}`, timestamp: i < 4 ? same : at(`2026-09-0${i}T00:00:00Z`) }));
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page: AuditPage = await repo.query({ limit: 3, ...(cursor ? { cursor } : {}) });
          seen.push(...page.entries.map((e) => e.id));
          cursor = page.nextCursor;
          check(++pages <= 5, 'pagination ends');
        } while (cursor);
        checkEqual([...seen].sort(), stored.map((e) => e.id).sort(), 'every entry once');
        checkEqual(new Set(seen).size, seen.length, 'no repeats');
      },
    },
  ]);
}
