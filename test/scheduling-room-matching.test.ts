import { describe, it, expect } from 'bun:test';
import { checkRoomSuitability, findSuitableRooms } from '../src/scheduling/index.js';
import type { Room } from '../src/scheduling/index.js';

function room(overrides: Partial<Room> = {}): Room {
  return { id: 'room-1', name: 'Room 101', capacity: 30, features: [], ...overrides };
}

describe('checkRoomSuitability', () => {
  it('is suitable when capacity and features both match', () => {
    const r = room({ capacity: 30, features: ['projector'] });
    const result = checkRoomSuitability(r, { minCapacity: 20, requiredFeatures: ['projector'] });
    expect(result.suitable).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('is unsuitable when capacity is too small', () => {
    const r = room({ capacity: 10 });
    const result = checkRoomSuitability(r, { minCapacity: 20 });
    expect(result.suitable).toBe(false);
    expect(result.reasons[0]).toContain('capacity');
  });

  it('is unsuitable when a required feature is missing', () => {
    const r = room({ capacity: 30, features: [] });
    const result = checkRoomSuitability(r, { minCapacity: 20, requiredFeatures: ['lab'] });
    expect(result.suitable).toBe(false);
    expect(result.reasons[0]).toContain('lab');
  });

  it('reports both capacity and feature problems together', () => {
    const r = room({ capacity: 5, features: [] });
    const result = checkRoomSuitability(r, { minCapacity: 20, requiredFeatures: ['lab'] });
    expect(result.reasons).toHaveLength(2);
  });

  it('has no feature requirement issues when none are required', () => {
    const r = room({ capacity: 30, features: [] });
    const result = checkRoomSuitability(r, { minCapacity: 20 });
    expect(result.suitable).toBe(true);
  });
});

describe('findSuitableRooms', () => {
  it('filters down to only rooms that qualify', () => {
    const rooms = [
      room({ id: 'a', capacity: 10 }),
      room({ id: 'b', capacity: 40, features: ['lab'] }),
      room({ id: 'c', capacity: 40 }),
    ];
    const result = findSuitableRooms(rooms, { minCapacity: 30, requiredFeatures: ['lab'] });
    expect(result.map((r) => r.id)).toEqual(['b']);
  });
});
