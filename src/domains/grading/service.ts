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
  /**
   * OPTIONAL, and strongly recommended: mark entry `id` as superseded by `byId` **only if it is
   * still current** (its `supersededBy` is unset), as ONE atomic compare-and-set (a conditional
   * update), and return whether it did. Without it the service checks that the previous entry is
   * current and then writes, so two simultaneous regrades of one entry can both pass the check and
   * leave two current entries. With it, the loser gets a `GradeConflictError` and its own entry is
   * kept, marked as superseded by the winner, so exactly one entry stays current.
   */
  supersedeIfCurrent?(id: string, byId: string): Promise<boolean>;
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

/** A grade that cannot be recorded: the numbers are not a valid score out of a valid maximum. */
export class InvalidGradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGradeError';
  }
}

export interface GradingServiceOptions {
  /**
   * Allow a score above the maximum (extra credit), which then counts as the percentage it is
   * (120 out of 100 is 120%), so a final grade can exceed 100. Off by default, so a typo such as
   * 850 for 85 is refused instead of silently inflating a grade. Negative and non-finite numbers,
   * and a maximum of zero or less, are refused either way.
   */
  allowExtraCredit?: boolean;
  /**
   * The system grader names (each starting with `system:`, such as `'system:quiz'`) that may post
   * grades through `recordSystemGrade`, which needs no actor. Empty by default: nothing can.
   */
  systemGraders?: string[];
}

/** `recordSystemGrade` was called with a grader name the host has not allowed (or one that is not a `system:` name). */
export class SystemGraderNotAllowedError extends Error {
  constructor(readonly source: string) {
    super(`'${source}' is not an allowed system grader`);
    this.name = 'SystemGraderNotAllowedError';
  }
}

/**
 * A regrade lost a race: another regrade of the same entry was recorded first. The loser's entry is
 * kept as history, superseded by the winner's, so exactly one entry is current. Nothing was
 * announced for the loser; ask again with `winnerId` as the `previousEntryId` if the grade should
 * still change.
 */
export class GradeConflictError extends Error {
  constructor(
    /** The entry this call created and then marked as superseded. */
    readonly entryId: string,
    /** The entry both regrades were replacing. */
    readonly previousEntryId: string,
    /** The entry that won (absent if the repository could not say). */
    readonly winnerId?: string,
  ) {
    super(`Grade entry ${previousEntryId} was superseded by another regrade first`);
    this.name = 'GradeConflictError';
  }
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
    private readonly options: GradingServiceOptions = {},
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
   *
   * The numbers must make a grade, checked after the permission check:
   * `maxScore` finite and above zero, `score` finite and not negative, and
   * `score` not above `maxScore` unless the service was built with
   * `allowExtraCredit`. Otherwise it throws `InvalidGradeError` and stores,
   * supersedes and announces nothing.
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

    this.validateNumbers(score, maxScore);

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
      if (this.grades.supersedeIfCurrent) {
        // An atomic compare-and-set: only one regrade of an entry can win.
        if (!(await this.grades.supersedeIfCurrent(previousEntryId, entry.id))) {
          const winnerId = (await this.grades.findById(previousEntryId))?.supersededBy;
          // Keep the loser's entry as history, behind the winner, so exactly one stays current.
          if (winnerId !== undefined) await this.grades.markSuperseded(entry.id, winnerId);
          throw new GradeConflictError(entry.id, previousEntryId, winnerId);
        }
      } else {
        await this.grades.markSuperseded(previousEntryId, entry.id);
      }
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

  /**
   * Records a grade made by the system rather than a person, such as a quiz's automatic score. It
   * takes no actor and checks no permission, so it is for SDK code and your own server code only;
   * never expose it to a client. To keep that safe, the grader name `source` must start with
   * `system:` and be listed in the service's `systemGraders` option, or it throws
   * `SystemGraderNotAllowedError` and stores nothing. With enforcement on, the submission must exist and
   * belong to `userId`. The score is checked like any grade. It is always a new entry (there is no
   * regrade here) and `grading.gradePosted` is emitted with the source as `graderId`.
   */
  async recordSystemGrade(
    submissionId: string,
    userId: string,
    score: number,
    maxScore: number,
    source: string,
  ): Promise<GradeEntry> {
    if (!source.startsWith('system:') || !(this.options.systemGraders ?? []).includes(source)) {
      throw new SystemGraderNotAllowedError(source);
    }
    if (this.enforcement) {
      const located = await this.enforcement.submissions.locate(submissionId);
      if (!located) throw new Error(`Submission ${submissionId} not found`);
      if (located.userId !== userId) throw new Error('The submission does not belong to that user');
    }
    this.validateNumbers(score, maxScore);

    const entry = await this.grades.create({
      submissionId,
      userId,
      score,
      maxScore,
      graderId: source,
      gradedAt: new Date(),
    });
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
  private validateNumbers(score: number, maxScore: number): void {
    if (typeof maxScore !== 'number' || !Number.isFinite(maxScore) || maxScore <= 0) {
      throw new InvalidGradeError('maxScore must be a finite number above zero');
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
      throw new InvalidGradeError('score must be a finite number that is not negative');
    }
    if (score > maxScore && !this.options.allowExtraCredit) {
      throw new InvalidGradeError(
        'score is above maxScore; build the service with allowExtraCredit to allow extra credit',
      );
    }
  }

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
      afterCompletion: true, // a completed student keeps read-only access to their own grades
    });
  }
}
