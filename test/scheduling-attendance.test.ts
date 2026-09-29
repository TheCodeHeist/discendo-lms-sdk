import { describe, it, expect } from 'bun:test';
import { SchedulingService, validateAttendanceTarget } from '../src/domains/scheduling/index.js';
import { InMemorySchedulingRepository } from '../src/domains/scheduling/testing/in-memory-repository.js';
import type { AttendanceEntry, AttendanceRecorder } from '../src/domains/scheduling/index.js';
import type { ClassSessionTemplate } from '../src/domains/scheduling/index.js';

function template(overrides: Partial<ClassSessionTemplate> = {}): ClassSessionTemplate {
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
    ...overrides,
  };
}

class FakeAttendanceRecorder implements AttendanceRecorder {
  entries: AttendanceEntry[] = [];
  async record(entry: AttendanceEntry): Promise<void> {
    this.entries.push(entry);
  }
  async listForSession(sessionId: string): Promise<AttendanceEntry[]> {
    return this.entries.filter((e) => e.sessionId === sessionId);
  }
}

describe('validateAttendanceTarget', () => {
  it('is valid (no error) for a scheduled occurrence', () => {
    const result = validateAttendanceTarget({
      id: 'occ-1',
      templateId: 'tpl-1',
      date: new Date('2026-10-05'),
      status: 'scheduled',
    });
    expect(result).toBeUndefined();
  });

  it('is valid for a completed occurrence', () => {
    const result = validateAttendanceTarget({
      id: 'occ-1',
      templateId: 'tpl-1',
      date: new Date('2026-10-05'),
      status: 'completed',
    });
    expect(result).toBeUndefined();
  });

  it('rejects a null occurrence as not-found', () => {
    const result = validateAttendanceTarget(null);
    expect(result?.reason).toBe('occurrence-not-found');
  });

  it('rejects a cancelled occurrence', () => {
    const result = validateAttendanceTarget({
      id: 'occ-1',
      templateId: 'tpl-1',
      date: new Date('2026-10-05'),
      status: 'cancelled',
    });
    expect(result?.reason).toBe('occurrence-cancelled');
  });

  it('allows a moved occurrence (still happened, just relocated)', () => {
    const result = validateAttendanceTarget({
      id: 'occ-1',
      templateId: 'tpl-1',
      date: new Date('2026-10-05'),
      status: 'moved',
      roomId: 'room-2',
    });
    expect(result).toBeUndefined();
  });
});

describe('SchedulingService attendance integration', () => {
  it('records attendance for a valid occurrence', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(template());
    const recorder = new FakeAttendanceRecorder();
    const service = new SchedulingService(repo, recorder);

    const [occ] = await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
    await service.recordAttendanceForOccurrence(occ!.id, 'student-1', 'present');

    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.sessionId).toBe(occ!.id);
    expect(recorder.entries[0]?.status).toBe('present');
  });

  it('refuses to record attendance for a cancelled occurrence', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(template());
    const recorder = new FakeAttendanceRecorder();
    const service = new SchedulingService(repo, recorder);

    const [occ] = await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
    await service.cancelOccurrence(occ!.id, 'snow day');

    await expect(
      service.recordAttendanceForOccurrence(occ!.id, 'student-1', 'present'),
    ).rejects.toThrow(/cancelled/);
    expect(recorder.entries).toHaveLength(0);
  });

  it('refuses to record attendance for a nonexistent occurrence', async () => {
    const repo = new InMemorySchedulingRepository();
    const recorder = new FakeAttendanceRecorder();
    const service = new SchedulingService(repo, recorder);

    await expect(
      service.recordAttendanceForOccurrence('does-not-exist', 'student-1', 'present'),
    ).rejects.toThrow(/No occurrence/);
  });

  it('throws clearly if no AttendanceRecorder was configured', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(template());
    const service = new SchedulingService(repo); // no recorder passed

    const [occ] = await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
    await expect(
      service.recordAttendanceForOccurrence(occ!.id, 'student-1', 'present'),
    ).rejects.toThrow(/no AttendanceRecorder/);
  });

  it('canRecordAttendance reports the same validation without throwing', async () => {
    const repo = new InMemorySchedulingRepository();
    repo.seedTemplate(template());
    const service = new SchedulingService(repo);

    const [occ] = await service.materializeOccurrences('tpl-1', new Date('2026-10-05'), new Date('2026-10-05'));
    const okCheck = await service.canRecordAttendance(occ!.id);
    expect(okCheck).toBeUndefined();

    await service.cancelOccurrence(occ!.id);
    const cancelledCheck = await service.canRecordAttendance(occ!.id);
    expect(cancelledCheck?.reason).toBe('occurrence-cancelled');
  });
});
