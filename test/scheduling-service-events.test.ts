import { describe, it, expect } from 'bun:test';
import { SchedulingService } from '../src/domains/scheduling/index.js';
import type { ClassSessionTemplate } from '../src/domains/scheduling/index.js';
import { InMemorySchedulingRepository } from '../src/domains/scheduling/testing/in-memory-repository.js';
import { EventBus } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';

function template(): ClassSessionTemplate {
  return {
    id: 'tpl-1',
    sectionId: 'sec-1',
    teacherIds: ['teacher-1'],
    groupId: 'group-1',
    roomId: 'room-1',
    rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] },
    startTime: '10:00',
    endTime: '11:00',
    timezone: 'UTC',
    validFrom: new Date('2026-10-05'),
  };
}

async function setup() {
  const repo = new InMemorySchedulingRepository();
  repo.seedTemplate(template());
  const bus = new EventBus();
  const events: LmsEvent[] = [];
  bus.on('*', (e) => events.push(e));
  const service = new SchedulingService(repo, undefined, bus);
  const [occ] = await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { service, occ: occ!, events, flush, bus };
}

describe('SchedulingService event emission', () => {
  it('emits scheduling.occurrenceCancelled with the note', async () => {
    const { service, occ, events, flush } = await setup();

    await service.cancelOccurrence(occ.id, 'snow day');
    await flush();

    expect(events).toEqual([
      { type: 'scheduling.occurrenceCancelled', occurrenceId: occ.id, templateId: 'tpl-1', note: 'snow day' },
    ]);
  });

  it('omits note from the cancelled event when none was given', async () => {
    const { service, occ, events, flush } = await setup();

    await service.cancelOccurrence(occ.id);
    await flush();

    expect(events).toHaveLength(1);
    expect('note' in events[0]!).toBe(false);
  });

  it('emits scheduling.occurrenceRescheduled carrying the post-move values', async () => {
    const { service, occ, events, flush } = await setup();

    await service.rescheduleOccurrence(occ.id, { roomId: 'room-2', startTime: '13:00', endTime: '14:00' });
    await flush();

    expect(events).toEqual([
      {
        type: 'scheduling.occurrenceRescheduled',
        occurrenceId: occ.id,
        templateId: 'tpl-1',
        date: occ.date,
        roomId: 'room-2',
        startTime: '13:00',
        endTime: '14:00',
      },
    ]);
  });

  it('does not emit anything when materializing occurrences', async () => {
    const { events, flush } = await setup();
    await flush();
    expect(events).toHaveLength(0);
  });

  it('still completes the cancel when a listener throws', async () => {
    const { service, occ, bus, flush } = await setup();
    bus.on('scheduling.occurrenceCancelled', () => {
      throw new Error('listener bug');
    });

    const result = await service.cancelOccurrence(occ.id);
    await flush();

    expect(result.status).toBe('cancelled');
  });

  it('works with no EventBus supplied at all', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(template());
    const service = new SchedulingService(repo);
    const [occ] = await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));

    await expect(service.cancelOccurrence(occ!.id)).resolves.toMatchObject({ status: 'cancelled' });
  });
});
