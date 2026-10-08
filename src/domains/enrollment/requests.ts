import type { EnrollmentRequestRepository } from '../../core/repositories.js';
import type { CourseSection, EnrollmentRequest, EnrollmentRequestStatus, Identity } from '../../core/types.js';
import type { EventBus } from '../../core/events.js';
import { sameOrg } from '../../core/tenancy.js';
import { ActorRequiredError, PermissionDeniedError } from '../../core/permissions.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { authorizeInSection } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import type { EnrollmentService } from './service.js';
import {
  AlreadyEnrolledError,
  InvalidRequestModificationError,
  RequestNotPendingError,
  SectionNotOpenError,
} from './types.js';
import type { RejectOptions, RequestOptions, ReviewOptions } from './types.js';

/** What the service needs: the authorization repositories plus the request repository. */
export type EnrollmentRequestRepos = AuthorizationRepos & { enrollmentRequests: EnrollmentRequestRepository };

export interface EnrollmentRequestServiceOptions {
  /**
   * Required. Requests are about who is asking and who is deciding, so EVERY method needs an
   * `{ actorId }`. The student's methods need no rule (see `request`); the reviewer's methods
   * are the `enrollment.reviewRequest` action.
   */
  policy: PermissionPolicy;
}

/**
 * Lets a student ask for a seat and an administrator decide. Asking is always for yourself and
 * always as a `student`; deciding is `accept` (enroll them), `modify` (enroll them in another
 * section of the same course) or `reject`. Accepting goes through `EnrollmentService.enroll`, so
 * capacity, the waitlist queue, tenancy and the section's status apply exactly as for any enrollment.
 */
export class EnrollmentRequestService {
  constructor(
    private readonly repos: EnrollmentRequestRepos,
    private readonly enrollment: Pick<EnrollmentService, 'enroll'>,
    private readonly events: EventBus | undefined,
    private readonly options: EnrollmentRequestServiceOptions,
  ) {}

  /**
   * The actor asks for a seat in `sectionId`, for themself. This is not a permission action: a
   * student has no role in a section they are not in yet, so the rule is about identity instead.
   * The actor must be a known user with the `student` role, in the same organization as the
   * section's course, and the section must be open to them. A missing section, another
   * organization's section and a draft are all refused with the same `PermissionDeniedError`, so
   * none can be probed; an archived one throws `SectionNotOpenError`. Someone who already holds a
   * place (active, waitlisted or completed) gets `AlreadyEnrolledError`. Asking again while a request
   * is pending returns that request, unchanged and without a second event.
   */
  async request(sectionId: string, actor?: ActorContext, opts: RequestOptions = {}): Promise<EnrollmentRequest> {
    const action: Action = 'enrollment.request';
    const user = await this.loadActor(actor, action);
    if (!user.roles.includes('student')) throw new PermissionDeniedError(action);

    const section = await this.visibleSection(user, sectionId, action);
    if (section.status === 'archived') throw new SectionNotOpenError(section.id, 'archived');

    const existing = await this.repos.enrollments.findByUserAndSection(user.id, sectionId);
    if (existing && existing.status !== 'dropped') throw new AlreadyEnrolledError(sectionId);

    const pending = await this.repos.enrollmentRequests.findPending(user.id, sectionId);
    if (pending) return pending;

    const created = await this.repos.enrollmentRequests.create({
      userId: user.id,
      sectionId,
      status: 'pending',
      requestedAt: new Date(),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    });
    void this.events?.emit({
      type: 'enrollment.requested',
      requestId: created.id,
      userId: created.userId,
      sectionId: created.sectionId,
    });
    return created;
  }

  /** The student takes back their own pending request. Withdrawing twice changes nothing. */
  async withdraw(requestId: string, actor?: ActorContext): Promise<EnrollmentRequest> {
    const action: Action = 'enrollment.withdrawRequest';
    if (!actor) throw new ActorRequiredError(action);
    const request = await this.repos.enrollmentRequests.findById(requestId);
    // Someone else's request and a request that does not exist are the same refusal.
    if (!request || request.userId !== actor.actorId) throw new PermissionDeniedError(action);
    if (request.status === 'withdrawn') return request;
    if (request.status !== 'pending') throw new RequestNotPendingError(request.id, request.status);

    const { request: done, won } = await this.decide(request, { status: 'withdrawn' });
    if (won) {
      void this.events?.emit({
        type: 'enrollment.requestDecided',
        requestId: done.id,
        userId: done.userId,
        sectionId: done.sectionId,
        decision: 'withdrawn',
      });
    }
    return done;
  }

  /** The actor's own requests, in every status. */
  async listMine(actor?: ActorContext): Promise<EnrollmentRequest[]> {
    const user = await this.loadActor(actor, 'enrollment.request');
    return this.repos.enrollmentRequests.listByUser(user.id);
  }

  /** A section's requests, optionally only those in `status`. Needs `enrollment.reviewRequest` in the section. */
  async listRequests(
    sectionId: string,
    status?: EnrollmentRequestStatus,
    actor?: ActorContext,
  ): Promise<EnrollmentRequest[]> {
    await authorizeInSection(this.options.policy, this.repos, 'enrollment.reviewRequest', actor, { sectionId });
    return this.repos.enrollmentRequests.listBySection(sectionId, status);
  }

  /**
   * Enrolls the student in the section they asked for, as a `student`, and records the decision.
   * By default a full section (or one with people waiting) waitlists them; pass
   * `waitlistIfFull: false` to fail instead. If enrolling fails (section closed, capacity, tenant)
   * the request stays pending, so the reviewer can reject it or try again; trying again is safe.
   * Accepting an already accepted request returns it as it is.
   */
  async accept(requestId: string, actor?: ActorContext, opts: ReviewOptions = {}): Promise<EnrollmentRequest> {
    return this.review(requestId, undefined, actor, opts);
  }

  /**
   * Like `accept`, but places the student in `sectionId`, which must be a different section of the
   * same course (the one asked for may be full, or clash). The reviewer needs
   * `enrollment.reviewRequest` in BOTH sections. The request keeps the section that was asked for
   * in `sectionId` and records the one granted in `grantedSectionId`.
   */
  async modify(
    requestId: string,
    sectionId: string,
    actor?: ActorContext,
    opts: ReviewOptions = {},
  ): Promise<EnrollmentRequest> {
    return this.review(requestId, sectionId, actor, opts);
  }

  /** Refuses the request. Nobody is enrolled. Rejecting twice changes nothing. */
  async reject(requestId: string, actor?: ActorContext, opts: RejectOptions = {}): Promise<EnrollmentRequest> {
    const { request, reviewerId } = await this.loadForReview(requestId, actor);
    if (request.status === 'rejected') return request;
    if (request.status !== 'pending') throw new RequestNotPendingError(request.id, request.status);

    const { request: done, won } = await this.decide(request, {
      status: 'rejected',
      reviewedAt: new Date(),
      reviewerId,
      ...(opts.note !== undefined ? { reviewNote: opts.note } : {}),
    });
    if (won) {
      void this.events?.emit({
        type: 'enrollment.requestDecided',
        requestId: done.id,
        userId: done.userId,
        sectionId: done.sectionId,
        decision: 'rejected',
        reviewerId,
      });
    }
    return done;
  }

  private async review(
    requestId: string,
    modifiedSectionId: string | undefined,
    actor: ActorContext | undefined,
    opts: ReviewOptions,
  ): Promise<EnrollmentRequest> {
    const { request, reviewerId } = await this.loadForReview(requestId, actor);
    if (request.status === 'accepted') return request;
    if (request.status !== 'pending') throw new RequestNotPendingError(request.id, request.status);

    const targetId = modifiedSectionId ?? request.sectionId;
    if (modifiedSectionId !== undefined) {
      // The reviewer must be allowed to review in the target section as well, before anything about it is revealed.
      await authorizeInSection(this.options.policy, this.repos, 'enrollment.reviewRequest', actor, {
        sectionId: modifiedSectionId,
      });
      if (modifiedSectionId === request.sectionId) throw new InvalidRequestModificationError('same-section');
      const [asked, granted] = await Promise.all([
        this.repos.courses.findSection(request.sectionId),
        this.repos.courses.findSection(modifiedSectionId),
      ]);
      if (!asked || !granted || asked.courseId !== granted.courseId) {
        throw new InvalidRequestModificationError('different-course');
      }
    }

    // Enroll first, record second: if recording fails the request stays pending and a retry finds the
    // enrollment already there. EnrollmentService does the capacity, queue, tenant and status checks.
    const enrolled = await this.enrollment.enroll(
      {
        userId: request.userId,
        sectionId: targetId,
        role: 'student',
        waitlistIfFull: opts.waitlistIfFull ?? true,
        ...(opts.allowDraft ? { allowDraft: true } : {}),
      },
      actor,
    );

    const { request: done, won } = await this.decide(request, {
      status: 'accepted',
      reviewedAt: new Date(),
      reviewerId,
      enrollmentId: enrolled.id,
      grantedSectionId: targetId,
      ...(opts.note !== undefined ? { reviewNote: opts.note } : {}),
    });
    if (won) {
      void this.events?.emit({
        type: 'enrollment.requestDecided',
        requestId: done.id,
        userId: done.userId,
        sectionId: done.sectionId,
        decision: 'accepted',
        reviewerId,
        enrollmentId: enrolled.id,
        enrollmentStatus: enrolled.status,
        grantedSectionId: targetId,
      });
    }
    return done;
  }

  /**
   * Finds the request and checks the reviewer may review in its section. An unknown request has no
   * section and is refused exactly like a forbidden one.
   */
  private async loadForReview(
    requestId: string,
    actor: ActorContext | undefined,
  ): Promise<{ request: EnrollmentRequest; reviewerId: string }> {
    const found = actor ? await this.repos.enrollmentRequests.findById(requestId) : null;
    const auth = await authorizeInSection(this.options.policy, this.repos, 'enrollment.reviewRequest', actor, {
      sectionId: found?.sectionId,
    });
    if (!found) throw new PermissionDeniedError('enrollment.reviewRequest');
    return { request: found, reviewerId: auth.ctx.actor.id };
  }

  /**
   * Records a decision on a pending request. With `decideIfPending` it is one atomic step: if
   * someone else decided first, an identical decision is returned as it is (`won: false`, so no second
   * event) and a different one throws `RequestNotPendingError`. Without it, this is a plain update.
   */
  private async decide(
    request: EnrollmentRequest,
    patch: Partial<Omit<EnrollmentRequest, 'id'>>,
  ): Promise<{ request: EnrollmentRequest; won: boolean }> {
    const repo = this.repos.enrollmentRequests;
    if (!repo.decideIfPending) return { request: await repo.update(request.id, patch), won: true };

    const decided = await repo.decideIfPending(request.id, patch);
    if (decided) return { request: decided, won: true };
    const now = await repo.findById(request.id);
    if (now && now.status === patch.status) return { request: now, won: false };
    throw new RequestNotPendingError(request.id, now?.status ?? 'unknown');
  }

  private async loadActor(actor: ActorContext | undefined, action: Action): Promise<Identity> {
    if (!actor) throw new ActorRequiredError(action);
    const user = await this.repos.users.findById(actor.actorId);
    if (!user) throw new PermissionDeniedError(action);
    return user;
  }

  /** The section, if this user may see it as a student; otherwise the one refusal. */
  private async visibleSection(user: Identity, sectionId: string, action: Action): Promise<CourseSection> {
    const section = await this.repos.courses.findSection(sectionId);
    const course = section ? await this.repos.courses.findCourse(section.courseId) : null;
    if (!section || !course || !sameOrg(course.orgId, user.orgId) || section.status === 'draft') {
      throw new PermissionDeniedError(action);
    }
    return section;
  }
}
