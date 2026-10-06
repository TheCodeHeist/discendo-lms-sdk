/**
 * Role-based permission checks, pluggable so a host can swap in richer
 * (attribute-based) rules without touching the SDK.
 *
 * The SDK does not authenticate anyone: the host decides who is calling and
 * tells a service with an `{ actorId }`. A service built with a policy then
 * requires that on every call (see `authorization.ts`), and a host can also call
 * `policy.can(...)` / `authorize(...)` itself at its own API boundary. This file
 * does no I/O; everything the policy needs is already in the context.
 *
 * Roles come from two places, and they mean different things:
 *  - `Enrollment.role` is a person's role INSIDE one section. Actions that
 *    target a section use this (via `ctx.section.role`).
 *  - `Identity.roles` is account-wide. Only `admin` is honoured for actions
 *    that target a section: a global "instructor" does not get to manage every
 *    section, only the ones they are actually enrolled in as an instructor.
 *    For actions with no section (`ctx.section` omitted) `Identity.roles` are
 *    used as they are.
 *
 * Deny by default: an unknown action, or a context that can't prove the
 * needed relationship, is refused.
 */
import type { Id, Identity, Role, Enrollment, GuardianScope } from './types.js';
import { sameOrg } from './tenancy.js';

/**
 * Who may perform an action. `roles` may always do it; `ownRoles` may do it
 * only to their own resource (`ctx.resourceOwnerId === ctx.actor.id`), e.g. a
 * student viewing their own grade but not a classmate's.
 */
export interface ActionRule {
  roles?: readonly Role[];
  ownRoles?: readonly Role[];
  /**
   * A guardian whose verified link to the resource's owner includes this scope
   * may do it (read-only actions only). Without it a rule never admits a guardian.
   */
  guardianScope?: GuardianScope;
  /**
   * An instructor or admin may hand this action to a teaching assistant, one
   * section at a time (see `TaGrant` and `DelegationService`). Without it a
   * grant for the action has no effect.
   */
  delegable?: boolean;
  /**
   * A student whose enrollment is `completed` keeps this action, read-only, in that section
   * (their own grades and the published content). Only for view actions, and only students:
   * a completed TA or instructor gets nothing. A guardian of such a student follows. It also
   * takes the service calling `authorizeInSection` with `afterCompletion: true`, so overriding
   * a rule without this flag revokes the access.
   */
  afterCompletion?: boolean;
}

/** Built-in defaults. Deliberately conservative; every one is overridable. */
export const DEFAULT_RULES = {
  // enrollment
  'enrollment.enroll': { roles: ['admin', 'instructor'], delegable: true },
  'enrollment.bulkEnroll': { roles: ['admin'] },
  'enrollment.drop': { roles: ['admin', 'instructor'], ownRoles: ['student'] },
  'enrollment.viewRoster': { roles: ['admin', 'instructor', 'ta'] },
  // Enrolling someone with a role ALSO requires the matching grantRole action,
  // so nobody can hand out a role beyond what they are allowed to grant.
  'enrollment.grantRole.admin': { roles: ['admin'] },
  'enrollment.grantRole.instructor': { roles: ['admin'] },
  'enrollment.grantRole.ta': { roles: ['admin', 'instructor'] },
  'enrollment.grantRole.student': { roles: ['admin', 'instructor'], delegable: true },
  // content
  'content.view': { roles: ['admin', 'instructor', 'ta', 'student'], afterCompletion: true },
  'content.manage': { roles: ['admin', 'instructor'], delegable: true },
  // assessment and grading
  'assessment.submit': { ownRoles: ['student'] },
  'assessment.startAttempt': { ownRoles: ['student'] },
  'assessment.viewAttempts': { roles: ['admin', 'instructor', 'ta'], ownRoles: ['student'] },
  // staff record work a student did offline (a "none" submission) so it can be graded
  'assessment.recordOffline': { roles: ['admin', 'instructor'], delegable: true },
  'grading.record': { roles: ['admin', 'instructor', 'ta'] },
  'grading.view': { roles: ['admin', 'instructor', 'ta'], ownRoles: ['student'], guardianScope: 'grades', afterCompletion: true },
  // communication
  // Announcements have two separate channels: one addressed to the students and one to the
  // guardians. Each has its own post and view action, so nobody gets one by holding the other.
  'communication.postAnnouncement': { roles: ['admin', 'instructor'], delegable: true },
  'communication.postGuardianAnnouncement': { roles: ['admin', 'instructor'] },
  'communication.viewAnnouncements': { roles: ['admin', 'instructor', 'ta', 'student'] },
  'communication.viewGuardianAnnouncements': { roles: ['admin', 'instructor', 'ta'], guardianScope: 'announcements' },
  'communication.participate': { roles: ['admin', 'instructor', 'ta', 'student'] },
  // Guardian links belong to a person, not to a section, so the first two are organization-wide.
  // Only admins create, change or revoke a link, and it is never delegable.
  'guardian.manageLinks': { roles: ['admin'] },
  'guardian.viewLinks': { roles: ['admin'], ownRoles: ['admin', 'instructor', 'ta', 'student'] },
  // who to notify for a guardian announcement: a section's instructors and admins
  'guardian.listRecipients': { roles: ['admin', 'instructor'] },
  // scheduling
  'scheduling.view': { roles: ['admin', 'instructor', 'ta', 'student'], guardianScope: 'schedule' },
  'scheduling.manage': { roles: ['admin'] },
  // An instructor cancels or moves their own class (an admin any), and a TA when delegated. Each
  // change tells admins who made it (see the events).
  'scheduling.manageOccurrence': { roles: ['admin', 'instructor'], delegable: true },
  'scheduling.recordAttendance': { roles: ['admin', 'instructor'], delegable: true },
  // An instructor's own availability and preferences (an admin anyone's); qualifications are the admin's alone.
  'scheduling.manageSettings': { roles: ['admin'], ownRoles: ['instructor'] },
  'scheduling.manageQualifications': { roles: ['admin'] },
  // delegation: instructors hand delegable actions to their TAs; a TA can see their own
  'delegation.grant': { roles: ['admin', 'instructor'] },
  'delegation.revoke': { roles: ['admin', 'instructor'] },
  'delegation.view': { roles: ['admin', 'instructor'], ownRoles: ['ta'] },
  // reporting and administration
  // Taking attendance is an instructor's job; a TA only when the instructor appoints one (delegation).
  'reporting.recordAttendance': { roles: ['admin', 'instructor'], delegable: true },
  'reporting.view': { roles: ['admin', 'instructor', 'ta'], ownRoles: ['student'], guardianScope: 'attendance' },
  'admin.viewAuditLog': { roles: ['admin'] },
} as const satisfies Record<string, ActionRule>;

export type BuiltInAction = keyof typeof DEFAULT_RULES;
/** A built-in action, or any string a host defines for its own features. */
export type Action = BuiltInAction | (string & {});

export interface PermissionContext {
  /** The person attempting the action. */
  actor: Identity;
  /**
   * Include when the action targets a section. `role` is the actor's role in
   * that section (see `activeSectionRole`); omit or leave undefined when they
   * are not enrolled. `delegated` are the grants an instructor gave this actor
   * as a TA in the section, ALREADY verified (see `authorizeInSection`); they
   * only count for a `ta` and only for actions whose rule is `delegable`.
   */
  section?: {
    role?: Role | undefined;
    delegated?: readonly Action[] | undefined;
    /**
     * The role of a COMPLETED enrollment in this section. Only filled in when the service asked
     * for it (`afterCompletion`), and only a completed `student` is ever honored, by a rule that
     * has `afterCompletion`. It is never a `role`: a completed enrollment still grants nothing else.
     */
    completedRole?: Role | undefined;
  };
  /**
   * Organization that owns the target, or `undefined` when the target belongs
   * to no organization. Always compared with the actor's organization, and
   * "no organization" only matches "no organization": an actor who belongs to
   * an organization cannot act on an un-owned resource, and vice versa. The
   * key is required so a caller can't forget it; an untyped caller that omits
   * it is treated as saying "no organization" and fails closed.
   */
  resourceOrgId: Id | undefined;
  /** Whose resource this is (e.g. the student a grade belongs to), for `ownRoles` rules. */
  resourceOwnerId?: Id | undefined;
  /**
   * A guardian link that has ALREADY been verified for this actor and this
   * resource (see `authorizeInSection`): the ward and what the link allows. The
   * policy still requires `wardId` to be the resource's owner, and never lets a
   * guardian act on their own resource this way.
   */
  guardian?: { wardId: Id; scopes: readonly GuardianScope[]; wardCompleted?: boolean | undefined } | undefined;
  // `wardCompleted` is true when the ward's enrollment is completed rather than active. It is
  // only ever set when the service asked for it (`afterCompletion`); a policy that looks at
  // `guardian` itself must treat it as read-only access to an action that is readable after completion.
}

/** May be async so a host's own policy can look things up (attribute-based rules). */
export interface PermissionPolicy {
  can(action: Action, ctx: PermissionContext): boolean | Promise<boolean>;
}

/**
 * Identifies who is making a service call. Services that are given a
 * `PermissionPolicy` require it on every call and load the actor from their
 * repository by id, so roles and organization are never taken from the caller.
 */
export interface ActorContext {
  actorId: Id;
}

export class PermissionDeniedError extends Error {
  constructor(readonly action: Action) {
    super(`Not permitted: ${action}`);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * A service has a permission policy but the call didn't say who is acting.
 * This is a bug in the calling code, not a refusal, so it is a different
 * error from PermissionDeniedError (think HTTP 500, not 403). The call is
 * never allowed through without an actor.
 */
export class ActorRequiredError extends Error {
  constructor(readonly action: Action) {
    super(`An actor is required for ${action} because a permission policy is configured`);
    this.name = 'ActorRequiredError';
  }
}

/**
 * Throws PermissionDeniedError unless the policy allows the action. Only an
 * exact `true` allows: a policy that returns anything else (a truthy string
 * from untyped code, `undefined` from a forgotten return) is a denial. If the
 * policy itself throws, that error propagates and the action does not happen.
 */
export async function authorize(
  policy: PermissionPolicy,
  action: Action,
  ctx: PermissionContext,
): Promise<void> {
  const allowed = await policy.can(action, ctx);
  if (allowed !== true) throw new PermissionDeniedError(action);
}

/**
 * The role an enrollment grants, or undefined. Only an `active` enrollment
 * counts: waitlisted, dropped and completed ones grant nothing.
 */
export function activeSectionRole(
  enrollment: Pick<Enrollment, 'role' | 'status'> | null | undefined,
): Role | undefined {
  return enrollment && enrollment.status === 'active' ? enrollment.role : undefined;
}

/**
 * The role of a `completed` enrollment, or undefined. Completion grants nothing by itself: only a
 * rule with `afterCompletion`, asked about by a service that opted in, honors a completed student.
 */
export function completedSectionRole(
  enrollment: Pick<Enrollment, 'role' | 'status'> | null | undefined,
): Role | undefined {
  return enrollment && enrollment.status === 'completed' ? enrollment.role : undefined;
}

/** The roles that count for this context (see the module note on the two role sources). */
export function effectiveRoles(ctx: PermissionContext): Role[] {
  if (!ctx.section) return [...ctx.actor.roles];
  const roles: Role[] = [];
  if (ctx.section.role !== undefined) roles.push(ctx.section.role);
  if (ctx.actor.roles.includes('admin') && !roles.includes('admin')) roles.push('admin');
  return roles;
}

export interface RolePolicyOptions {
  /**
   * Per-action rules that REPLACE the default for that action entirely (they
   * are not merged), and may add actions of your own. An empty rule `{}`
   * denies everyone.
   */
  overrides?: Readonly<Record<string, ActionRule>>;
}

/** The default policy: the rule table above, applied after a tenant check. */
export function createRolePolicy(options: RolePolicyOptions = {}): PermissionPolicy & {
  can(action: Action, ctx: PermissionContext): boolean;
  /** The actions whose rule is `delegable`, for `DelegationService`. */
  readonly delegableActions: readonly string[];
} {
  // A Map, so action names like "constructor" or "__proto__" can't hit prototype members.
  const rules = new Map<string, ActionRule>(Object.entries(DEFAULT_RULES));
  for (const [action, rule] of Object.entries(options.overrides ?? {})) rules.set(action, rule);

  const delegableActions = [...rules].filter(([, rule]) => rule.delegable === true).map(([action]) => action);

  return {
    delegableActions,
    can(action, ctx) {
      // Tenant first: not even an admin acts across organizations. "No org" only matches
      // "no org", in both directions, and the check is never skipped.
      if (!sameOrg(ctx.actor.orgId, ctx.resourceOrgId)) return false;

      const rule = rules.get(action);
      if (!rule) return false;

      const roles = effectiveRoles(ctx);
      // A completed student keeps the read-only actions that opt in (their own grades, published content).
      if (rule.afterCompletion === true && ctx.section?.completedRole === 'student' && !roles.includes('student')) {
        roles.push('student');
      }
      if (rule.roles?.some((r) => roles.includes(r))) return true;

      const isOwner = ctx.resourceOwnerId !== undefined && ctx.resourceOwnerId === ctx.actor.id;
      if (isOwner && (rule.ownRoles?.some((r) => roles.includes(r)) ?? false)) return true;

      if (
        rule.delegable === true &&
        ctx.section?.role === 'ta' &&
        ctx.section.delegated?.includes(action) === true
      ) {
        return true;
      }

      const g = ctx.guardian;
      return (
        rule.guardianScope !== undefined &&
        g !== undefined &&
        ctx.resourceOwnerId !== undefined &&
        g.wardId === ctx.resourceOwnerId &&
        g.wardId !== ctx.actor.id &&
        (g.wardCompleted !== true || rule.afterCompletion === true) &&
        g.scopes.includes(rule.guardianScope)
      );
    },
  };
}
