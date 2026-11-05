import type { Id } from '../../../core/types.js';
import type { ActorContext } from '../../../core/permissions.js';
import { InvalidSchedulingSettingsError } from '../types.js';
import type { AvailabilityRule, TeacherQualification, TeacherSchedulingPreferences } from '../types.js';
import type { SchedulingSettingsRepository } from '../repositories.js';
import type { SchedulingAccess } from './access.js';
import type { SchedulingDeps } from './context.js';
import { validateAvailability, validatePreferences } from './validation.js';

/** Availability, preferences and qualifications: the inputs the checks and the planner read. */
export class SchedulingSettings {
  constructor(
    private readonly deps: SchedulingDeps,
    private readonly access: SchedulingAccess,
  ) {}

  async setAvailability(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    rules: Array<Omit<AvailabilityRule, 'id' | 'resourceId' | 'resourceType'>>,
    actor?: ActorContext,
  ): Promise<AvailabilityRule[]> {
    await this.access.authorizeResourceSettings(resourceType, resourceId, actor);
    const clean = validateAvailability(rules);
    return this.store().replaceAvailability(resourceType, resourceId, clean);
  }

  async getAvailability(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    actor?: ActorContext,
  ): Promise<AvailabilityRule[]> {
    await this.access.authorizeResourceSettings(resourceType, resourceId, actor);
    return this.deps.scheduling.listAvailability(resourceType, resourceId);
  }

  async setTeacherPreferences(
    teacherId: Id,
    preferences: Omit<TeacherSchedulingPreferences, 'teacherId'>,
    actor?: ActorContext,
  ): Promise<TeacherSchedulingPreferences> {
    await this.access.authorizeTeacherSettings(teacherId, actor);
    const clean = validatePreferences(preferences);
    return this.store().saveTeacherPreferences({ teacherId, ...clean });
  }

  async getTeacherPreferences(teacherId: Id, actor?: ActorContext): Promise<TeacherSchedulingPreferences | null> {
    await this.access.authorizeTeacherSettings(teacherId, actor);
    return this.store().findTeacherPreferences(teacherId);
  }

  async setTeacherQualification(
    teacherId: Id,
    qualifiedCourseIds: Id[],
    actor?: ActorContext,
  ): Promise<TeacherQualification> {
    if (this.access.enforcement) {
      const auth = await this.access.authorizeOrg('scheduling.manageQualifications', actor);
      const orgId = auth.ctx.actor.orgId;
      await this.access.assertUserInOrg(teacherId, orgId);
      if (Array.isArray(qualifiedCourseIds)) {
        for (const courseId of qualifiedCourseIds) await this.access.assertCourseInOrg(courseId, orgId);
      }
    }
    if (!Array.isArray(qualifiedCourseIds) || qualifiedCourseIds.some((c) => typeof c !== 'string' || c === '')) {
      throw new InvalidSchedulingSettingsError('Qualified courses must be a list of course ids');
    }
    return this.store().saveTeacherQualification({ teacherId, qualifiedCourseIds: [...new Set(qualifiedCourseIds)] });
  }

  async getTeacherQualification(teacherId: Id, actor?: ActorContext): Promise<TeacherQualification | null> {
    await this.access.authorizeTeacherSettings(teacherId, actor);
    return this.deps.scheduling.findTeacherQualification(teacherId);
  }

  private store(): SchedulingSettingsRepository {
    const settings = this.deps.options.settings;
    if (!settings) {
      throw new Error('Managing scheduling settings needs a SchedulingSettingsRepository (options.settings)');
    }
    return settings;
  }
}
