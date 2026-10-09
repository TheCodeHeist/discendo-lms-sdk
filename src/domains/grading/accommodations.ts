import type { EventBus } from '../../core/events.js';
import type { RepositoryContext } from '../../core/repositories.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError, activeSectionRole } from '../../core/permissions.js';
import { authorizeInSection } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import type { Excusal, TimeExtension } from './types.js';

export interface ListOptions {
  /** Include revoked records. Default false. */
  includeRevoked?: boolean;
}

export interface TimeExtensionRepository {
  create(extension: Omit<TimeExtension, 'id'>): Promise<TimeExtension>;
  /** The student's extension on this content that has not been revoked, or null. There should never be two. */
  findActive(userId: string, contentId: string): Promise<TimeExtension | null>;
  /** Set `revokedAt` and `revokedBy` and return the updated record. */
  revoke(id: string, at: Date, by: string): Promise<TimeExtension>;
  listForContent(contentId: string, options?: ListOptions): Promise<TimeExtension[]>;
  listForUser(userId: string, sectionId: string, options?: ListOptions): Promise<TimeExtension[]>;
}

export interface ExcusalRepository {
  create(excusal: Omit<Excusal, 'id'>): Promise<Excusal>;
  /** The student's excusal for this content that has not been revoked, or null. There should never be two. */
  findActive(userId: string, contentId: string): Promise<Excusal | null>;
  /** Set `revokedAt` and `revokedBy` and return the updated record. */
  revoke(id: string, at: Date, by: string): Promise<Excusal>;
  listForContent(contentId: string, options?: ListOptions): Promise<Excusal[]>;
  listForUser(userId: string, sectionId: string, options?: ListOptions): Promise<Excusal[]>;
}

/** What the service needs: the authorization repositories, the content nodes, and the two new repositories. */
export type AccommodationRepos = AuthorizationRepos &
  Pick<RepositoryContext, 'content'> & {
    extensions: TimeExtensionRepository;
    excusals: ExcusalRepository;
  };

export interface AccommodationServiceOptions {
  /** Required: every method needs an `{ actorId }`, because each record says who made it. */
  policy: PermissionPolicy;
}

/**
 * Per-student exceptions to the normal rules of a piece of work: **extensions** (extra time) and
 * **excusals** (left out of the final grade). Staff and delegated TAs grant and end them, each under
 * their own name; a student sees their own, and so does a guardian with the grades scope.
 *
 * Nothing is deleted: ending one sets `revokedAt`/`revokedBy`, and changing an extension keeps the old
 * one as history. The SDK stores no due dates, so an extension is only an amount of time: see
 * `effectiveDueAt` and `daysLate`, and the `extensions` option of `AssessmentService` for quizzes.
 */
export class AccommodationService {
  constructor(
    private readonly repos: AccommodationRepos,
    private readonly events: EventBus | undefined,
    private readonly options: AccommodationServiceOptions,
  ) {}

  /**
   * Gives the student `extraSeconds` more time on the content. Needs `grading.grantExtension` in the
   * content's section (admin, instructor, or a TA it was delegated to), and the student must be an
   * active student of that section. The permission is checked before anything else, so a stranger learns
   * nothing; unknown content is refused exactly like forbidden content. `extraSeconds` must be a finite
   * number above zero.
   *
   * Granting the same amount again changes nothing and emits nothing. A different amount replaces the
   * old extension, which stays as a revoked record. Emits `grading.extensionGranted`.
   */
  async grantExtension(
    contentId: string,
    userId: string,
    extraSeconds: number,
    actor?: ActorContext,
    options: { reason?: string } = {},
  ): Promise<TimeExtension> {
    const action: Action = 'grading.grantExtension';
    const { sectionId, actorId } = await this.authorizeStaff(action, actor, contentId);
    await this.requireActiveStudent(userId, sectionId, action);
    if (typeof extraSeconds !== 'number' || !Number.isFinite(extraSeconds) || extraSeconds <= 0) {
      throw new Error('extraSeconds must be a finite number above zero');
    }

    const repo = this.repos.extensions;
    const active = await repo.findActive(userId, contentId);
    if (active && active.extraSeconds === extraSeconds) return active;
    if (active) await repo.revoke(active.id, new Date(), actorId);

    const created = await repo.create({
      userId,
      contentId,
      sectionId,
      extraSeconds,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      grantedBy: actorId,
      grantedAt: new Date(),
    });
    void this.events?.emit({
      type: 'grading.extensionGranted',
      extensionId: created.id,
      userId,
      contentId,
      sectionId,
      extraSeconds,
      grantedBy: actorId,
      ...(active ? { replacedExtensionId: active.id } : {}),
    });
    return created;
  }

  /** Ends the student's extension on the content and returns it, or null if they had none. Needs `grading.grantExtension`. */
  async revokeExtension(contentId: string, userId: string, actor?: ActorContext): Promise<TimeExtension | null> {
    const { actorId } = await this.authorizeStaff('grading.grantExtension', actor, contentId);
    const active = await this.repos.extensions.findActive(userId, contentId);
    return active ? this.repos.extensions.revoke(active.id, new Date(), actorId) : null;
  }

  /**
   * The student's current extension on the content, or null. The student can read their own (and a
   * guardian with the `grades` scope their ward's); staff can read anyone's (`grading.view`).
   */
  async getExtension(contentId: string, userId: string, actor?: ActorContext): Promise<TimeExtension | null> {
    await this.authorizeView(actor, contentId, userId);
    return this.repos.extensions.findActive(userId, contentId);
  }

  /** Everyone's extensions on the content. Staff only (`grading.grantExtension`). */
  async listExtensions(contentId: string, actor?: ActorContext, options: ListOptions = {}): Promise<TimeExtension[]> {
    await this.authorizeStaff('grading.grantExtension', actor, contentId);
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
    const action: Action = 'grading.excuse';
    const { sectionId, actorId } = await this.authorizeStaff(action, actor, contentId);
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
      type: 'grading.excused',
      excusalId: created.id,
      userId,
      contentId,
      sectionId,
      excusedBy: actorId,
    });
    return created;
  }

  /** Ends the student's excusal and returns it, or null if they had none. The work counts again. Needs `grading.excuse`. */
  async unexcuse(contentId: string, userId: string, actor?: ActorContext): Promise<Excusal | null> {
    const { actorId } = await this.authorizeStaff('grading.excuse', actor, contentId);
    const active = await this.repos.excusals.findActive(userId, contentId);
    return active ? this.repos.excusals.revoke(active.id, new Date(), actorId) : null;
  }

  /** The student's current excusal for the content, or null. Readable like `getExtension`. */
  async getExcusal(contentId: string, userId: string, actor?: ActorContext): Promise<Excusal | null> {
    await this.authorizeView(actor, contentId, userId);
    return this.repos.excusals.findActive(userId, contentId);
  }

  /** Everyone's excusals for the content. Staff only (`grading.excuse`). */
  async listExcusals(contentId: string, actor?: ActorContext, options: ListOptions = {}): Promise<Excusal[]> {
    await this.authorizeStaff('grading.excuse', actor, contentId);
    return this.repos.excusals.listForContent(contentId, options);
  }

  /** The section comes from the content node, never from the caller; an unknown node is refused like a forbidden one. */
  private async authorizeStaff(
    action: Action,
    actor: ActorContext | undefined,
    contentId: string,
  ): Promise<{ sectionId: string; actorId: string }> {
    // Skipped without an actor, so the caller hears "actor required" before anything is looked up.
    const node = actor ? await this.repos.content.findById(contentId) : null;
    const auth = await authorizeInSection(this.options.policy, this.repos, action, actor, { sectionId: node?.sectionId });
    return { sectionId: node!.sectionId, actorId: auth.ctx.actor.id };
  }

  private async authorizeView(actor: ActorContext | undefined, contentId: string, userId: string): Promise<void> {
    const node = actor ? await this.repos.content.findById(contentId) : null;
    await authorizeInSection(this.options.policy, this.repos, 'grading.view', actor, {
      sectionId: node?.sectionId,
      ownerId: userId,
      afterCompletion: true, // a completed student keeps read-only access to their own records
    });
  }

  private async requireActiveStudent(userId: string, sectionId: string, action: Action): Promise<void> {
    const membership = await this.repos.enrollments.findByUserAndSection(userId, sectionId);
    if (activeSectionRole(membership) !== 'student') throw new PermissionDeniedError(action);
  }
}
