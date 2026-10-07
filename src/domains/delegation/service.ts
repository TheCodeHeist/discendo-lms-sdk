import type { DelegationRepository } from '../../core/repositories.js';
import type { TaGrant } from '../../core/types.js';
import { authorize, activeSectionRole } from '../../core/permissions.js';
import type { ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { authorizeInSection } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import { ActionNotDelegableError, NotAnActiveTaError } from './types.js';

/** What the service needs: the authorization repositories plus a delegation repository. */
export type DelegationRepos = AuthorizationRepos & { delegations: DelegationRepository };

export interface DelegationServiceOptions {
  /**
   * Delegation only makes sense with permission checks, so a policy is required and EVERY
   * method needs an `{ actorId }`. A policy made by `createRolePolicy` says which actions are
   * delegable (`delegableActions`); with any other policy nothing is, unless you list them below.
   */
  policy: PermissionPolicy & { delegableActions?: readonly string[] };
  /** Overrides the actions the policy declares as delegable. */
  delegableActions?: readonly string[];
}

/**
 * Lets an instructor (or admin) hand some of their own permissions to a TA in one section, and
 * take them back. A grant belongs to the TA's enrollment, so it ends with it. A grant only has an
 * effect through a rule marked `delegable`; the checks here keep stored grants honest: only
 * delegable actions, only ones the grantor holds, only to an active TA of that section.
 */
export class DelegationService {
  private readonly delegable: ReadonlySet<string>;

  constructor(
    private readonly repos: DelegationRepos,
    private readonly options: DelegationServiceOptions,
  ) {
    this.delegable = new Set(options.delegableActions ?? options.policy.delegableActions ?? []);
  }

  /** Gives `taUserId` the right to do `action` in `sectionId`. Granting the same action twice returns the first grant. */
  async grant(sectionId: string, taUserId: string, action: string, actor?: ActorContext): Promise<TaGrant> {
    const auth = await authorizeInSection(this.options.policy, this.repos, 'delegation.grant', actor, { sectionId });
    if (!this.delegable.has(action)) throw new ActionNotDelegableError(action);
    // You can only hand over what you hold yourself in this section.
    await authorize(auth.policy, action, auth.ctx);

    const ta = await this.repos.enrollments.findByUserAndSection(taUserId, sectionId);
    if (!ta || activeSectionRole(ta) !== 'ta') throw new NotAnActiveTaError();

    const existing = (await this.repos.delegations.listActiveForEnrollment(ta.id)).find(
      (g) => this.counts(g, ta.id, sectionId) && g.action === action,
    );
    if (existing) return existing;

    return this.repos.delegations.create({
      enrollmentId: ta.id,
      sectionId,
      action,
      grantedBy: auth.ctx.actor.id,
      grantedAt: new Date(),
    });
  }

  /** Takes a grant back. Revoking an already revoked grant changes nothing. */
  async revoke(grantId: string, actor?: ActorContext): Promise<TaGrant> {
    // Only needed to find out which section this is about. An unknown grant has no section and
    // is refused exactly like a forbidden one.
    const grant = actor ? await this.repos.delegations.findById(grantId) : null;
    await authorizeInSection(this.options.policy, this.repos, 'delegation.revoke', actor, {
      sectionId: grant?.sectionId,
    });
    if (!grant) throw new Error('unreachable: authorization refuses a missing section');
    if (grant.revokedAt !== undefined) return grant;
    return this.repos.delegations.revoke(grantId, new Date());
  }

  /** The active grants of one TA in a section. A TA may see their own; instructors and admins anyone's. */
  async list(sectionId: string, taUserId: string, actor?: ActorContext): Promise<TaGrant[]> {
    await authorizeInSection(this.options.policy, this.repos, 'delegation.view', actor, {
      sectionId,
      ownerId: taUserId,
    });
    const ta = await this.repos.enrollments.findByUserAndSection(taUserId, sectionId);
    if (!ta || activeSectionRole(ta) !== 'ta') return [];
    return (await this.repos.delegations.listActiveForEnrollment(ta.id)).filter((g) => this.counts(g, ta.id, sectionId));
  }

  /** A grant only counts for this enrollment and section, and only while not revoked. */
  private counts(g: TaGrant, enrollmentId: string, sectionId: string): boolean {
    return g.enrollmentId === enrollmentId && g.sectionId === sectionId && g.revokedAt === undefined;
  }
}
