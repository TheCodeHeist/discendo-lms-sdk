import { describe, it, expect } from 'bun:test';
import { AssessmentService } from '../src/domains/assessment/index.js';
import type { SubmissionRepository, QuizRepository, Submission } from '../src/domains/assessment/index.js';
import { EventBus } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';

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
  };
  return { submissions, quizzes };
}

const payload = { kind: 'text', text: 'my answer' } as never;

describe('AssessmentService event emission', () => {
  it('emits assessment.submissionReceived with the stored submission details', async () => {
    const { submissions, quizzes } = makeRepos();
    const bus = new EventBus();
    const received: LmsEvent[] = [];
    bus.on('assessment.submissionReceived', (e) => received.push(e));

    const service = new AssessmentService(submissions, quizzes, undefined, bus);
    const sub = await service.submit('content-1', 'user-1', payload);
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([
      {
        type: 'assessment.submissionReceived',
        submissionId: sub.id,
        contentId: 'content-1',
        userId: 'user-1',
        attemptNumber: 1,
      },
    ]);
  });

  it('reports the right attemptNumber on a resubmission', async () => {
    const { submissions, quizzes } = makeRepos();
    const bus = new EventBus();
    const attempts: number[] = [];
    bus.on('assessment.submissionReceived', (e) => attempts.push(e.attemptNumber));

    const service = new AssessmentService(submissions, quizzes, undefined, bus);
    await service.submit('content-1', 'user-1', payload);
    await service.submit('content-1', 'user-1', payload);
    await new Promise((r) => setTimeout(r, 0));

    expect(attempts).toEqual([1, 2]);
  });

  it('does not emit when the submission is rejected for exceeding maxAttempts', async () => {
    const { submissions, quizzes } = makeRepos();
    const bus = new EventBus();
    let count = 0;
    bus.on('assessment.submissionReceived', () => {
      count++;
    });

    const service = new AssessmentService(submissions, quizzes, undefined, bus);
    await service.submit('content-1', 'user-1', payload, 1);
    await expect(service.submit('content-1', 'user-1', payload, 1)).rejects.toThrow('No attempts remaining');
    await new Promise((r) => setTimeout(r, 0));

    expect(count).toBe(1);
  });

  it('still returns the submission when a listener throws', async () => {
    const { submissions, quizzes } = makeRepos();
    const bus = new EventBus();
    bus.on('assessment.submissionReceived', () => {
      throw new Error('listener bug');
    });

    const service = new AssessmentService(submissions, quizzes, undefined, bus);

    await expect(service.submit('content-1', 'user-1', payload)).resolves.toMatchObject({ id: 'sub-1' });
  });

  it('works with no EventBus supplied at all', async () => {
    const { submissions, quizzes } = makeRepos();
    const service = new AssessmentService(submissions, quizzes);

    await expect(service.submit('content-1', 'user-1', payload)).resolves.toMatchObject({ attemptNumber: 1 });
  });
});
