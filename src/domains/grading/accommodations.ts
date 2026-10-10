import type { EventBus } from "../../core/events.js";
import type {
  Action,
  ActorContext,
  PermissionPolicy,
} from "../../core/permissions.js";
import {
  ActorRequiredError,
  PermissionDeniedError,
  activeSectionRole,
} from "../../core/permissions.js";
import { authorizeInSection } from "../../core/authorization.js";
import type { AuthorizationRepos } from "../../core/authorization.js";
import type { RepositoryContext } from "../../core/repositories.js";
import type { Excusal, TimeExtension } from "./types.js";

export interface TimeExtensionRepository {
  create(e: Omit<TimeExtension, "id">): Promise<TimeExtension>;
  findById(id: string): Promise<TimeExtension | null>;
  findActive(userId: string, contentId: string): Promise<TimeExtension | null>;
  listForContent(
    contentId: string,
    options?: { includeRevoked?: boolean },
  ): Promise<TimeExtension[]>;
  revoke(id: string, at: Date, by: string): Promise<TimeExtension>;
}

export interface ExcusalRepository {
  create(e: Omit<Excusal, "id">): Promise<Excusal>;
  findById(id: string): Promise<Excusal | null>;
  findActive(userId: string, contentId: string): Promise<Excusal | null>;
  listForContent(
    contentId: string,
    options?: { includeRevoked?: boolean },
  ): Promise<Excusal[]>;
  listForUser(userId: string, sectionId: string): Promise<Excusal[]>;
  revoke(id: string, at: Date, by: string): Promise<Excusal>;
}

export type AccommodationRepos = AuthorizationRepos &
  Pick<RepositoryContext, "content"> & {
    extensions: TimeExtensionRepository;
    excusals: ExcusalRepository;
  };

export interface AccommodationServiceOptions {
  /** Every method enforces this policy and requires an `{ actorId }`. There is no unenforced mode. */
  policy: PermissionPolicy;
}

export interface ListOptions {
  includeRevoked?: boolean;
}

export class AccommodationService {
  constructor(
    private readonly repos: AccommodationRepos,
    private readonly events: EventBus | undefined,
    private readonly options: AccommodationServiceOptions,
  ) {}

  /**
   * Grants the student extra time on a piece of content: added to deadlines and quiz time limits.
   * Needs `grading.grantExtension` (admin + instructor, delegable). The target must be an active
   * student of the content's section; an unknown node is refused like a forbidden one. Idempotent
   * for the same amount: returns the active record and emits nothing. A different amount replaces
   * the active record, keeping it as history. Emits `grading.extensionGranted`.
   */
  async grantExtension(
    contentId: string,
    userId: string,
    extraSeconds: number,
    actor?: ActorContext,
    options: { reason?: string } = {},
  ): Promise<TimeExtension> {
    const action: Action = "grading.grantExtension";
    const { sectionId, actorId, orgId } = await this.authorizeStaff(
      action,
      actor,
      contentId,
    );
    await this.requireActiveStudent(userId, sectionId, action);
    if (!Number.isFinite(extraSeconds) || extraSeconds <= 0) {
      throw new Error(
        `extraSeconds must be a positive finite number, got ${extraSeconds}`,
      );
    }

    const active = await this.repos.extensions.findActive(userId, contentId);
    if (active && active.extraSeconds === extraSeconds) return active;

    const created = await this.repos.extensions.create({
      userId,
      contentId,
      sectionId,
      extraSeconds,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      grantedBy: actorId,
      grantedAt: new Date(),
    });
    if (active) {
      await this.repos.extensions.revoke(active.id, created.grantedAt, actorId);
    }

    void this.events?.emit({
      type: "grading.extensionGranted",
      extensionId: created.id,
      userId,
      contentId,
      sectionId,
      extraSeconds,
      grantedBy: actorId,
      ...(active ? { replacedExtensionId: active.id } : {}),
      ...(orgId !== undefined ? { orgId } : {}),
    });
    return created;
  }

  /** Ends the student's extension on the content and returns it, or null if they had none. Needs `grading.grantExtension`. */
  async revokeExtension(
    contentId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<TimeExtension | null> {
    const { actorId, orgId } = await this.authorizeStaff(
      "grading.grantExtension",
      actor,
      contentId,
    );
    const active = await this.repos.extensions.findActive(userId, contentId);
    if (!active) return null;
    const revoked = await this.repos.extensions.revoke(
      active.id,
      new Date(),
      actorId,
    );
    void this.events?.emit({
      type: "grading.extensionRevoked",
      extensionId: revoked.id,
      userId: revoked.userId,
      contentId: revoked.contentId,
      sectionId: revoked.sectionId,
      revokedBy: actorId,
      ...(orgId !== undefined ? { orgId } : {}),
    });
    return revoked;
  }

  /**
   * The student's current extension on the content, or null. The student can read their own (and a
   * guardian with the `grades` scope their ward's); staff can read anyone's (`grading.view`).
   */
  async getExtension(
    contentId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<TimeExtension | null> {
    await this.authorizeView(actor, contentId, userId);
    return this.repos.extensions.findActive(userId, contentId);
  }

  /** Everyone's extensions on the content. Staff only (`grading.grantExtension`). */
  async listExtensions(
    contentId: string,
    actor?: ActorContext,
    options: ListOptions = {},
  ): Promise<TimeExtension[]> {
    await this.authorizeStaff("grading.grantExtension", actor, contentId);
    return this.repos.extensions.listForContent(contentId, options);
  }

  /**
   * Excuses the student from the content: it is left out of their final grade (see
   * `GradingService`'s `excusals` option), not counted as zero. Needs `grading.excuse`, with the same
   * checks and refusals as `grantExtension`. Excusing someone who is already excused changes nothing and
   * emits nothing. Emits `grading.excused`.
   */
  async excuse(
    contentId: string,
    userId: string,
    actor?: ActorContext,
    options: { reason?: string } = {},
  ): Promise<Excusal> {
    const action: Action = "grading.excuse";
    const { sectionId, actorId, orgId } = await this.authorizeStaff(
      action,
      actor,
      contentId,
    );
    await this.requireActiveStudent(userId, sectionId, action);

    const active = await this.repos.excusals.findActive(userId, contentId);
    if (active) return active;
    const created = await this.repos.excusals.create({
      userId,
      contentId,
      sectionId,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      excusedBy: actorId,
      excusedAt: new Date(),
    });

    void this.events?.emit({
      type: "grading.excused",
      excusalId: created.id,
      userId,
      contentId,
      sectionId,
      excusedBy: actorId,
      ...(orgId !== undefined ? { orgId } : {}),
    });
    return created;
  }

  /** Ends the student's excusal and returns it, or null if they had none. The work counts again. Needs `grading.excuse`. */
  async unexcuse(
    contentId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<Excusal | null> {
    const { actorId, orgId } = await this.authorizeStaff(
      "grading.excuse",
      actor,
      contentId,
    );
    const active = await this.repos.excusals.findActive(userId, contentId);
    if (!active) return null;
    const revoked = await this.repos.excusals.revoke(
      active.id,
      new Date(),
      actorId,
    );
    void this.events?.emit({
      type: "grading.unexcused",
      excusalId: revoked.id,
      userId: revoked.userId,
      contentId: revoked.contentId,
      sectionId: revoked.sectionId,
      revokedBy: actorId,
      ...(orgId !== undefined ? { orgId } : {}),
    });
    return revoked;
  }

  /** The student's current excusal for the content, or null. Readable like `getExtension`. */
  async getExcusal(
    contentId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<Excusal | null> {
    await this.authorizeView(actor, contentId, userId);
    return this.repos.excusals.findActive(userId, contentId);
  }

  /** Everyone's excusals for the content. Staff only (`grading.excuse`). */
  async listExcusals(
    contentId: string,
    actor?: ActorContext,
    options: ListOptions = {},
  ): Promise<Excusal[]> {
    await this.authorizeStaff("grading.excuse", actor, contentId);
    return this.repos.excusals.listForContent(contentId, options);
  }

  /** The section comes from the content node, never from the caller; an unknown node is refused like a forbidden one. */
  private async authorizeStaff(
    action: Action,
    actor: ActorContext | undefined,
    contentId: string,
  ): Promise<{ sectionId: string; actorId: string; orgId?: string }> {
    // Skipped without an actor, so the caller hears "actor required" before anything is looked up.
    const node = actor ? await this.repos.content.findById(contentId) : null;
    const auth = await authorizeInSection(
      this.options.policy,
      this.repos,
      action,
      actor,
      { sectionId: node?.sectionId },
    );
    const orgId = auth.ctx.resourceOrgId ?? auth.ctx.actor.orgId;
    return {
      sectionId: node!.sectionId,
      actorId: auth.ctx.actor.id,
      ...(orgId !== undefined ? { orgId } : {}),
    };
  }

  private async authorizeView(
    actor: ActorContext | undefined,
    contentId: string,
    userId: string,
  ): Promise<void> {
    const node = actor ? await this.repos.content.findById(contentId) : null;
    await authorizeInSection(
      this.options.policy,
      this.repos,
      "grading.view",
      actor,
      {
        sectionId: node?.sectionId,
        ownerId: userId,
        afterCompletion: true, // a completed student keeps read-only access to their own records
      },
    );
  }

  private async requireActiveStudent(
    userId: string,
    sectionId: string,
    action: Action,
  ): Promise<void> {
    const membership = await this.repos.enrollments.findByUserAndSection(
      userId,
      sectionId,
    );
    if (activeSectionRole(membership) !== "student")
      throw new PermissionDeniedError(action);
  }
}
