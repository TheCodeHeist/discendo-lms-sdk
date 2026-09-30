import { describe, it, expect } from 'bun:test';
import { generateOccurrences } from '../src/domains/scheduling/generator.js';
import { SchedulingService } from '../src/domains/scheduling/service.js';
import { InMemorySchedulingRepository } from '../src/domains/scheduling/testing/in-memory-repository.js';
import type { ClassSessionTemplate } from '../src/domains/scheduling/index.js';

function baseTemplate(overrides: Partial<ClassSessionTemplate> = {}): ClassSessionTemplate {
  return {
    id: 'tpl-1',
    sectionId: 'sec-1',
    teacherIds: ['teacher-1'],
    groupId: 'group-1',
    roomId: 'room-1',
    rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE', 'FR'] },
    startTime: '10:00',
    endTime: '11:00',
    timezone: 'UTC',
    validFrom: new Date('2026-10-05'), // a Monday
    ...overrides,
  };
}

describe('generateOccurrences', () => {
  it('produces one occurrence per matching weekday in range', () => {
    const template = baseTemplate();
    const results = generateOccurrences(template, new Date('2026-10-05'), new Date('2026-10-11'));
    // Mon 10/5, Wed 10/7, Fri 10/9 within that week
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
    ]);
  });

  it('respects interval > 1 (fortnightly)', () => {
    const template = baseTemplate({
      rule: { freq: 'WEEKLY', interval: 2, byDay: ['MO'] },
    });
    // 4 weeks: 10/5 (week 0, fires), 10/12 (week 1, skip), 10/19 (week 2, fires), 10/26 (week 3, skip)
    const results = generateOccurrences(template, new Date('2026-10-05'), new Date('2026-10-26'));
    expect(results.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2026-10-05',
      '2026-10-19',
    ]);
  });

  it('clamps to validUntil even if range extends further', () => {
    const template = baseTemplate({ validUntil: new Date('2026-10-07') });
    const results = generateOccurrences(template, new Date('2026-10-05'), new Date('2026-10-11'));
    expect(results.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2026-10-05',
      '2026-10-07',
    ]);
  });

  it('returns empty when range is entirely before validFrom', () => {
    const template = baseTemplate({ validFrom: new Date('2026-12-01') });
    const results = generateOccurrences(template, new Date('2026-10-05'), new Date('2026-10-11'));
    expect(results).toHaveLength(0);
  });
});

describe('SchedulingService.materializeOccurrences', () => {
  it('persists generated occurrences via the repository', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(baseTemplate());
    const service = new SchedulingService(repo);

    const result = await service.materializeOccurrences(
      'tpl-1',
      new Date('2026-10-05'),
      new Date('2026-10-11'),
    );
    expect(result).toHaveLength(3);
    expect(result.every((o) => o.status === 'scheduled')).toBe(true);
  });

  it('is idempotent — re-running does not duplicate occurrences', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(baseTemplate());
    const service = new SchedulingService(repo);

    await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-11'));
    const second = await service.materializeOccurrences(
      'tpl-1',
      new Date('2026-10-05'),
      new Date('2026-10-11'),
    );
    expect(second).toHaveLength(3);
  });
});

describe('SchedulingService.checkConflicts end-to-end', () => {
  it('detects a teacher double-booked across two different templates', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(baseTemplate({ id: 'tpl-1', groupId: 'group-1' }));
    repo.seedTemplate(
      baseTemplate({ id: 'tpl-2', groupId: 'group-2', roomId: 'room-2', sectionId: 'sec-2' }),
    );
    const service = new SchedulingService(repo);

    await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
    const [second] = await service.materializeOccurrences(
      'tpl-2',
      new Date('2026-10-05'),
      new Date('2026-10-05'),
    );

    const conflicts = await service.checkConflicts(second!, {
      teacherIds: ['teacher-1'],
      roomId: 'room-2',
      groupId: 'group-2',
      startTime: '10:00',
      endTime: '11:00',
    });

    expect(conflicts.some((c) => c.resourceType === 'teacher')).toBe(true);
  });

  it('finds no conflicts when resources differ', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(baseTemplate({ id: 'tpl-1' }));
    repo.seedTemplate(
      baseTemplate({
        id: 'tpl-2',
        teacherIds: ['teacher-2'],
        groupId: 'group-2',
        roomId: 'room-2',
        sectionId: 'sec-2',
      }),
    );
    const service = new SchedulingService(repo);

    await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
    const [second] = await service.materializeOccurrences(
      'tpl-2',
      new Date('2026-10-05'),
      new Date('2026-10-05'),
    );

    const conflicts = await service.checkConflicts(second!, {
      teacherIds: ['teacher-2'],
      roomId: 'room-2',
      groupId: 'group-2',
      startTime: '10:00',
      endTime: '11:00',
    });

    expect(conflicts).toHaveLength(0);
  });
});
