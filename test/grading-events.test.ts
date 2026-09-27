import { describe, it, expect } from 'bun:test';
import { GradingService } from '../src/grading/index.js';
import type { GradeRepository } from '../src/grading/index.js';
import { EventBus } from '../src/core/index.js';
import type { GradeEntry } from '../src/grading/index.js';

function makeGradeRepo(): GradeRepository {
  const entries = new Map<string, GradeEntry>();
  let counter = 0;
  return {
    create: async (e) => {
      counter++;
      const entry: GradeEntry = { ...e, id: `grade-${counter}` };
      entries.set(entry.id, entry);
      return entry;
    },
    markSuperseded: async (id, byId) => {
      const existing = entries.get(id);
      if (existing) entries.set(id, { ...existing, supersededBy: byId });
    },
    listForUserInSection: async (userId) =>
      [...entries.values()].filter((e) => e.userId === userId).map((e) => ({ ...e, category: 'default' })),
  };
}

describe('GradingService event emission', () => {
  it('emits grading.gradePosted when a grade is recorded', async () => {
    const repo = makeGradeRepo();
    const bus = new EventBus();
    const received: Array<{ score: number; maxScore: number }> = [];
    bus.on('grading.gradePosted', (e) => {
      received.push(e);
    });

    const service = new GradingService(repo, bus);
    await service.recordGrade('sub-1', 'user-1', 85, 100, 'grader-1');
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.score).toBe(85);
    expect(received[0]?.maxScore).toBe(100);
  });

  it('emits once per recordGrade call, even when superseding a previous entry', async () => {
    const repo = makeGradeRepo();
    const bus = new EventBus();
    let count = 0;
    bus.on('grading.gradePosted', () => {
      count++;
    });

    const service = new GradingService(repo, bus);
    const first = await service.recordGrade('sub-1', 'user-1', 70, 100, 'grader-1');
    await service.recordGrade('sub-1', 'user-1', 90, 100, 'grader-1', first.id);
    await new Promise((r) => setTimeout(r, 0));

    expect(count).toBe(2);
  });

  it('works with no EventBus supplied at all', async () => {
    const repo = makeGradeRepo();
    const service = new GradingService(repo); // no bus
    const entry = await service.recordGrade('sub-1', 'user-1', 85, 100, 'grader-1');
    expect(entry.score).toBe(85);
  });
});
