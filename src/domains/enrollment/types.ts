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

/** What a student can say when asking for a seat. */
export interface RequestOptions {
  note?: string;
}

/** What a reviewer can add when accepting or modifying a request. */
export interface ReviewOptions {
  /** Said to the student in the record, not sent anywhere by the SDK. */
  note?: string;
  /** If the section is full (or people are waiting), waitlist the student instead of failing. Default: true. */
  waitlistIfFull?: boolean;
  /** As `EnrollOptions.allowDraft`. */
  allowDraft?: boolean;
}

/** What a reviewer can add when rejecting a request. */
export interface RejectOptions {
  note?: string;
}

/** The student already holds (or has completed) a place in the section they asked for. */
export class AlreadyEnrolledError extends Error {
  constructor(readonly sectionId: string) {
    super(`Already enrolled in section ${sectionId}`);
    this.name = 'AlreadyEnrolledError';
  }
}

/** The request was already settled the other way (or is not pending), so this decision cannot be made. */
export class RequestNotPendingError extends Error {
  constructor(
    readonly requestId: string,
    readonly status: string,
  ) {
    super(`Enrollment request ${requestId} is ${status}, not pending`);
    this.name = 'RequestNotPendingError';
  }
}

/** `modify` named a section that cannot take this student's place: the same one, or another course's. */
export class InvalidRequestModificationError extends Error {
  constructor(readonly reason: 'same-section' | 'different-course') {
    super(
      reason === 'same-section'
        ? 'A modified request must name a different section (use accept to keep the one asked for)'
        : 'A modified request must stay in the same course',
    );
    this.name = 'InvalidRequestModificationError';
  }
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
