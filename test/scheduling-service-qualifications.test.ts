import { describe, it, expect } from 'bun:test';
import { SchedulingService } from '../src/domains/scheduling/index.js';
import { InMemorySchedulingRepository } from '../src/domains/scheduling/testing/in-memory-repository.js';
import type { ClassSessionTemplate } from '../src/domains/scheduling/index.js';

function unsolvedTemplate(overrides: Partial<ClassSessionTemplate> = {}): ClassSessionTemplate {
  return {
    id: 'tpl-1',
    sectionId: 'sec-1',
    teacherIds: ['teacher-1'],
    groupId: 'group-1',
    rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'] },
    startTime: '09:00',
    endTime: '10:00',
    timezone: 'UTC',
    validFrom: new Date('2026-10-05'),
    ...overrides,
  };
}

describe('SchedulingService.planAutoSchedule with teacher qualifications', () => {
  it('schedules a template whose teacher is qualified for its course', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate({ courseId: 'course-physics' }));
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', name: 'Room 1', capacity: 30, features: [] });
    repo.seedTeacherQualification({ teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
  });

  it('refuses to schedule a template whose teacher lacks the course qualification', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate({ courseId: 'course-chemistry' }));
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', name: 'Room 1', capacity: 30, features: [] });
    repo.seedTeacherQualification({ teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('INFEASIBLE');
    expect(result.unplaced[0]?.sessionId).toBe('tpl-1');

    const stillUnset = await repo.findTemplate('tpl-1');
    expect(stillUnset?.roomId).toBeUndefined();
  });

  it('does not enforce qualification for a template with no courseId', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate()); // no courseId set
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', name: 'Room 1', capacity: 30, features: [] });
    repo.seedTeacherQualification({ teacherId: 'teacher-1', qualifiedCourseIds: [] });

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
  });

  it('does not enforce qualification for a teacher with no qualification record at all', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(unsolvedTemplate({ courseId: 'course-anything' }));
    repo.seedGroup({ id: 'group-1', sectionId: 'sec-1', size: 20 });
    repo.seedRoom({ id: 'room-1', name: 'Room 1', capacity: 30, features: [] });
    // no seedTeacherQualification call at all

    const service = new SchedulingService(repo);
    const { result } = await service.planAutoSchedule(['tpl-1'], {
      candidateSlotsPerDay: ['09:00'],
      days: ['MO', 'TU', 'WE', 'TH', 'FR'],
    });

    expect(result.status).toBe('COMPLETE');
  });
});
