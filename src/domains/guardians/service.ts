import type { RepositoryContext, GuardianLinkManagementRepository } from '../../core/repositories.js';
import type { GuardianLink, GuardianScope } from '../../core/types.js';
import type { ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { activeSectionRole } from '../../core/permissions.js';
import { authorizeInSection, authorizeWithinOwnOrg, assertInActorOrg } from '../../core/authorization.js';
import type { Authorized } from '../../core/authorization.js';
import { sameOrg } from '../../core/tenancy.js';
import {
  GuardianLinkExistsError,
  GuardianLinkNotFoundError,
  GuardianLinkTargetError,
  InvalidGuardianLinkError,
} from './types.js';
import type { GuardianRecipient } from './types.js';

export type GuardianServiceRepos = Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'> & {
  guardianLinks: GuardianLinkManagementRepository;
};

export interface GuardianServiceOptions {
  /** Every method enforces this policy and requires an `{ actorId }`. There is no unenforced mode. */
  policy: PermissionPolicy;
}

const SCOPES: readonly GuardianScope[] = ['grades', 'attendance', 'schedule', 'announcements'];

export class GuardianService {
  constructor(
    private readonly repos: GuardianServiceRepos,
    private readonly options: GuardianServiceOptions,
  ) {}

  /**
   * Links a guardian to a ward with the given scopes. Needs `guardian.manageLinks` (admins only,
   * never delegable). Both people must exist in the actor's organization (a missing person and a
   * person of another organization are refused with the same error), must differ, and the scopes
   * must be a non-empty list of known scopes (duplicates are dropped). The link's organization is
   * the ward's. At most one link can be active per guardian and ward: a second one is refused,
   * and `updateScopes` changes an existing one. A link belongs to the person, not to a section,
   * so the ward need not be enrolled anywhere.
   */
  async createLink(guardianId: string, wardId: string, scopes: GuardianScope[], actor?: ActorContext): Promise<GuardianLink> {
    const auth = await this.authorizeManage(actor);
    const cleaned = cleanScopes(scopes);
    if (guardianId === wardId) throw new InvalidGuardianLinkError('A person cannot be their own guardian');

    const [guardian, ward] = await Promise.all([this.repos.users.findById(guardianId), this.repos.users.findById(wardId)]);
    if (!guardian || !ward || !sameOrg(guardian.orgId, auth.ctx.actor.orgId) || !sameOrg(ward.orgId, auth.ctx.actor.orgId)) {
      throw new GuardianLinkTargetError();
    }

    const existing = await this.repos.guardianLinks.findActive(guardianId, wardId);
    // re-check what comes back: a repository that returns some other link must not block this one
    if (existing && existing.guardianId === guardianId && existing.wardId === wardId && existing.status === 'active') {
      throw new GuardianLinkExistsError(existing.id);
    }

    return this.repos.guardianLinks.create({
      guardianId,
      wardId,
      ...(ward.orgId !== undefined ? { orgId: ward.orgId } : {}),
      scopes: cleaned,
      status: 'active',
      createdAt: new Date(),
    });
  }

  /**
   * Replaces the scopes of an active link (admins only). A revoked link cannot be changed: create
   * a new one. A link of another organization is not found, exactly like one that does not exist.
   */
  async updateScopes(linkId: string, scopes: GuardianScope[], actor?: ActorContext): Promise<GuardianLink> {
    const auth = await this.authorizeManage(actor);
    const cleaned = cleanScopes(scopes);
    const link = await this.findLink(linkId, auth);
    if (link.status !== 'active') throw new InvalidGuardianLinkError('A revoked link cannot be changed');
    return this.repos.guardianLinks.update(linkId, { scopes: cleaned });
  }

  /**
   * Ends a link (admins only): the guardian loses access at once, and the record is kept with the
   * time it ended. Idempotent: revoking a revoked link changes nothing and returns it as it is.
   */
  async revokeLink(linkId: string, actor?: ActorContext): Promise<GuardianLink> {
    const auth = await this.authorizeManage(actor);
    const link = await this.findLink(linkId, auth);
    if (link.status === 'revoked') return link;
    return this.repos.guardianLinks.update(linkId, { status: 'revoked', revokedAt: new Date() });
  }

  /**
   * A guardian's active links, so they (or an admin) can see which wards there are. Needs
   * `guardian.viewLinks`: admins, or the guardian themselves for their own. Revoked links and
   * links of another organization are left out, and an unknown guardian, or one of another
   * organization, gives an empty list.
   */
  async listWards(guardianId: string, actor?: ActorContext): Promise<GuardianLink[]> {
    const auth = await authorizeWithinOwnOrg(this.options.policy, this.repos, 'guardian.viewLinks', actor, { ownerId: guardianId });
    const guardian = await this.repos.users.findById(guardianId);
    if (!guardian || !sameOrg(guardian.orgId, auth.ctx.actor.orgId)) return [];
    return (await this.repos.guardianLinks.listByGuardian(guardianId)).filter(
      (l) => l.guardianId === guardianId && l.status === 'active' && sameOrg(l.orgId, auth.ctx.actor.orgId),
    );
  }

  /**
   * Who to notify about a section's guardian announcement: one entry per guardian, with their wards
   * in the section, for guardians whose active link carries `scope`. Needs `guardian.listRecipients`
   * in the section (its instructors, or an admin). It applies the same rule as reading does: the
   * link must be active and in the course's organization, and the ward an **active student** of the
   * section, so nobody is notified who could not read the message. Dropped, waitlisted and
   * completed wards are left out. Costs one link lookup per student, in the section's order.
   */
  async guardiansOfSection(sectionId: string, scope: GuardianScope, actor?: ActorContext): Promise<GuardianRecipient[]> {
    const auth = await authorizeInSection(this.options.policy, this.repos, 'guardian.listRecipients', actor, { sectionId });
    if (!SCOPES.includes(scope)) throw new InvalidGuardianLinkError(`Unknown guardian scope: ${String(scope)}`);

    const byGuardian = new Map<string, string[]>();
    for (const enrollment of await this.repos.enrollments.listBySection(sectionId)) {
      if (activeSectionRole(enrollment) !== 'student') continue;
      for (const l of await this.repos.guardianLinks.listByWard(enrollment.userId)) {
        if (l.wardId !== enrollment.userId || l.status !== 'active' || !l.scopes.includes(scope)) continue;
        if (!sameOrg(l.orgId, auth.ctx.resourceOrgId)) continue;
        const wards = byGuardian.get(l.guardianId) ?? [];
        if (!wards.includes(enrollment.userId)) wards.push(enrollment.userId);
        byGuardian.set(l.guardianId, wards);
      }
    }
    return [...byGuardian].map(([guardianId, wardIds]) => ({ guardianId, wardIds }));
  }

  private authorizeManage(actor: ActorContext | undefined): Promise<Authorized> {
    return authorizeWithinOwnOrg(this.options.policy, this.repos, 'guardian.manageLinks', actor);
  }

  /** The link, or "not found" if it does not exist or belongs to another organization. */
  private async findLink(linkId: string, auth: Authorized): Promise<GuardianLink> {
    const link = await this.repos.guardianLinks.findById(linkId);
    if (!link || link.id !== linkId) throw new GuardianLinkNotFoundError();
    try {
      assertInActorOrg(auth, link.orgId, 'guardian.manageLinks');
    } catch {
      throw new GuardianLinkNotFoundError();
    }
    return link;
  }
}

/** A non-empty list of known scopes, without duplicates, in the order given. */
function cleanScopes(scopes: GuardianScope[]): GuardianScope[] {
  if (!Array.isArray(scopes) || scopes.length === 0) throw new InvalidGuardianLinkError('A link needs at least one scope');
  for (const s of scopes) {
    if (!SCOPES.includes(s)) throw new InvalidGuardianLinkError(`Unknown guardian scope: ${String(s)}`);
  }
  return [...new Set(scopes)];
}
