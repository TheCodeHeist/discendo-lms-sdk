import type { Id } from '../../../core/types.js';
import type { Action, ActorContext } from '../../../core/permissions.js';
import { authorizeInSection, authorizeWithinOwnOrg } from '../../../core/authorization.js';
import type { Authorized } from '../../../core/authorization.js';
import { sameOrg } from '../../../core/tenancy.js';
import { SchedulingTargetNotFoundError } from '../types.js';
import type { ClassOccurrence, ClassSessionTemplate } from '../types.js';
import type { SchedulingDeps, SchedulingEnforcement } from './context.js';

/** What `authorizeOccurrence` found, so the caller can act on it and report who did. */
export interface OccurrenceGuard {
  auth: Authorized;
  occurrence: ClassOccurrence;
  template: ClassSessionTemplate;
  oversight: { sectionId: string; actorId: string; actorRole?: 'admin' | 'instructor' | 'ta'; orgId?: string };
}

/**
 * Every permission and organization check the scheduling service makes, in one place. The methods
 * that assume enforcement is on (`authorizeTemplate`, `authorizeOrg`, the `assert*` ones) are only
 * called by code that has checked `enforcement` first.
 */
export class SchedulingAccess {
  constructor(private readonly deps: SchedulingDeps) {}

  get enforcement(): SchedulingEnforcement | undefined {
    return this.deps.options.enforcement;
  }

  /** Authorizes in a template's section, looking the template up only once there is an actor. */
  async authorizeTemplate(
    action: Action,
    actor: ActorContext | undefined,
    templateId: Id,
  ): Promise<{ auth: Authorized; template: ClassSessionTemplate }> {
    const e = this.enforcement!;
    const template = actor ? await this.deps.scheduling.findTemplate(templateId) : null;
    const auth = await authorizeInSection(e.policy, e.repos, action, actor, { sectionId: template?.sectionId });
    // authorizeInSection has already refused a missing template, so there is one here.
    return { auth, template: template! };
  }

  /**
   * Authorizes in the section of an occurrence's STORED template and returns what the caller needs
   * to report who did it. Undefined without enforcement. An unknown occurrence, or one whose
   * template is gone, is refused like a forbidden one.
   */
  async authorizeOccurrence(
    action: Action,
    actor: ActorContext | undefined,
    occurrenceId: Id,
  ): Promise<OccurrenceGuard | undefined> {
    const e = this.enforcement;
    if (!e) return undefined;
    const occurrence = actor ? await this.deps.scheduling.findOccurrence(occurrenceId) : null;
    const template = occurrence ? await this.deps.scheduling.findTemplate(occurrence.templateId) : null;
    const auth = await authorizeInSection(e.policy, e.repos, action, actor, { sectionId: template?.sectionId });
    const actorRole = actorRoleOf(auth);
    const orgId = auth.ctx.resourceOrgId ?? auth.ctx.actor.orgId;
    return {
      auth,
      occurrence: occurrence!,
      template: template!,
      oversight: {
        sectionId: template!.sectionId,
        actorId: actor!.actorId,
        ...(actorRole ? { actorRole } : {}),
        ...(orgId !== undefined ? { orgId } : {}),
      },
    };
  }

  /** For actions that belong to no section: the actor's own organization, account-wide roles only. */
  authorizeOrg(action: Action, actor: ActorContext | undefined, ownerId?: Id): Promise<Authorized> {
    const e = this.enforcement!;
    return authorizeWithinOwnOrg(e.policy, e.repos, action, actor, { ownerId });
  }

  async authorizeTeacherSettings(teacherId: Id, actor: ActorContext | undefined): Promise<void> {
    if (!this.enforcement) return;
    const auth = await this.authorizeOrg('scheduling.manageSettings', actor, teacherId);
    await this.assertUserInOrg(teacherId, auth.ctx.actor.orgId);
  }

  async authorizeResourceSettings(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    actor: ActorContext | undefined,
  ): Promise<void> {
    const e = this.enforcement;
    if (!e) return;
    if (resourceType === 'teacher') return this.authorizeTeacherSettings(resourceId, actor);
    if (resourceType === 'room') {
      const auth = await this.authorizeOrg('scheduling.manage', actor);
      await this.assertRoomInOrg(resourceId, auth.ctx.actor.orgId);
      return;
    }
    // a group belongs to a section, so the admin must hold scheduling.manage in THAT section
    const group = actor ? await this.deps.scheduling.findGroup(resourceId) : null;
    await authorizeInSection(e.policy, e.repos, 'scheduling.manage', actor, { sectionId: group?.sectionId });
  }

  async assertUserInOrg(userId: Id, orgId: string | undefined): Promise<void> {
    const user = await this.enforcement!.repos.users.findById(userId);
    if (!user || !sameOrg(user.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  async assertRoomInOrg(roomId: Id, orgId: string | undefined): Promise<void> {
    const room = await this.deps.scheduling.findRoom(roomId);
    if (!room || !sameOrg(room.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  async assertCourseInOrg(courseId: Id, orgId: string | undefined): Promise<void> {
    const course = await this.enforcement!.repos.courses.findCourse(courseId);
    if (!course || !sameOrg(course.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  async assertGroupInOrg(groupId: Id, orgId: string | undefined): Promise<void> {
    const repos = this.enforcement!.repos;
    const group = await this.deps.scheduling.findGroup(groupId);
    const section = group ? await repos.courses.findSection(group.sectionId) : null;
    const course = section ? await repos.courses.findCourse(section.courseId) : null;
    if (!course || !sameOrg(course.orgId, orgId)) throw new SchedulingTargetNotFoundError();
  }

  async assertResourcesInOrg(
    orgId: string | undefined,
    resources: { teacherIds: Id[]; roomId?: Id; groupId: Id },
  ): Promise<void> {
    for (const teacherId of resources.teacherIds) await this.assertUserInOrg(teacherId, orgId);
    if (resources.roomId !== undefined) await this.assertRoomInOrg(resources.roomId, orgId);
    await this.assertGroupInOrg(resources.groupId, orgId);
  }

  async assertTemplateResourcesInOrg(template: ClassSessionTemplate, orgId: string | undefined): Promise<void> {
    await this.assertResourcesInOrg(orgId, {
      teacherIds: template.teacherIds,
      groupId: template.groupId,
      ...(template.roomId !== undefined ? { roomId: template.roomId } : {}),
    });
  }
}

/** 'admin' if the actor is one, else the role they acted as in the section, if it is staff. */
function actorRoleOf(auth: Authorized): 'admin' | 'instructor' | 'ta' | undefined {
  if (auth.ctx.actor.roles.includes('admin')) return 'admin';
  const role = auth.ctx.section?.role;
  return role === 'instructor' || role === 'ta' ? role : undefined;
}
