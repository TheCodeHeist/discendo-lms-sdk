import type { Id } from '../../core/types.js';
import type { EventBus } from '../../core/events.js';
import type { ActorContext } from '../../core/permissions.js';
import type { SchedulingRepository, SchedulingSettingsRepository } from './repositories.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import { AUTHORIZATION_REPOS, isServiceConfig, requireRepos, ServiceConfigError } from '../../core/service-config.js';
import type { ServiceConfig } from '../../core/service-config.js';
import type {
  AvailabilityRule,
  ClassOccurrence,
  ClassSessionTemplate,
  TeacherQualification,
  TeacherSchedulingPreferences,
  Weekday,
} from './types.js';
import type { ResourceConflict } from './rules/conflict.js';
import type { RoomRequirement } from './rules/room-matching.js';
import type { SolveResult, SolverOptions } from './solver/types.js';
import type { AttendanceEntry, AttendanceRecorder, validateAttendanceTarget } from './attendance.js';
import type {
  AvailabilityViolation,
  BookingResources,
  RoomViolation,
  SchedulingCheckResult,
  SchedulingServiceOptions,
} from './service/context.js';
import { SchedulingAccess } from './service/access.js';
import { SchedulingChecks } from './service/checks.js';
import { SchedulingOccurrences } from './service/occurrences.js';
import { SchedulingAutoScheduler } from './service/auto-schedule.js';
import { SchedulingSettings } from './service/settings.js';

export type {
  AvailabilityViolation,
  RoomViolation,
  SchedulingCheckResult,
  SchedulingEnforcement,
  SchedulingServiceOptions,
} from './service/context.js';

/**
 * `new SchedulingService({ repos: { scheduling, settings?, attendance?, ... }, policy?, events? })`.
 * `repos.settings` (a `SchedulingSettingsRepository`) enables the settings methods; `repos.attendance`
 * (an `AttendanceRecorder`, which reporting's `AttendanceRepository` fits) enables attendance. With a
 * `policy`, `repos` must also hold `users`, `courses` and `enrollments`.
 */
export interface SchedulingServiceConfig
  extends ServiceConfig<
    {
      scheduling: SchedulingRepository;
      settings?: SchedulingSettingsRepository;
      attendance?: AttendanceRecorder;
    } & Partial<AuthorizationRepos>
  > {}

/**
 * The scheduling module's one entry point. It is a thin facade: each group of methods is
 * implemented in its own file under `service/` (checks, occurrences, auto-scheduling, settings),
 * all sharing one set of permission and organization checks (`service/access.ts`).
 */
export class SchedulingService {
  private readonly checks: SchedulingChecks;
  private readonly occurrences: SchedulingOccurrences;
  private readonly autoScheduler: SchedulingAutoScheduler;
  private readonly settings: SchedulingSettings;

  constructor(config: SchedulingServiceConfig);
  /** @deprecated Pass one config object: `new SchedulingService({ repos: { scheduling, ... }, policy, events })`. See docs/MIGRATION.md. */
  constructor(
    scheduling: SchedulingRepository,
    attendanceRecorder?: AttendanceRecorder,
    events?: EventBus,
    options?: SchedulingServiceOptions,
  );
  constructor(...args: unknown[]) {
    let deps: { scheduling: SchedulingRepository; attendanceRecorder: AttendanceRecorder | undefined; events: EventBus | undefined; options: SchedulingServiceOptions };
    if (isServiceConfig(args)) {
      const { repos, policy, events } = args[0] as SchedulingServiceConfig;
      if (policy) requireRepos('SchedulingService', repos, AUTHORIZATION_REPOS);
      deps = {
        scheduling: repos.scheduling,
        attendanceRecorder: repos.attendance,
        events,
        options: {
          ...(policy ? { enforcement: { policy, repos: repos as AuthorizationRepos } } : {}),
          ...(repos.settings ? { settings: repos.settings } : {}),
        },
      };
    } else {
      const [scheduling, attendanceRecorder, events, options] = args as [
        SchedulingRepository,
        AttendanceRecorder | undefined,
        EventBus | undefined,
        SchedulingServiceOptions | undefined,
      ];
      deps = { scheduling, attendanceRecorder, events, options: options ?? {} };
    }
    const access = new SchedulingAccess(deps);
    this.checks = new SchedulingChecks(deps, access);
    this.occurrences = new SchedulingOccurrences(deps, access);
    this.autoScheduler = new SchedulingAutoScheduler(deps, access);
    this.settings = new SchedulingSettings(deps, access);
  }

  // ---- checks: is this slot bookable? ----

  /**
   * Checks a candidate occurrence against everything already booked for the
   * same teachers/room/group on the same day. Returns every conflict found
   * across all three resource types; an empty array means clear.
   *
   * This only checks for double-booking. It does NOT check whether the
   * resources are even supposed to be working this slot — see
   * `checkAvailabilityForResources` for that, or `checkAll` to run both.
   */
  checkConflicts(candidate: ClassOccurrence, resources: BookingResources, actor?: ActorContext): Promise<ResourceConflict[]> {
    return this.checks.checkConflicts(candidate, resources, actor);
  }

  /**
   * Checks whether every resource involved is actually allowed to be booked
   * at this date/time — teacher work hours, room open hours, group meeting
   * hours, per their declared AvailabilityRules. A resource with no rules
   * on file is treated as always available (see availability.ts).
   */
  checkAvailabilityForResources(date: Date, resources: BookingResources, actor?: ActorContext): Promise<AvailabilityViolation[]> {
    return this.checks.checkAvailabilityForResources(date, resources, actor);
  }

  /**
   * Checks whether a specific room has enough capacity and the required
   * feature tags for a session. Pure capacity/feature match only — does not
   * check whether the room is free at that time (see checkConflicts) or
   * within its open hours (see checkAvailabilityForResources).
   */
  checkRoomForOccurrence(roomId: Id, requirement: RoomRequirement, actor?: ActorContext): Promise<RoomViolation | undefined> {
    return this.checks.checkRoomForOccurrence(roomId, requirement, actor);
  }

  /**
   * Runs conflict, availability, and (when a room is given) capacity/feature
   * checks together — the one call most scheduling UIs actually want, since
   * "is this slot bookable at all" means all three at once. `roomRequirement`
   * is optional: omit it if you don't need capacity/feature enforcement.
   */
  checkAll(
    candidate: ClassOccurrence,
    resources: BookingResources,
    roomRequirement?: RoomRequirement,
    actor?: ActorContext,
  ): Promise<SchedulingCheckResult> {
    return this.checks.checkAll(candidate, resources, roomRequirement, actor);
  }

  // ---- occurrences: the concrete timetable ----

  /**
   * Materializes occurrences for a template across [rangeStart, rangeEnd]
   * and persists them, skipping dates that already have an occurrence for
   * this template so repeated calls (the "keep a rolling window filled"
   * pattern) are safe to run idempotently.
   */
  materializeOccurrences(templateId: Id, rangeStart: Date, rangeEnd: Date, actor?: ActorContext): Promise<ClassOccurrence[]> {
    return this.occurrences.materializeOccurrences(templateId, rangeStart, rangeEnd, actor);
  }

  /** Cancels a single occurrence without touching its template or siblings. */
  cancelOccurrence(id: Id, note?: string, actor?: ActorContext): Promise<ClassOccurrence> {
    return this.occurrences.cancelOccurrence(id, note, actor);
  }

  /** Moves a single occurrence to a new room/time, leaving the template untouched. */
  rescheduleOccurrence(
    id: Id,
    patch: { roomId?: Id; startTime?: string; endTime?: string; date?: Date },
    actor?: ActorContext,
  ): Promise<ClassOccurrence> {
    return this.occurrences.rescheduleOccurrence(id, patch, actor);
  }

  /**
   * Records attendance for a single student against a specific occurrence,
   * refusing to do so if the occurrence doesn't exist or was cancelled (see
   * validateAttendanceTarget). Requires an AttendanceRecorder to have been
   * passed to the constructor and throws otherwise, since calling this
   * without one is a caller mistake, not a runtime condition to handle.
   *
   * reporting.AttendanceRepository already satisfies AttendanceRecorder's
   * shape, so the same repository implementation you give ReportingService
   * can be passed here unchanged.
   */
  recordAttendanceForOccurrence(
    occurrenceId: Id,
    userId: Id,
    status: AttendanceEntry['status'],
    actor?: ActorContext,
  ): Promise<void> {
    return this.occurrences.recordAttendanceForOccurrence(occurrenceId, userId, status, actor);
  }

  /**
   * Same validation as recordAttendanceForOccurrence, without throwing —
   * use this in a UI path where you want to show the user why a class
   * can't accept attendance yet (e.g. greyed out for a cancelled session)
   * rather than catching an exception.
   */
  canRecordAttendance(occurrenceId: Id, actor?: ActorContext): Promise<ReturnType<typeof validateAttendanceTarget>> {
    return this.occurrences.canRecordAttendance(occurrenceId, actor);
  }

  /**
   * A section's occurrences between two dates (inclusive), across all of its templates, oldest
   * first, cancelled ones included (students need to know a class is off). With enforcement
   * (`actor` required) this is `scheduling.view` in the section: its active members, staff, and a
   * guardian whose link has the `schedule` scope who names the ward (`options.wardId`). Without
   * enforcement it returns everything.
   */
  listOccurrences(
    sectionId: Id,
    from: Date,
    to: Date,
    actor?: ActorContext,
    options: { wardId?: Id } = {},
  ): Promise<ClassOccurrence[]> {
    return this.occurrences.listOccurrences(sectionId, from, to, actor, options);
  }

  // ---- auto-scheduling ----

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
  planAutoSchedule(
    templateIds: Id[],
    grid: { candidateSlotsPerDay: string[]; days: Weekday[] },
    durationOverrides: Record<Id, number> = {},
    solverOptions?: SolverOptions,
    actor?: ActorContext,
  ): Promise<{ result: SolveResult; skippedAvailability: string[] }> {
    return this.autoScheduler.planAutoSchedule(templateIds, grid, durationOverrides, solverOptions, actor);
  }

  /**
   * Writes a solved plan's placements back onto their templates (room,
   * time, and which days the rule fires on). Templates that the solver
   * marked unplaceable are left untouched — handle those separately, e.g.
   * via manual scheduling.
   */
  applyAutoSchedulePlan(result: SolveResult, actor?: ActorContext): Promise<ClassSessionTemplate[]> {
    return this.autoScheduler.applyAutoSchedulePlan(result, actor);
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
  setAvailability(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    rules: Array<Omit<AvailabilityRule, 'id' | 'resourceId' | 'resourceType'>>,
    actor?: ActorContext,
  ): Promise<AvailabilityRule[]> {
    return this.settings.setAvailability(resourceType, resourceId, rules, actor);
  }

  /** A resource's availability rules, with the same permission as `setAvailability`. */
  getAvailability(resourceType: 'teacher' | 'room' | 'group', resourceId: Id, actor?: ActorContext): Promise<AvailabilityRule[]> {
    return this.settings.getAvailability(resourceType, resourceId, actor);
  }

  /**
   * Saves what a teacher prefers, replacing earlier preferences (`{}` clears them). Needs
   * `scheduling.manageSettings`: the instructor themselves, or an admin, for a teacher of the
   * actor's organization. `planAutoSchedule` uses them as soft constraints, weight 1 for everyone.
   */
  setTeacherPreferences(
    teacherId: Id,
    preferences: Omit<TeacherSchedulingPreferences, 'teacherId'>,
    actor?: ActorContext,
  ): Promise<TeacherSchedulingPreferences> {
    return this.settings.setTeacherPreferences(teacherId, preferences, actor);
  }

  /** A teacher's saved preferences, or null, with the same permission as `setTeacherPreferences`. */
  getTeacherPreferences(teacherId: Id, actor?: ActorContext): Promise<TeacherSchedulingPreferences | null> {
    return this.settings.getTeacherPreferences(teacherId, actor);
  }

  /**
   * Sets which courses a teacher is qualified for, replacing the earlier list. **Admins only**
   * (`scheduling.manageQualifications`): an instructor cannot qualify themselves. With enforcement
   * the teacher and every course must belong to the actor's organization. An empty list means
   * qualified for nothing (a teacher with no record at all is not restricted).
   */
  setTeacherQualification(teacherId: Id, qualifiedCourseIds: Id[], actor?: ActorContext): Promise<TeacherQualification> {
    return this.settings.setTeacherQualification(teacherId, qualifiedCourseIds, actor);
  }

  /** A teacher's qualification, or null: the instructor themselves, or an admin (`scheduling.manageSettings`). */
  getTeacherQualification(teacherId: Id, actor?: ActorContext): Promise<TeacherQualification | null> {
    return this.settings.getTeacherQualification(teacherId, actor);
  }
}
