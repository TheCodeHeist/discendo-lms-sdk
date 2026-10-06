import type { Id } from '../../core/types.js';
import type { EventBus } from '../../core/events.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError, activeSectionRole } from '../../core/permissions.js';
import { authorizeInSection, authorizeWithinOwnOrg } from '../../core/authorization.js';
import type { Authorized, AuthorizationRepos } from '../../core/authorization.js';
import { sameOrg } from '../../core/tenancy.js';
import type { SchedulingRepository, SchedulingSettingsRepository } from './repositories.js';
import {
  InvalidSchedulingPlanError,
  InvalidSchedulingSettingsError,
  SchedulingTargetNotFoundError,
} from './types.js';
import type {
  AvailabilityRule,
  ClassOccurrence,
  ClassSessionTemplate,
  RecurrenceRule,
  TeacherQualification,
  TeacherSchedulingPreferences,
  Weekday,
} from './types.js';
import { teacherTimePreference } from './solver/soft-constraints.js';
import { effectiveWindow, findConflictsForResource, type ResourceConflict } from './rules/conflict.js';
import { checkAvailability, type AvailabilityCheckResult } from './rules/availability.js';
import { checkRoomSuitability, type RoomRequirement } from './rules/room-matching.js';
import { generateOccurrences } from './generator.js';
import {
  flattenAvailabilityForSolver,
  placementsToTemplatePatches,
  roomToSolverRoom,
  type SolvedTemplatePatch,
} from './solver-adapter.js';
import { solveSchedule } from './solver/backtracking.js';
import type { SchedulingProblem, SolveResult, SolverOptions, UnscheduledSession } from './solver/types.js';
import { validateAttendanceTarget, type AttendanceEntry, type AttendanceRecorder } from './attendance.js';

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

/** Everything needed to turn permission enforcement on, bundled so none of it can be forgotten. */
export interface SchedulingEnforcement {
  policy: PermissionPolicy;
  repos: AuthorizationRepos;
}

export interface SchedulingServiceOptions {
  /**
   * Turns on permission enforcement (and organization checks on rooms, teachers, groups and
   * courses). Once set, every public method that touches schedules or settings requires an
   * `{ actorId }` argument and refuses to run without one. Leave it unset and the service behaves as
   * it always has: no actor, no permission checks, no organization checks.
   */
  enforcement?: SchedulingEnforcement;
  /**
   * Where the settings methods (availability, preferences, qualifications) write. Without it those
   * methods throw; reading a schedule never needs it. Saved preferences are used by
   * `planAutoSchedule` when it is given.
   */
  settings?: SchedulingSettingsRepository;
}

/** What `authorizeOccurrence` found, so the caller can act on it and report who did. */
interface OccurrenceGuard {
  auth: Authorized;
  occurrence: ClassOccurrence;
  template: ClassSessionTemplate;
  oversight: { sectionId: string; actorId: string; actorRole?: 'admin' | 'instructor' | 'ta' };
}

const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SchedulingService {
  constructor(
    private readonly scheduling: SchedulingRepository,
    private readonly attendanceRecorder?: AttendanceRecorder,
    private readonly events?: EventBus,
    private readonly options: SchedulingServiceOptions = {},
  ) {}

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
    actor?: ActorContext,
  ): Promise<ResourceConflict[]> {
    // With enforcement: the section is the candidate's STORED template's (never what the caller says
    // the candidate is), and every resource must belong to the actor's organization, so this cannot
    // be used to read another organization's bookings.
    if (this.options.enforcement) {
      const { auth } = await this.authorizeTemplate('scheduling.manageOccurrence', actor, candidate.templateId);
      await this.assertResourcesInOrg(auth.ctx.resourceOrgId, resources);
    }
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
    actor?: ActorContext,
  ): Promise<AvailabilityViolation[]> {
    // No candidate here to tie to a section, so this is organization-wide: an instructor or admin
    // of the organization, asking about resources of that same organization.
    if (this.options.enforcement) {
      const auth = await this.authorizeOrg('scheduling.manageOccurrence', actor);
      await this.assertResourcesInOrg(auth.ctx.actor.orgId, resources);
    }
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
    actor?: ActorContext,
  ): Promise<RoomViolation | undefined> {
    if (this.options.enforcement) {
      const auth = await this.authorizeOrg('scheduling.manageOccurrence', actor);
      await this.assertRoomInOrg(roomId, auth.ctx.actor.orgId);
    }
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
    actor?: ActorContext,
  ): Promise<SchedulingCheckResult> {
    // Authorize against the candidate's section first, so a refusal is always the same refusal and
    // reads nothing; each of the three checks then authorizes the actor itself as well.
    if (this.options.enforcement) await this.authorizeTemplate('scheduling.manageOccurrence', actor, candidate.templateId);
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
    actor?: ActorContext,
  ): Promise<ClassOccurrence[]> {
    if (this.options.enforcement) await this.authorizeTemplate('scheduling.manage', actor, templateId);
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
  async cancelOccurrence(id: Id, note?: string, actor?: ActorContext): Promise<ClassOccurrence> {
    const guard = await this.authorizeOccurrence('scheduling.manageOccurrence', actor, id);
    const patch: Partial<ClassOccurrence> = { status: 'cancelled' };
    if (note !== undefined) patch.note = note;
    const updated = await this.scheduling.updateOccurrence(id, patch);
    void this.events?.emit({
      type: 'scheduling.occurrenceCancelled',
      occurrenceId: updated.id,
      templateId: updated.templateId,
      ...(updated.note !== undefined && { note: updated.note }),
      // oversight: who cancelled it, and what it was
      ...(guard ? { ...guard.oversight, previousStatus: guard.occurrence.status } : {}),
    });
    return updated;
  }

  /** Moves a single occurrence to a new room/time, leaving the template untouched. */
  async rescheduleOccurrence(
    id: Id,
    patch: { roomId?: Id; startTime?: string; endTime?: string; date?: Date },
    actor?: ActorContext,
  ): Promise<ClassOccurrence> {
    const guard = await this.authorizeOccurrence('scheduling.manageOccurrence', actor, id);
    // the room must belong to the organization of the section being rescheduled
    if (guard && patch.roomId !== undefined) await this.assertRoomInOrg(patch.roomId, guard.auth.ctx.resourceOrgId);
    const updated = await this.scheduling.updateOccurrence(id, { ...patch, status: 'moved' });
    void this.events?.emit({
      type: 'scheduling.occurrenceRescheduled',
      occurrenceId: updated.id,
      templateId: updated.templateId,
      date: updated.date,
      ...(updated.roomId !== undefined && { roomId: updated.roomId }),
      ...(updated.startTime !== undefined && { startTime: updated.startTime }),
      ...(updated.endTime !== undefined && { endTime: updated.endTime }),
      // oversight: who moved it, and where it was before (the effective values, template defaults included)
      ...(guard ? { ...guard.oversight, from: previousOf(guard.occurrence, guard.template) } : {}),
    });
    return updated;
  }

  /**
   * Records attendance for a single student against a specific occurrence,
   * refusing to do so if the occurrence doesn't exist or was cancelled (see
   * validateAttendanceTarget). Requires an AttendanceRecorder to have been
   * passed to the constructor — throws otherwise, since calling this
   * without one wiring one up is a caller mistake, not a runtime condition
   * to handle gracefully.
   *
   * reporting.AttendanceRepository already satisfies AttendanceRecorder's
   * shape, so the same repository implementation you give ReportingService
   * can be passed here unchanged.
   */
  async recordAttendanceForOccurrence(
    occurrenceId: Id,
    userId: Id,
    status: AttendanceEntry['status'],
    actor?: ActorContext,
  ): Promise<void> {
    const guard = await this.authorizeOccurrence('scheduling.recordAttendance', actor, occurrenceId);
    if (guard) {
      // attendance is only ever about a student who is currently taking the section
      const membership = await this.options.enforcement!.repos.enrollments.findByUserAndSection(
        userId,
        guard.oversight.sectionId,
      );
      if (activeSectionRole(membership) !== 'student') throw new PermissionDeniedError('scheduling.recordAttendance');
    }
    if (!this.attendanceRecorder) {
      throw new Error(
        'recordAttendanceForOccurrence: no AttendanceRecorder was provided to SchedulingService.',
      );
    }

    const occurrence = await this.scheduling.findOccurrence(occurrenceId);
    const error = validateAttendanceTarget(occurrence);
    if (error) {
      throw new Error(`recordAttendanceForOccurrence: ${error.message}`);
    }

    await this.attendanceRecorder.record({
      sessionId: occurrenceId,
      userId,
      status,
      recordedAt: new Date(),
      ...(guard ? { recordedBy: guard.oversight.actorId } : {}),
    });
  }

  /**
   * Same validation as recordAttendanceForOccurrence, without throwing —
   * use this in a UI path where you want to show the user why a class
   * can't accept attendance yet (e.g. greyed out for a cancelled session)
   * rather than catching an exception.
   */
  async canRecordAttendance(
    occurrenceId: Id,
    actor?: ActorContext,
  ): Promise<ReturnType<typeof validateAttendanceTarget>> {
    await this.authorizeOccurrence('scheduling.recordAttendance', actor, occurrenceId);
    const occurrence = await this.scheduling.findOccurrence(occurrenceId);
    return validateAttendanceTarget(occurrence);
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
    actor?: ActorContext,
  ): Promise<{ result: SolveResult; skippedAvailability: string[] }> {
    // With enforcement the plan stays inside one organization: the actor needs scheduling.manage in
    // every template's section, and only that organization's rooms are ever offered to the solver.
    let orgId: string | undefined;
    const enforcement = this.options.enforcement;
    if (enforcement) {
      if (templateIds.length === 0) {
        orgId = (await this.authorizeOrg('scheduling.manage', actor)).ctx.actor.orgId;
      }
      for (const id of templateIds) {
        const { auth, template } = await this.authorizeTemplate('scheduling.manage', actor, id);
        orgId = auth.ctx.resourceOrgId;
        await this.assertTemplateResourcesInOrg(template, orgId);
      }
    }
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

    const allRooms = await this.scheduling.listRooms();
    const rooms = enforcement ? allRooms.filter((r) => sameOrg(r.orgId, orgId)) : allRooms;
    for (const room of rooms) {
      const rules = await this.scheduling.listAvailability('room', room.id);
      const { windows, skipped } = flattenAvailabilityForSolver(rules, 'room', room.id);
      availabilityWindows.push(...windows);
      if (skipped.length > 0) skippedAvailability.push(`room:${room.id}`);
    }

    const teacherQualifications = [];
    for (const teacherId of teacherIds) {
      const qualification = await this.scheduling.findTeacherQualification(teacherId);
      if (qualification) teacherQualifications.push(qualification);
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
        ...(t.courseId ? { courseId: t.courseId } : {}),
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
      ...(teacherQualifications.length > 0 ? { teacherQualifications } : {}),
      candidateSlotsPerDay: grid.candidateSlotsPerDay,
      days: grid.days,
    };

    const result = solveSchedule(problem, await this.withSavedPreferences([...teacherIds], solverOptions));
    return { result, skippedAvailability };
  }

  /**
   * Writes a solved plan's placements back onto their templates (room,
   * time, and which days the rule fires on). Templates that the solver
   * marked unplaceable are left untouched — handle those separately, e.g.
   * via manual scheduling.
   */
  async applyAutoSchedulePlan(result: SolveResult, actor?: ActorContext): Promise<ClassSessionTemplate[]> {
    const patches: SolvedTemplatePatch[] = placementsToTemplatePatches(result.placements);
    // A plan is data the caller hands over, so with enforcement every placement is checked first
    // (permission in its template's section, the room's organization, well-formed times and days)
    // and nothing is written unless all of them pass.
    if (this.options.enforcement) await this.verifyPlan(patches, actor);
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

  // ---- the timetable, read ----

  /**
   * A section's occurrences between two dates (inclusive), across all of its templates, oldest
   * first, cancelled ones included (students need to know a class is off). With enforcement
   * (`actor` required) this is `scheduling.view` in the section: its active members, staff, and a
   * guardian whose link has the `schedule` scope who names the ward (`options.wardId`). Without
   * enforcement it returns everything.
   */
  async listOccurrences(
    sectionId: Id,
    from: Date,
    to: Date,
    actor?: ActorContext,
    options: { wardId?: Id } = {},
  ): Promise<ClassOccurrence[]> {
    const e = this.options.enforcement;
    if (e) {
      await authorizeInSection(e.policy, e.repos, 'scheduling.view', actor, { sectionId, ownerId: options.wardId });
    }
    const found: ClassOccurrence[] = [];
    for (const template of await this.scheduling.listTemplatesForSection(sectionId)) {
      found.push(...(await this.scheduling.listOccurrences(template.id, from, to)));
    }
    return found.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // ---- settings ----

  /**
   * Replaces ALL of a resource's availability rules (an empty list clears them) and returns the
   * stored rules. With enforcement (`actor` required): a **teacher's** are managed by that
   * instructor or by an admin (`scheduling.manageSettings`), and the teacher must be in the actor's
   * organization; a **room's** and a **group's** are admin-only (`scheduling.manage`), and must be
   * in the actor's organization. The rules are validated after the permission check
   * (`InvalidSchedulingSettingsError`) and the old ones are kept if they are not valid.
   */
  async setAvailability(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    rules: Array<Omit<AvailabilityRule, 'id' | 'resourceId' | 'resourceType'>>,
    actor?: ActorContext,
  ): Promise<AvailabilityRule[]> {
    await this.authorizeResourceSettings(resourceType, resourceId, actor);
    const clean = validateAvailability(rules);
    return this.settings().replaceAvailability(resourceType, resourceId, clean);
  }

  /** A resource's availability rules, with the same permission as `setAvailability`. */
  async getAvailability(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    actor?: ActorContext,
  ): Promise<AvailabilityRule[]> {
    await this.authorizeResourceSettings(resourceType, resourceId, actor);
    return this.scheduling.listAvailability(resourceType, resourceId);
  }

  /**
   * Saves what a teacher prefers, replacing earlier preferences (`{}` clears them). Needs
   * `scheduling.manageSettings`: the instructor themselves, or an admin, for a teacher of the
   * actor's organization. `planAutoSchedule` uses them as soft constraints, weight 1 for everyone.
   */
  async setTeacherPreferences(
    teacherId: Id,
    preferences: Omit<TeacherSchedulingPreferences, 'teacherId'>,
    actor?: ActorContext,
  ): Promise<TeacherSchedulingPreferences> {
    await this.authorizeTeacherSettings(teacherId, actor);
    const clean = validatePreferences(preferences);
    return this.settings().saveTeacherPreferences({ teacherId, ...clean });
  }

  /** A teacher's saved preferences, or null, with the same permission as `setTeacherPreferences`. */
  async getTeacherPreferences(teacherId: Id, actor?: ActorContext): Promise<TeacherSchedulingPreferences | null> {
    await this.authorizeTeacherSettings(teacherId, actor);
    return this.settings().findTeacherPreferences(teacherId);
  }

  /**
   * Sets which courses a teacher is qualified for, replacing the earlier list. **Admins only**
   * (`scheduling.manageQualifications`): an instructor cannot qualify themselves. With enforcement
   * the teacher and every course must belong to the actor's organization. An empty list means
   * qualified for nothing (a teacher with no record at all is not restricted).
   */
  async setTeacherQualification(
    teacherId: Id,
    qualifiedCourseIds: Id[],
    actor?: ActorContext,
  ): Promise<TeacherQualification> {
    const e = this.options.enforcement;
    if (e) {
      const auth = await this.authorizeOrg('scheduling.manageQualifications', actor);
      const orgId = auth.ctx.actor.orgId;
      await this.assertUserInOrg(teacherId, orgId);
      if (Array.isArray(qualifiedCourseIds)) {
        for (const courseId of qualifiedCourseIds) {
          const course = await e.repos.courses.findCourse(courseId);
          if (!course || !sameOrg(course.orgId, orgId)) throw new SchedulingTargetNotFoundError();
        }
      }
    }
    if (!Array.isArray(qualifiedCourseIds) || qualifiedCourseIds.some((c) => typeof c !== 'string' || c === '')) {
      throw new InvalidSchedulingSettingsError('Qualified courses must be a list of course ids');
    }
    return this.settings().saveTeacherQualification({ teacherId, qualifiedCourseIds: [...new Set(qualifiedCourseIds)] });
  }

  /** A teacher's qualification, or null: the instructor themselves, or an admin (`scheduling.manageSettings`). */
  async getTeacherQualification(teacherId: Id, actor?: ActorContext): Promise<TeacherQualification | null> {
    await this.authorizeTeacherSettings(teacherId, actor);
    return this.scheduling.findTeacherQualification(teacherId);
  }

  // ---- helpers ----

  private settings(): SchedulingSettingsRepository {
    const settings = this.options.settings;
    if (!settings) {
      throw new Error('Managing scheduling settings needs a SchedulingSettingsRepository (options.settings)');
    }
    return settings;
  }

  /** The soft constraints for the teachers' saved preferences, added to the caller's own. */
  private async withSavedPreferences(teacherIds: Id[], options: SolverOptions | undefined): Promise<SolverOptions | undefined> {
    const settings = this.options.settings;
    if (!settings) return options;
    const saved = [];
    for (const teacherId of teacherIds) {
      const window = (await settings.findTeacherPreferences(teacherId))?.preferredStartWindow;
      if (window) saved.push(teacherTimePreference(teacherId, window.earliest, window.latest, 1));
    }
    if (saved.length === 0) return options;
    return { ...options, softConstraints: [...(options?.softConstraints ?? []), ...saved] };
  }

  /** Authorizes in a template's section, looking the template up only once there is an actor. */
  private async authorizeTemplate(
    action: Action,
    actor: ActorContext | undefined,
    templateId: Id,
  ): Promise<{ auth: Authorized; template: ClassSessionTemplate }> {
    const e = this.options.enforcement!;
    const template = actor ? await this.scheduling.findTemplate(templateId) : null;
    const auth = await authorizeInSection(e.policy, e.repos, action, actor, { sectionId: template?.sectionId });
    // authorizeInSection has already refused a missing template, so there is one here.
    return { auth, template: template! };
  }

  /**
   * Authorizes in the section of an occurrence's STORED template and returns what the caller needs
   * to report who did it. Undefined without enforcement. An unknown occurrence, or one whose
   * template is gone, is refused like a forbidden one.
   */
  private async authorizeOccurrence(
    action: Action,
    actor: ActorContext | undefined,
    occurrenceId: Id,
  ): Promise<OccurrenceGuard | undefined> {
    const e = this.options.enforcement;
    if (!e) return undefined;
    const occurrence = actor ? await this.scheduling.findOccurrence(occurrenceId) : null;
    const template = occurrence ? await this.scheduling.findTemplate(occurrence.templateId) : null;
    const auth = await authorizeInSection(e.policy, e.repos, action, actor, { sectionId: template?.sectionId });
    const actorRole = actorRoleOf(auth);
    return {
      auth,
      occurrence: occurrence!,
      template: template!,
      oversight: { sectionId: template!.sectionId, actorId: actor!.actorId, ...(actorRole ? { actorRole } : {}) },
    };
  }

  /** For actions that belong to no section: the actor's own organization, account-wide roles only. */
  private authorizeOrg(action: Action, actor: ActorContext | undefined, ownerId?: Id): Promise<Authorized> {
    const e = this.options.enforcement!;
    return authorizeWithinOwnOrg(e.policy, e.repos, action, actor, { ownerId });
  }

  private async authorizeTeacherSettings(teacherId: Id, actor: ActorContext | undefined): Promise<void> {
    if (!this.options.enforcement) return;
    const auth = await this.authorizeOrg('scheduling.manageSettings', actor, teacherId);
    await this.assertUserInOrg(teacherId, auth.ctx.actor.orgId);
  }

  private async authorizeResourceSettings(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    actor: ActorContext | undefined,
  ): Promise<void> {
    const e = this.options.enforcement;
    if (!e) return;
    if (resourceType === 'teacher') return this.authorizeTeacherSettings(resourceId, actor);
    if (resourceType === 'room') {
      const auth = await this.authorizeOrg('scheduling.manage', actor);
      await this.assertRoomInOrg(resourceId, auth.ctx.actor.orgId);
      return;
    }
    // a group belongs to a section, so the admin must hold scheduling.manage in THAT section
    const group = actor ? await this.scheduling.findGroup(resourceId) : null;
    await authorizeInSection(e.policy, e.repos, 'scheduling.manage', actor, { sectionId: group?.sectionId });
  }

  private async assertUserInOrg(userId: Id, orgId: string | undefined): Promise<void> {
    const user = await this.options.enforcement!.repos.users.findById(userId);
    if (!user || !sameOrg(user.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  private async assertRoomInOrg(roomId: Id, orgId: string | undefined): Promise<void> {
    const room = await this.scheduling.findRoom(roomId);
    if (!room || !sameOrg(room.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  private async assertGroupInOrg(groupId: Id, orgId: string | undefined): Promise<void> {
    const repos = this.options.enforcement!.repos;
    const group = await this.scheduling.findGroup(groupId);
    const section = group ? await repos.courses.findSection(group.sectionId) : null;
    const course = section ? await repos.courses.findCourse(section.courseId) : null;
    if (!course || !sameOrg(course.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  private async assertResourcesInOrg(
    orgId: string | undefined,
    resources: { teacherIds: Id[]; roomId?: Id; groupId: Id },
  ): Promise<void> {
    for (const teacherId of resources.teacherIds) await this.assertUserInOrg(teacherId, orgId);
    if (resources.roomId !== undefined) await this.assertRoomInOrg(resources.roomId, orgId);
    await this.assertGroupInOrg(resources.groupId, orgId);
  }

  private async assertTemplateResourcesInOrg(template: ClassSessionTemplate, orgId: string | undefined): Promise<void> {
    await this.assertResourcesInOrg(orgId, {
      teacherIds: template.teacherIds,
      groupId: template.groupId,
      ...(template.roomId !== undefined ? { roomId: template.roomId } : {}),
    });
  }

  /** Checks a whole plan, and throws on the first problem, before anything is written. */
  private async verifyPlan(patches: SolvedTemplatePatch[], actor: ActorContext | undefined): Promise<void> {
    if (patches.length === 0) {
      await this.authorizeOrg('scheduling.manage', actor);
      return;
    }
    for (const patch of patches) {
      const { auth } = await this.authorizeTemplate('scheduling.manage', actor, patch.templateId);
      await this.assertRoomInOrg(patch.roomId, auth.ctx.resourceOrgId);
      if (
        !HHMM.test(patch.startTime) ||
        !HHMM.test(patch.endTime) ||
        toMinutes(patch.startTime) >= toMinutes(patch.endTime) ||
        !Array.isArray(patch.days) ||
        patch.days.length === 0 ||
        patch.days.some((d) => !WEEKDAYS.includes(d))
      ) {
        throw new InvalidSchedulingPlanError(`The placement for ${patch.templateId} has invalid times or days`);
      }
    }
  }
}

/** 'admin' if the actor is one, else the role they acted as in the section, if it is staff. */
function actorRoleOf(auth: Authorized): 'admin' | 'instructor' | 'ta' | undefined {
  if (auth.ctx.actor.roles.includes('admin')) return 'admin';
  const role = auth.ctx.section?.role;
  return role === 'instructor' || role === 'ta' ? role : undefined;
}

/** What an occurrence was before it moved: its own values, or its template's where it has none. */
function previousOf(
  occurrence: ClassOccurrence,
  template: ClassSessionTemplate,
): NonNullable<import('../../core/events.js').OccurrenceRescheduledEvent['from']> {
  const roomId = occurrence.roomId ?? template.roomId;
  const startTime = occurrence.startTime ?? template.startTime;
  const endTime = occurrence.endTime ?? template.endTime;
  return {
    date: occurrence.date,
    status: occurrence.status,
    ...(roomId !== undefined ? { roomId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  };
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function validRecurrence(rule: RecurrenceRule): boolean {
  return (
    !!rule &&
    rule.freq === 'WEEKLY' &&
    Number.isInteger(rule.interval) &&
    rule.interval >= 1 &&
    Array.isArray(rule.byDay) &&
    rule.byDay.length > 0 &&
    rule.byDay.every((d) => WEEKDAYS.includes(d))
  );
}

/** Availability rules the planner and checks can rely on, copied field by field (nothing else gets through). */
function validateAvailability(
  rules: Array<Omit<AvailabilityRule, 'id' | 'resourceId' | 'resourceType'>>,
): Array<Omit<AvailabilityRule, 'id' | 'resourceId' | 'resourceType'>> {
  if (!Array.isArray(rules)) throw new InvalidSchedulingSettingsError('Availability must be a list of rules');
  return rules.map((r, i) => {
    const where = `Availability rule ${i + 1}`;
    if (!validRecurrence(r.rule)) throw new InvalidSchedulingSettingsError(`${where}: the recurrence needs a weekly rule with an interval of at least 1 and known days`);
    if (!HHMM.test(r.startTime) || !HHMM.test(r.endTime)) throw new InvalidSchedulingSettingsError(`${where}: times must be HH:MM`);
    if (toMinutes(r.startTime) >= toMinutes(r.endTime)) throw new InvalidSchedulingSettingsError(`${where}: it must end after it starts`);
    if (typeof r.timezone !== 'string' || r.timezone === '') throw new InvalidSchedulingSettingsError(`${where}: a timezone is required`);
    if (!(r.validFrom instanceof Date) || Number.isNaN(r.validFrom.getTime())) throw new InvalidSchedulingSettingsError(`${where}: validFrom must be a date`);
    if (r.validUntil !== undefined && (!(r.validUntil instanceof Date) || Number.isNaN(r.validUntil.getTime()) || r.validUntil < r.validFrom)) {
      throw new InvalidSchedulingSettingsError(`${where}: validUntil must be a date on or after validFrom`);
    }
    return {
      rule: { ...r.rule },
      startTime: r.startTime,
      endTime: r.endTime,
      timezone: r.timezone,
      validFrom: r.validFrom,
      ...(r.validUntil !== undefined ? { validUntil: r.validUntil } : {}),
    };
  });
}

function validatePreferences(
  preferences: Omit<TeacherSchedulingPreferences, 'teacherId'>,
): Omit<TeacherSchedulingPreferences, 'teacherId'> {
  const window = preferences?.preferredStartWindow;
  if (window === undefined) return {};
  if (!HHMM.test(window.earliest) || !HHMM.test(window.latest)) {
    throw new InvalidSchedulingSettingsError('A preferred start window needs earliest and latest as HH:MM');
  }
  if (toMinutes(window.earliest) > toMinutes(window.latest)) {
    throw new InvalidSchedulingSettingsError('A preferred start window cannot end before it starts');
  }
  return { preferredStartWindow: { earliest: window.earliest, latest: window.latest } };
}

function minutesBetween(start: string, end: string): number | undefined {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return undefined;
  return eh * 60 + em - (sh * 60 + sm);
}
