import { describe, it, expect } from 'bun:test';
import { findConflictsForResource, effectiveWindow } from '../src/scheduling/index.js';
import type { ClassOccurrence } from '../src/scheduling/index.js';

function occ(id: string, date: string, status: ClassOccurrence['status'] = 'scheduled'): ClassOccurrence {
  return { id, templateId: 't1', date: new Date(date), status };
}

describe('findConflictsForResource', () => {
  it('flags overlapping time windows on the same date', () => {
    const candidate = occ('c1', '2026-10-05');
    const existing = occ('c2', '2026-10-05');
    const windows = new Map([['c2', { start: '10:00', end: '11:00' }]]);

    const conflicts = findConflictsForResource(
      'teacher',
      'teacher-1',
      candidate,
      { start: '10:30', end: '11:30' },
      [existing],
      windows,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.resourceId).toBe('teacher-1');
  });

  it('does not flag back-to-back non-overlapping windows', () => {
    const candidate = occ('c1', '2026-10-05');
    const existing = occ('c2', '2026-10-05');
    const windows = new Map([['c2', { start: '09:00', end: '10:00' }]]);

    const conflicts = findConflictsForResource(
      'room',
      'room-1',
      candidate,
      { start: '10:00', end: '11:00' },
      [existing],
      windows,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('ignores cancelled occurrences', () => {
    const candidate = occ('c1', '2026-10-05');
    const existing = occ('c2', '2026-10-05', 'cancelled');
    const windows = new Map([['c2', { start: '10:00', end: '11:00' }]]);

    const conflicts = findConflictsForResource(
      'group',
      'group-1',
      candidate,
      { start: '10:30', end: '11:30' },
      [existing],
      windows,
    );
    expect(conflicts).toHaveLength(0);
  });

  it('ignores occurrences on a different date', () => {
    const candidate = occ('c1', '2026-10-05');
    const existing = occ('c2', '2026-10-06');
    const windows = new Map([['c2', { start: '10:00', end: '11:00' }]]);

    const conflicts = findConflictsForResource(
      'teacher',
      'teacher-1',
      candidate,
      { start: '10:00', end: '11:00' },
      [existing],
      windows,
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('effectiveWindow', () => {
  it('falls back to template window when no override is set', () => {
    const result = effectiveWindow(occ('c1', '2026-10-05'), '09:00', '10:00');
    expect(result).toEqual({ start: '09:00', end: '10:00' });
  });

  it('prefers a per-occurrence override', () => {
    const withOverride: ClassOccurrence = {
      ...occ('c1', '2026-10-05'),
      startTime: '13:00',
      endTime: '14:00',
    };
    const result = effectiveWindow(withOverride, '09:00', '10:00');
    expect(result).toEqual({ start: '13:00', end: '14:00' });
  });
});
