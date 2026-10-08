import type { Role } from '../../core/types.js';

export interface EnrollOptions {
  userId: string;
  sectionId: string;
  role: Role;
  /** If the section is at capacity, waitlist instead of throwing. */
  waitlistIfFull?: boolean;
  /**
   * Let this enrollment go into a section that is still a `draft`, so staff can load a roster
   * before the section opens. Archived sections never take new enrollments, with or without this.
   */
  allowDraft?: boolean;
}

/** What `bulkEnroll` applies to every row. */
export interface BulkEnrollOptions {
  /** As `EnrollOptions.allowDraft`. */
  allowDraft?: boolean;
}

/** What `promoteFromWaitlist` accepts. */
export interface PromoteOptions {
  /** Promote in a section that is still a `draft`, as `EnrollOptions.allowDraft`. Archived sections never promote. */
  allowDraft?: boolean;
}

/** The section is not taking new enrollments: it is still a draft, or it has been archived. */
export class SectionNotOpenError extends Error {
  constructor(
    readonly sectionId: string,
    readonly status: 'draft' | 'archived',
  ) {
    super(
      status === 'draft'
        ? `Section ${sectionId} is a draft and is not open for enrollment (staff can pass allowDraft to pre-load it)`
        : `Section ${sectionId} is archived and takes no new enrollments`,
    );
    this.name = 'SectionNotOpenError';
  }
}

/** Only an active or waitlisted enrollment can be dropped; a completed one is history. */
export class EnrollmentNotDroppableError extends Error {
  constructor(
    readonly enrollmentId: string,
    readonly status: string,
  ) {
    super(`Enrollment ${enrollmentId} is ${status} and cannot be dropped`);
    this.name = 'EnrollmentNotDroppableError';
  }
}

export interface BatchEnrollRow {
  userExternalRef: string;
  role: Role;
}

export interface BatchReport {
  succeeded: number;
  failed: Array<{ row: BatchEnrollRow; reason: string }>;
}
