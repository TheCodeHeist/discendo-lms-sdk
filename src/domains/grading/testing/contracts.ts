/**
 * Contract suites for the grading repositories. See `core/testing/contract.ts` for how to run
 * them with your test runner.
 */
import { check, checkEqual, idsOf, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { ExcusalRepository, TimeExtensionRepository } from '../accommodations.js';
import type { GradeRepository } from '../service.js';
import type { Excusal, GradeEntry, TimeExtension } from '../types.js';
import type { GradeReleaseRepository } from '../release.js';
import type { GradePlacement } from './in-memory.js';

const at = (iso: string) => new Date(iso);

const entry = (over: Partial<Omit<GradeEntry, 'id'>> = {}): Omit<GradeEntry, 'id'> => ({
  submissionId: 'sub-hw1',
  userId: 'u1',
  score: 8,
  maxScore: 10,
  graderId: 'teacher',
  gradedAt: at('2026-09-12T00:00:00Z'),
  ...over,
});

/**
 * The factory is told where each submission the suite grades belongs (section, category,
 * content), because `listForUserInSection` must return that and a `GradeEntry` does not carry it.
 * In a real database it comes from your submissions and content tables: seed those to match.
 */
export function gradeRepositoryContract(
  make: (placements: Record<string, GradePlacement>) => GradeRepository | Promise<GradeRepository>,
): ContractCase[] {
  const placements: Record<string, GradePlacement> = {
    'sub-hw1': { sectionId: 's1', category: 'homework', contentId: 'hw1' },
    'sub-exam': { sectionId: 's1', category: 'exams', contentId: 'exam' },
    'sub-other': { sectionId: 's2', category: 'homework', contentId: 'hw9' },
  };
  return suite('GradeRepository', [
    {
      name: 'create and findById round-trip',
      run: async () => {
        const repo = await make(placements);
        const created = await repo.create(entry());
        check(typeof created.id === 'string' && created.id !== '', 'create returns a non-empty id');
        checkEqual(await repo.findById(created.id), created, 'findById');
        checkEqual(await repo.findById('nope'), null, 'unknown id');
      },
    },
    {
      name: 'markSuperseded sets supersededBy and keeps the entry',
      run: async () => {
        const repo = await make(placements);
        const first = await repo.create(entry());
        const second = await repo.create(entry({ score: 9 }));
        await repo.markSuperseded(first.id, second.id);
        checkEqual(await repo.findById(first.id), { ...first, supersededBy: second.id }, 'first is superseded, not deleted');
      },
    },
    {
      name: 'supersedeIfCurrent (if implemented) succeeds once, and only one of two concurrent calls wins',
      run: async () => {
        const repo = await make(placements);
        if (!repo.supersedeIfCurrent) return;
        const first = await repo.create(entry());
        const a = await repo.create(entry({ score: 9 }));
        const b = await repo.create(entry({ score: 7 }));
        const results = await Promise.all([repo.supersedeIfCurrent(first.id, a.id), repo.supersedeIfCurrent(first.id, b.id)]);
        checkEqual(results.filter(Boolean).length, 1, 'exactly one wins');
        const winner = results[0] ? a.id : b.id;
        checkEqual((await repo.findById(first.id))?.supersededBy, winner, "the winner's id is recorded");
        checkEqual(await repo.supersedeIfCurrent(first.id, a.id), false, 'no longer current');
      },
    },
    {
      name: "listForUserInSection returns that student's entries in that section, superseded ones included, with category and contentId",
      run: async () => {
        const repo = await make(placements);
        const hw = await repo.create(entry());
        const regrade = await repo.create(entry({ score: 10 }));
        await repo.markSuperseded(hw.id, regrade.id);
        const exam = await repo.create(entry({ submissionId: 'sub-exam', score: 40, maxScore: 50 }));
        await repo.create(entry({ submissionId: 'sub-other' }));
        await repo.create(entry({ userId: 'u2' }));
        const listed = await repo.listForUserInSection('u1', 's1');
        checkEqual(idsOf(listed), idsOf([hw, regrade, exam]), 'three entries in s1');
        const byId = new Map(listed.map((e) => [e.id, e]));
        checkEqual(byId.get(exam.id)?.category, 'exams', 'category of the exam');
        checkEqual(byId.get(hw.id)?.contentId, 'hw1', 'contentId of the homework');
        checkEqual(byId.get(hw.id)?.supersededBy, regrade.id, 'supersededBy is returned (the calculation skips it)');
      },
    },
  ]);
}

function accommodationCases<T extends TimeExtension | Excusal>(
  name: string,
  make: () => Promise<{
    create(e: Omit<T, 'id'>): Promise<T>;
    findById(id: string): Promise<T | null>;
    findActive(userId: string, contentId: string): Promise<T | null>;
    listForContent(contentId: string, options?: { includeRevoked?: boolean }): Promise<T[]>;
    revoke(id: string, at: Date, by: string): Promise<T>;
  }>,
  record: (over: { userId?: string; contentId?: string }) => Omit<T, 'id'>,
): ContractCase[] {
  return [
    {
      name: `${name}: create and findById round-trip`,
      run: async () => {
        const repo = await make();
        const created = await repo.create(record({}));
        checkEqual(await repo.findById(created.id), created, 'findById');
        checkEqual(await repo.findById('nope'), null, 'unknown id');
      },
    },
    {
      name: `${name}: revoke keeps the record and findActive stops returning it`,
      run: async () => {
        const repo = await make();
        const created = await repo.create(record({}));
        checkEqual((await repo.findActive('u1', 'hw1'))?.id, created.id, 'active before');
        const when = at('2026-10-01T00:00:00Z');
        const revoked = await repo.revoke(created.id, when, 'teacher');
        checkEqual([revoked.revokedAt, revoked.revokedBy], [when, 'teacher'], 'revokedAt and revokedBy set');
        checkEqual(await repo.findActive('u1', 'hw1'), null, 'no longer active');
        checkEqual((await repo.findById(created.id))?.revokedBy, 'teacher', 'still stored');
      },
    },
    {
      name: `${name}: listForContent leaves out revoked ones unless includeRevoked`,
      run: async () => {
        const repo = await make();
        const a = await repo.create(record({ userId: 'u1' }));
        const b = await repo.create(record({ userId: 'u2' }));
        await repo.create(record({ contentId: 'hw2' }));
        await repo.revoke(b.id, at('2026-10-01'), 'teacher');
        checkEqual(idsOf(await repo.listForContent('hw1')), [a.id], 'active only');
        checkEqual(idsOf(await repo.listForContent('hw1', { includeRevoked: true })), idsOf([a, b]), 'with revoked');
      },
    },
  ];
}

export function timeExtensionRepositoryContract(make: RepositoryFactory<TimeExtensionRepository>): ContractCase[] {
  return suite(
    'TimeExtensionRepository',
    accommodationCases<TimeExtension>('extension', async () => make(), (over) => ({
      userId: over.userId ?? 'u1',
      contentId: over.contentId ?? 'hw1',
      sectionId: 's1',
      extraSeconds: 86_400,
      grantedBy: 'teacher',
      grantedAt: at('2026-09-05T00:00:00Z'),
    })),
  );
}

export function excusalRepositoryContract(make: RepositoryFactory<ExcusalRepository>): ContractCase[] {
  const excusal = (over: { userId?: string; contentId?: string; sectionId?: string }): Omit<Excusal, 'id'> => ({
    userId: over.userId ?? 'u1',
    contentId: over.contentId ?? 'hw1',
    sectionId: over.sectionId ?? 's1',
    excusedBy: 'teacher',
    excusedAt: at('2026-09-05T00:00:00Z'),
  });
  return suite('ExcusalRepository', [
    ...accommodationCases<Excusal>('excusal', async () => make(), excusal),
    {
      name: "listForUser returns the student's excusals in that section, revoked ones included",
      run: async () => {
        const repo = await make();
        const a = await repo.create(excusal({}));
        const b = await repo.create(excusal({ contentId: 'hw2' }));
        await repo.create(excusal({ sectionId: 's2' }));
        await repo.create(excusal({ userId: 'u2' }));
        await repo.revoke(b.id, at('2026-10-01'), 'teacher');
        checkEqual(idsOf(await repo.listForUser('u1', 's1')), idsOf([a, b]), "u1's excusals in s1");
      },
    },
  ]);
}

export function gradeReleaseRepositoryContract(make: RepositoryFactory<GradeReleaseRepository>): ContractCase[] {
  const release = (contentId: string, sectionId = 's1') => ({ sectionId, contentId, releasedAt: at('2026-10-01T00:00:00Z'), releasedBy: 'teacher' });
  return suite('GradeReleaseRepository', [
    {
      name: 'create and findActive round-trip, per section and content',
      run: async () => {
        const repo = await make();
        const r = await repo.create(release('hw1'));
        check(typeof r.id === 'string' && r.id !== '', 'create returns a non-empty id');
        checkEqual(await repo.findActive('s1', 'hw1'), r, 'findActive');
        checkEqual(await repo.findActive('s2', 'hw1'), null, 'the same content in another section is not released');
        checkEqual(await repo.findActive('s1', 'hw2'), null, 'other content is not released');
      },
    },
    {
      name: 'hide keeps the record, and findActive and listActive stop returning it',
      run: async () => {
        const repo = await make();
        const a = await repo.create(release('hw1'));
        const b = await repo.create(release('hw2'));
        await repo.create(release('hw1', 's2'));
        const when = at('2026-10-02T00:00:00Z');
        const hidden = await repo.hide(a.id, when, 'teacher');
        checkEqual([hidden.hiddenAt, hidden.hiddenBy, hidden.releasedBy], [when, 'teacher', 'teacher'], 'hidden, not deleted');
        checkEqual(await repo.findActive('s1', 'hw1'), null, 'no longer active');
        checkEqual(idsOf(await repo.listActive('s1')), [b.id], 'only hw2 is released in s1');
        const again = await repo.create(release('hw1'));
        checkEqual((await repo.findActive('s1', 'hw1'))?.id, again.id, 'releasing again makes a new record');
      },
    },
  ]);
}

export interface GradingRepositoryFactories {
  grades?: Parameters<typeof gradeRepositoryContract>[0];
  extensions?: RepositoryFactory<TimeExtensionRepository>;
  excusals?: RepositoryFactory<ExcusalRepository>;
  releases?: RepositoryFactory<GradeReleaseRepository>;
}

/** The contracts for whichever grading repositories you pass a factory for. */
export function gradingRepositoryContracts(f: GradingRepositoryFactories): ContractCase[] {
  return [
    ...(f.grades ? gradeRepositoryContract(f.grades) : []),
    ...(f.extensions ? timeExtensionRepositoryContract(f.extensions) : []),
    ...(f.excusals ? excusalRepositoryContract(f.excusals) : []),
    ...(f.releases ? gradeReleaseRepositoryContract(f.releases) : []),
  ];
}
