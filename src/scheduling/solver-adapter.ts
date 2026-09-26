/**
 * Bridges SchedulingRepository data and the solver's pure in-memory
 * SchedulingProblem shape. The solver itself never touches a repository
 * (see solver/types.ts) — this is where that boundary is crossed.
 */
import type { Id } from "../core/types.js";
import type { AvailabilityRule, Room, Weekday } from "./types.js";
import type {
  PlacedSession,
  ResourceAvailabilityWindow,
  SolverRoom,
  UnscheduledSession,
} from "./solver/types.js";

/**
 * Flattens an AvailabilityRule into per-weekday windows for the solver's
 * "one representative week" model.
 *
 * Limitation: only `interval === 1` (fires every week) rules translate
 * faithfully. A fortnightly-or-sparser rule (`interval > 1`) doesn't have a
 * single representative week — the solver would either over-constrain (if
 * treated as "never available") or under-constrain (if treated as "always
 * available on its by-days"), and neither is safe to pick silently. Such
 * rules are skipped here (treated as if the resource is unconstrained by
 * them), and reported back so the caller can decide, e.g. warn the user or
 * fall back to manual placement for that resource.
 */
export function flattenAvailabilityForSolver(
  rules: AvailabilityRule[],
  resourceType: "teacher" | "room" | "group",
  resourceId: Id,
): { windows: ResourceAvailabilityWindow[]; skipped: AvailabilityRule[] } {
  const windows: ResourceAvailabilityWindow[] = [];
  const skipped: AvailabilityRule[] = [];

  for (const rule of rules) {
    if (rule.rule.interval !== 1 || rule.rule.raw) {
      skipped.push(rule);
      continue;
    }
    for (const day of rule.rule.byDay) {
      windows.push({
        resourceType,
        resourceId,
        day,
        startTime: rule.startTime,
        endTime: rule.endTime,
      });
    }
  }

  return { windows, skipped };
}

export function roomToSolverRoom(room: Room): SolverRoom {
  return { id: room.id, capacity: room.capacity, features: room.features };
}

/** Every weekday the solver's `days` field can contain, in institution order. */
export const ALL_WEEKDAYS: Weekday[] = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
];

export interface SolvedTemplatePatch {
  templateId: Id;
  roomId: Id;
  startTime: string;
  endTime: string;
  /** Every weekday this template should meet on, at the room/time above. */
  days: Weekday[];
}

/** Converts solver placements back into the patches a caller applies to templates. */
export function placementsToTemplatePatches(
  placements: PlacedSession[],
): SolvedTemplatePatch[] {
  return placements.map((p) => ({
    templateId: p.sessionId,
    roomId: p.roomId,
    startTime: p.startTime,
    endTime: p.endTime,
    days: p.days,
  }));
}

export type { UnscheduledSession };
