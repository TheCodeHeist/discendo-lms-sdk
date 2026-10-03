import type { GradeEntry, GradingScheme, GradeScale } from './types.js';
import type { EventBus } from '../../core/events.js';
import type { ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError, ActorRequiredError } from '../../core/permissions.js';
import { authorizeInSection } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import { computeFinalGrade, toLetterGrade } from './calculations.js';

export interface GradeRepository {
  create(entry: Omit<GradeEntry, 'id'>): Promise<GradeEntry>;
  findById(id: string): Promise<GradeEntry | null>;
  markSuperseded(id: string, byId: string): Promise<void>;
  listForUserInSection(
    userId: string,
    sectionId: string,
  ): Promise<Array<GradeEntry & { category: string }>>;
}

/** Where a submission lives and who made it. */
export interface SubmissionLocation {
  sectionId: string;
  userId: string;
}

/**
 * Grading doesn't know about submissions or content (modules may only depend
 * on `core`), so when permissions are enforced the host supplies this lookup:
 * typically submission -> content node -> section. Return null if unknown.
 *
 * The section MUST come from here, never from the caller of `recordGrade`,
 * or a grader could claim a section they're allowed in while grading another.
 */
export interface SubmissionLocator {
  locate(submissionId: string): Promise<SubmissionLocation | null>;
}

/** Everything needed to turn permission enforcement on, bundled so none of it can be forgotten. */
export interface GradingEnforcement {
  policy: PermissionPolicy;
  repos: AuthorizationRepos;
  submissions: SubmissionLocator;
}

export class GradingService {
  constructor(
    private readonly grades: GradeRepository,
    private readonly events?: EventBus,
    /**
     * Turns on permission enforcement. Once set, every public method requires
     * an `{ actorId }` argument and refuses to run without one. Leave it unset
     * and the service behaves as it always has: no actor, no permission checks
     * (the integrity checks on `previousEntryId` apply either way).
     */
    private readonly enforcement?: GradingEnforcement,
  ) {}

  /**
   * Records a grade. Never overwrites — if the submission was already
   * graded, the old entry is marked superseded and a fresh one is created.
   * This gives you a full audit trail for free.
   *
   * `previousEntryId`, if given, must be the current entry for THIS
   * submission; superseding anything else would silently erase another
   * grade from the gradebook.
   *
   * With enforcement on (`actor` required), the actor needs `grading.record`
   * in the submission's section, `graderId` must be the actor (nobody records
   * a grade under someone else's name), `userId` must be whoever submitted the
   * work, and nobody may grade their own submission.
   */
  async recordGrade(
    submissionId: string,
    userId: string,
    score: number,
    maxScore: number,
    graderId: string,
    previousEntryId?: string,
    actor?: ActorContext,
  ): Promise<GradeEntry> {
    if (this.enforcement) {
      await this.authorizeRecord(this.enforcement, submissionId, userId, graderId, actor);
    }

    if (previousEntryId !== undefined) {
      const previous = await this.grades.findById(previousEntryId);
      if (!previous) throw new Error(`Previous grade entry ${previousEntryId} not found`);
      if (previous.submissionId !== submissionId) {
        throw new Error('Previous grade entry belongs to a different submission');
      }
      if (previous.supersededBy !== undefined) {
        throw new Error('Previous grade entry has already been superseded');
      }
    }

    const entry = await this.grades.create({
      submissionId,
      userId,
      score,
      maxScore,
      graderId,
      gradedAt: new Date(),
    });
    if (previousEntryId) {
      await this.grades.markSuperseded(previousEntryId, entry.id);
    }

    void this.events?.emit({
      type: 'grading.gradePosted',
      gradeEntryId: entry.id,
      submissionId: entry.submissionId,
      userId: entry.userId,
      score: entry.score,
      maxScore: entry.maxScore,
      graderId: entry.graderId,
    });

    return entry;
  }

  /** With enforcement on, needs `grading.view` (students: their own grades only). */
  async computeFinalGradeForUser(
    userId: string,
    sectionId: string,
    scheme: GradingScheme,
    actor?: ActorContext,
  ): Promise<number> {
    await this.authorizeView(userId, sectionId, actor);
    return this.computeFinalUnchecked(userId, sectionId, scheme);
  }

  /** With enforcement on, needs `grading.view` (students: their own grades only). */
  async computeLetterGradeForUser(
    userId: string,
    sectionId: string,
    scheme: GradingScheme,
    scale: GradeScale,
    actor?: ActorContext,
  ): Promise<string> {
    await this.authorizeView(userId, sectionId, actor);
    const percent = await this.computeFinalUnchecked(userId, sectionId, scheme);
    return toLetterGrade(percent, scale);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private async computeFinalUnchecked(
    userId: string,
    sectionId: string,
    scheme: GradingScheme,
  ): Promise<number> {
    const entries = await this.grades.listForUserInSection(userId, sectionId);
    const byCategory = new Map<string, GradeEntry[]>();
    for (const e of entries) {
      if (e.supersededBy) continue; // only count current entries
      const bucket = byCategory.get(e.category) ?? [];
      bucket.push(e);
      byCategory.set(e.category, bucket);
    }
    return computeFinalGrade(byCategory, scheme);
  }

  /**
   * Order matters: the actor is required and authorized BEFORE the submission
   * is compared against the caller's arguments, so an unauthorized caller
   * learns nothing (not even who submitted what) from a mismatch.
   */
  private async authorizeRecord(
    enforcement: GradingEnforcement,
    submissionId: string,
    userId: string,
    graderId: string,
    actor: ActorContext | undefined,
  ): Promise<void> {
    const action = 'grading.record';
    if (!actor) throw new ActorRequiredError(action);

    const located = await enforcement.submissions.locate(submissionId);
    if (!located) throw new PermissionDeniedError(action); // unknown submission: same answer as forbidden

    await authorizeInSection(enforcement.policy, enforcement.repos, action, actor, {
      sectionId: located.sectionId,
      ownerId: located.userId,
    });

    // Authorized from here on.
    if (actor.actorId === located.userId) throw new PermissionDeniedError(action); // no grading your own work
    if (graderId !== actor.actorId) throw new PermissionDeniedError(action); // no forging who graded
    if (userId !== located.userId) {
      throw new Error(`Submission ${submissionId} was not submitted by user ${userId}`);
    }
  }

  private async authorizeView(
    userId: string,
    sectionId: string,
    actor: ActorContext | undefined,
  ): Promise<void> {
    const enforcement = this.enforcement;
    if (!enforcement) return;
    await authorizeInSection(enforcement.policy, enforcement.repos, 'grading.view', actor, {
      sectionId,
      ownerId: userId,
    });
  }
}
