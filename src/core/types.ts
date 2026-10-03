/**
 * Core primitives shared across every module.
 * Everything else in the SDK is built on top of these.
 */

export type Id = string;
export type Timestamp = Date;

export type Role = 'student' | 'instructor' | 'ta' | 'admin' | 'guardian';

/**
 * A tenant: one institution, school, or company inside a shared deployment.
 * Single-institution deployments can ignore organizations entirely; leaving
 * `orgId` unset everywhere turns every tenant check into a no-op.
 * See `tenancy.ts` for how the checks work.
 */
export interface Organization {
  id: Id;
  name: string;
}

/**
 * What a guardian may see of their ward's records. Each scope opens exactly one
 * read-only built-in action (see `guardianScope` on the rules in `permissions.ts`):
 * `grades` -> `grading.view`, `attendance` -> `reporting.view`,
 * `schedule` -> `scheduling.view`. A guardian can never write anything.
 */
export type GuardianScope = 'grades' | 'attendance' | 'schedule';

/**
 * A parent-or-guardian to student relationship: the guardian may read the ward's
 * records within `scopes` and nothing else. Only an `active` link counts.
 * `orgId` is the organization the link is valid in (unset in single-tenant use)
 * and has to match the organization of what is being read.
 */
export interface GuardianLink {
  id: Id;
  guardianId: Id;
  wardId: Id;
  orgId?: Id;
  scopes: GuardianScope[];
  status: 'active' | 'revoked';
  createdAt: Timestamp;
  revokedAt?: Timestamp;
}

export interface Identity {
  id: Id;
  /** Reference back to the host app's own user record, if different. */
  externalRef?: string;
  roles: Role[];
  /** The organization this person belongs to. Unset in single-tenant use. */
  orgId?: Id;
}

/**
 * A Course is a template (e.g. "Intro to Physics").
 * A CourseSection is a running instance of it (e.g. "Intro to Physics — Fall 2026, Section B").
 * Keep these separate — conflating them is the most common regret in LMS data models.
 */
export interface Course {
  id: Id;
  title: string;
  description?: string;
  /**
   * The organization that owns this course. A course with an `orgId` can only
   * be joined by identities of the same organization; a course without one
   * is unscoped and no tenant checks apply to it. Sections, enrollments and
   * content inherit their tenant from here rather than repeating it.
   */
  orgId?: Id;
}

export interface CourseSection {
  id: Id;
  courseId: Id;
  termId?: Id;
  capacity?: number;
  status: 'draft' | 'published' | 'archived';
}

export type EnrollmentStatus = 'active' | 'waitlisted' | 'dropped' | 'completed';

export interface Enrollment {
  id: Id;
  userId: Id;
  sectionId: Id;
  role: Role;
  status: EnrollmentStatus;
  enrolledAt: Timestamp;
  droppedAt?: Timestamp;
}

export type ContentKind = 'page' | 'assignment' | 'quiz' | 'file' | 'link';

export interface ContentNode {
  id: Id;
  sectionId: Id;
  kind: ContentKind;
  title: string;
  parentId?: Id;
  orderIndex: number;
  published: boolean;
  version: number;
}

export interface AcademicTerm {
  id: Id;
  name: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  /** The organization whose calendar this term belongs to. Unset in single-tenant use. */
  orgId?: Id;
}
