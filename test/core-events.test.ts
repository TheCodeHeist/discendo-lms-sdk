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

const enrolled = (id: string): LmsEvent => ({
  type: 'enrollment.enrolled',
  enrollmentId: id,
  userId: 'u1',
  sectionId: 's1',
  status: 'active',
});

describe('EventBus handler typing', () => {
  it('accepts handlers that return a non-void value', async () => {
    const bus = new EventBus();
    const received: LmsEvent[] = [];
    // Returns a number (Array.push). Regression: this used to fail tsc.
    bus.on('enrollment.enrolled', (e) => received.push(e));
    bus.on('*', (e) => received.push(e));

    await bus.emit(enrolled('e1'));

    expect(received).toHaveLength(2);
  });
});

describe('EventBus wildcard listeners', () => {
  it("delivers every event type to an '*' handler", async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.on('*', (e) => {
      types.push(e.type);
    });

    await bus.emit(enrolled('e1'));
    await bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 1 });
    await bus.emit({ type: 'assessment.submissionReceived', submissionId: 'x', contentId: 'c', userId: 'u', attemptNumber: 1 });

    expect(types).toEqual(['enrollment.enrolled', 'content.published', 'assessment.submissionReceived']);
  });

  it('runs specific handlers before wildcard handlers for the same event', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('*', () => {
      order.push('wildcard');
    });
    bus.on('enrollment.enrolled', () => {
      order.push('specific');
    });

    await bus.emit(enrolled('e1'));

    expect(order).toEqual(['specific', 'wildcard']);
  });

  it('calls a handler once per event, not twice, when both a specific and a wildcard handler exist', async () => {
    const bus = new EventBus();
    let wildcardCalls = 0;
    bus.on('enrollment.enrolled', () => {});
    bus.on('*', () => {
      wildcardCalls++;
    });

    await bus.emit(enrolled('e1'));

    expect(wildcardCalls).toBe(1);
  });

  it('can be unsubscribed', async () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.on('*', () => {
      count++;
    });

    await bus.emit(enrolled('e1'));
    off();
    await bus.emit(enrolled('e2'));

    expect(count).toBe(1);
  });

  it('isolates a throwing wildcard handler and reports it via onHandlerError', async () => {
    const errors: unknown[] = [];
    const bus = new EventBus({ onHandlerError: (err) => errors.push(err) });
    let specificCalled = false;
    bus.on('*', () => {
      throw new Error('boom');
    });
    bus.on('enrollment.enrolled', () => {
      specificCalled = true;
    });

    await expect(bus.emit(enrolled('e1'))).resolves.toBeUndefined();

    expect(specificCalled).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('EventBus.once', () => {
  it('fires a typed handler exactly once', async () => {
    const bus = new EventBus();
    const ids: string[] = [];
    bus.once('enrollment.enrolled', (e) => {
      ids.push(e.enrollmentId);
    });

    await bus.emit(enrolled('e1'));
    await bus.emit(enrolled('e2'));

    expect(ids).toEqual(['e1']);
  });

  it('fires a wildcard handler exactly once, on the first event of any type', async () => {
    const bus = new EventBus();
    const types: string[] = [];
    bus.once('*', (e) => {
      types.push(e.type);
    });

    await bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 1 });
    await bus.emit(enrolled('e1'));

    expect(types).toEqual(['content.published']);
  });

  it('does not fire if cancelled before the event arrives', async () => {
    const bus = new EventBus();
    let called = false;
    const cancel = bus.once('enrollment.enrolled', () => {
      called = true;
    });
    cancel();

    await bus.emit(enrolled('e1'));

    expect(called).toBe(false);
  });

  it('still fires only once when the handler re-emits the same event type', async () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('enrollment.enrolled', async () => {
      calls++;
      await bus.emit(enrolled('nested'));
    });

    await bus.emit(enrolled('e1'));

    expect(calls).toBe(1);
  });

  it('does not disturb other handlers registered for the same type', async () => {
    const bus = new EventBus();
    let persistent = 0;
    bus.once('enrollment.enrolled', () => {});
    bus.on('enrollment.enrolled', () => {
      persistent++;
    });

    await bus.emit(enrolled('e1'));
    await bus.emit(enrolled('e2'));

    expect(persistent).toBe(2);
  });
});

