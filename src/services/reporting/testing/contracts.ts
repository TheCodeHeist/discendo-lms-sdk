/** Contract suites for the reporting repositories. See `core/testing/contract.ts` for how to run them. */
import { checkEqual, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { AttendanceRepository } from '../service.js';

const at = (iso: string) => new Date(iso);

export function attendanceRepositoryContract(make: RepositoryFactory<AttendanceRepository>): ContractCase[] {
  return suite('AttendanceRepository', [
    {
      name: "record stores every field, and listForSession returns only that session's records",
      run: async () => {
        const repo = await make();
        const mark = { sessionId: 'occ1', userId: 'u1', status: 'late' as const, recordedAt: at('2026-09-01T09:05:00Z'), recordedBy: 't1' };
        await repo.record(mark);
        await repo.record({ sessionId: 'occ1', userId: 'u2', status: 'present', recordedAt: at('2026-09-01T09:00:00Z') });
        await repo.record({ sessionId: 'occ2', userId: 'u1', status: 'absent', recordedAt: at('2026-09-02T09:00:00Z') });
        const listed = await repo.listForSession('occ1');
        checkEqual(listed.map((r) => r.userId).sort(), ['u1', 'u2'], 'two marks in occ1');
        checkEqual(listed.find((r) => r.userId === 'u1'), mark, 'stored as given');
        checkEqual(await repo.listForSession('occ-none'), [], 'none for an unknown session');
      },
    },
  ]);
}
