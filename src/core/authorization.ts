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
import {
  authorize,
  activeSectionRole,
  ActorRequiredError,
  PermissionDeniedError,
} from './permissions.js';

/** The repositories needed to work out who the actor is and what they are to a section. */
export type AuthorizationRepos = Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'>;

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
  };
  await authorize(policy, action, ctx);
  return { policy, ctx };
}
