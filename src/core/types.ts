/**
 * Core primitives shared across every module.
 * Everything else in the SDK is built on top of these.
 */

export type Id = string;
export type Timestamp = Date;

export type Role = 'student' | 'instructor' | 'ta' | 'admin' | 'guardian';

export interface Identity {
  id: Id;
  /** Reference back to the host app's own user record, if different. */
  externalRef?: string;
  roles: Role[];
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
}
