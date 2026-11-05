import { describe, expect, it } from 'bun:test';
import { PermissionDeniedError, authorizeInSection, createRolePolicy, effectiveRoles } from '../src/core/index.js';
import type { PermissionPolicy } from '../src/core/index.js';
import type { Identity, LmsEvent, PermissionContext } from '../src/core/index.js';
import { createInMemoryLms } from '../src/testing/index.js';

/**
 * Department-scoped administrators: a person who is an admin only for the sections of courses in
 * the departments they administer, inside their own organization, and nowhere else. Written
 * before the implementation, and mutation-tested, as the README asks for permission changes.
 */
const as = (actorId: string) => ({ actorId });

async function school() {
  const lms = createInMemoryLms();
  const events: LmsEvent[] = [];
  lms.bus.on('*', (e) => void events.push(e));
  const org = { orgId: 'school' };
  lms.repos.departments.seed({ id: 'sci', orgId: 'school', name: 'Science' }, { id: 'arts', orgId: 'school', name: 'Arts' });
  lms.repos.users.seed(
    { id: 'principal', roles: ['admin'], ...org },
    { id: 'sci-head', roles: ['instructor'], adminOfDepartments: ['sci'], ...org },
    { id: 'teacher', roles: ['instructor'], ...org },
    { id: 'stu', roles: ['student'], ...org },
    { id: 'parent', roles: [], ...org },
    // same department id in another organization
    { id: 'other-head', roles: ['instructor'], adminOfDepartments: ['sci'], orgId: 'other' },
  );
  lms.repos.courses
    .seedCourse(
      { id: 'bio', title: 'Biology', departmentId: 'sci', ...org },
      { id: 'art', title: 'Art', departmentId: 'arts', ...org },
      { id: 'free', title: 'Study skills', ...org },
      { id: 'other-bio', title: 'Biology', departmentId: 'sci', orgId: 'other' },
    )
    .seedSection(
      { id: 'bio-a', courseId: 'bio', status: 'published' },
      { id: 'art-a', courseId: 'art', status: 'published' },
      { id: 'free-a', courseId: 'free', status: 'published' },
      { id: 'other-a', courseId: 'other-bio', status: 'published' },
    );
  return { lms, events };
}

describe('department admins: inside their departments they act as admins', () => {
  it('enrolls people and manages content in a section of their department, with no enrollment of their own', async () => {
    const { lms } = await school();
    await expect(lms.services.enrollment.enroll({ userId: 'teacher', sectionId: 'bio-a', role: 'instructor' }, as('sci-head'))).resolves.toMatchObject({ status: 'active' });
    await expect(lms.services.enrollment.enroll({ userId: 'stu', sectionId: 'bio-a', role: 'student' }, as('sci-head'))).resolves.toBeDefined();
    const node = await lms.services.content.createNode({ sectionId: 'bio-a', kind: 'page', title: 'Cells', orderIndex: 0, published: false }, as('sci-head'));
    await expect(lms.services.content.publish(node.id, as('sci-head'))).resolves.toMatchObject({ published: true });
    expect(await lms.services.enrollment.listRoster('bio-a', undefined, as('sci-head'))).toHaveLength(2);
  });

  it('is reported as an admin when they cancel a class (oversight)', async () => {
    const { lms, events } = await school();
    lms.repos.scheduling.seedGroup({ id: 'g', sectionId: 'bio-a', size: 10 });
    lms.repos.scheduling.seedTemplate({
      id: 't', sectionId: 'bio-a', teacherIds: ['teacher'], groupId: 'g',
      rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] }, startTime: '09:00', endTime: '10:00', timezone: 'UTC',
      validFrom: new Date('2026-10-05T00:00:00Z'),
    });
    const [monday] = await lms.services.scheduling.materializeOccurrences('t', new Date('2026-10-05T00:00:00Z'), new Date('2026-10-06T00:00:00Z'), as('sci-head'));
    await lms.services.scheduling.cancelOccurrence(monday!.id, 'trip', as('sci-head'));
    expect(events.find((e) => e.type === 'scheduling.occurrenceCancelled')).toMatchObject({ actorId: 'sci-head', actorRole: 'admin' });
  });
});

describe('department admins: outside their departments they are not', () => {
  it('cannot act in a section of another department, or of a course with no department', async () => {
    const { lms } = await school();
    for (const sectionId of ['art-a', 'free-a']) {
      await expect(lms.services.enrollment.enroll({ userId: 'stu', sectionId, role: 'student' }, as('sci-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(lms.services.content.createNode({ sectionId, kind: 'page', title: 'x', orderIndex: 0, published: false }, as('sci-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('cannot reach another organization that happens to use the same department id', async () => {
    const { lms } = await school();
    await expect(lms.services.enrollment.enroll({ userId: 'stu', sectionId: 'other-a', role: 'student' }, as('sci-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(lms.services.enrollment.enroll({ userId: 'stu', sectionId: 'bio-a', role: 'student' }, as('other-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('gets none of the organization-wide admin actions: guardian links, the audit log, qualifications', async () => {
    const { lms } = await school();
    await expect(lms.services.guardians.createLink('parent', 'stu', ['grades'], as('sci-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(lms.services.admin.history('anything', as('sci-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(lms.services.scheduling.setTeacherQualification('teacher', ['bio'], as('sci-head'))).rejects.toBeInstanceOf(PermissionDeniedError);
    // a full admin can do all three
    await expect(lms.services.guardians.createLink('parent', 'stu', ['grades'], as('principal'))).resolves.toBeDefined();
  });
});

describe('the policy only trusts a department-admin flag that authorization verified', () => {
  const policy = createRolePolicy();
  const head: Identity = { id: 'h', roles: [], orgId: 'school', adminOfDepartments: ['sci'] };

  it('effectiveRoles adds admin only when the section says the actor is its department admin', () => {
    expect(effectiveRoles({ actor: head, section: {}, resourceOrgId: 'school' })).toEqual([]);
    expect(effectiveRoles({ actor: head, section: { departmentAdmin: true }, resourceOrgId: 'school' })).toEqual(['admin']);
  });

  it('a hand-built context with adminOfDepartments on the actor but no verified flag grants nothing', () => {
    const ctx: PermissionContext = { actor: head, section: {}, resourceOrgId: 'school' };
    expect(policy.can('enrollment.enroll', ctx)).toBe(false);
    expect(policy.can('enrollment.enroll', { ...ctx, section: { departmentAdmin: true } })).toBe(true);
  });

  it('even a verified flag cannot cross organizations', () => {
    expect(policy.can('enrollment.enroll', { actor: head, section: { departmentAdmin: true }, resourceOrgId: 'other' })).toBe(false);
  });
});

describe('authorizeInSection verifies the department itself', () => {
  // A custom policy with no tenant check of its own: only the verified flag stands between a
  // department admin and another organization's section that reuses the department id.
  const adminsOnly: PermissionPolicy = { can: (_action, ctx) => effectiveRoles(ctx).includes('admin') };

  it('does not set the flag across organizations, even for a policy that skips the tenant check', async () => {
    const { lms } = await school();
    await expect(authorizeInSection(adminsOnly, lms.repos, 'custom.action', as('other-head'), { sectionId: 'bio-a' })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(authorizeInSection(adminsOnly, lms.repos, 'custom.action', as('sci-head'), { sectionId: 'bio-a' })).resolves.toBeDefined();
  });

  it('does not set it for a course with no department or another department', async () => {
    const { lms } = await school();
    for (const sectionId of ['art-a', 'free-a']) {
      await expect(authorizeInSection(adminsOnly, lms.repos, 'custom.action', as('sci-head'), { sectionId })).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });
});
