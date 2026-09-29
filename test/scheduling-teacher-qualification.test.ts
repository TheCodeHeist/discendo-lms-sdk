import { describe, it, expect } from 'bun:test';
import {
  checkTeacherQualified,
  checkAllTeachersQualified,
} from '../src/domains/scheduling/index.js';
import type { TeacherQualification } from '../src/domains/scheduling/index.js';

function qual(overrides: Partial<TeacherQualification> = {}): TeacherQualification {
  return { teacherId: 'teacher-1', qualifiedCourseIds: ['course-physics'], ...overrides };
}

describe('checkTeacherQualified', () => {
  it('passes trivially when courseId is undefined', () => {
    const result = checkTeacherQualified('teacher-1', undefined, [qual({ qualifiedCourseIds: [] })]);
    expect(result.qualified).toBe(true);
  });

  it('treats a teacher with no qualification record as qualified for anything', () => {
    const result = checkTeacherQualified('teacher-2', 'course-physics', [qual()]);
    expect(result.qualified).toBe(true);
  });

  it('passes when the course is in the teacher\'s qualified list', () => {
    const result = checkTeacherQualified('teacher-1', 'course-physics', [qual()]);
    expect(result.qualified).toBe(true);
  });

  it('fails when the course is not in the teacher\'s qualified list', () => {
    const result = checkTeacherQualified('teacher-1', 'course-chemistry', [qual()]);
    expect(result.qualified).toBe(false);
    expect(result.reason).toContain('teacher-1');
  });

  it('fails for every course when qualifiedCourseIds is empty (not "unconstrained")', () => {
    const result = checkTeacherQualified('teacher-1', 'course-physics', [
      qual({ qualifiedCourseIds: [] }),
    ]);
    expect(result.qualified).toBe(false);
  });
});

describe('checkAllTeachersQualified', () => {
  it('returns empty when every teacher is qualified', () => {
    const results = checkAllTeachersQualified(
      ['teacher-1'],
      'course-physics',
      [qual()],
    );
    expect(results).toHaveLength(0);
  });

  it('returns a failure per unqualified teacher in a multi-teacher session', () => {
    const results = checkAllTeachersQualified(
      ['teacher-1', 'teacher-2'],
      'course-chemistry',
      [qual({ teacherId: 'teacher-1', qualifiedCourseIds: ['course-chemistry'] }), qual({ teacherId: 'teacher-2', qualifiedCourseIds: ['course-physics'] })],
    );
    expect(results).toHaveLength(1);
  });

  it('returns empty when courseId is undefined regardless of qualifications on file', () => {
    const results = checkAllTeachersQualified(['teacher-1'], undefined, [qual({ qualifiedCourseIds: [] })]);
    expect(results).toHaveLength(0);
  });
});
