import type { Id } from '../../../core/types.js';
import type { EventBus } from '../../../core/events.js';
import type { PermissionPolicy } from '../../../core/permissions.js';
import type { AuthorizationRepos } from '../../../core/authorization.js';
import type { SchedulingRepository, SchedulingSettingsRepository } from '../repositories.js';
import type { AttendanceRecorder } from '../attendance.js';
import type { ResourceConflict } from '../rules/conflict.js';

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

/** The resources one booking uses, as the check methods take them. */
export interface BookingResources {
  teacherIds: Id[];
  roomId?: Id;
  groupId: Id;
  startTime: string;
  endTime: string;
}

/** What every part of the scheduling service shares: its dependencies, as given to the constructor. */
export interface SchedulingDeps {
  scheduling: SchedulingRepository;
  attendanceRecorder: AttendanceRecorder | undefined;
  events: EventBus | undefined;
  options: SchedulingServiceOptions;
}
