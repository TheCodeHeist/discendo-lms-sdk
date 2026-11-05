/** Contract suites for the content repositories. See `core/testing/contract.ts` for how to run them. */
import { check, checkEqual, idsOf, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { ContentNode } from '../../../core/types.js';
import type { ContentPrerequisiteRepository, ContentRevision, ContentRevisionRepository } from '../types.js';

const at = (iso: string) => new Date(iso);

export function contentRevisionRepositoryContract(make: RepositoryFactory<ContentRevisionRepository>): ContractCase[] {
  const snapshot = (version: number): ContentNode => ({
    id: 'n1',
    sectionId: 's1',
    kind: 'page',
    title: `v${version}`,
    orderIndex: 0,
    published: version > 1,
    version,
    availableFrom: at('2026-09-01T00:00:00Z'),
  });
  const revision = (version: number, change: ContentRevision['change']): Omit<ContentRevision, 'id'> => ({
    contentId: 'n1',
    sectionId: 's1',
    version,
    change,
    snapshot: snapshot(version),
    changedBy: 'teacher',
    changedAt: at(`2026-09-0${version}T00:00:00Z`),
    ...(change === 'updated' ? { changedFields: ['title'] } : {}),
  });
  return suite('ContentRevisionRepository', [
    {
      name: 'append stores the whole revision, snapshot dates included',
      run: async () => {
        const repo = await make();
        const stored = await repo.append(revision(1, 'created'));
        check(typeof stored.id === 'string' && stored.id !== '', 'append returns a non-empty id');
        checkEqual(stored, { ...revision(1, 'created'), id: stored.id }, 'stored as given');
        const [listed] = await repo.listForContent('n1');
        check(listed?.snapshot.availableFrom instanceof Date, 'a snapshot date comes back as a Date');
      },
    },
    {
      name: "listForContent returns that node's revisions, oldest version first",
      run: async () => {
        const repo = await make();
        await repo.append(revision(2, 'updated'));
        await repo.append(revision(1, 'created'));
        await repo.append({ ...revision(1, 'created'), contentId: 'n2' });
        await repo.append(revision(3, 'published'));
        checkEqual((await repo.listForContent('n1')).map((r) => r.version), [1, 2, 3], 'versions in order');
        checkEqual(await repo.listForContent('none'), [], 'none for unknown content');
      },
    },
  ]);
}

export function contentPrerequisiteRepositoryContract(make: RepositoryFactory<ContentPrerequisiteRepository>): ContractCase[] {
  const edge = (contentId: string, requiresContentId: string, sectionId = 's1') => ({
    contentId,
    requiresContentId,
    sectionId,
    createdBy: 'teacher',
    createdAt: at('2026-09-01T00:00:00Z'),
  });
  return suite('ContentPrerequisiteRepository', [
    {
      name: 'add, listForContent and listForSection',
      run: async () => {
        const repo = await make();
        const a = await repo.add(edge('b', 'a'));
        const c = await repo.add(edge('c', 'b'));
        await repo.add(edge('x', 'y', 's2'));
        checkEqual(await repo.listForContent('b'), [a], 'what b requires');
        checkEqual(idsOf(await repo.listForSection('s1')), idsOf([a, c]), 'every edge of s1');
      },
    },
    {
      name: 'remove returns true once, then false',
      run: async () => {
        const repo = await make();
        await repo.add(edge('b', 'a'));
        checkEqual(await repo.remove('b', 'a'), true, 'first remove');
        checkEqual(await repo.remove('b', 'a'), false, 'second remove');
        checkEqual(await repo.listForContent('b'), [], 'gone');
      },
    },
  ]);
}

export interface ContentRepositoryFactories {
  revisions?: RepositoryFactory<ContentRevisionRepository>;
  prerequisites?: RepositoryFactory<ContentPrerequisiteRepository>;
}

export function contentRepositoryContracts(f: ContentRepositoryFactories): ContractCase[] {
  return [
    ...(f.revisions ? contentRevisionRepositoryContract(f.revisions) : []),
    ...(f.prerequisites ? contentPrerequisiteRepositoryContract(f.prerequisites) : []),
  ];
}
