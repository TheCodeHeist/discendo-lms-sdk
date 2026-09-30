import type { RepositoryContext } from '../../core/repositories.js';
import type { Enrollment } from '../../core/types.js';
import type { EventBus } from '../../core/events.js';
import type { EnrollOptions, BatchEnrollRow, BatchReport } from './types.js';

export class EnrollmentService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly events?: EventBus,
  ) {}

  async enroll(opts: EnrollOptions): Promise<Enrollment> {
    const existing = await this.repos.enrollments.findByUserAndSection(
      opts.userId,
      opts.sectionId,
    );
    if (existing && existing.status !== 'dropped') {
      return existing; // idempotent — calling twice shouldn't duplicate
    }

    const section = await this.repos.courses.findSection(opts.sectionId);
    if (!section) throw new Error(`Section ${opts.sectionId} not found`);

    let status: Enrollment['status'] = 'active';
    if (section.capacity !== undefined) {
      const activeCount = await this.repos.enrollments.countActive(opts.sectionId);
      if (activeCount >= section.capacity) {
        if (!opts.waitlistIfFull) {
          throw new Error(`Section ${opts.sectionId} is at capacity`);
        }
        status = 'waitlisted';
      }
    }

    const enrollment = await this.repos.enrollments.create({
      userId: opts.userId,
      sectionId: opts.sectionId,
      role: opts.role,
      status,
      enrolledAt: new Date(),
    });

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

  async drop(enrollmentId: string): Promise<Enrollment> {
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

    return dropped;
  }

  async listRoster(
    sectionId: string,
    status?: Enrollment['status'],
  ): Promise<Enrollment[]> {
    return this.repos.enrollments.listBySection(sectionId, status);
  }

  /**
   * Bulk enroll from a roster feed. Resolves each row's externalRef to a user
   * via the UserRepository, so the host app's own user IDs never need to
   * leak into this call.
   */
  async bulkEnroll(sectionId: string, rows: BatchEnrollRow[]): Promise<BatchReport> {
    const report: BatchReport = { succeeded: 0, failed: [] };

    for (const row of rows) {
      const user = await this.repos.users.findByExternalRef(row.userExternalRef);
      if (!user) {
        report.failed.push({ row, reason: 'user not found' });
        continue;
      }
      try {
        await this.enroll({
          userId: user.id,
          sectionId,
          role: row.role,
          waitlistIfFull: true,
        });
        report.succeeded++;
      } catch (err) {
        report.failed.push({ row, reason: (err as Error).message });
      }
    }

    return report;
  }
}
