/**
 * Pure room-suitability checks: does a room have enough capacity and the
 * required feature tags for a given group/session? No booking/conflict
 * awareness here — a room can be "suitable" and still be double-booked;
 * see conflict.ts and availability.ts for those, and solver/ for combining
 * all three into a placement decision.
 */
import type { Room } from './types.js';

export interface RoomRequirement {
  minCapacity: number;
  requiredFeatures?: string[];
}

export interface RoomMatchResult {
  suitable: boolean;
  reasons: string[];
}

export function checkRoomSuitability(room: Room, requirement: RoomRequirement): RoomMatchResult {
  const reasons: string[] = [];

  if (room.capacity < requirement.minCapacity) {
    reasons.push(
      `Room "${room.name}" capacity ${room.capacity} is below required ${requirement.minCapacity}.`,
    );
  }

  const missing = (requirement.requiredFeatures ?? []).filter((f) => !room.features.includes(f));
  if (missing.length > 0) {
    reasons.push(`Room "${room.name}" is missing required feature(s): ${missing.join(', ')}.`);
  }

  return { suitable: reasons.length === 0, reasons };
}

/** Filters a room list down to ones that satisfy a requirement. */
export function findSuitableRooms(rooms: Room[], requirement: RoomRequirement): Room[] {
  return rooms.filter((r) => checkRoomSuitability(r, requirement).suitable);
}
