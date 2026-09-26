import type { Id } from '../core/types.js';
import type { SchedulingRepository } from './repositories.js';
import type { ClassOccurrence, ClassSessionTemplate } from './types.js';
import { effectiveWindow, findConflictsForResource, type ResourceConflict } from './conflict.js';
import { checkAvailability, type AvailabilityCheckResult } from './availability.js';
import { checkRoomSuitability, type RoomRequirement } from './room-matching.js';
import { generateOccurrences } from './generator.js';
import {
  flattenAvailabilityForSolver,
  placementsToTemplatePatches,
  roomToSolverRoom,
  type SolvedTemplatePatch,
} from './solver-adapter.js';
import { solveSchedule } from './solver/backtracking.js';
import type { SchedulingProblem, SolveResult, SolverOptions, UnscheduledSession } from './solver/types.js';

export interface AvailabilityViolation {
  resourceType: 'teacher' | 'room' | 'group';
  resourceId: Id;
  reason: string;
}

export interface RoomViolation {
  roomId: Id;
  reasons: string[];
}

export interface SchedulingCheckResult {
  conflicts: ResourceConflict[];
  availabilityViolations: AvailabilityViolation[];
  roomViolation?: RoomViolation;
  /** True only when there are no conflicts, availability violations, or room mismatch. */
  ok: boolean;
}

export class SchedulingService {
  constructor(private readonly scheduling: SchedulingRepository) {}

  /**
   * Checks a candidate occurrence against everything already booked for the
   * same teachers/room/group in the surrounding window. Returns every
   * conflict found across all three resource types — empty array means clear.
   *
   * This is the primitive both manual scheduling UIs and the auto-generator
   * (added later) build on; it never assumes an occurrence came from a solve.
   *
   * This only checks for double-booking. It does NOT check whether the
   * resources are even supposed to be working this slot — see
   * `checkAvailabilityForResources` for that, or `checkAll` to run both.
   */
  async checkConflicts(
    candidate: ClassOccurrence,
    resources: {
      teacherIds: Id[];
      roomId?: Id;
      groupId: Id;
      startTime: string;
      endTime: string;
    },
  ): Promise<ResourceConflict[]> {
    const dayStart = new Date(candidate.date);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(candidate.date);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const candidateWindow = effectiveWindow(candidate, resources.startTime, resources.endTime);
    const conflicts: ResourceConflict[] = [];

    for (const teacherId of resources.teacherIds) {
      const existing = await this.scheduling.listOccurrencesForResource(
        'teacher',
        teacherId,
        dayStart,
        dayEnd,
      );
      conflicts.push(
        ...this.diffAgainst('teacher', teacherId, candidate, candidateWindow, existing, resources),
      );
    }

    if (resources.roomId) {
      const existing = await this.scheduling.listOccurrencesForResource(
        'room',
        resources.roomId,
        dayStart,
        dayEnd,
      );
      conflicts.push(
        ...this.diffAgainst('room', resources.roomId, candidate, candidateWindow, existing, resources),
      );
    }

    const groupExisting = await this.scheduling.listOccurrencesForResource(
      'group',
      resources.groupId,
      dayStart,
      dayEnd,
    );
    conflicts.push(
      ...this.diffAgainst('group', resources.groupId, candidate, candidateWindow, groupExisting, resources),
    );

    return conflicts;
  }

  /**
   * Checks whether every resource involved is actually allowed to be booked
   * at this date/time — teacher work hours, room open hours, group meeting
   * hours, per their declared AvailabilityRules. A resource with no rules
   * on file is treated as always available (see availability.ts).
   */
  async checkAvailabilityForResources(
    date: Date,
    resources: {
      teacherIds: Id[];
      roomId?: Id;
      groupId: Id;
      startTime: string;
      endTime: string;
    },
  ): Promise<AvailabilityViolation[]> {
    const violations: AvailabilityViolation[] = [];

    const checkOne = async (
      resourceType: 'teacher' | 'room' | 'group',
      resourceId: Id,
    ): Promise<void> => {
      const rules = await this.scheduling.listAvailability(resourceType, resourceId);
      const result: AvailabilityCheckResult = checkAvailability(
        rules,
        date,
        resources.startTime,
        resources.endTime,
      );
      if (!result.available) {
        violations.push({ resourceType, resourceId, reason: result.reason ?? 'Not available.' });
      }
    };

    for (const teacherId of resources.teacherIds) {
      await checkOne('teacher', teacherId);
    }
    if (resources.roomId) {
      await checkOne('room', resources.roomId);
    }
    await checkOne('group', resources.groupId);

    return violations;
  }

  /**
   * Checks whether a specific room has enough capacity and the required
   * feature tags for a session. Pure capacity/feature match only — does not
   * check whether the room is free at that time (see checkConflicts) or
   * within its open hours (see checkAvailabilityForResources).
   */
  async checkRoomForOccurrence(
    roomId: Id,
    requirement: RoomRequirement,
  ): Promise<RoomViolation | undefined> {
    const room = await this.scheduling.findRoom(roomId);
    if (!room) {
      return { roomId, reasons: [`Room ${roomId} not found.`] };
    }
    const result = checkRoomSuitability(room, requirement);
    return result.suitable ? undefined : { roomId, reasons: result.reasons };
  }

  /**
   * Runs conflict, availability, and (when a room is given) capacity/feature
   * checks together — the one call most scheduling UIs actually want, since
   * "is this slot bookable at all" means all three at once. `roomRequirement`
   * is optional: omit it if you don't need capacity/feature enforcement.
   */
  async checkAll(
    candidate: ClassOccurrence,
    resources: {
      teacherIds: Id[];
      roomId?: Id;
      groupId: Id;
      startTime: string;
      endTime: string;
    },
    roomRequirement?: RoomRequirement,
  ): Promise<SchedulingCheckResult> {
    const [conflicts, availabilityViolations, roomViolation] = await Promise.all([
      this.checkConflicts(candidate, resources),
      this.checkAvailabilityForResources(candidate.date, resources),
      resources.roomId && roomRequirement
        ? this.checkRoomForOccurrence(resources.roomId, roomRequirement)
        : Promise.resolve(undefined),
    ]);
    return {
      conflicts,
      availabilityViolations,
      ...(roomViolation ? { roomViolation } : {}),
      ok: conflicts.length === 0 && availabilityViolations.length === 0 && !roomViolation,
    };
  }

  private diffAgainst(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    candidate: ClassOccurrence,
    candidateWindow: { start: string; end: string },
    existing: ClassOccurrence[],
    resources: { startTime: string; endTime: string },
  ): ResourceConflict[] {
    // Existing occurrences fall back to the same template window unless they
    // carry their own override — callers with per-template windows should
    // build a real Map; this default assumes one shared window per call.
    const windows = new Map(
      existing.map((o) => [o.id, effectiveWindow(o, resources.startTime, resources.endTime)]),
    );
    return findConflictsForResource(
      resourceType,
      resourceId,
      candidate,
      candidateWindow,
      existing,
      windows,
    );
  }

  /**
   * Materializes occurrences for a template across [rangeStart, rangeEnd]
   * and persists them, skipping dates that already have an occurrence for
   * this template so repeated calls (the "keep a rolling window filled"
   * pattern) are safe to run idempotently.
   */
  async materializeOccurrences(
    templateId: Id,
    rangeStart: Date,
    rangeEnd: Date,
  ): Promise<ClassOccurrence[]> {
    const template = await this.scheduling.findTemplate(templateId);
    if (!template) throw new Error(`materializeOccurrences: template ${templateId} not found`);

    const already = await this.scheduling.listOccurrences(templateId, rangeStart, rangeEnd);
    const existingDates = new Set(already.map((o) => o.date.toISOString().slice(0, 10)));

    const candidates = generateOccurrences(template, rangeStart, rangeEnd).filter(
      (o) => !existingDates.has(o.date.toISOString().slice(0, 10)),
    );

    if (candidates.length === 0) return already;

    const created = await this.scheduling.createOccurrences(candidates);
    return [...already, ...created];
  }

  /** Cancels a single occurrence without touching its template or siblings. */
  async cancelOccurrence(id: Id, note?: string): Promise<ClassOccurrence> {
    const patch: Partial<ClassOccurrence> = { status: 'cancelled' };
    if (note !== undefined) patch.note = note;
    return this.scheduling.updateOccurrence(id, patch);
  }

  /** Moves a single occurrence to a new room/time, leaving the template untouched. */
  async rescheduleOccurrence(
    id: Id,
    patch: { roomId?: Id; startTime?: string; endTime?: string; date?: Date },
  ): Promise<ClassOccurrence> {
    return this.scheduling.updateOccurrence(id, { ...patch, status: 'moved' });
  }

  /**
   * Runs the auto-suggestion solver against a set of templates and returns
   * a plan (which room/day/time each template would get) without writing
   * anything — review the plan, then call `applyAutoSchedulePlan` once
   * you're happy with it. Kept as two steps deliberately: silently
   * overwriting templates on every call would be a surprising thing for a
   * library to do, and a caller may want to show the plan to a human first.
   *
   * `durationMinutes` per template is derived from its own startTime/endTime
   * if it already has them (e.g. re-solving an existing template); pass it
   * explicitly via `durationOverrides` for brand-new templates that don't
   * have times yet.
   */
  async planAutoSchedule(
    templateIds: Id[],
    grid: { candidateSlotsPerDay: string[]; days: import('./types.js').Weekday[] },
    durationOverrides: Record<Id, number> = {},
    solverOptions?: SolverOptions,
  ): Promise<{ result: SolveResult; skippedAvailability: string[] }> {
    const templates: ClassSessionTemplate[] = [];
    for (const id of templateIds) {
      const t = await this.scheduling.findTemplate(id);
      if (!t) throw new Error(`planAutoSchedule: template ${id} not found`);
      templates.push(t);
    }

    const skippedAvailability: string[] = [];
    const availabilityWindows = [];

    const teacherIds = new Set(templates.flatMap((t) => t.teacherIds));
    const groupIds = new Set(templates.map((t) => t.groupId));

    for (const teacherId of teacherIds) {
      const rules = await this.scheduling.listAvailability('teacher', teacherId);
      const { windows, skipped } = flattenAvailabilityForSolver(rules, 'teacher', teacherId);
      availabilityWindows.push(...windows);
      if (skipped.length > 0) skippedAvailability.push(`teacher:${teacherId}`);
    }
    for (const groupId of groupIds) {
      const rules = await this.scheduling.listAvailability('group', groupId);
      const { windows, skipped } = flattenAvailabilityForSolver(rules, 'group', groupId);
      availabilityWindows.push(...windows);
      if (skipped.length > 0) skippedAvailability.push(`group:${groupId}`);
    }

    const rooms = await this.scheduling.listRooms();
    for (const room of rooms) {
      const rules = await this.scheduling.listAvailability('room', room.id);
      const { windows, skipped } = flattenAvailabilityForSolver(rules, 'room', room.id);
      availabilityWindows.push(...windows);
      if (skipped.length > 0) skippedAvailability.push(`room:${room.id}`);
    }

    const sessions: UnscheduledSession[] = [];
    for (const t of templates) {
      const group = await this.scheduling.findGroup(t.groupId);
      if (!group) throw new Error(`planAutoSchedule: group ${t.groupId} not found for template ${t.id}`);

      const duration =
        durationOverrides[t.id] ?? minutesBetween(t.startTime, t.endTime) ?? undefined;
      if (duration === undefined) {
        throw new Error(
          `planAutoSchedule: template ${t.id} has no derivable duration — pass it via durationOverrides.`,
        );
      }

      sessions.push({
        id: t.id,
        sectionId: t.sectionId,
        teacherIds: t.teacherIds,
        groupId: t.groupId,
        groupSize: group.size,
        ...(t.requiredRoomFeatures ? { requiredRoomFeatures: t.requiredRoomFeatures } : {}),
        candidateDays: t.rule.byDay,
        durationMinutes: duration,
      });
    }

    const problem: SchedulingProblem = {
      sessions,
      rooms: rooms.map(roomToSolverRoom),
      availability: availabilityWindows,
      candidateSlotsPerDay: grid.candidateSlotsPerDay,
      days: grid.days,
    };

    const result = solveSchedule(problem, solverOptions);
    return { result, skippedAvailability };
  }

  /**
   * Writes a solved plan's placements back onto their templates (room,
   * time, and which days the rule fires on). Templates that the solver
   * marked unplaceable are left untouched — handle those separately, e.g.
   * via manual scheduling.
   */
  async applyAutoSchedulePlan(result: SolveResult): Promise<ClassSessionTemplate[]> {
    const patches: SolvedTemplatePatch[] = placementsToTemplatePatches(result.placements);
    const updated: ClassSessionTemplate[] = [];
    for (const patch of patches) {
      const template = await this.scheduling.findTemplate(patch.templateId);
      if (!template) continue;
      const next = await this.scheduling.updateTemplate(patch.templateId, {
        roomId: patch.roomId,
        startTime: patch.startTime,
        endTime: patch.endTime,
        rule: { ...template.rule, byDay: patch.days },
      });
      updated.push(next);
    }
    return updated;
  }
}

function minutesBetween(start: string, end: string): number | undefined {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return undefined;
  return eh * 60 + em - (sh * 60 + sm);
}
