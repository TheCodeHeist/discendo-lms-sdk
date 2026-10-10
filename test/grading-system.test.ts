import { describe, it, expect } from 'bun:test';
import { GradingService, InvalidGradeError, SystemGraderNotAllowedError } from '../src/domains/grading/index.js';
import type { GradeEntry, GradeRepository, GradingEnforcement } from '../src/domains/grading/index.js';
import { EventBus, createRolePolicy } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));

function build(opts: { systemGraders?: string[]; enforce?: boolean; extraCredit?: boolean; located?: { sectionId: string; userId: string } | null } = {}) {
  const entries: GradeEntry[] = [];
  const grades: GradeRepository = {
    create: async (e) => {
      const entry = { ...e, id: `grade-${entries.length + 1}` } as GradeEntry;
      entries.push(entry);
      return entry;
    },
    findById: async (id) => entries.find((e) => e.id === id) ?? null,
    markSuperseded: async () => {},
    listForUserInSection: async () => [],
  };
  const bus = new EventBus();
  const events: LmsEvent[] = [];
  bus.on('*', (e) => void events.push(e));
  const enforcement: GradingEnforcement | undefined = opts.enforce
    ? {
        policy: createRolePolicy(),
        repos: {} as GradingEnforcement['repos'],
        submissions: { locate: async () => (opts.located === undefined ? { sectionId: 'sec-a', userId: 'stu' } : opts.located) },
      }
    : undefined;
  const service = new GradingService(grades, bus, enforcement, {
    ...(opts.systemGraders ? { systemGraders: opts.systemGraders } : {}),
    ...(opts.extraCredit ? { allowExtraCredit: true } : {}),
  });
  return { service, entries, events };
}

describe('GradingService.recordSystemGrade', () => {
  it('records a grade under the named system grader, and announces it like any other grade', async () => {
    const w = build({ systemGraders: ['system:quiz'] });
    const entry = await w.service.recordSystemGrade('sub-1', 'stu', 3, 4, 'system:quiz');
    await sleep();
    expect(entry).toMatchObject({ submissionId: 'sub-1', userId: 'stu', score: 3, maxScore: 4, graderId: 'system:quiz' });
    expect(entry.gradedAt).toBeInstanceOf(Date);
    expect(w.entries).toHaveLength(1);
    expect(w.events).toEqual([
      { type: 'grading.gradePosted', gradeEntryId: entry.id, submissionId: 'sub-1', userId: 'stu', score: 3, maxScore: 4, graderId: 'system:quiz' },
    ]);
  });

  it('refuses a grader the host did not list, and everything when none are listed', async () => {
    const none = build();
    await expect(none.service.recordSystemGrade('s', 'u', 1, 2, 'system:quiz')).rejects.toBeInstanceOf(SystemGraderNotAllowedError);
    const other = build({ systemGraders: ['system:quiz'] });
    await expect(other.service.recordSystemGrade('s', 'u', 1, 2, 'system:exam')).rejects.toMatchObject({ name: 'SystemGraderNotAllowedError', source: 'system:exam' });
    expect(none.entries).toEqual([]);
    expect(other.entries).toEqual([]);
  });

  it('never accepts a grader name without the system: prefix, even when listed, so it cannot pass for a person', async () => {
    const w = build({ systemGraders: ['teacher-1'] });
    await expect(w.service.recordSystemGrade('s', 'u', 1, 2, 'teacher-1')).rejects.toBeInstanceOf(SystemGraderNotAllowedError);
    expect(w.entries).toEqual([]);
  });

  it('checks the numbers like any grade, and honors allowExtraCredit', async () => {
    const w = build({ systemGraders: ['system:quiz'] });
    for (const [score, max] of [[-1, 4], [5, 4], [1, 0], [Number.NaN, 4]] as const) {
      await expect(w.service.recordSystemGrade('s', 'u', score, max, 'system:quiz')).rejects.toBeInstanceOf(InvalidGradeError);
    }
    expect(w.entries).toEqual([]);
    const extra = build({ systemGraders: ['system:quiz'], extraCredit: true });
    await expect(extra.service.recordSystemGrade('s', 'u', 5, 4, 'system:quiz')).resolves.toMatchObject({ score: 5 });
  });

  it('needs no actor even with enforcement on, because the host named the grader', async () => {
    const w = build({ systemGraders: ['system:quiz'], enforce: true });
    await expect(w.service.recordSystemGrade('sub-1', 'stu', 1, 2, 'system:quiz')).resolves.toMatchObject({ graderId: 'system:quiz' });
  });

  it('with enforcement on, refuses a submission that is not that person\'s, or does not exist, and stores nothing', async () => {
    const mismatch = build({ systemGraders: ['system:quiz'], enforce: true });
    await expect(mismatch.service.recordSystemGrade('sub-1', 'someone-else', 1, 2, 'system:quiz')).rejects.toThrow(/does not belong/);
    const missing = build({ systemGraders: ['system:quiz'], enforce: true, located: null });
    await expect(missing.service.recordSystemGrade('sub-1', 'stu', 1, 2, 'system:quiz')).rejects.toThrow(/not found/);
    expect(mismatch.entries).toEqual([]);
    expect(missing.entries).toEqual([]);
  });
});
