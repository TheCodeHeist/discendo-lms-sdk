import { describe, it, expect } from 'bun:test';
import { checkAvailability } from '../src/scheduling/index.js';
import type { AvailabilityRule } from '../src/scheduling/index.js';

function rule(overrides: Partial<AvailabilityRule> = {}): AvailabilityRule {
  return {
    id: 'avail-1',
    resourceId: 'teacher-1',
    resourceType: 'teacher',
    rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] },
    startTime: '09:00',
    endTime: '17:00',
    timezone: 'UTC',
    validFrom: new Date('2026-10-05'), // a Monday
    ...overrides,
  };
}

describe('checkAvailability', () => {
  it('treats a resource with no rules as always available', () => {
    const result = checkAvailability([], new Date('2026-10-05'), '10:00', '11:00');
    expect(result.available).toBe(true);
  });

  it('is available when the window falls fully inside a matching rule', () => {
    const result = checkAvailability([rule()], new Date('2026-10-06'), '10:00', '11:00');
    expect(result.available).toBe(true);
  });

  it('is unavailable when the window falls outside declared hours', () => {
    const result = checkAvailability([rule()], new Date('2026-10-06'), '18:00', '19:00');
    expect(result.available).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('is unavailable on a day the rule does not cover', () => {
    // 2026-10-04 is a Sunday; rule only covers Mon-Fri
    const result = checkAvailability([rule()], new Date('2026-10-04'), '10:00', '11:00');
    expect(result.available).toBe(false);
  });

  it('is unavailable before validFrom', () => {
    const result = checkAvailability(
      [rule({ validFrom: new Date('2026-11-01') })],
      new Date('2026-10-06'),
      '10:00',
      '11:00',
    );
    expect(result.available).toBe(false);
  });

  it('is unavailable after validUntil', () => {
    const result = checkAvailability(
      [rule({ validUntil: new Date('2026-10-10') })],
      new Date('2026-10-20'),
      '10:00',
      '11:00',
    );
    expect(result.available).toBe(false);
  });

  it('is available if any one of several rules matches (e.g. split shift)', () => {
    const morning = rule({ startTime: '09:00', endTime: '12:00' });
    const afternoon = rule({ id: 'avail-2', startTime: '14:00', endTime: '18:00' });
    const result = checkAvailability([morning, afternoon], new Date('2026-10-06'), '15:00', '16:00');
    expect(result.available).toBe(true);
  });

  it('respects fortnightly availability (interval=2)', () => {
    const fortnightly = rule({ rule: { freq: 'WEEKLY', interval: 2, byDay: ['MO'] } });
    // week 0 (10/5) fires, week 1 (10/12) does not
    const weekZero = checkAvailability([fortnightly], new Date('2026-10-05'), '10:00', '11:00');
    const weekOne = checkAvailability([fortnightly], new Date('2026-10-12'), '10:00', '11:00');
    expect(weekZero.available).toBe(true);
    expect(weekOne.available).toBe(false);
  });
});
