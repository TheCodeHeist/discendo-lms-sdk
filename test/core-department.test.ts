import { describe, it, expect } from 'bun:test';
import { assertCourseDepartment, TenantMismatchError, UnknownDepartmentError } from '../src/core/index.js';
import type { Course, Department } from '../src/core/index.js';

const science: Department = { id: 'dept-sci', orgId: 'org-a', name: 'Science' };
const music: Department = { id: 'dept-music', orgId: 'org-a', name: 'Creative Arts' };
const course = (extra: Partial<Course> = {}): Course => ({ id: 'c1', title: 'Intro', orgId: 'org-a', ...extra });

describe('assertCourseDepartment', () => {
  it('does nothing for a course with no department (schools never need one)', () => {
    expect(() => assertCourseDepartment(course(), undefined)).not.toThrow();
    expect(() => assertCourseDepartment(course(), null)).not.toThrow();
  });

  it('accepts a department of the same organization', () => {
    expect(() => assertCourseDepartment(course({ departmentId: 'dept-sci' }), science)).not.toThrow();
  });

  it('works in a single-institution deployment where nothing has an organization', () => {
    const dept: Department = { id: 'd', name: 'Maths' };
    const c: Course = { id: 'c', title: 'Algebra', departmentId: 'd' };
    expect(() => assertCourseDepartment(c, dept)).not.toThrow();
  });

  it('refuses a department of another organization, with a generic message and the ids for logging', () => {
    const other: Department = { id: 'dept-sci', orgId: 'org-b', name: 'Science' };
    try {
      assertCourseDepartment(course({ departmentId: 'dept-sci' }), other);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TenantMismatchError);
      const err = e as TenantMismatchError;
      expect(err.expectedOrgId).toBe('org-a');
      expect(err.actualOrgId).toBe('org-b');
      expect(err.message).not.toContain('org-a');
      expect(err.message).not.toContain('org-b');
    }
  });

  it('refuses a department with no organization on an org-scoped course, and the reverse', () => {
    const free: Department = { id: 'dept-sci', name: 'Science' };
    expect(() => assertCourseDepartment(course({ departmentId: 'dept-sci' }), free)).toThrow(TenantMismatchError);
    const c: Course = { id: 'c', title: 'x', departmentId: 'dept-sci' };
    expect(() => assertCourseDepartment(c, science)).toThrow(TenantMismatchError);
  });

  it('refuses when the course names a department that was not found', () => {
    expect(() => assertCourseDepartment(course({ departmentId: 'dept-sci' }), null)).toThrow(UnknownDepartmentError);
    expect(() => assertCourseDepartment(course({ departmentId: 'dept-sci' }), undefined)).toThrow(UnknownDepartmentError);
  });

  it('refuses when the repository returned a different department than the course names', () => {
    expect(() => assertCourseDepartment(course({ departmentId: 'dept-sci' }), music)).toThrow(UnknownDepartmentError);
  });

  it('keeps the unknown-department message generic', () => {
    try {
      assertCourseDepartment(course({ departmentId: 'dept-secret' }), null);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('dept-secret');
      expect((e as UnknownDepartmentError).departmentId).toBe('dept-secret');
    }
  });
});
