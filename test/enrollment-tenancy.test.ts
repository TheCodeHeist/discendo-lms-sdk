import { describe, it, expect } from 'bun:test';
import { EnrollmentService } from '../src/domains/enrollment/index.js';
import { EventBus, TenantMismatchError } from '../src/core/index.js';
import type { RepositoryContext, Enrollment, CourseSection, Course, Identity } from '../src/core/index.js';

function makeRepos(opts: {
  courses?: Course[];
  users?: Identity[];
  sections?: CourseSection[];
  /** false simulates a host whose UserRepository ignores the orgId hint. Default true. */
  honorOrgId?: boolean;
}) {
  const honorOrgId = opts.honorOrgId ?? true;
  const courses = new Map((opts.courses ?? []).map((c) => [c.id, c]));
  const users = new Map((opts.users ?? []).map((u) => [u.id, u]));
  const sections = new Map((opts.sections ?? []).map((s) => [s.id, s]));
  const enrollments = new Map<string, Enrollment>();
  const calls = { findCourse: 0, findUserById: 0 };
  const externalRefCalls: Array<{ ref: string; orgId: string | undefined }> = [];
  let counter = 0;

  const repos: RepositoryContext = {
    users: {
      findById: async (id) => {
        calls.findUserById++;
        return users.get(id) ?? null;
      },
      findByExternalRef: async (ref, orgId) => {
        externalRefCalls.push({ ref, orgId });
        return (
          [...users.values()].find(
            (u) => u.externalRef === ref && (!honorOrgId || orgId === undefined || u.orgId === orgId),
          ) ?? null
        );
      },
    },
    courses: {
      findCourse: async (id) => {
        calls.findCourse++;
        return courses.get(id) ?? null;
      },
      findSection: async (id) => sections.get(id) ?? null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => {
        const entry: Enrollment = { ...e, id: `enr-${++counter}` };
        enrollments.set(entry.id, entry);
        return entry;
      },
      update: async (id, patch) => {
        const updated = { ...enrollments.get(id)!, ...patch };
        enrollments.set(id, updated);
        return updated;
      },
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments.values()].find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => [...enrollments.values()].filter((e) => e.sectionId === sectionId),
      countActive: async (sectionId) =>
        [...enrollments.values()].filter((e) => e.sectionId === sectionId && e.status === 'active').length,
    },
    content: {
      findById: async () => null,
      listBySection: async () => [],
      create: async (n) => ({ ...n, id: 'c1', version: 1 }),
      update: async (id, patch) => ({ id, sectionId: 's1', kind: 'page', title: '', orderIndex: 0, published: false, version: 1, ...patch }),
      reorder: async () => {},
    },
    terms: { findById: async () => null },
  };
  return { repos, enrollments, calls, externalRefCalls };
}

const orgACourse: Course = { id: 'course-a', title: 'Physics', orgId: 'org-a' };
const unscopedCourse: Course = { id: 'course-open', title: 'Open course' };
const sectionA: CourseSection = { id: 'sec-a', courseId: 'course-a', status: 'published' };
const sectionOpen: CourseSection = { id: 'sec-open', courseId: 'course-open', status: 'published' };

const alice: Identity = { id: 'alice', roles: ['student'], orgId: 'org-a' };
const bob: Identity = { id: 'bob', roles: ['student'], orgId: 'org-b' };
const carol: Identity = { id: 'carol', roles: ['student'] }; // belongs to no organization

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EnrollmentService tenant checks', () => {
  it('enrolls a member of the same organization', async () => {
    const { repos } = makeRepos({ courses: [orgACourse], users: [alice], sections: [sectionA] });
    const service = new EnrollmentService(repos);

    const result = await service.enroll({ userId: 'alice', sectionId: 'sec-a', role: 'student' });

    expect(result.status).toBe('active');
  });

  it("rejects a user from a different organization and creates no enrollment", async () => {
    const { repos, enrollments } = makeRepos({ courses: [orgACourse], users: [bob], sections: [sectionA] });
    const service = new EnrollmentService(repos);

    await expect(service.enroll({ userId: 'bob', sectionId: 'sec-a', role: 'student' })).rejects.toBeInstanceOf(
      TenantMismatchError,
    );
    expect(enrollments.size).toBe(0);
  });

  it('fails closed: a user with no organization cannot join an org-scoped course', async () => {
    const { repos, enrollments } = makeRepos({ courses: [orgACourse], users: [carol], sections: [sectionA] });
    const service = new EnrollmentService(repos);

    await expect(service.enroll({ userId: 'carol', sectionId: 'sec-a', role: 'student' })).rejects.toBeInstanceOf(
      TenantMismatchError,
    );
    expect(enrollments.size).toBe(0);
  });

  it('does not leak the course organization in the error message', async () => {
    const { repos } = makeRepos({ courses: [orgACourse], users: [bob], sections: [sectionA] });
    const service = new EnrollmentService(repos);

    const err = (await service
      .enroll({ userId: 'bob', sectionId: 'sec-a', role: 'student' })
      .catch((e: unknown) => e)) as TenantMismatchError;

    expect(err.message).not.toContain('org-a');
    expect(err.expectedOrgId).toBe('org-a');
    expect(err.actualOrgId).toBe('org-b');
  });

  it('rejects before the capacity logic, so a cross-tenant user is never waitlisted', async () => {
    const full: CourseSection = { ...sectionA, capacity: 0 };
    const { repos, enrollments } = makeRepos({ courses: [orgACourse], users: [bob], sections: [full] });
    const service = new EnrollmentService(repos);

    await expect(
      service.enroll({ userId: 'bob', sectionId: 'sec-a', role: 'student', waitlistIfFull: true }),
    ).rejects.toBeInstanceOf(TenantMismatchError);
    expect(enrollments.size).toBe(0);
  });

  it('emits no enrollment event for a rejected cross-tenant attempt', async () => {
    const { repos } = makeRepos({ courses: [orgACourse], users: [bob], sections: [sectionA] });
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.on('*', (e) => events.push(e));
    const service = new EnrollmentService(repos, bus);

    await service.enroll({ userId: 'bob', sectionId: 'sec-a', role: 'student' }).catch(() => {});
    await flush();

    expect(events).toEqual([]);
  });

  it('reports "user not found" for an unknown user on an org-scoped course', async () => {
    const { repos } = makeRepos({ courses: [orgACourse], users: [], sections: [sectionA] });
    const service = new EnrollmentService(repos);

    await expect(service.enroll({ userId: 'ghost', sectionId: 'sec-a', role: 'student' })).rejects.toThrow(
      'User ghost not found',
    );
  });

  describe('single-tenant / unscoped behavior', () => {
    it('applies no check to an unscoped course, even for users that have an organization', async () => {
      const { repos } = makeRepos({ courses: [unscopedCourse], users: [alice, bob, carol], sections: [sectionOpen] });
      const service = new EnrollmentService(repos);

      for (const userId of ['alice', 'bob', 'carol']) {
        const result = await service.enroll({ userId, sectionId: 'sec-open', role: 'student' });
        expect(result.status).toBe('active');
      }
    });

    it('does not even load the user for an unscoped course', async () => {
      const { repos, calls } = makeRepos({ courses: [unscopedCourse], users: [alice], sections: [sectionOpen] });
      const service = new EnrollmentService(repos);

      await service.enroll({ userId: 'alice', sectionId: 'sec-open', role: 'student' });

      expect(calls.findUserById).toBe(0);
      expect(calls.findCourse).toBe(1); // the one extra lookup that tenancy costs
    });

    it('treats a section whose course cannot be found as unscoped', async () => {
      const orphan: CourseSection = { id: 'sec-orphan', courseId: 'missing-course', status: 'published' };
      const { repos } = makeRepos({ users: [alice], sections: [orphan] });
      const service = new EnrollmentService(repos);

      await expect(service.enroll({ userId: 'alice', sectionId: 'sec-orphan', role: 'student' })).resolves.toMatchObject({
        status: 'active',
      });
    });

    it('skips the check entirely when the user is already enrolled (idempotent path)', async () => {
      const { repos, calls } = makeRepos({ courses: [orgACourse], users: [alice], sections: [sectionA] });
      const service = new EnrollmentService(repos);
      await service.enroll({ userId: 'alice', sectionId: 'sec-a', role: 'student' });
      const before = { ...calls };

      await service.enroll({ userId: 'alice', sectionId: 'sec-a', role: 'student' });

      expect(calls).toEqual(before);
    });
  });

  describe('bulkEnroll', () => {
    it('still rejects a cross-tenant row when the host ignores the orgId hint (the guard is the backstop)', async () => {
      const dana: Identity = { id: 'dana', externalRef: 'ext-dana', roles: ['student'], orgId: 'org-a' };
      const erik: Identity = { id: 'erik', externalRef: 'ext-erik', roles: ['student'], orgId: 'org-b' };
      const { repos, enrollments } = makeRepos({
        courses: [orgACourse],
        users: [dana, erik],
        sections: [sectionA],
        honorOrgId: false,
      });
      const service = new EnrollmentService(repos);

      const report = await service.bulkEnroll('sec-a', [
        { userExternalRef: 'ext-dana', role: 'student' },
        { userExternalRef: 'ext-erik', role: 'student' },
      ]);

      expect(report.succeeded).toBe(1);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]!.row.userExternalRef).toBe('ext-erik');
      expect(report.failed[0]!.reason).toContain('organization');
      expect(report.failed[0]!.reason).not.toContain('org-a');
      expect([...enrollments.values()].map((e) => e.userId)).toEqual(['dana']);
    });

    it('passes the course organization to findByExternalRef', async () => {
      const dana: Identity = { id: 'dana', externalRef: 'ext-dana', roles: ['student'], orgId: 'org-a' };
      const { repos, externalRefCalls } = makeRepos({ courses: [orgACourse], users: [dana], sections: [sectionA] });
      const service = new EnrollmentService(repos);

      await service.bulkEnroll('sec-a', [{ userExternalRef: 'ext-dana', role: 'student' }]);

      expect(externalRefCalls).toEqual([{ ref: 'ext-dana', orgId: 'org-a' }]);
    });

    it('resolves a shared external reference to the right person in each organization', async () => {
      const inA: Identity = { id: 'shared-in-a', externalRef: 'ext-1', roles: ['student'], orgId: 'org-a' };
      const inB: Identity = { id: 'shared-in-b', externalRef: 'ext-1', roles: ['student'], orgId: 'org-b' };
      const orgBCourse: Course = { id: 'course-b', title: 'Chemistry', orgId: 'org-b' };
      const sectionB: CourseSection = { id: 'sec-b', courseId: 'course-b', status: 'published' };
      // Put org-b's person FIRST so a tenant-blind lookup would return the wrong one for org-a.
      const { repos, enrollments } = makeRepos({
        courses: [orgACourse, orgBCourse],
        users: [inB, inA],
        sections: [sectionA, sectionB],
      });
      const service = new EnrollmentService(repos);

      const reportA = await service.bulkEnroll('sec-a', [{ userExternalRef: 'ext-1', role: 'student' }]);
      const reportB = await service.bulkEnroll('sec-b', [{ userExternalRef: 'ext-1', role: 'student' }]);

      expect(reportA).toEqual({ succeeded: 1, failed: [] });
      expect(reportB).toEqual({ succeeded: 1, failed: [] });
      const bySection = Object.fromEntries([...enrollments.values()].map((e) => [e.sectionId, e.userId]));
      expect(bySection).toEqual({ 'sec-a': 'shared-in-a', 'sec-b': 'shared-in-b' });
    });

    it('reports "user not found" when the reference exists only in another organization', async () => {
      const erik: Identity = { id: 'erik', externalRef: 'ext-erik', roles: ['student'], orgId: 'org-b' };
      const { repos, enrollments } = makeRepos({ courses: [orgACourse], users: [erik], sections: [sectionA] });
      const service = new EnrollmentService(repos);

      const report = await service.bulkEnroll('sec-a', [{ userExternalRef: 'ext-erik', role: 'student' }]);

      expect(report.succeeded).toBe(0);
      expect(report.failed[0]!.reason).toBe('user not found');
      expect(enrollments.size).toBe(0);
    });

    it('passes no organization for an unscoped course', async () => {
      const dana: Identity = { id: 'dana', externalRef: 'ext-dana', roles: ['student'], orgId: 'org-a' };
      const { repos, externalRefCalls } = makeRepos({ courses: [unscopedCourse], users: [dana], sections: [sectionOpen] });
      const service = new EnrollmentService(repos);

      await service.bulkEnroll('sec-open', [{ userExternalRef: 'ext-dana', role: 'student' }]);

      expect(externalRefCalls).toEqual([{ ref: 'ext-dana', orgId: undefined }]);
    });

    it('reports a missing section per row, without an organization hint', async () => {
      const dana: Identity = { id: 'dana', externalRef: 'ext-dana', roles: ['student'] };
      const { repos, externalRefCalls } = makeRepos({ users: [dana] });
      const service = new EnrollmentService(repos);

      const report = await service.bulkEnroll('no-such-section', [{ userExternalRef: 'ext-dana', role: 'student' }]);

      expect(report.succeeded).toBe(0);
      expect(report.failed[0]!.reason).toContain('not found');
      expect(externalRefCalls).toEqual([{ ref: 'ext-dana', orgId: undefined }]);
    });
  });
});
