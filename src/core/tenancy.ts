/**
 * Tenant (organization) checks shared by every module.
 *
 * Model: a Course may carry an `orgId`; Sections, Enrollments and Content
 * inherit it through their course instead of repeating it. Identities and
 * Terms may carry one too. If nothing in a deployment sets an `orgId`, none
 * of these checks ever run, so single-institution hosts pay nothing for this.
 *
 * Rule: an id only matches the *same* id. "No organization" (`undefined`)
 * only matches "no organization", so a person with no org can't slip into an
 * org-scoped course by omission. Permission checks (permissions.ts) apply the
 * same rule in both directions and never skip it.
 *
 * Departments (`Department`) group courses inside one organization. They are
 * not a tenant boundary: only the organization is.
 */
import type { Id, Course, Department } from './types.js';

export function sameOrg(a: Id | undefined, b: Id | undefined): boolean {
  return a === b;
}

/**
 * Thrown when something from one organization is used with another's.
 *
 * The message is deliberately generic: it can end up in an API response or a
 * bulk-import report, and it must not tell a caller which organization owns
 * a course. The ids are available as properties for the host's own logging.
 */
export class TenantMismatchError extends Error {
  constructor(
    message: string,
    readonly expectedOrgId: Id | undefined,
    readonly actualOrgId: Id | undefined,
  ) {
    super(message);
    this.name = 'TenantMismatchError';
  }
}

/** Throws TenantMismatchError unless both sides belong to the same organization. */
export function assertSameOrg(
  expectedOrgId: Id | undefined,
  actualOrgId: Id | undefined,
  message: string,
): void {
  if (!sameOrg(expectedOrgId, actualOrgId)) {
    throw new TenantMismatchError(message, expectedOrgId, actualOrgId);
  }
}

/** A course names a department that was not found, or the wrong one was supplied. */
export class UnknownDepartmentError extends Error {
  constructor(readonly departmentId: Id) {
    // Generic on purpose, like TenantMismatchError: the id is a property for host-side logging.
    super('Unknown department');
    this.name = 'UnknownDepartmentError';
  }
}

/**
 * For a host that creates or edits courses: throws unless the department the
 * course names exists and belongs to the course's organization. A course with
 * no `departmentId` always passes. Pass what `departments.findById` returned.
 */
export function assertCourseDepartment(
  course: Pick<Course, 'orgId' | 'departmentId'>,
  department: Department | null | undefined,
): void {
  if (course.departmentId === undefined) return;
  if (!department || department.id !== course.departmentId) {
    throw new UnknownDepartmentError(course.departmentId);
  }
  assertSameOrg(course.orgId, department.orgId, 'Department belongs to a different organization');
}
