import { describe, expect, it } from 'bun:test';
import { PermissionDeniedError, ServiceConfigError, createRolePolicy, isServiceConfig, requireRepos } from '../src/core/index.js';
import { AssessmentService } from '../src/domains/assessment/index.js';
import { GradingService } from '../src/domains/grading/index.js';
import { GroupService } from '../src/domains/enrollment/index.js';
import { SchedulingService } from '../src/domains/scheduling/index.js';
import { CommunicationService } from '../src/services/communication/index.js';
import { ReportingService } from '../src/services/reporting/index.js';
import { AdminService } from '../src/services/admin/index.js';
import {
  InMemoryAnnouncementRepository,
  InMemoryAttendanceRepository,
  InMemoryAuditRepository,
  InMemoryCourseRepository,
  InMemoryEnrollmentRepository,
  InMemoryGradeRepository,
  InMemoryQuizRepository,
  InMemorySchedulingRepository,
  InMemorySubmissionRepository,
  InMemoryThreadRepository,
  InMemoryUserRepository,
  createInMemoryLms,
} from '../src/testing/index.js';

const policy = createRolePolicy();
const as = (actorId: string) => ({ actorId });

describe('isServiceConfig', () => {
  it('is true only for a single object with repos', () => {
    expect(isServiceConfig([{ repos: {} }])).toBe(true);
    expect(isServiceConfig([{ repos: {} }, undefined])).toBe(false);
    expect(isServiceConfig([{ users: {}, courses: {} }])).toBe(false); // a RepositoryContext, the old first argument
    expect(isServiceConfig([{ repos: null }])).toBe(false);
    expect(isServiceConfig([])).toBe(false);
    expect(isServiceConfig([null])).toBe(false);
  });

  it('never mistakes an old single-argument call for the new form', async () => {
    const lms = createInMemoryLms({ enforce: false });
    // GroupService(repos) was a valid old call with one argument: still the old form.
    const groups = new GroupService(lms.repos);
    lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
    await expect(groups.createGroup('s', 'Team A')).resolves.toMatchObject({ name: 'Team A' });
  });
});

describe('a missing repository is a clear error when the service is built, not a refusal later', () => {
  const users = new InMemoryUserRepository();
  const courses = new InMemoryCourseRepository();
  const enrollments = new InMemoryEnrollmentRepository();

  it('requireRepos names every missing repository', () => {
    expect(() => requireRepos('X', { users }, ['users', 'courses', 'enrollments'])).toThrow('X needs repos.courses, repos.enrollments to enforce permissions');
    expect(() => requireRepos('X', { users }, ['users'])).not.toThrow();
  });

  it('per service, only when a policy is given', () => {
    const base = { submissions: new InMemorySubmissionRepository(), quizzes: new InMemoryQuizRepository() };
    expect(() => new AssessmentService({ repos: { ...base, users, courses, enrollments }, policy })).toThrow(ServiceConfigError);
    expect(() => new AssessmentService({ repos: { ...base, users, courses, enrollments }, policy })).toThrow('repos.content');
    expect(() => new AssessmentService({ repos: base })).not.toThrow();

    const grades = new InMemoryGradeRepository();
    expect(() => new GradingService({ repos: { grades, users, courses, enrollments }, policy })).toThrow('SubmissionLocator');
    expect(() => new GradingService({ repos: { grades }, policy, submissions: { locate: async () => null } })).toThrow('repos.users');

    expect(() => new SchedulingService({ repos: { scheduling: new InMemorySchedulingRepository() }, policy })).toThrow(ServiceConfigError);
    const comms = { announcements: new InMemoryAnnouncementRepository(), threads: new InMemoryThreadRepository() };
    expect(() => new CommunicationService({ repos: comms, policy })).toThrow(ServiceConfigError);
    expect(() => new ReportingService({ repos: { attendance: new InMemoryAttendanceRepository(), users, courses, enrollments }, policy })).toThrow('SessionLocator');
    expect(() => new AdminService({ repos: { audit: new InMemoryAuditRepository() }, policy })).toThrow('repos.users');
  });
});

describe('the old and new forms behave the same', () => {
  async function world() {
    const lms = createInMemoryLms();
    lms.repos.users.seed({ id: 'admin', roles: ['admin'] }, { id: 'teacher', roles: ['instructor'] }, { id: 'stu', roles: ['student'] });
    lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
    await lms.services.enrollment.enroll({ userId: 'teacher', sectionId: 's', role: 'instructor' }, as('admin'));
    await lms.services.enrollment.enroll({ userId: 'stu', sectionId: 's', role: 'student' }, as('admin'));
    const hw = await lms.services.content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW', orderIndex: 0, published: true }, as('teacher'));
    const sub = await lms.services.assessment.submit(hw.id, 'stu', { kind: 'text', content: 'x' }, undefined, as('stu'));
    return { lms, sub };
  }

  it('GradingService: same refusals, same grade', async () => {
    const { lms, sub } = await world();
    const authRepos = { users: lms.repos.users, courses: lms.repos.courses, enrollments: lms.repos.enrollments };
    const legacy = new GradingService(lms.repos.grades, lms.bus, { policy, repos: authRepos, submissions: lms.locators.submissions });
    const modern = new GradingService({ repos: { ...authRepos, grades: lms.repos.grades }, policy, events: lms.bus, submissions: lms.locators.submissions });
    for (const service of [legacy, modern]) {
      await expect(service.recordGrade(sub.id, 'stu', 5, 10, 'stu', undefined, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    const a = await legacy.recordGrade(sub.id, 'stu', 6, 10, 'teacher', undefined, as('teacher'));
    const b = await modern.recordGrade(sub.id, 'stu', 7, 10, 'teacher', a.id, as('teacher'));
    expect((await lms.repos.grades.findById(a.id))?.supersededBy).toBe(b.id);
  });

  it('AdminService and ReportingService: the new form enforces like the old', async () => {
    const { lms } = await world();
    const modernAdmin = new AdminService({ repos: { audit: lms.repos.audit, users: lms.repos.users }, policy });
    await expect(modernAdmin.history('x', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(modernAdmin.history('x', as('admin'))).resolves.toEqual([]);
    const reporting = new ReportingService({
      repos: { attendance: lms.repos.attendance, users: lms.repos.users, courses: lms.repos.courses, enrollments: lms.repos.enrollments },
      sessions: lms.locators.sessions,
      policy,
    });
    await expect(reporting.exportRoster('s', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect((await reporting.exportRoster('s', as('teacher'))).toRows()).toHaveLength(2);
  });
});
