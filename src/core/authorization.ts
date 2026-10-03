/**
 * The one place that turns "actor X wants to do Y in section Z" into a policy
 * decision, shared by every service that enforces permissions so the rules
 * below can't drift apart between modules.
 *
 * Everything fails closed:
 *  - no actor on the call                 -> ActorRequiredError
 *  - unknown actor                        -> PermissionDeniedError
 *  - missing target (no section, or a section whose course can't be found, so
 *    its organization is unknown)         -> PermissionDeniedError
 *  - the policy says no, or throws        -> the action doesn't happen
 *
 * A missing target is a denial, not "not found", for EVERY actor, so this
 * can't be used to probe which sections or enrollments exist. The actor is
 * loaded from the repository by id; roles and organization are never taken
 * from the caller.
 */
import type { RepositoryContext } from './repositories.js';
import type { Action, ActorContext, PermissionContext, PermissionPolicy } from './permissions.js';
import { sameOrg } from './tenancy.js';
import {
  authorize,
  activeSectionRole,
  ActorRequiredError,
  PermissionDeniedError,
} from './permissions.js';

/** The repositories needed to work out who the actor is and what they are to a section. */
export type AuthorizationRepos = Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'guardianLinks'>;

/** A successful authorization, kept so later checks in the same call can reuse it. */
export interface Authorized {
  policy: PermissionPolicy;
  ctx: PermissionContext;
}

export async function authorizeInSection(
  policy: PermissionPolicy,
  repos: AuthorizationRepos,
  action: Action,
  actor: ActorContext | undefined,
  target: { sectionId: string | undefined; ownerId?: string | undefined },
): Promise<Authorized> {
  if (!actor) throw new ActorRequiredError(action);
  if (target.sectionId === undefined) throw new PermissionDeniedError(action);

  const user = await repos.users.findById(actor.actorId);
  if (!user) throw new PermissionDeniedError(action);

  const section = await repos.courses.findSection(target.sectionId);
  if (!section) throw new PermissionDeniedError(action);
  const course = await repos.courses.findCourse(section.courseId);
  if (!course) throw new PermissionDeniedError(action);

  const membership = await repos.enrollments.findByUserAndSection(user.id, target.sectionId);
  const ctx: PermissionContext = {
    actor: user,
    section: { role: activeSectionRole(membership) },
    resourceOrgId: course.orgId,
    resourceOwnerId: target.ownerId,
    guardian: await verifiedGuardianLink(repos, user.id, target.ownerId, target.sectionId, course.orgId),
  };
  await authorize(policy, action, ctx);
  return { policy, ctx };
}

/**
 * The guardian relationship between the actor and the owner of the resource, or
 * undefined. Looked up only when someone is asking about another person's
 * resource and the host configured a link repository. Whatever the repository
 * returns is re-checked here (right guardian, right ward, still active, same
 * organization as the course), so a wrong or stale link can't grant anything.
 * The ward must also be an active student in this section.
 */
async function verifiedGuardianLink(
  repos: AuthorizationRepos,
  actorId: string,
  ownerId: string | undefined,
  sectionId: string,
  courseOrgId: string | undefined,
): Promise<PermissionContext['guardian']> {
  if (!repos.guardianLinks || ownerId === undefined || ownerId === actorId) return undefined;
  const link = await repos.guardianLinks.findActive(actorId, ownerId);
  if (
    !link ||
    link.status !== 'active' ||
    link.guardianId !== actorId ||
    link.wardId !== ownerId ||
    !sameOrg(link.orgId, courseOrgId)
  ) {
    return undefined;
  }
  // A guardian's access follows the ward's own enrollment: only in a section where the
  // ward is currently an active student.
  const wardEnrollment = await repos.enrollments.findByUserAndSection(ownerId, sectionId);
  if (activeSectionRole(wardEnrollment) !== 'student') return undefined;
  return { wardId: link.wardId, scopes: link.scopes };
}
