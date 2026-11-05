import type { Id } from '../../../core/types.js';
import type { ActorContext } from '../../../core/permissions.js';
import type { ClassOccurrence } from '../types.js';
import { effectiveWindow, findConflictsForResource, type ResourceConflict } from '../rules/conflict.js';
import { checkAvailability } from '../rules/availability.js';
import { checkRoomSuitability, type RoomRequirement } from '../rules/room-matching.js';
import type { SchedulingAccess } from './access.js';
import type {
  AvailabilityViolation,
  BookingResources,
  RoomViolation,
  SchedulingCheckResult,
  SchedulingDeps,
} from './context.js';

type ResourceType = 'teacher' | 'room' | 'group';

/** "Is this slot bookable?": double-booking, availability and room suitability. */
export class SchedulingChecks {
  constructor(
    private readonly deps: SchedulingDeps,
    private readonly access: SchedulingAccess,
  ) {}

  async checkConflicts(
    candidate: ClassOccurrence,
    resources: BookingResources,
    actor?: ActorContext,
  ): Promise<ResourceConflict[]> {
    // With enforcement: the section is the candidate's STORED template's (never what the caller says
    // the candidate is), and every resource must belong to the actor's organization, so this cannot
    // be used to read another organization's bookings.
    if (this.access.enforcement) {
      const { auth } = await this.access.authorizeTemplate('scheduling.manageOccurrence', actor, candidate.templateId);
      await this.access.assertResourcesInOrg(auth.ctx.resourceOrgId, resources);
    }
    const dayStart = new Date(candidate.date);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(candidate.date);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const candidateWindow = effectiveWindow(candidate, resources.startTime, resources.endTime);
    const conflicts: ResourceConflict[] = [];

    const checkOne = async (resourceType: ResourceType, resourceId: Id): Promise<void> => {
      const existing = await this.deps.scheduling.listOccurrencesForResource(resourceType, resourceId, dayStart, dayEnd);
      // Existing occurrences fall back to the same template window unless they carry their own
      // override; this default assumes one shared window per call.
      const windows = new Map(existing.map((o) => [o.id, effectiveWindow(o, resources.startTime, resources.endTime)]));
      conflicts.push(...findConflictsForResource(resourceType, resourceId, candidate, candidateWindow, existing, windows));
    };

    for (const teacherId of resources.teacherIds) await checkOne('teacher', teacherId);
    if (resources.roomId) await checkOne('room', resources.roomId);
    await checkOne('group', resources.groupId);

    return conflicts;
  }

  async checkAvailabilityForResources(
    date: Date,
    resources: BookingResources,
    actor?: ActorContext,
  ): Promise<AvailabilityViolation[]> {
    // No candidate here to tie to a section, so this is organization-wide: an instructor or admin
    // of the organization, asking about resources of that same organization.
    if (this.access.enforcement) {
      const auth = await this.access.authorizeOrg('scheduling.manageOccurrence', actor);
      await this.access.assertResourcesInOrg(auth.ctx.actor.orgId, resources);
    }
    const violations: AvailabilityViolation[] = [];

    const checkOne = async (resourceType: ResourceType, resourceId: Id): Promise<void> => {
      const rules = await this.deps.scheduling.listAvailability(resourceType, resourceId);
      const result = checkAvailability(rules, date, resources.startTime, resources.endTime);
      if (!result.available) {
        violations.push({ resourceType, resourceId, reason: result.reason ?? 'Not available.' });
      }
    };

    for (const teacherId of resources.teacherIds) await checkOne('teacher', teacherId);
    if (resources.roomId) await checkOne('room', resources.roomId);
    await checkOne('group', resources.groupId);

    return violations;
  }

  async checkRoomForOccurrence(
    roomId: Id,
    requirement: RoomRequirement,
    actor?: ActorContext,
  ): Promise<RoomViolation | undefined> {
    if (this.access.enforcement) {
      const auth = await this.access.authorizeOrg('scheduling.manageOccurrence', actor);
      await this.access.assertRoomInOrg(roomId, auth.ctx.actor.orgId);
    }
    const room = await this.deps.scheduling.findRoom(roomId);
    if (!room) {
      return { roomId, reasons: [`Room ${roomId} not found.`] };
    }
    const result = checkRoomSuitability(room, requirement);
    return result.suitable ? undefined : { roomId, reasons: result.reasons };
  }

  async checkAll(
    candidate: ClassOccurrence,
    resources: BookingResources,
    roomRequirement?: RoomRequirement,
    actor?: ActorContext,
  ): Promise<SchedulingCheckResult> {
    // Authorize against the candidate's section first, so a refusal is always the same refusal and
    // reads nothing; each of the three checks then authorizes the actor itself as well.
    if (this.access.enforcement) await this.access.authorizeTemplate('scheduling.manageOccurrence', actor, candidate.templateId);
    const [conflicts, availabilityViolations, roomViolation] = await Promise.all([
      this.checkConflicts(candidate, resources, actor),
      this.checkAvailabilityForResources(candidate.date, resources, actor),
      resources.roomId && roomRequirement
        ? this.checkRoomForOccurrence(resources.roomId, roomRequirement, actor)
        : Promise.resolve(undefined),
    ]);
    return {
      conflicts,
      availabilityViolations,
      ...(roomViolation ? { roomViolation } : {}),
      ok: conflicts.length === 0 && availabilityViolations.length === 0 && !roomViolation,
    };
  }
}
