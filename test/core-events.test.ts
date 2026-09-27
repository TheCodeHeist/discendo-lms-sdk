import { describe, it, expect } from 'bun:test';
import { EventBus } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';

describe('EventBus', () => {
  it('delivers an emitted event to a registered handler', async () => {
    const bus = new EventBus();
    const received: LmsEvent[] = [];
    bus.on('enrollment.enrolled', (e) => {
      received.push(e);
    });

    await bus.emit({
      type: 'enrollment.enrolled',
      enrollmentId: 'e1',
      userId: 'u1',
      sectionId: 's1',
      status: 'active',
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('enrollment.enrolled');
  });

  it('does not deliver an event to a handler registered for a different type', async () => {
    const bus = new EventBus();
    let called = false;
    bus.on('grading.gradePosted', () => {
      called = true;
    });

    await bus.emit({
      type: 'enrollment.enrolled',
      enrollmentId: 'e1',
      userId: 'u1',
      sectionId: 's1',
      status: 'active',
    });

    expect(called).toBe(false);
  });

  it('delivers to multiple handlers registered for the same type', async () => {
    const bus = new EventBus();
    let count = 0;
    bus.on('enrollment.dropped', () => {
      count++;
    });
    bus.on('enrollment.dropped', () => {
      count++;
    });

    await bus.emit({ type: 'enrollment.dropped', enrollmentId: 'e1', userId: 'u1', sectionId: 's1' });

    expect(count).toBe(2);
  });

  it('does not throw when no handlers are registered for the emitted type', async () => {
    const bus = new EventBus();
    await expect(
      bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 2 }),
    ).resolves.toBeUndefined();
  });

  it('isolates a throwing handler from other handlers for the same event', async () => {
    const bus = new EventBus();
    let secondCalled = false;
    bus.on('grading.gradePosted', () => {
      throw new Error('boom');
    });
    bus.on('grading.gradePosted', () => {
      secondCalled = true;
    });

    await bus.emit({
      type: 'grading.gradePosted',
      gradeEntryId: 'g1',
      submissionId: 'sub1',
      userId: 'u1',
      score: 90,
      maxScore: 100,
      graderId: 'grader1',
    });

    expect(secondCalled).toBe(true);
  });

  it('never rejects emit() itself even when every handler throws', async () => {
    const bus = new EventBus();
    bus.on('content.published', () => {
      throw new Error('boom');
    });

    await expect(
      bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 1 }),
    ).resolves.toBeUndefined();
  });

  it('reports a handler failure via onHandlerError when supplied', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ onHandlerError: (err) => errors.push(err) });
    bus.on('content.published', () => {
      throw new Error('boom');
    });

    await bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 1 });

    expect(errors).toHaveLength(1);
  });

  it('reports a rejected async handler via onHandlerError too', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ onHandlerError: (err) => errors.push(err) });
    bus.on('content.published', async () => {
      throw new Error('async boom');
    });

    await bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 1 });

    expect(errors).toHaveLength(1);
  });

  it('lets a handler unsubscribe via the returned function', async () => {
    const bus = new EventBus();
    let count = 0;
    const unsubscribe = bus.on('enrollment.enrolled', () => {
      count++;
    });

    await bus.emit({ type: 'enrollment.enrolled', enrollmentId: 'e1', userId: 'u1', sectionId: 's1', status: 'active' });
    unsubscribe();
    await bus.emit({ type: 'enrollment.enrolled', enrollmentId: 'e2', userId: 'u2', sectionId: 's1', status: 'active' });

    expect(count).toBe(1);
  });
});
