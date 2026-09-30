import { describe, it, expect } from 'bun:test';
import { bridgeEventBusToNotificationSink } from '../src/services/communication/index.js';
import type { NotificationEvent, NotificationSink } from '../src/services/communication/index.js';
import { EventBus } from '../src/core/index.js';

function makeSink() {
  const dispatched: NotificationEvent[] = [];
  const sink: NotificationSink = {
    dispatch: async (e) => {
      dispatched.push(e);
    },
  };
  return { sink, dispatched };
}

const gradePosted = {
  type: 'grading.gradePosted' as const,
  gradeEntryId: 'g1',
  submissionId: 'sub-1',
  userId: 'user-1',
  score: 85,
  maxScore: 100,
  graderId: 'grader-1',
};

describe('bridgeEventBusToNotificationSink', () => {
  it('translates grading.gradePosted into a gradePosted notification', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    bridgeEventBusToNotificationSink(bus, sink, { resolveContentId: (id) => `content-for-${id}` });

    await bus.emit(gradePosted);

    expect(dispatched).toEqual([
      { type: 'gradePosted', userId: 'user-1', contentId: 'content-for-sub-1', score: 85 },
    ]);
  });

  it('supports an async resolveContentId', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    bridgeEventBusToNotificationSink(bus, sink, { resolveContentId: async () => 'content-9' });

    await bus.emit(gradePosted);

    expect(dispatched[0]).toMatchObject({ contentId: 'content-9' });
  });

  it('skips the notification when the submission cannot be resolved', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    bridgeEventBusToNotificationSink(bus, sink, { resolveContentId: () => undefined });

    await bus.emit(gradePosted);

    expect(dispatched).toHaveLength(0);
  });

  it('forwards nothing for grades when no resolveContentId is supplied', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    bridgeEventBusToNotificationSink(bus, sink);

    await bus.emit(gradePosted);

    expect(dispatched).toHaveLength(0);
  });

  it('ignores events that have no notification equivalent', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    bridgeEventBusToNotificationSink(bus, sink, { resolveContentId: () => 'c' });

    await bus.emit({ type: 'enrollment.enrolled', enrollmentId: 'e1', userId: 'u1', sectionId: 's1', status: 'active' });
    await bus.emit({ type: 'content.published', contentId: 'c1', sectionId: 's1', version: 1 });

    expect(dispatched).toHaveLength(0);
  });

  it('reports a failing sink through onError without failing emit or the bus', async () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    const busErrors: unknown[] = [];
    const failingBus = new EventBus({ onHandlerError: (e) => busErrors.push(e) });
    const sink: NotificationSink = {
      dispatch: async () => {
        throw new Error('smtp down');
      },
    };
    bridgeEventBusToNotificationSink(failingBus, sink, {
      resolveContentId: () => 'c',
      onError: (e) => errors.push(e),
    });

    await expect(failingBus.emit(gradePosted)).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(busErrors).toHaveLength(0);
    void bus;
  });

  it('reports a throwing resolveContentId through onError', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    const errors: unknown[] = [];
    bridgeEventBusToNotificationSink(bus, sink, {
      resolveContentId: () => {
        throw new Error('db down');
      },
      onError: (e) => errors.push(e),
    });

    await bus.emit(gradePosted);

    expect(errors).toHaveLength(1);
    expect(dispatched).toHaveLength(0);
  });

  it('stops forwarding after the returned unsubscribe is called', async () => {
    const bus = new EventBus();
    const { sink, dispatched } = makeSink();
    const detach = bridgeEventBusToNotificationSink(bus, sink, { resolveContentId: () => 'c' });

    await bus.emit(gradePosted);
    detach();
    await bus.emit(gradePosted);

    expect(dispatched).toHaveLength(1);
  });
});
