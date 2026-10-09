import { unusedQuizAttempts } from './helpers/quiz-store.js';
import { describe, it, expect } from 'bun:test';
import { AssessmentService } from '../src/domains/assessment/index.js';
import type {
  SubmissionRepository,
  QuizRepository,
  Submission,
  PlagiarismCheckHook,
} from '../src/domains/assessment/index.js';

function makeRepos() {
  const store: Submission[] = [];
  const submissions: SubmissionRepository = {
    create: async (s) => {
      const sub: Submission = { ...s, id: `sub-${store.length + 1}` };
      store.push(sub);
      return sub;
    },
    countAttempts: async (contentId, userId) =>
      store.filter((s) => s.contentId === contentId && s.userId === userId).length,
  };
  const quizzes: QuizRepository = {
    getQuestions: async () => [],
    createAttempt: async (a) => ({ ...a, id: 'attempt-1' }),
    ...unusedQuizAttempts,
  };
  return { store, submissions, quizzes };
}

const payload = { kind: 'text', text: 'my answer' } as never;

/** Collects unhandled rejections raised while `run` executes and the loop drains. */
async function captureUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => {
    seen.push(reason);
  };
  process.on('unhandledRejection', handler);
  try {
    await run();
    // Give the runtime a few turns to surface any unhandled rejection.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off('unhandledRejection', handler);
  }
  return seen;
}

describe('AssessmentService plagiarism hook', () => {
  it('calls the hook with the stored submission', async () => {
    const { submissions, quizzes } = makeRepos();
    const calls: Submission[] = [];
    const hook: PlagiarismCheckHook = async (s) => {
      calls.push(s);
      return { flagged: false };
    };
    const service = new AssessmentService(submissions, quizzes, hook);
    const sub = await service.submit('c1', 'u1', payload);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([sub]);
  });

  it('does not wait for a slow hook', async () => {
    const { submissions, quizzes } = makeRepos();
    const hook: PlagiarismCheckHook = () => new Promise(() => {}); // never settles
    const service = new AssessmentService(submissions, quizzes, hook);
    const result = await Promise.race([
      service.submit('c1', 'u1', payload).then(() => 'done'),
      new Promise((r) => setTimeout(() => r('blocked'), 200)),
    ]);
    expect(result).toBe('done');
  });

  it('a rejecting hook does not fail the submission or leave an unhandled rejection', async () => {
    const { store, submissions, quizzes } = makeRepos();
    const hook: PlagiarismCheckHook = async () => {
      throw new Error('checker down');
    };
    const service = new AssessmentService(submissions, quizzes, hook);
    let submitted: Submission | undefined;
    const unhandled = await captureUnhandled(async () => {
      submitted = await service.submit('c1', 'u1', payload);
    });
    expect(submitted?.id).toBe('sub-1');
    expect(store).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it('a hook that throws synchronously does not fail the submission or leak', async () => {
    const { store, submissions, quizzes } = makeRepos();
    const hook = (() => {
      throw new Error('sync boom');
    }) as unknown as PlagiarismCheckHook;
    const service = new AssessmentService(submissions, quizzes, hook);
    let submitted: Submission | undefined;
    const unhandled = await captureUnhandled(async () => {
      submitted = await service.submit('c1', 'u1', payload);
    });
    expect(submitted?.id).toBe('sub-1');
    expect(store).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it('still emits the submission event when the hook rejects', async () => {
    const { submissions, quizzes } = makeRepos();
    const { EventBus } = await import('../src/core/index.js');
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('assessment.submissionReceived', (e) => seen.push(e.submissionId));
    const hook: PlagiarismCheckHook = async () => {
      throw new Error('checker down');
    };
    const service = new AssessmentService(submissions, quizzes, hook, bus);
    await captureUnhandled(async () => {
      await service.submit('c1', 'u1', payload);
    });
    expect(seen).toEqual(['sub-1']);
  });
});
