import { describe, it, expect } from 'bun:test';
import { SchedulingService } from '../src/scheduling/index.js';
import { InMemorySchedulingRepository } from '../src/scheduling/testing/in-memory-repository.js';
import type { ClassSessionTemplate } from '../src/scheduling/index.js';

function unsolvedTemplate(overrides: Partial<ClassSessionTemplate> = {}): ClassSessionTemplate {
  return {
    id: 'tpl-1',
    sectionId: 'sec-1',
    teacherIds: ['teacher-1'],
    groupId: 'group-1',
    // No roomId yet — this is what the solver decides.
    rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'] },
    startTime: '09:00', // used only to derive duration; solver picks the real slot
    endTime: '10:00',
    timezone: 'UTC',
    validFrom: new Date('2026-10-05'),
    ...overrides,
  };
}

describe('SchedulingService auto-scheduling', () => {
  it('plans and applies a schedule end to end for a single template', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate());
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', capacity: 30, features: [] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00', '10:00', '11:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
    expect(result.placements).toHaveLength(1);

    const [updated] = await service.applyAutoSchedulePlan(result);
    expect(updated?.roomId).toBe('room-1');
    expect(updated?.rule.byDay.sort()).toEqual(['MO', 'WE']);

    // Confirm the persisted template actually reflects the plan.
    const persisted = await repo.findTemplate('tpl-1');
    expect(persisted?.roomId).toBe('room-1');
  });

  it('places two templates sharing a teacher onto non-conflicting days/rooms', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(
      unsolvedTemplate({ id: 'tpl-1', groupId: 'group-1', rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] } }),
    );
    repo.seedTemplate(
      unsolvedTemplate({ id: 'tpl-2', groupId: 'group-2', rule: { freq: 'WEEKLY', interval: 1, byDay: ['TU'] } }),
    );
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedGroup({ id: 'group-2', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', capacity: 30, features: [] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1', 'tpl-2'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
    await service.applyAutoSchedulePlan(result);

    const t1 = await repo.findTemplate('tpl-1');
    const t2 = await repo.findTemplate('tpl-2');
    // Different days -> no actual conflict, even sharing the same teacher/room/time.
    expect(t1?.rule.byDay).toEqual(['MO']);
    expect(t2?.rule.byDay).toEqual(['TU']);
  });

  it('respects a required room feature end to end', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate({ requiredRoomFeatures: ['lab'] }));
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', capacity: 30, features: [] });
    repo.seedRoom({ id: 'room-lab', capacity: 30, features: ['lab'] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
    expect(result.placements[0]?.roomId).toBe('room-lab');
  });

  it('respects teacher availability rules loaded from the repository', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate({ rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] } }));
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', capacity: 30, features: [] });
    repo.seedAvailability({
      id: 'avail-1',
      resourceId: 'teacher-1',
      resourceType: 'teacher',
      rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] },
      startTime: '13:00',
      endTime: '17:00',
      timezone: 'UTC',
      validFrom: new Date('2026-10-05'),
    });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00', '14:00'], // 09:00 is outside the teacher's window
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
    expect(result.placements[0]?.startTime).toBe('14:00');
  });

  it('reports unplaceable templates without throwing', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate());
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 999 }); // too big for any room
    repo.seedRoom({ id: 'room-1', capacity: 30, features: [] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('INFEASIBLE');
    expect(result.unplaced[0]?.sessionId).toBe('tpl-1');

    // Applying an all-unplaced plan should be a safe no-op.
    const updated = await service.applyAutoSchedulePlan(result);
    expect(updated).toHaveLength(0);
    const stillUnset = await repo.findTemplate('tpl-1');
    expect(stillUnset?.roomId).toBeUndefined();
  });
});
