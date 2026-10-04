/**
 * Core primitives shared across every module.
 * Everything else in the SDK is built on top of these.
 */

export type Id = string;
export type Timestamp = Date;

export type Role = 'student' | 'instructor' | 'ta' | 'admin';

/**
 * A tenant: one institution, school, or company inside a shared deployment.
 * Single-institution deployments can ignore organizations entirely; leaving
 * `orgId` unset everywhere makes every tenant check pass.
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

/**
 * An optional grouping of courses inside ONE organization: a department, a
 * faculty, a subject area. It is for sorting and reporting, not a tenant
 * boundary: a student can take courses from several departments of the same
 * organization. Schools and other hosts that don't need it never set
 * `Course.departmentId`. `orgId` must match the organization of the courses
 * placed in it (see `assertCourseDepartment`).
 */
export interface Department {
  id: Id;
  orgId?: Id;
  name: string;
}

/**
 * One action an instructor (or admin) handed to ONE teaching assistant in ONE
 * section. It belongs to the TA's enrollment, not to the person: when that
 * enrollment ends and the person is enrolled again, the new enrollment starts
 * with no grants. Only an action a rule marks `delegable` has any effect, and
 * only while `revokedAt` is unset.
 */
export interface TaGrant {
  id: Id;
  enrollmentId: Id;
  sectionId: Id;
  action: string;
  grantedBy: Id;
  grantedAt: Timestamp;
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
   * be joined by identities of the same organization, and only people of that
   * organization can act on it. A course without one belongs to no
   * organization: permission checks only admit actors who have none either,
   * while enrollment's user check still skips it. Sections, enrollments and
   * content inherit their tenant from here rather than repeating it.
   */
  orgId?: Id;
  /** Optional grouping inside the organization (see `Department`). */
  departmentId?: Id;
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
