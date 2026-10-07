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
  completedSectionRole,
  effectiveRoles,
  ActorRequiredError,
  PermissionDeniedError,
} from './permissions.js';

/** The repositories needed to work out who the actor is and what they are to a section. */
export type AuthorizationRepos = Pick<
  RepositoryContext,
  'users' | 'courses' | 'enrollments' | 'guardianLinks' | 'delegations'
>;

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
  target: {
    sectionId: string | undefined;
    ownerId?: string | undefined;
    /**
     * Set by a service for an action that is readable after a student completes the section
     * (see `ActionRule.afterCompletion`). Only then is a completed enrollment (the actor's, or
     * the ward's for a guardian) put in the context, and the rule still has to opt in. Leave it
     * out for everything else, so completion never reaches a policy that did not ask for it.
     */
    afterCompletion?: boolean | undefined;
  },
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
  const role = activeSectionRole(membership);
  const ctx: PermissionContext = {
    actor: user,
    section: {
      role,
      delegated: role === 'ta' && membership ? await verifiedGrants(repos, membership.id, target.sectionId) : undefined,
      completedRole: target.afterCompletion === true ? completedSectionRole(membership) : undefined,
    },
    resourceOrgId: course.orgId,
    resourceOwnerId: target.ownerId,
    guardian: await verifiedGuardianLink(repos, user.id, target.ownerId, target.sectionId, course.orgId, target.afterCompletion === true),
  };
  await authorize(policy, action, ctx);
  return { policy, ctx };
}

/**
 * Authorization for an action that belongs to no section (managing guardian links, say). The
 * actor is loaded from the repository, so roles and organization never come from the caller, and
 * the policy is asked in the actor's OWN organization with no section: only the account-wide
 * roles count (an `admin` of the organization), and a guardian link is never in play.
 *
 * The policy's tenant wall is therefore satisfied by construction, so **the caller must compare
 * every resource it then touches with the actor's organization** (`assertInActorOrg`), or an
 * admin of one organization could act on another's.
 */
export async function authorizeWithinOwnOrg(
  policy: PermissionPolicy,
  repos: Pick<AuthorizationRepos, 'users'>,
  action: Action,
  actor: ActorContext | undefined,
  target: { ownerId?: string | undefined } = {},
): Promise<Authorized> {
  if (!actor) throw new ActorRequiredError(action);
  const user = await repos.users.findById(actor.actorId);
  if (!user) throw new PermissionDeniedError(action);
  const ctx: PermissionContext = { actor: user, resourceOrgId: user.orgId, resourceOwnerId: target.ownerId };
  await authorize(policy, action, ctx);
  return { policy, ctx };
}

/**
 * Refuses (as a plain `PermissionDeniedError`, saying nothing about the other organization)
 * unless the resource belongs to the actor's organization. "No organization" matches only "no
 * organization", the same rule as everywhere else.
 */
export function assertInActorOrg(auth: Authorized, resourceOrgId: string | undefined, action: Action): void {
  if (!sameOrg(auth.ctx.actor.orgId, resourceOrgId)) throw new PermissionDeniedError(action);
}

/**
 * Whether the authorized actor is staff (admin, instructor or TA) for the section they were
 * authorized in. Used by the modules that keep unpublished material away from everyone else.
 */
export function isStaff(ctx: PermissionContext): boolean {
  return effectiveRoles(ctx).some((r) => r === 'admin' || r === 'instructor' || r === 'ta');
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
  afterCompletion: boolean,
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
  // A guardian's access follows the ward's own enrollment: only in a section where the ward is
  // currently an active student, or, for an action that is readable after completion, a student
  // who has completed it (flagged, so the policy can still refuse anything else).
  const wardEnrollment = await repos.enrollments.findByUserAndSection(ownerId, sectionId);
  if (activeSectionRole(wardEnrollment) === 'student') return { wardId: link.wardId, scopes: link.scopes };
  if (afterCompletion && completedSectionRole(wardEnrollment) === 'student') {
    return { wardId: link.wardId, scopes: link.scopes, wardCompleted: true };
  }
  return undefined;
}

/**
 * The actions delegated to this TA enrollment in this section, or undefined.
 * Looked up only for an active TA and only when the host configured a
 * delegation repository. Whatever the repository returns is re-checked (this
 * enrollment, this section, not revoked), so a wrong or stale grant can't count.
 */
async function verifiedGrants(
  repos: AuthorizationRepos,
  enrollmentId: string,
  sectionId: string,
): Promise<string[] | undefined> {
  if (!repos.delegations) return undefined;
  const grants = await repos.delegations.listActiveForEnrollment(enrollmentId);
  return grants
    .filter((g) => g.enrollmentId === enrollmentId && g.sectionId === sectionId && g.revokedAt === undefined)
    .map((g) => g.action);
}
