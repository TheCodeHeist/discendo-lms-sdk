/**
 * Role-based permission checks, pluggable so a host can swap in richer
 * (attribute-based) rules without touching the SDK.
 *
 * The SDK does not authenticate anyone and its services don't yet take an
 * "acting user"; a host calls `policy.can(...)` / `authorize(...)` at its own
 * API boundary before calling a service. Nothing here does any I/O.
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
}

/** Built-in defaults. Deliberately conservative; every one is overridable. */
export const DEFAULT_RULES = {
  // enrollment
  'enrollment.enroll': { roles: ['admin', 'instructor'] },
  'enrollment.bulkEnroll': { roles: ['admin'] },
  'enrollment.drop': { roles: ['admin', 'instructor'], ownRoles: ['student'] },
  'enrollment.viewRoster': { roles: ['admin', 'instructor', 'ta'] },
  // Enrolling someone with a role ALSO requires the matching grantRole action,
  // so nobody can hand out a role beyond what they are allowed to grant.
  'enrollment.grantRole.admin': { roles: ['admin'] },
  'enrollment.grantRole.instructor': { roles: ['admin'] },
  'enrollment.grantRole.ta': { roles: ['admin', 'instructor'] },
  'enrollment.grantRole.student': { roles: ['admin', 'instructor'] },
  // content
  'content.view': { roles: ['admin', 'instructor', 'ta', 'student'] },
  'content.manage': { roles: ['admin', 'instructor'] },
  // assessment and grading
  'assessment.submit': { ownRoles: ['student'] },
  'grading.record': { roles: ['admin', 'instructor', 'ta'] },
  'grading.view': { roles: ['admin', 'instructor', 'ta'], ownRoles: ['student'], guardianScope: 'grades' },
  // communication
  'communication.postAnnouncement': { roles: ['admin', 'instructor'] },
  'communication.participate': { roles: ['admin', 'instructor', 'ta', 'student'] },
  // scheduling
  'scheduling.view': { roles: ['admin', 'instructor', 'ta', 'student'], guardianScope: 'schedule' },
  'scheduling.manage': { roles: ['admin'] },
  // reporting and administration
  'reporting.recordAttendance': { roles: ['admin', 'instructor', 'ta'] },
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
   * are not enrolled.
   */
  section?: { role?: Role | undefined };
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
  guardian?: { wardId: Id; scopes: readonly GuardianScope[] } | undefined;
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
} {
  // A Map, so action names like "constructor" or "__proto__" can't hit prototype members.
  const rules = new Map<string, ActionRule>(Object.entries(DEFAULT_RULES));
  for (const [action, rule] of Object.entries(options.overrides ?? {})) rules.set(action, rule);

  return {
    can(action, ctx) {
      // Tenant first: not even an admin acts across organizations. "No org" only matches
      // "no org", in both directions, and the check is never skipped.
      if (!sameOrg(ctx.actor.orgId, ctx.resourceOrgId)) return false;

      const rule = rules.get(action);
      if (!rule) return false;

      const roles = effectiveRoles(ctx);
      if (rule.roles?.some((r) => roles.includes(r))) return true;

      const isOwner = ctx.resourceOwnerId !== undefined && ctx.resourceOwnerId === ctx.actor.id;
      if (isOwner && (rule.ownRoles?.some((r) => roles.includes(r)) ?? false)) return true;

      const g = ctx.guardian;
      return (
        rule.guardianScope !== undefined &&
        g !== undefined &&
        ctx.resourceOwnerId !== undefined &&
        g.wardId === ctx.resourceOwnerId &&
        g.wardId !== ctx.actor.id &&
        g.scopes.includes(rule.guardianScope)
      );
    },
  };
}
