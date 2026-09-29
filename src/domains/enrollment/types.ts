import type { Role } from '../../core/types.js';

export interface EnrollOptions {
  userId: string;
  sectionId: string;
  role: Role;
  /** If the section is at capacity, waitlist instead of throwing. */
  waitlistIfFull?: boolean;
}

export interface BatchEnrollRow {
  userExternalRef: string;
  role: Role;
}

export interface BatchReport {
  succeeded: number;
  failed: Array<{ row: BatchEnrollRow; reason: string }>;
}
