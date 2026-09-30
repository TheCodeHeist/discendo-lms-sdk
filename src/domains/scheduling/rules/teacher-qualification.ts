/**
 * Pure teacher-qualification checks: is a teacher allowed to teach a given
 * course at all? No scheduling/time awareness here — a teacher can be
 * fully qualified and still be double-booked (conflict.ts) or unavailable
 * at that time (availability.ts); this module only answers the staffing
 * question, independent of when.
 */
import type { Id } from '../../../core/types.js';
import type { TeacherQualification } from '../types.js';

export interface QualificationCheckResult {
  qualified: boolean;
  reason?: string;
}

/**
 * A teacher with no TeacherQualification record in `qualifications` is
 * treated as qualified for everything — qualification tracking is opt-in,
 * same as AvailabilityRule (see its docstring). Once a teacher *does* have
 * a record, only the courses explicitly listed in it are treated as
 * qualified — an empty `qualifiedCourseIds` array means qualified for
 * nothing, not "unconstrained."
 *
 * `courseId` is optional to match ClassSessionTemplate.courseId — if the
 * session/template doesn't declare a course at all, the check always
 * passes trivially, since there's nothing to check against.
 */
export function checkTeacherQualified(
  teacherId: Id,
  courseId: string | undefined,
  qualifications: TeacherQualification[],
): QualificationCheckResult {
  if (courseId === undefined) return { qualified: true };

  const record = qualifications.find((q) => q.teacherId === teacherId);
  if (!record) return { qualified: true };

  if (record.qualifiedCourseIds.includes(courseId)) return { qualified: true };

  return {
    qualified: false,
    reason: `Teacher ${teacherId} is not listed as qualified for course ${courseId}.`,
  };
}

/**
 * Checks every teacher against a single course requirement, returning one
 * result per unqualified teacher (empty array means everyone's qualified).
 * This is what a multi-teacher session needs — ALL co-teachers must be
 * qualified, not just one of them.
 */
export function checkAllTeachersQualified(
  teacherIds: Id[],
  courseId: string | undefined,
  qualifications: TeacherQualification[],
): QualificationCheckResult[] {
  const results: QualificationCheckResult[] = [];
  for (const teacherId of teacherIds) {
    const result = checkTeacherQualified(teacherId, courseId, qualifications);
    if (!result.qualified) results.push(result);
  }
  return results;
}
