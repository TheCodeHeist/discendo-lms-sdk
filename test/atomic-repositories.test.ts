import { unusedQuizAttempts } from './helpers/quiz-store.js';
import { describe, it, expect } from 'bun:test';
import { EnrollmentService } from '../src/domains/enrollment/index.js';
import { AssessmentService } from '../src/domains/assessment/index.js';
import type { Submission, SubmissionRepository, QuizRepository } from '../src/domains/assessment/index.js';
import { GradingService, GradeConflictError } from '../src/domains/grading/index.js';
import type { GradeEntry, GradeRepository } from '../src/domains/grading/index.js';
import { EventBus } from '../src/core/index.js';
import type { CourseSection, Enrollment, Identity, RepositoryContext } from '../src/core/index.js';

/** Yields to the event loop, so two "simultaneous" calls interleave between a check and the write. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = tick;

// ---------------------------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------------------------

function enrollmentWorld(opts: { atomic: boolean }) {
  const people = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank', 'ivan', 'judy'];
  const users = new Map<string, Identity>(people.map((id) => [id, { id, roles: ['student'] }]));
  const sections: Record<string, CourseSection> = {
    'sec-1': { id: 'sec-1', courseId: 'c', status: 'published', capacity: 1 },
    'sec-3': { id: 'sec-3', courseId: 'c', status: 'published', capacity: 3 },
    'sec-open': { id: 'sec-open', courseId: 'c', status: 'published' },
  };
  const rows: Enrollment[] = [];
  let seq = 0;
  const seatCalls: Array<{ enrollment: Omit<Enrollment, 'id'>; capacity: number }> = [];
  const plainCreates: Array<Omit<Enrollment, 'id'>> = [];
  const enrollments: RepositoryContext['enrollments'] = {
    create: async (e) => {
      await tick();
      plainCreates.push(e);
      const row = { ...e, id: `enr-${++seq}` } as Enrollment;
      rows.push(row);
      return row;
    },
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    update: async (id, patch) => ({ ...rows.find((r) => r.id === id)!, ...patch }),
    findByUserAndSection: async (userId, sectionId) => [...rows].reverse().find((r) => r.userId === userId && r.sectionId === sectionId) ?? null,
    listBySection: async (sectionId, status) => rows.filter((r) => r.sectionId === sectionId && (!status || r.status === status)),
    countActive: async (sectionId) => {
      const n = rows.filter((r) => r.sectionId === sectionId && r.status === 'active').length;
      await tick(); // the gap in which another enrollment can slip in
      return n;
    },
    ...(opts.atomic
      ? {
          // No await between the check and the write: atomic, like a database transaction would be.
          createIfSeatFree: (e: Omit<Enrollment, 'id'>, capacity: number) => {
            seatCalls.push({ enrollment: e, capacity });
            if (rows.filter((r) => r.sectionId === e.sectionId && r.status === 'active').length >= capacity) return Promise.resolve(null);
            const row = { ...e, id: `enr-${++seq}` } as Enrollment;
            rows.push(row);
            return Promise.resolve(row);
          },
        }
      : {}),
  };
  const repos = {
    users: { findById: async (id: string) => users.get(id) ?? null, findByExternalRef: async (ref: string) => users.get(ref.replace('ext-', '')) ?? null },
    courses: { findCourse: async (id: string) => ({ id, title: 'C' }), findSection: async (id: string) => sections[id] ?? null, listSections: async () => [] },
    enrollments,
    terms: { findById: async () => null },
  } as unknown as RepositoryContext;
  const bus = new EventBus();
  const events: Array<{ type: string; status?: string }> = [];
  bus.on('enrollment.enrolled', (e) => void events.push(e as never));
  const service = new EnrollmentService(repos, bus);
  const statuses = (sectionId: string) => rows.filter((r) => r.sectionId === sectionId).map((r) => r.status).sort();
  return { service, rows, seatCalls, plainCreates, events, statuses };
}

describe('capacity: createIfSeatFree', () => {
  const take = (w: ReturnType<typeof enrollmentWorld>, userId: string, sectionId = 'sec-1', waitlistIfFull = true) =>
    w.service.enroll({ userId, sectionId, role: 'student', waitlistIfFull });

  it('WITHOUT it, two simultaneous enrollments can both take the last seat (the documented limitation)', async () => {
    const w = enrollmentWorld({ atomic: false });
    await Promise.all([take(w, 'alice'), take(w, 'bob')]);
    expect(w.statuses('sec-1')).toEqual(['active', 'active']); // capacity is 1
  });

  it('WITH it, exactly one gets the last seat and the other is waitlisted', async () => {
    const w = enrollmentWorld({ atomic: true });
    await Promise.all([take(w, 'alice'), take(w, 'bob')]);
    expect(w.statuses('sec-1')).toEqual(['active', 'waitlisted']);
  });

  it('WITH it and no waitlisting, one succeeds and the other is refused with the capacity error', async () => {
    const w = enrollmentWorld({ atomic: true });
    const results = await Promise.allSettled([take(w, 'alice', 'sec-1', false), take(w, 'bob', 'sec-1', false)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refusal = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refusal.reason as Error).message).toContain('capacity');
    expect(w.rows).toHaveLength(1);
  });

  it('WITH it, ten simultaneous enrollments into three seats give exactly three active and seven waitlisted', async () => {
    const w = enrollmentWorld({ atomic: true });
    const people = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank', 'ivan', 'judy'];
    await Promise.all(people.map((p) => take(w, p, 'sec-3')));
    expect(w.statuses('sec-3').filter((s) => s === 'active')).toHaveLength(3);
    expect(w.statuses('sec-3').filter((s) => s === 'waitlisted')).toHaveLength(7);
  });

  it('hands the repository an ACTIVE enrollment and the section\'s capacity, and makes the waitlisted one with the ordinary create', async () => {
    const w = enrollmentWorld({ atomic: true });
    await take(w, 'alice');
    await take(w, 'bob');
    expect(w.seatCalls).toHaveLength(2);
    expect(w.seatCalls[0]).toMatchObject({ capacity: 1, enrollment: { userId: 'alice', sectionId: 'sec-1', role: 'student', status: 'active' } });
    expect(w.plainCreates).toHaveLength(1);
    expect(w.plainCreates[0]).toMatchObject({ userId: 'bob', status: 'waitlisted' });
  });

  it('is not used for a section with no capacity', async () => {
    const w = enrollmentWorld({ atomic: true });
    await Promise.all([take(w, 'alice', 'sec-open'), take(w, 'bob', 'sec-open')]);
    expect(w.seatCalls).toEqual([]);
    expect(w.statuses('sec-open')).toEqual(['active', 'active']);
  });

  it('announces each enrollment once, with the status it really got', async () => {
    const w = enrollmentWorld({ atomic: true });
    await Promise.all([take(w, 'alice'), take(w, 'bob')]);
    await sleep();
    expect(w.events.map((e) => e.status).sort()).toEqual(['active', 'waitlisted']);
  });

  it('is used by bulkEnroll too, so a roster import cannot over-fill a section either', async () => {
    const w = enrollmentWorld({ atomic: true });
    const report = await w.service.bulkEnroll('sec-3', ['alice', 'bob', 'carol', 'dave', 'erin'].map((p) => ({ userExternalRef: `ext-${p}`, role: 'student' as const })));
    expect(report.succeeded).toBe(5);
    expect(w.statuses('sec-3')).toEqual(['active', 'active', 'active', 'waitlisted', 'waitlisted']);
  });

  it('works exactly as before when the repository does not provide it', async () => {
    const w = enrollmentWorld({ atomic: false });
    await take(w, 'alice');
    await expect(take(w, 'bob', 'sec-1', false)).rejects.toThrow('capacity');
    expect(w.seatCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Attempts
// ---------------------------------------------------------------------------------------------

function assessmentWorld(opts: { atomic: boolean }) {
  const rows: Submission[] = [];
  let seq = 0;
  const attemptCalls: Array<{ draft: Record<string, unknown>; maxAttempts: number | undefined }> = [];
  const submissions: SubmissionRepository = {
    countAttempts: async (contentId, userId) => {
      const n = rows.filter((r) => r.contentId === contentId && r.userId === userId).length;
      await tick();
      return n;
    },
    create: async (s) => {
      await tick();
      const row = { ...s, id: `sub-${++seq}` } as Submission;
      rows.push(row);
      return row;
    },
    ...(opts.atomic
      ? {
          createAttempt: (draft: Omit<Submission, 'id' | 'attemptNumber'>, maxAttempts?: number) => {
            attemptCalls.push({ draft: draft as never, maxAttempts });
            const count = rows.filter((r) => r.contentId === draft.contentId && r.userId === draft.userId).length;
            if (maxAttempts !== undefined && count >= maxAttempts) return Promise.resolve(null);
            const row = { ...draft, attemptNumber: count + 1, id: `sub-${++seq}` } as Submission;
            rows.push(row);
            return Promise.resolve(row);
          },
        }
      : {}),
  };
  const quizzes: QuizRepository = { getQuestions: async () => [], createAttempt: async (a) => ({ ...a, id: 'q1' }), ...unusedQuizAttempts };
  const bus = new EventBus();
  const received: unknown[] = [];
  bus.on('assessment.submissionReceived', (e) => void received.push(e));
  const service = new AssessmentService(submissions, quizzes, undefined, bus);
  const text = { kind: 'text', content: 'answer' } as never;
  return { service, rows, attemptCalls, received, text, numbers: () => rows.map((r) => r.attemptNumber).sort((a, b) => a - b) };
}

describe('attempts: createAttempt', () => {
  it('WITHOUT it, two simultaneous submissions both get through a limit of one, with the same attempt number (the documented limitation)', async () => {
    const w = assessmentWorld({ atomic: false });
    await Promise.all([w.service.submit('c1', 'u1', w.text, 1), w.service.submit('c1', 'u1', w.text, 1)]);
    expect(w.rows).toHaveLength(2);
    expect(w.numbers()).toEqual([1, 1]);
  });

  it('WITH it, a limit of one lets exactly one through, and the other is told no attempts remain', async () => {
    const w = assessmentWorld({ atomic: true });
    const results = await Promise.allSettled([w.service.submit('c1', 'u1', w.text, 1), w.service.submit('c1', 'u1', w.text, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as Error).message).toBe('No attempts remaining');
    expect(w.rows).toHaveLength(1);
    expect(w.numbers()).toEqual([1]);
  });

  it('WITH it, simultaneous submissions with no limit still get distinct attempt numbers', async () => {
    const w = assessmentWorld({ atomic: true });
    await Promise.all([1, 2, 3, 4, 5].map(() => w.service.submit('c1', 'u1', w.text)));
    expect(w.numbers()).toEqual([1, 2, 3, 4, 5]);
  });

  it('WITHOUT it, the same simultaneous submissions repeat attempt numbers (the documented limitation)', async () => {
    const w = assessmentWorld({ atomic: false });
    await Promise.all([1, 2, 3].map(() => w.service.submit('c1', 'u1', w.text)));
    expect(new Set(w.numbers()).size).toBeLessThan(3);
  });

  it('WITH it, a staff-recorded offline submission racing a student\'s own gets its own number, whichever starts first', async () => {
    const first = assessmentWorld({ atomic: true });
    await Promise.all([first.service.recordOffline('c1', 'u1'), first.service.submit('c1', 'u1', first.text)]);
    expect(first.numbers()).toEqual([1, 2]);
    const second = assessmentWorld({ atomic: true });
    await Promise.all([second.service.submit('c1', 'u1', second.text), second.service.recordOffline('c1', 'u1')]);
    expect(second.numbers()).toEqual([1, 2]);
  });

  it('passes the limit through, and asks for no number: the repository assigns it', async () => {
    const w = assessmentWorld({ atomic: true });
    await w.service.submit('c1', 'u1', w.text, 3);
    await w.service.submit('c1', 'u1', w.text);
    expect(w.attemptCalls.map((c) => c.maxAttempts)).toEqual([3, undefined]);
    expect('attemptNumber' in w.attemptCalls[0]!.draft).toBe(false);
    expect(w.attemptCalls[0]!.draft).toMatchObject({ contentId: 'c1', userId: 'u1', payload: w.text });
  });

  it('announces only a submission that was stored', async () => {
    const w = assessmentWorld({ atomic: true });
    await Promise.allSettled([w.service.submit('c1', 'u1', w.text, 1), w.service.submit('c1', 'u1', w.text, 1)]);
    await sleep();
    expect(w.received).toHaveLength(1);
  });

  it('works exactly as before when the repository does not provide it', async () => {
    const w = assessmentWorld({ atomic: false });
    await w.service.submit('c1', 'u1', w.text, 1);
    await expect(w.service.submit('c1', 'u1', w.text, 1)).rejects.toThrow('No attempts remaining');
    expect(w.numbers()).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------------------------
// Regrading
// ---------------------------------------------------------------------------------------------

function gradingWorld(opts: { atomic: boolean }) {
  const rows: GradeEntry[] = [];
  let seq = 0;
  const calls = { markSuperseded: 0, supersedeIfCurrent: 0 };
  const grades: GradeRepository = {
    create: async (e) => {
      await tick();
      const row = { ...e, id: `g-${++seq}` } as GradeEntry;
      rows.push(row);
      return row;
    },
    findById: async (id) => {
      const row = rows.find((r) => r.id === id) ?? null;
      await tick();
      return row ? { ...row } : null;
    },
    markSuperseded: async (id, byId) => {
      calls.markSuperseded++;
      const i = rows.findIndex((r) => r.id === id);
      rows[i] = { ...rows[i]!, supersededBy: byId };
    },
    listForUserInSection: async (userId) => rows.filter((r) => r.userId === userId && r.supersededBy === undefined).map((r) => ({ ...r, category: 'hw' })),
    ...(opts.atomic
      ? {
          // A compare-and-set with no await inside: atomic.
          supersedeIfCurrent: (id: string, byId: string) => {
            calls.supersedeIfCurrent++;
            const i = rows.findIndex((r) => r.id === id);
            if (i < 0 || rows[i]!.supersededBy !== undefined) return Promise.resolve(false);
            rows[i] = { ...rows[i]!, supersededBy: byId };
            return Promise.resolve(true);
          },
        }
      : {}),
  };
  const bus = new EventBus();
  const posted: Array<{ gradeEntryId: string }> = [];
  bus.on('grading.gradePosted', (e) => void posted.push(e as never));
  const service = new GradingService(grades, bus);
  const current = () => rows.filter((r) => r.supersededBy === undefined);
  return { service, rows, calls, posted, current };
}

describe('regrading: supersedeIfCurrent', () => {
  async function twoRegrades(w: ReturnType<typeof gradingWorld>) {
    const first = await w.service.recordGrade('s1', 'u1', 70, 100, 'g1');
    const results = await Promise.allSettled([
      w.service.recordGrade('s1', 'u1', 80, 100, 'g1', first.id),
      w.service.recordGrade('s1', 'u1', 90, 100, 'g2', first.id),
    ]);
    return { first, results };
  }

  it('WITHOUT it, two simultaneous regrades of one entry can both succeed, leaving two current entries (the documented limitation)', async () => {
    const w = gradingWorld({ atomic: false });
    const { results } = await twoRegrades(w);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(w.current().length).toBe(2);
  });

  it('WITH it, exactly one regrade wins and exactly one entry stays current', async () => {
    const w = gradingWorld({ atomic: true });
    const { first, results } = await twoRegrades(w);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(w.current()).toHaveLength(1);
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<GradeEntry>).value;
    expect(w.current()[0]!.id).toBe(winner.id);
    expect(w.rows.find((r) => r.id === first.id)!.supersededBy).toBe(winner.id);
  });

  it('tells the loser it lost, and to whom, and keeps its entry as history superseded by the winner', async () => {
    const w = gradingWorld({ atomic: true });
    const { results } = await twoRegrades(w);
    const loss = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<GradeEntry>).value;
    expect(loss).toBeInstanceOf(GradeConflictError);
    expect(loss).toBeInstanceOf(Error);
    expect((loss as GradeConflictError).winnerId).toBe(winner.id);
    const loserRow = w.rows.find((r) => r.id === (loss as GradeConflictError).entryId)!;
    expect(loserRow).toBeDefined();
    expect(loserRow.supersededBy).toBe(winner.id);
    expect(w.rows).toHaveLength(3); // the original, the winner, and the loser: nothing is deleted
  });

  it('counts only the winner towards the final grade', async () => {
    const w = gradingWorld({ atomic: true });
    const { results } = await twoRegrades(w);
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<GradeEntry>).value;
    const scheme = { categories: [{ name: 'hw', weight: 1 }] };
    expect(await w.service.computeFinalGradeForUser('u1', 'sec-1', scheme)).toBeCloseTo((winner.score / winner.maxScore) * 100);
  });

  it('announces only the grade that won', async () => {
    const w = gradingWorld({ atomic: true });
    const { results } = await twoRegrades(w);
    await sleep();
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<GradeEntry>).value;
    expect(w.posted.map((p) => p.gradeEntryId)).toEqual([expect.any(String), winner.id]); // the first grade, then the winner
  });

  it('uses it instead of markSuperseded for an ordinary regrade, which works as before', async () => {
    const w = gradingWorld({ atomic: true });
    const first = await w.service.recordGrade('s1', 'u1', 70, 100, 'g1');
    const second = await w.service.recordGrade('s1', 'u1', 85, 100, 'g1', first.id);
    expect(w.calls.supersedeIfCurrent).toBe(1);
    expect(w.rows.find((r) => r.id === first.id)!.supersededBy).toBe(second.id);
    expect(w.current()).toHaveLength(1);
  });

  it('does not use it for a first grade, which supersedes nothing', async () => {
    const w = gradingWorld({ atomic: true });
    await w.service.recordGrade('s1', 'u1', 70, 100, 'g1');
    expect(w.calls.supersedeIfCurrent).toBe(0);
  });

  it('works exactly as before when the repository does not provide it', async () => {
    const w = gradingWorld({ atomic: false });
    const first = await w.service.recordGrade('s1', 'u1', 70, 100, 'g1');
    const second = await w.service.recordGrade('s1', 'u1', 85, 100, 'g1', first.id);
    expect(w.calls.markSuperseded).toBe(1);
    expect(w.rows.find((r) => r.id === first.id)!.supersededBy).toBe(second.id);
  });

  it('the earlier checks still come first: a previous entry that is already superseded is refused before anything is created', async () => {
    const w = gradingWorld({ atomic: true });
    const first = await w.service.recordGrade('s1', 'u1', 70, 100, 'g1');
    await w.service.recordGrade('s1', 'u1', 85, 100, 'g1', first.id);
    const before = w.rows.length;
    await expect(w.service.recordGrade('s1', 'u1', 95, 100, 'g1', first.id)).rejects.toThrow('already been superseded');
    expect(w.rows).toHaveLength(before);
  });
});
