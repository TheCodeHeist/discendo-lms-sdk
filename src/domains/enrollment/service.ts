import type { RepositoryContext } from '../../core/repositories.js';
import type { Enrollment, CourseSection, Role } from '../../core/types.js';
import type { EventBus } from '../../core/events.js';
import { assertSameOrg } from '../../core/tenancy.js';
import { authorize } from '../../core/permissions.js';
import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { authorizeInSection } from '../../core/authorization.js';
import type { Authorized } from '../../core/authorization.js';
import { EnrollmentNotDroppableError, SectionNotOpenError } from './types.js';
import type { EnrollOptions, BatchEnrollRow, BatchReport, BulkEnrollOptions, PromoteOptions } from './types.js';

export interface EnrollmentServiceOptions {
  /**
   * Turns on permission enforcement. Once set, EVERY public method requires
   * an `{ actorId }` argument and refuses to run without one. Leave it unset
   * and the service behaves as it always has: no actor, no permission checks.
   */
  policy?: PermissionPolicy;
  /**
   * Turns on automatic promotion: after an **active** enrollment is dropped, the longest-waiting
   * person on that section's waitlist takes the free seat. Off by default. It runs under the drop's
   * own authorization (nobody needs `enrollment.promoteWaitlist` for it), skips draft and archived
   * sections, and never fails the drop: if the promotion itself fails, the drop still succeeds and
   * `promoteFromWaitlist` can be called to catch up.
   */
  promoteOnDrop?: boolean;
}

export class EnrollmentService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly events?: EventBus,
    private readonly options: EnrollmentServiceOptions = {},
  ) {}

  /**
   * Enrolls `opts.userId`. With a policy this needs `enrollment.enroll` in the
   * section AND `enrollment.grantRole.<role>` for the role being granted.
   */
  async enroll(opts: EnrollOptions, actor?: ActorContext): Promise<Enrollment> {
    // Authorization comes first, even before the "already enrolled" shortcut,
    // so an unauthorized caller can't use it to learn who is in a section.
    const auth = await this.authorizeOn('enrollment.enroll', actor, {
      sectionId: opts.sectionId,
      ownerId: opts.userId,
    });
    if (auth) await authorize(auth.policy, grantAction(opts.role), auth.ctx);

    return this.enrollUnchecked(opts);
  }

  async drop(enrollmentId: string, actor?: ActorContext): Promise<Enrollment> {
    let existing: Enrollment | null;
    if (this.options.policy) {
      // Only needed to find out whose enrollment this is and which section it is in.
      existing = actor ? await this.repos.enrollments.findById(enrollmentId) : null;
      await this.authorizeOn('enrollment.drop', actor, {
        sectionId: existing?.sectionId,
        ownerId: existing?.userId,
      });
    } else {
      existing = await this.repos.enrollments.findById(enrollmentId);
    }
    // (With permissions on, an unknown enrollment was already refused above, like a forbidden one.)
    if (!existing) throw new Error(`Enrollment ${enrollmentId} not found`);
    // Dropping twice changes nothing: no new time, no second event.
    if (existing.status === 'dropped') return existing;
    // A completed enrollment is history, and dropping it would erase the completion.
    if (existing.status === 'completed') throw new EnrollmentNotDroppableError(enrollmentId, existing.status);

    // Never hard-delete — preserve history for audit/reporting.
    const dropped = await this.repos.enrollments.update(enrollmentId, {
      status: 'dropped',
      droppedAt: new Date(),
    });

    void this.events?.emit({
      type: 'enrollment.dropped',
      enrollmentId: dropped.id,
      userId: dropped.userId,
      sectionId: dropped.sectionId,
    });

    // Only an active enrollment held a seat. Dropping a waitlisted one frees nothing.
    if (this.options.promoteOnDrop && existing.status === 'active') {
      await this.promoteAfterDrop(dropped.sectionId);
    }

    return dropped;
  }

  /**
   * Gives free seats to the people waiting for them, longest-waiting first (`enrolledAt`, then
   * enrollment id). Returns the enrollments it promoted, in that order; nobody is promoted when
   * there is no free seat or nobody is waiting, so calling it again is harmless. A section with no
   * `capacity` has no seats to run out of, so its whole waitlist is promoted. Emits
   * `enrollment.promoted` for each person.
   *
   * With a policy this needs `enrollment.promoteWaitlist` in the section (admin, instructor; not
   * delegable). The section must be open: an archived one is refused, a draft one unless
   * `options.allowDraft`. Use it after raising a section's capacity, and as a catch-up for
   * `promoteOnDrop`.
   */
  async promoteFromWaitlist(
    sectionId: string,
    actor?: ActorContext,
    options: PromoteOptions = {},
  ): Promise<Enrollment[]> {
    // Permission first, so a stranger cannot tell a missing section from a closed one.
    const auth = await this.authorizeOn('enrollment.promoteWaitlist', actor, { sectionId });

    const section = await this.repos.courses.findSection(sectionId);
    if (!section) throw new Error(`Section ${sectionId} not found`);
    if (section.status === 'archived') throw new SectionNotOpenError(section.id, 'archived');
    if (section.status === 'draft' && !options.allowDraft) throw new SectionNotOpenError(section.id, 'draft');

    return this.promoteUnchecked(section, 'manual', auth?.ctx.actor.id);
  }

  async listRoster(
    sectionId: string,
    status?: Enrollment['status'],
    actor?: ActorContext,
  ): Promise<Enrollment[]> {
    await this.authorizeOn('enrollment.viewRoster', actor, { sectionId });
    return this.repos.enrollments.listBySection(sectionId, status);
  }

  /**
   * Bulk enroll from a roster feed. Resolves each row's externalRef to a user
   * via the UserRepository, so the host app's own user IDs never need to
   * leak into this call.
   *
   * With a policy this needs `enrollment.bulkEnroll` for the section, and
   * each row's role is checked against `enrollment.grantRole.<role>`; a row
   * whose role the actor may not grant is reported as failed ("not permitted")
   * and the rest of the batch continues.
   */
  async bulkEnroll(
    sectionId: string,
    rows: BatchEnrollRow[],
    actor?: ActorContext,
    options: BulkEnrollOptions = {},
  ): Promise<BatchReport> {
    const auth = await this.authorizeOn('enrollment.bulkEnroll', actor, { sectionId });
    const report: BatchReport = { succeeded: 0, failed: [] };

    // Resolve the section's organization once for the whole batch so each
    // external reference is looked up inside the right tenant. A missing
    // section is left for enrollUnchecked() to report per row, as before.
    const section = await this.repos.courses.findSection(sectionId);
    const orgId = section ? await this.orgIdOfSection(section) : undefined;

    for (const row of rows) {
      if (auth && !(await this.mayGrant(auth, row.role))) {
        report.failed.push({ row, reason: 'not permitted' });
        continue;
      }

      const user = await this.repos.users.findByExternalRef(row.userExternalRef, orgId);
      if (!user) {
        report.failed.push({ row, reason: 'user not found' });
        continue;
      }
      try {
        await this.enrollUnchecked({
          userId: user.id,
          sectionId,
          role: row.role,
          waitlistIfFull: true,
          ...(options.allowDraft ? { allowDraft: true } : {}),
        });
        report.succeeded++;
      } catch (err) {
        report.failed.push({ row, reason: (err as Error).message });
      }
    }

    return report;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** The enrollment logic itself. Callers are responsible for authorization. */
  private async enrollUnchecked(opts: EnrollOptions): Promise<Enrollment> {
    const existing = await this.repos.enrollments.findByUserAndSection(
      opts.userId,
      opts.sectionId,
    );
    if (existing && existing.status !== 'dropped') {
      return existing; // idempotent — calling twice shouldn't duplicate
    }

    const section = await this.repos.courses.findSection(opts.sectionId);
    if (!section) throw new Error(`Section ${opts.sectionId} not found`);

    await this.assertSameTenant(opts.userId, section);

    // Checked after the organization, so a person of another organization hears "wrong organization".
    if (section.status === 'archived') throw new SectionNotOpenError(section.id, 'archived');
    if (section.status === 'draft' && !opts.allowDraft) throw new SectionNotOpenError(section.id, 'draft');

    let status: Enrollment['status'] = 'active';
    let seated: Enrollment | undefined;
    if (section.capacity !== undefined) {
      // People already waiting were here first. Even with a seat free, a newcomer joins the back of
      // the line instead of taking it (the waitlist is cleared by promoteFromWaitlist).
      const queued = (await this.repos.enrollments.listBySection(opts.sectionId, 'waitlisted')).length > 0;
      if (queued) {
        if (!opts.waitlistIfFull) {
          throw new Error(`Section ${opts.sectionId} is at capacity or has a waitlist (pass waitlistIfFull to join it)`);
        }
        status = 'waitlisted';
      } else if (this.repos.enrollments.createIfSeatFree) {
        // The repository checks the seat and takes it in one atomic step, so two people cannot both
        // get the last one.
        const taken = await this.repos.enrollments.createIfSeatFree(
          { userId: opts.userId, sectionId: opts.sectionId, role: opts.role, status: 'active', enrolledAt: new Date() },
          section.capacity,
        );
        if (taken) {
          seated = taken;
        } else {
          if (!opts.waitlistIfFull) throw new Error(`Section ${opts.sectionId} is at capacity`);
          status = 'waitlisted';
        }
      } else {
        // Check, then write: not atomic, so the last seat can be taken twice (see the docs).
        const activeCount = await this.repos.enrollments.countActive(opts.sectionId);
        if (activeCount >= section.capacity) {
          if (!opts.waitlistIfFull) {
            throw new Error(`Section ${opts.sectionId} is at capacity`);
          }
          status = 'waitlisted';
        }
      }
    }

    const enrollment =
      seated ??
      (await this.repos.enrollments.create({
        userId: opts.userId,
        sectionId: opts.sectionId,
        role: opts.role,
        status,
        enrolledAt: new Date(),
      }));

    // Fire-and-forget — a slow or failing listener should never delay or
    // break the enrollment itself (see EventBus's failure-isolation note).
    void this.events?.emit({
      type: 'enrollment.enrolled',
      enrollmentId: enrollment.id,
      userId: enrollment.userId,
      sectionId: enrollment.sectionId,
      status: status as 'active' | 'waitlisted',
    });

    return enrollment;
  }

  /** The promotion itself. Callers have authorized and checked the section is open. */
  private async promoteUnchecked(
    section: CourseSection,
    trigger: 'manual' | 'auto',
    actorId?: string,
  ): Promise<Enrollment[]> {
    const capacity = section.capacity;
    let free = Number.POSITIVE_INFINITY;
    if (capacity !== undefined) {
      free = capacity - (await this.repos.enrollments.countActive(section.id));
      if (free <= 0) return [];
    }

    const waiting = (await this.repos.enrollments.listBySection(section.id, 'waitlisted')).sort(byQueuePosition);
    const promoted: Enrollment[] = [];
    for (const candidate of waiting) {
      if (promoted.length >= free) break;
      // With the atomic method the repository refuses when the seat is gone or the person has been
      // promoted meanwhile (null), and we move on to the next in line.
      const result =
        capacity !== undefined && this.repos.enrollments.promoteIfSeatFree
          ? await this.repos.enrollments.promoteIfSeatFree(candidate.id, capacity)
          : await this.repos.enrollments.update(candidate.id, { status: 'active' });
      if (!result) continue;
      promoted.push(result);

      void this.events?.emit({
        type: 'enrollment.promoted',
        enrollmentId: result.id,
        userId: result.userId,
        sectionId: result.sectionId,
        previousStatus: 'waitlisted',
        trigger,
        ...(actorId !== undefined ? { actorId } : {}),
      });
    }
    return promoted;
  }

  /** `promoteOnDrop`: a best-effort catch-up that can never fail or undo the drop that led to it. */
  private async promoteAfterDrop(sectionId: string): Promise<void> {
    try {
      const section = await this.repos.courses.findSection(sectionId);
      if (!section || section.status !== 'published') return;
      await this.promoteUnchecked(section, 'auto');
    } catch {
      // The drop already happened. promoteFromWaitlist() picks up whatever was missed.
    }
  }

  /**
   * Permission check for an action inside a section. Returns undefined when no
   * policy is configured (enforcement off). All the fail-closed rules live in
   * `authorizeInSection` (core/authorization.ts), shared with other modules.
   */
  private async authorizeOn(
    action: Action,
    actor: ActorContext | undefined,
    target: { sectionId: string | undefined; ownerId?: string | undefined },
  ): Promise<Authorized | undefined> {
    const policy = this.options.policy;
    if (!policy) return undefined;
    return authorizeInSection(policy, this.repos, action, actor, target);
  }

  /** Non-throwing grantRole check for batch rows; a policy that throws counts as "no". */
  private async mayGrant(auth: Authorized, role: Role): Promise<boolean> {
    try {
      return (await auth.policy.can(grantAction(role), auth.ctx)) === true;
    } catch {
      return false;
    }
  }

  /**
   * A section belongs to the organization of its course, and only a member of that same
   * organization may join it. This is strict in both directions: "no organization" matches
   * only "no organization", so a person who has an organization cannot join a course that
   * has none, and vice versa. The user is therefore always loaded. A section whose course
   * the repository cannot find is a data problem, reported as `Course <id> not found` before
   * the person is loaded.
   */
  private async assertSameTenant(userId: string, section: CourseSection): Promise<void> {
    const course = await this.repos.courses.findCourse(section.courseId);
    if (!course) throw new Error(`Course ${section.courseId} not found`);
    const user = await this.repos.users.findById(userId);
    if (!user) throw new Error(`User ${userId} not found`);
    assertSameOrg(course.orgId, user.orgId, 'User does not belong to this course\'s organization');
  }

  /**
   * Used only to give a bulk import's reference lookups an organization hint. A missing
   * course yields no hint; each row then fails with `Course <id> not found` from the check above.
   */
  private async orgIdOfSection(section: CourseSection): Promise<string | undefined> {
    const course = await this.repos.courses.findCourse(section.courseId);
    return course?.orgId;
  }
}

function grantAction(role: Role): Action {
  return `enrollment.grantRole.${role}`;
}

/** Waitlist order: the one who has waited longest first; the enrollment id settles ties. */
function byQueuePosition(a: Enrollment, b: Enrollment): number {
  const byTime = a.enrolledAt.getTime() - b.enrolledAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
