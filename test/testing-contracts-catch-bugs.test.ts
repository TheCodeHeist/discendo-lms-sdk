import { describe, expect, it } from 'bun:test';
import {
  ContractViolation,
  InMemoryEnrollmentRepository,
  InMemoryExcusalRepository,
  InMemoryGradeRepository,
  InMemorySubmissionRepository,
  InMemoryThreadRepository,
  enrollmentRepositoryContract,
  excusalRepositoryContract,
  gradeRepositoryContract,
  quizRepositoryContract,
  submissionRepositoryContract,
  threadRepositoryContract,
  type ContractCase,
} from '../src/testing/index.js';
import type { Enrollment } from '../src/core/index.js';
import type { QuizAttempt, QuizQuestion, QuizRepository } from '../src/domains/assessment/index.js';

/**
 * A contract suite is only worth running if it fails a repository that gets the contract wrong.
 * Each test here breaks one in-memory repository in one realistic way (the kind of bug a database
 * implementation actually has) and checks that the matching case catches it.
 */
async function failures(cases: ContractCase[]): Promise<string[]> {
  const failed: string[] = [];
  for (const c of cases) {
    try {
      await c.run();
    } catch (e) {
      if (!(e instanceof ContractViolation)) throw e;
      failed.push(c.name);
    }
  }
  return failed;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the contract suites catch broken repositories', () => {
  it('an enrollment lookup that returns the OLDEST record instead of the most recent', async () => {
    class Oldest extends InMemoryEnrollmentRepository {
      override async findByUserAndSection(userId: string, sectionId: string) {
        return (await this.listBySection(sectionId)).find((e) => e.userId === userId) ?? null;
      }
    }
    expect(await failures(enrollmentRepositoryContract(() => new Oldest()))).toEqual([
      'EnrollmentRepository: findByUserAndSection returns the MOST RECENT record (permission checks depend on it)',
    ]);
  });

  it('a createIfSeatFree that checks and writes in two steps (not atomic)', async () => {
    class Racy extends InMemoryEnrollmentRepository {
      override async createIfSeatFree(e: Omit<Enrollment, 'id'>, capacity: number) {
        const taken = await this.countActive(e.sectionId);
        await tick(); // the gap a real database has without a transaction
        return taken >= capacity ? null : this.create(e);
      }
    }
    expect(await failures(enrollmentRepositoryContract(() => new Racy()))).toEqual([
      'EnrollmentRepository: createIfSeatFree (if implemented) is atomic: concurrent calls never overfill',
    ]);
  });

  it('an update that replaces the row instead of merging the patch', async () => {
    class Replacing extends InMemoryEnrollmentRepository {
      override async update(id: string, patch: Partial<Enrollment>) {
        const before = (await this.findById(id))!;
        const replaced = { id, ...patch } as Enrollment;
        await super.update(id, Object.fromEntries(Object.keys(before).map((k) => [k, undefined])) as Partial<Enrollment>);
        return super.update(id, replaced);
      }
    }
    expect(await failures(enrollmentRepositoryContract(() => new Replacing()))).toContain(
      'EnrollmentRepository: update merges the patch and keeps the other fields',
    );
  });

  it('a submission store whose createAttempt numbers from 0 and ignores the limit', async () => {
    class Sloppy extends InMemorySubmissionRepository {
      override async createAttempt(draft: Parameters<InMemorySubmissionRepository['createAttempt']>[0]) {
        return this.create({ ...draft, attemptNumber: await this.countAttempts(draft.contentId, draft.userId) });
      }
    }
    const failed = await failures(submissionRepositoryContract(() => new Sloppy()));
    expect(failed).toContain('SubmissionRepository: createAttempt (if implemented) numbers attempts 1, 2, 3 and refuses past the limit');
  });

  /** A small Map-backed quiz store, with one switch per bug. */
  function quizStore(bug: 'readModifyWrite' | 'closeTwice') {
    return ({ quizId, questions }: { quizId: string; questions: QuizQuestion[] }): QuizRepository => {
      const rows = new Map<string, QuizAttempt>();
      let n = 0;
      const get = (id: string) => (rows.has(id) ? structuredClone(rows.get(id)!) : null);
      return {
        getQuestions: async (id) => (id === quizId ? structuredClone(questions) : []),
        createAttempt: async (a) => {
          const row = { ...structuredClone(a), id: `a${++n}` };
          rows.set(row.id, row);
          return structuredClone(row);
        },
        findAttempt: async (id) => get(id),
        findOpenAttempt: async (q, u) => [...rows.values()].reverse().find((a) => a.quizId === q && a.userId === u && !a.submittedAt) ?? null,
        saveAnswer: async (id, questionId, choiceIndex) => {
          const before = get(id);
          if (!before || before.submittedAt) return null;
          if (bug === 'readModifyWrite') await tick(); // read, wait, write the whole object back
          const answers = { ...(bug === 'readModifyWrite' ? before.answers : rows.get(id)!.answers), [questionId]: choiceIndex };
          rows.set(id, { ...rows.get(id)!, answers });
          return get(id);
        },
        closeAttempt: async (id, close) => {
          const row = rows.get(id);
          if (!row || (bug !== 'closeTwice' && row.submittedAt)) return null;
          rows.set(id, { ...row, ...close });
          return get(id);
        },
        updateAttempt: async (id, patch) => {
          rows.set(id, { ...rows.get(id)!, ...patch });
          return get(id)!;
        },
      };
    };
  }

  it('a quiz store that saves answers by read-modify-write (concurrent answers lost)', async () => {
    expect(await failures(quizRepositoryContract(quizStore('readModifyWrite')))).toEqual([
      'QuizRepository: saveAnswer keeps earlier answers, and concurrent saves do not lose each other',
    ]);
  });

  it('a quiz store whose closeAttempt does not check the attempt is still open', async () => {
    expect(await failures(quizRepositoryContract(quizStore('closeTwice')))).toEqual([
      'QuizRepository: closeAttempt closes once: a second (or concurrent) close returns null',
    ]);
  });

  it('a grade store whose supersedeIfCurrent does not check the entry is still current', async () => {
    class Unconditional extends InMemoryGradeRepository {
      override async supersedeIfCurrent(id: string, byId: string) {
        await this.markSuperseded(id, byId);
        return true;
      }
    }
    const make = (placements: Record<string, { sectionId: string; category: string; contentId?: string }>) => {
      const repo = new Unconditional();
      for (const [id, p] of Object.entries(placements)) repo.place(id, p);
      return repo;
    };
    expect(await failures(gradeRepositoryContract(make))).toEqual([
      'GradeRepository: supersedeIfCurrent (if implemented) succeeds once, and only one of two concurrent calls wins',
    ]);
  });

  it('an excusal store whose listForUser drops revoked excusals', async () => {
    class ActiveOnly extends InMemoryExcusalRepository {
      override async listForUser(userId: string, sectionId: string) {
        return (await super.listForUser(userId, sectionId)).filter((e) => e.revokedAt === undefined);
      }
    }
    expect(await failures(excusalRepositoryContract(() => new ActiveOnly()))).toEqual([
      "ExcusalRepository: listForUser returns the student's excusals in that section, revoked ones included",
    ]);
  });

  it('a thread store that keeps only the latest post', async () => {
    class LatestOnly extends InMemoryThreadRepository {
      override async findById(id: string) {
        const t = await super.findById(id);
        return t ? { ...t, posts: t.posts.slice(-1) } : null;
      }
    }
    expect(await failures(threadRepositoryContract(() => new LatestOnly()))).toEqual([
      'ThreadRepository: addPost appends posts in order, each with its own id',
    ]);
  });
});
