/** Contract suites for the communication repositories. See `core/testing/contract.ts` for how to run them. */
import { check, checkEqual, idsOf, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { AnnouncementRepository, ThreadRepository } from '../service.js';

const at = (iso: string) => new Date(iso);

export function announcementRepositoryContract(make: RepositoryFactory<AnnouncementRepository>): ContractCase[] {
  return suite('AnnouncementRepository', [
    {
      name: "create stores the audience, and listBySection returns that section's announcements on both channels",
      run: async () => {
        const repo = await make();
        const a = await repo.create({ sectionId: 's1', title: 'Hi', body: 'Welcome', postedAt: at('2026-09-01'), audience: 'students' });
        const b = await repo.create({ sectionId: 's1', title: 'Parents', body: 'Meeting', postedAt: at('2026-09-02'), audience: 'guardians' });
        await repo.create({ sectionId: 's2', title: 'Other', body: '-', postedAt: at('2026-09-01') });
        const listed = await repo.listBySection('s1');
        checkEqual(idsOf(listed), idsOf([a, b]), 'both announcements of s1');
        checkEqual(listed.find((x) => x.id === b.id)?.audience, 'guardians', 'audience is stored (the service filters on it)');
      },
    },
  ]);
}

export function threadRepositoryContract(make: RepositoryFactory<ThreadRepository>): ContractCase[] {
  return suite('ThreadRepository', [
    {
      name: 'create starts a thread with no posts; findById returns it, or null',
      run: async () => {
        const repo = await make();
        const t = await repo.create({ sectionId: 's1', title: 'Questions', contentId: 'hw1' });
        checkEqual(t.posts, [], 'no posts yet');
        checkEqual(await repo.findById(t.id), t, 'findById');
        checkEqual(await repo.findById('nope'), null, 'unknown id');
      },
    },
    {
      name: 'addPost appends posts in order, each with its own id',
      run: async () => {
        const repo = await make();
        const t = await repo.create({ sectionId: 's1', title: 'Questions' });
        const p1 = await repo.addPost(t.id, { authorId: 'u1', body: 'first', postedAt: at('2026-09-01T10:00:00Z') });
        const p2 = await repo.addPost(t.id, { authorId: 'u2', body: 'second', postedAt: at('2026-09-01T11:00:00Z') });
        check(p1.id !== p2.id, 'posts get distinct ids');
        checkEqual((await repo.findById(t.id))?.posts.map((p) => p.body), ['first', 'second'], 'posts in order');
      },
    },
  ]);
}

export interface CommunicationRepositoryFactories {
  announcements?: RepositoryFactory<AnnouncementRepository>;
  threads?: RepositoryFactory<ThreadRepository>;
}

export function communicationRepositoryContracts(f: CommunicationRepositoryFactories): ContractCase[] {
  return [
    ...(f.announcements ? announcementRepositoryContract(f.announcements) : []),
    ...(f.threads ? threadRepositoryContract(f.threads) : []),
  ];
}
