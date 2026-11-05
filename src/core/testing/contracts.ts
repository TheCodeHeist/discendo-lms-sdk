/**
 * Contract suites for the repository interfaces in `core/repositories.ts`. Each function takes a
 * factory for a fresh repository and returns the checks it must pass (see `contract.ts` for how to
 * run them). The checks are about the behaviour the SDK's services rely on and the docs promise:
 * "the most recent", "only if still pending", "count what `countActive` counts", and so on.
 *
 * For the interfaces that only read, the factory is handed the rows to seed first, since the SDK
 * has no way to create them.
 */
import type {
  AcademicTerm,
  ContentNode,
  Course,
  CourseSection,
  Department,
  Enrollment,
  EnrollmentRequest,
  GuardianLink,
  Identity,
  Organization,
  TaGrant,
} from '../types.js';
import type {
  ContentRepository,
  CoursePrerequisiteRepository,
  CourseRepository,
  DelegationRepository,
  DepartmentRepository,
  EnrollmentRepository,
  EnrollmentRequestRepository,
  GroupRepository,
  GuardianLinkManagementRepository,
  OrganizationRepository,
  TermRepository,
  UserRepository,
} from '../repositories.js';
import { check, checkEqual, idsOf, suite, type ContractCase, type RepositoryFactory } from './contract.js';

const at = (iso: string) => new Date(iso);

// ---- read-only repositories: seeded by the factory ----

export function userRepositoryContract(make: (seed: Identity[]) => Promise<UserRepository> | UserRepository): ContractCase[] {
  const people: Identity[] = [
    { id: 'u1', roles: ['student'], externalRef: 'ext-1', orgId: 'org-a' },
    { id: 'u2', roles: ['instructor'], externalRef: 'ext-1', orgId: 'org-b' },
    { id: 'u3', roles: ['admin'] },
  ];
  return suite('UserRepository', [
    {
      name: 'findById returns the identity as stored, or null',
      run: async () => {
        const repo = await make(people);
        checkEqual(await repo.findById('u1'), people[0], 'findById(u1)');
        checkEqual(await repo.findById('nobody'), null, 'findById of an unknown id');
      },
    },
    {
      name: 'findByExternalRef with an orgId only returns an identity of that organization',
      run: async () => {
        const repo = await make(people);
        checkEqual((await repo.findByExternalRef('ext-1', 'org-b'))?.id, 'u2', 'ext-1 in org-b');
        checkEqual((await repo.findByExternalRef('ext-1', 'org-a'))?.id, 'u1', 'ext-1 in org-a');
        checkEqual(await repo.findByExternalRef('ext-1', 'org-c'), null, 'ext-1 in an organization that has none');
        checkEqual(await repo.findByExternalRef('missing'), null, 'an unknown reference');
      },
    },
  ]);
}

export function courseRepositoryContract(
  make: (seed: { courses: Course[]; sections: CourseSection[] }) => Promise<CourseRepository> | CourseRepository,
): ContractCase[] {
  const courses: Course[] = [{ id: 'c1', title: 'Physics', orgId: 'org-a' }, { id: 'c2', title: 'Art' }];
  const sections: CourseSection[] = [
    { id: 's1', courseId: 'c1', status: 'published', capacity: 30 },
    { id: 's2', courseId: 'c1', status: 'draft' },
    { id: 's3', courseId: 'c2', status: 'archived' },
  ];
  return suite('CourseRepository', [
    {
      name: 'finds courses and sections by id, or null',
      run: async () => {
        const repo = await make({ courses, sections });
        checkEqual(await repo.findCourse('c1'), courses[0], 'findCourse(c1)');
        checkEqual(await repo.findSection('s1'), sections[0], 'findSection(s1)');
        checkEqual(await repo.findCourse('nope'), null, 'findCourse of an unknown id');
        checkEqual(await repo.findSection('nope'), null, 'findSection of an unknown id');
      },
    },
    {
      name: "listSections returns every section of that course, whatever its status, and no other course's",
      run: async () => {
        const repo = await make({ courses, sections });
        checkEqual(idsOf(await repo.listSections('c1')), ['s1', 's2'], 'sections of c1');
        checkEqual(await repo.listSections('c-none'), [], 'sections of an unknown course');
      },
    },
  ]);
}

export function termRepositoryContract(make: (seed: AcademicTerm[]) => Promise<TermRepository> | TermRepository): ContractCase[] {
  const terms: AcademicTerm[] = [{ id: 't1', name: 'Fall', startsAt: at('2026-09-01'), endsAt: at('2026-12-20'), orgId: 'org-a' }];
  return suite('TermRepository', [
    {
      name: 'findById returns the term with its dates intact, or null',
      run: async () => {
        const repo = await make(terms);
        const found = await repo.findById('t1');
        checkEqual(found, terms[0], 'findById(t1)');
        check(found?.startsAt instanceof Date, 'startsAt comes back as a Date');
        checkEqual(await repo.findById('nope'), null, 'an unknown id');
      },
    },
  ]);
}

export function organizationRepositoryContract(
  make: (seed: Organization[]) => Promise<OrganizationRepository> | OrganizationRepository,
): ContractCase[] {
  return suite('OrganizationRepository', [
    {
      name: 'findById returns the organization, or null',
      run: async () => {
        const repo = await make([{ id: 'org-a', name: 'School A' }]);
        checkEqual(await repo.findById('org-a'), { id: 'org-a', name: 'School A' }, 'findById(org-a)');
        checkEqual(await repo.findById('nope'), null, 'an unknown id');
      },
    },
  ]);
}

export function departmentRepositoryContract(
  make: (seed: Department[]) => Promise<DepartmentRepository> | DepartmentRepository,
): ContractCase[] {
  const departments: Department[] = [
    { id: 'd1', orgId: 'org-a', name: 'Science' },
    { id: 'd2', orgId: 'org-a', name: 'Arts' },
    { id: 'd3', orgId: 'org-b', name: 'Science' },
    { id: 'd4', name: 'Unaffiliated' },
  ];
  return suite('DepartmentRepository', [
    {
      name: 'findById returns the department, or null',
      run: async () => {
        const repo = await make(departments);
        checkEqual(await repo.findById('d1'), departments[0], 'findById(d1)');
        checkEqual(await repo.findById('nope'), null, 'an unknown id');
      },
    },
    {
      name: 'listByOrg lists one organization, and undefined lists those with none',
      run: async () => {
        const repo = await make(departments);
        checkEqual(idsOf(await repo.listByOrg('org-a')), ['d1', 'd2'], 'departments of org-a');
        checkEqual(idsOf(await repo.listByOrg(undefined)), ['d4'], 'departments with no organization');
      },
    },
  ]);
}

// ---- repositories the SDK writes to ----

const enrollment = (over: Partial<Omit<Enrollment, 'id'>> = {}): Omit<Enrollment, 'id'> => ({
  userId: 'u1',
  sectionId: 's1',
  role: 'student',
  status: 'active',
  enrolledAt: at('2026-09-01T10:00:00Z'),
  ...over,
});

export function enrollmentRepositoryContract(make: RepositoryFactory<EnrollmentRepository>): ContractCase[] {
  const cases: ContractCase[] = [
    {
      name: 'create assigns an id and stores every field',
      run: async () => {
        const repo = await make();
        const created = await repo.create(enrollment());
        check(typeof created.id === 'string' && created.id !== '', 'create returns a non-empty id');
        checkEqual(await repo.findById(created.id), created, 'findById returns what create returned');
        checkEqual(await repo.findById('nope'), null, 'findById of an unknown id');
      },
    },
    {
      name: 'update merges the patch and keeps the other fields',
      run: async () => {
        const repo = await make();
        const created = await repo.create(enrollment());
        const droppedAt = at('2026-10-01T00:00:00Z');
        const updated = await repo.update(created.id, { status: 'dropped', droppedAt });
        checkEqual(updated, { ...created, status: 'dropped', droppedAt }, 'the updated enrollment');
        checkEqual(await repo.findById(created.id), updated, 'the stored enrollment');
      },
    },
    {
      name: 'findByUserAndSection returns the MOST RECENT record (permission checks depend on it)',
      run: async () => {
        const repo = await make();
        const first = await repo.create(enrollment({ enrolledAt: at('2026-09-01') }));
        await repo.update(first.id, { status: 'dropped' });
        const second = await repo.create(enrollment({ enrolledAt: at('2026-09-10') }));
        checkEqual((await repo.findByUserAndSection('u1', 's1'))?.id, second.id, 'the later enrollment');
        checkEqual(await repo.findByUserAndSection('u1', 's-other'), null, 'nothing in another section');
      },
    },
    {
      name: 'listBySection filters by section and, when given, by status',
      run: async () => {
        const repo = await make();
        const a = await repo.create(enrollment({ userId: 'a' }));
        const b = await repo.create(enrollment({ userId: 'b', status: 'waitlisted' }));
        await repo.create(enrollment({ userId: 'c', sectionId: 's2' }));
        checkEqual(idsOf(await repo.listBySection('s1')), idsOf([a, b]), 'everyone in s1');
        checkEqual(idsOf(await repo.listBySection('s1', 'waitlisted')), [b.id], 'the waitlist of s1');
      },
    },
    {
      name: 'countActive counts active enrollments of that section only',
      run: async () => {
        const repo = await make();
        await repo.create(enrollment({ userId: 'a' }));
        await repo.create(enrollment({ userId: 'b', role: 'ta' }));
        await repo.create(enrollment({ userId: 'c', status: 'waitlisted' }));
        await repo.create(enrollment({ userId: 'd', status: 'dropped' }));
        await repo.create(enrollment({ userId: 'e', sectionId: 's2' }));
        const counted = await repo.countActive('s1');
        // Whether staff take a seat is the host's choice; both are allowed, nothing else is.
        check(counted === 1 || counted === 2, `countActive(s1) should be 1 (students only) or 2 (everyone active), got ${counted}`);
      },
    },
  ];
  cases.push(
    {
      name: 'createIfSeatFree (if implemented) creates below capacity and returns null when full',
      run: async () => {
        const repo = await make();
        if (!repo.createIfSeatFree) return;
        const first = await repo.createIfSeatFree(enrollment({ userId: 'a' }), 1);
        check(first !== null, 'the first enrollment into a one-seat section succeeds');
        checkEqual(await repo.createIfSeatFree(enrollment({ userId: 'b' }), 1), null, 'the second is refused');
        checkEqual(await repo.findByUserAndSection('b', 's1'), null, 'and nothing was stored for it');
      },
    },
    {
      name: 'createIfSeatFree (if implemented) is atomic: concurrent calls never overfill',
      run: async () => {
        const repo = await make();
        if (!repo.createIfSeatFree) return;
        const results = await Promise.all(
          ['a', 'b', 'c', 'd', 'e'].map((userId) => repo.createIfSeatFree!(enrollment({ userId }), 2)),
        );
        checkEqual(results.filter((r) => r !== null).length, 2, 'exactly two of five simultaneous calls get a seat');
        checkEqual(await repo.countActive('s1'), 2, 'and two are stored');
      },
    },
    {
      name: 'promoteIfSeatFree (if implemented) promotes a waitlisted enrollment only while there is room',
      run: async () => {
        const repo = await make();
        if (!repo.promoteIfSeatFree) return;
        const waiting = await repo.create(enrollment({ userId: 'w', status: 'waitlisted' }));
        await repo.create(enrollment({ userId: 'a' }));
        checkEqual(await repo.promoteIfSeatFree(waiting.id, 1), null, 'refused while the section is full');
        checkEqual((await repo.promoteIfSeatFree(waiting.id, 2))?.status, 'active', 'promoted once there is room');
        checkEqual(await repo.promoteIfSeatFree(waiting.id, 5), null, 'refused once it is no longer waitlisted');
      },
    },
    {
      name: 'promoteIfSeatFree (if implemented) is atomic: concurrent promotions never overfill',
      run: async () => {
        const repo = await make();
        if (!repo.promoteIfSeatFree) return;
        const waiting = await Promise.all(['a', 'b', 'c'].map((userId) => repo.create(enrollment({ userId, status: 'waitlisted' }))));
        const results = await Promise.all(waiting.map((w) => repo.promoteIfSeatFree!(w.id, 1)));
        checkEqual(results.filter((r) => r !== null).length, 1, 'exactly one of three simultaneous promotions wins');
      },
    },
  );
  return suite('EnrollmentRepository', cases);
}

export function contentRepositoryContract(make: RepositoryFactory<ContentRepository>): ContractCase[] {
  const node = (over: Partial<Omit<ContentNode, 'id' | 'version'>> = {}): Omit<ContentNode, 'id' | 'version'> => ({
    sectionId: 's1',
    kind: 'page',
    title: 'Week 1',
    orderIndex: 0,
    published: false,
    ...over,
  });
  return suite('ContentRepository', [
    {
      name: 'create assigns an id and version 1',
      run: async () => {
        const repo = await make();
        const created = await repo.create(node());
        checkEqual(created.version, 1, 'a new node is version 1');
        checkEqual(await repo.findById(created.id), created, 'findById returns it');
        checkEqual(await repo.findById('nope'), null, 'findById of an unknown id');
      },
    },
    {
      name: 'update merges the patch',
      run: async () => {
        const repo = await make();
        const created = await repo.create(node());
        const updated = await repo.update(created.id, { published: true, version: 2 });
        checkEqual(updated, { ...created, published: true, version: 2 }, 'the updated node');
      },
    },
    {
      name: "listBySection returns that section's nodes only",
      run: async () => {
        const repo = await make();
        const a = await repo.create(node({ title: 'a' }));
        const b = await repo.create(node({ title: 'b', orderIndex: 1 }));
        await repo.create(node({ sectionId: 's2' }));
        checkEqual(idsOf(await repo.listBySection('s1')), idsOf([a, b]), 'nodes of s1');
      },
    },
    {
      name: "reorder sets each node's orderIndex to its position in the list",
      run: async () => {
        const repo = await make();
        const a = await repo.create(node({ title: 'a', orderIndex: 0 }));
        const b = await repo.create(node({ title: 'b', orderIndex: 1 }));
        const c = await repo.create(node({ title: 'c', orderIndex: 2 }));
        await repo.reorder('s1', [c.id, a.id, b.id]);
        checkEqual((await repo.findById(c.id))?.orderIndex, 0, 'c first');
        checkEqual((await repo.findById(a.id))?.orderIndex, 1, 'a second');
        checkEqual((await repo.findById(b.id))?.orderIndex, 2, 'b third');
      },
    },
  ]);
}

export function enrollmentRequestRepositoryContract(make: RepositoryFactory<EnrollmentRequestRepository>): ContractCase[] {
  const request = (over: Partial<Omit<EnrollmentRequest, 'id'>> = {}): Omit<EnrollmentRequest, 'id'> => ({
    userId: 'u1',
    sectionId: 's1',
    status: 'pending',
    requestedAt: at('2026-08-01T09:00:00Z'),
    ...over,
  });
  return suite('EnrollmentRequestRepository', [
    {
      name: 'create, findById and update round-trip',
      run: async () => {
        const repo = await make();
        const created = await repo.create(request({ note: 'please' }));
        checkEqual(await repo.findById(created.id), created, 'findById');
        const updated = await repo.update(created.id, { status: 'withdrawn' });
        checkEqual(updated, { ...created, status: 'withdrawn' }, 'update');
        checkEqual(await repo.findById('nope'), null, 'unknown id');
      },
    },
    {
      name: 'findPending only returns a pending request of that person for that section',
      run: async () => {
        const repo = await make();
        const decided = await repo.create(request());
        await repo.update(decided.id, { status: 'rejected' });
        checkEqual(await repo.findPending('u1', 's1'), null, 'a decided request is not pending');
        const pending = await repo.create(request());
        checkEqual((await repo.findPending('u1', 's1'))?.id, pending.id, 'the pending one');
        checkEqual(await repo.findPending('u2', 's1'), null, "nobody else's");
      },
    },
    {
      name: 'listBySection (optionally by status) and listByUser',
      run: async () => {
        const repo = await make();
        const a = await repo.create(request({ userId: 'a' }));
        const b = await repo.create(request({ userId: 'b', status: 'accepted' }));
        const c = await repo.create(request({ userId: 'a', sectionId: 's2' }));
        checkEqual(idsOf(await repo.listBySection('s1')), idsOf([a, b]), 'all of s1');
        checkEqual(idsOf(await repo.listBySection('s1', 'pending')), [a.id], 'pending in s1');
        checkEqual(idsOf(await repo.listByUser('a')), idsOf([a, c]), "a's requests");
      },
    },
    {
      name: 'decideIfPending (if implemented) applies only while pending, and only once under concurrency',
      run: async () => {
        const repo = await make();
        if (!repo.decideIfPending) return;
        const created = await repo.create(request());
        const results = await Promise.all([
          repo.decideIfPending(created.id, { status: 'accepted', reviewerId: 'r1' }),
          repo.decideIfPending(created.id, { status: 'rejected', reviewerId: 'r2' }),
        ]);
        checkEqual(results.filter((r) => r !== null).length, 1, 'exactly one of two simultaneous decisions applies');
        checkEqual(await repo.decideIfPending('nope', { status: 'accepted' }), null, 'an unknown id');
      },
    },
  ]);
}

export function delegationRepositoryContract(make: RepositoryFactory<DelegationRepository>): ContractCase[] {
  const grant = (over: Partial<Omit<TaGrant, 'id'>> = {}): Omit<TaGrant, 'id'> => ({
    enrollmentId: 'enr-ta',
    sectionId: 's1',
    action: 'grading.record',
    grantedBy: 'instructor',
    grantedAt: at('2026-09-02T00:00:00Z'),
    ...over,
  });
  return suite('DelegationRepository', [
    {
      name: 'create and findById round-trip',
      run: async () => {
        const repo = await make();
        const created = await repo.create(grant());
        checkEqual(await repo.findById(created.id), created, 'findById');
        checkEqual(await repo.findById('nope'), null, 'unknown id');
      },
    },
    {
      name: 'listActiveForEnrollment leaves out revoked grants, and revoke keeps the record',
      run: async () => {
        const repo = await make();
        const keep = await repo.create(grant());
        const drop = await repo.create(grant({ action: 'content.manage' }));
        await repo.create(grant({ enrollmentId: 'enr-other' }));
        const revokedAt = at('2026-10-01T00:00:00Z');
        const revoked = await repo.revoke(drop.id, revokedAt);
        checkEqual(revoked.revokedAt, revokedAt, 'revoke sets revokedAt');
        checkEqual(idsOf(await repo.listActiveForEnrollment('enr-ta')), [keep.id], 'only the active grant');
        checkEqual((await repo.findById(drop.id))?.revokedAt, revokedAt, 'the revoked grant is still stored');
      },
    },
  ]);
}

export function guardianLinkRepositoryContract(make: RepositoryFactory<GuardianLinkManagementRepository>): ContractCase[] {
  const link = (over: Partial<Omit<GuardianLink, 'id'>> = {}): Omit<GuardianLink, 'id'> => ({
    guardianId: 'g1',
    wardId: 'w1',
    scopes: ['grades'],
    status: 'active',
    createdAt: at('2026-09-01T00:00:00Z'),
    ...over,
  });
  return suite('GuardianLinkRepository', [
    {
      name: 'create, findById and update round-trip',
      run: async () => {
        const repo = await make();
        const created = await repo.create(link());
        checkEqual(await repo.findById(created.id), created, 'findById');
        const updated = await repo.update(created.id, { scopes: ['grades', 'attendance'] });
        checkEqual(updated.scopes, ['grades', 'attendance'], 'update replaces the scopes');
        checkEqual(updated.guardianId, 'g1', 'and keeps the rest');
      },
    },
    {
      name: 'findActive ignores revoked links',
      run: async () => {
        const repo = await make();
        const created = await repo.create(link());
        checkEqual((await repo.findActive('g1', 'w1'))?.id, created.id, 'the active link');
        await repo.update(created.id, { status: 'revoked', revokedAt: at('2026-10-01') });
        checkEqual(await repo.findActive('g1', 'w1'), null, 'no active link after revoking');
        checkEqual(await repo.findActive('g1', 'w-other'), null, 'nothing for another ward');
      },
    },
    {
      name: 'listByWard and listByGuardian include revoked links',
      run: async () => {
        const repo = await make();
        const a = await repo.create(link());
        const b = await repo.create(link({ guardianId: 'g2', status: 'revoked' }));
        const c = await repo.create(link({ wardId: 'w2' }));
        checkEqual(idsOf(await repo.listByWard('w1')), idsOf([a, b]), 'links to w1');
        checkEqual(idsOf(await repo.listByGuardian('g1')), idsOf([a, c]), 'links from g1');
      },
    },
  ]);
}

export function groupRepositoryContract(make: RepositoryFactory<GroupRepository>): ContractCase[] {
  return suite('GroupRepository', [
    {
      name: 'create, findById, and listBySection with and without a group set',
      run: async () => {
        const repo = await make();
        const a = await repo.create({ sectionId: 's1', name: 'A', groupSet: 'labs', maxMembers: 3 });
        const b = await repo.create({ sectionId: 's1', name: 'B', groupSet: 'projects' });
        await repo.create({ sectionId: 's2', name: 'C' });
        checkEqual(await repo.findById(a.id), a, 'findById');
        checkEqual(idsOf(await repo.listBySection('s1')), idsOf([a, b]), 'all groups of s1');
        checkEqual(idsOf(await repo.listBySection('s1', 'labs')), [a.id], 'only the labs set');
      },
    },
    {
      name: 'members: add, find, list, remove (true once, then false)',
      run: async () => {
        const repo = await make();
        const g = await repo.create({ sectionId: 's1', name: 'A' });
        await repo.addMember({ groupId: g.id, userId: 'u1', joinedAt: at('2026-09-03') });
        await repo.addMember({ groupId: g.id, userId: 'u2', joinedAt: at('2026-09-03') });
        checkEqual((await repo.findMember(g.id, 'u1'))?.userId, 'u1', 'findMember');
        checkEqual((await repo.listMembers(g.id)).map((m) => m.userId).sort(), ['u1', 'u2'], 'listMembers');
        checkEqual(await repo.removeMember(g.id, 'u1'), true, 'removeMember of a member');
        checkEqual(await repo.removeMember(g.id, 'u1'), false, 'removeMember again');
        checkEqual(await repo.findMember(g.id, 'u1'), null, 'gone');
      },
    },
    {
      name: "listGroupsForUser returns the user's groups in that section only",
      run: async () => {
        const repo = await make();
        const a = await repo.create({ sectionId: 's1', name: 'A' });
        const b = await repo.create({ sectionId: 's1', name: 'B' });
        const c = await repo.create({ sectionId: 's2', name: 'C' });
        for (const g of [a, c]) await repo.addMember({ groupId: g.id, userId: 'u1', joinedAt: at('2026-09-03') });
        await repo.addMember({ groupId: b.id, userId: 'u2', joinedAt: at('2026-09-03') });
        checkEqual(idsOf(await repo.listGroupsForUser('s1', 'u1')), [a.id], "u1's groups in s1");
      },
    },
    {
      name: 'delete returns true once, then false, and the group is gone',
      run: async () => {
        const repo = await make();
        const g = await repo.create({ sectionId: 's1', name: 'A' });
        checkEqual(await repo.delete(g.id), true, 'first delete');
        checkEqual(await repo.delete(g.id), false, 'second delete');
        checkEqual(await repo.findById(g.id), null, 'findById after delete');
      },
    },
  ]);
}

export function coursePrerequisiteRepositoryContract(make: RepositoryFactory<CoursePrerequisiteRepository>): ContractCase[] {
  return suite('CoursePrerequisiteRepository', [
    {
      name: 'add, listByCourse and remove',
      run: async () => {
        const repo = await make();
        const p = await repo.add({ courseId: 'c2', requiredCourseId: 'c1', minGrade: 60 });
        const q = await repo.add({ courseId: 'c2', requiredCourseId: 'c0', isCorequisite: true });
        await repo.add({ courseId: 'c3', requiredCourseId: 'c2' });
        checkEqual(idsOf(await repo.listByCourse('c2')), idsOf([p, q]), 'prerequisites of c2');
        checkEqual((await repo.listByCourse('c2')).find((x) => x.id === p.id), p, 'stored as given');
        checkEqual(await repo.remove(p.id), true, 'remove');
        checkEqual(await repo.remove(p.id), false, 'remove again');
        checkEqual(idsOf(await repo.listByCourse('c2')), [q.id], 'one left');
      },
    },
  ]);
}

/** Every core contract at once, for a host that implements them all on one database. */
export interface CoreRepositoryFactories {
  users?: (seed: Identity[]) => Promise<UserRepository> | UserRepository;
  courses?: (seed: { courses: Course[]; sections: CourseSection[] }) => Promise<CourseRepository> | CourseRepository;
  terms?: (seed: AcademicTerm[]) => Promise<TermRepository> | TermRepository;
  organizations?: (seed: Organization[]) => Promise<OrganizationRepository> | OrganizationRepository;
  departments?: (seed: Department[]) => Promise<DepartmentRepository> | DepartmentRepository;
  enrollments?: RepositoryFactory<EnrollmentRepository>;
  content?: RepositoryFactory<ContentRepository>;
  enrollmentRequests?: RepositoryFactory<EnrollmentRequestRepository>;
  delegations?: RepositoryFactory<DelegationRepository>;
  guardianLinks?: RepositoryFactory<GuardianLinkManagementRepository>;
  groups?: RepositoryFactory<GroupRepository>;
  coursePrerequisites?: RepositoryFactory<CoursePrerequisiteRepository>;
}

/** The contracts for whichever core repositories you pass a factory for. */
export function coreRepositoryContracts(f: CoreRepositoryFactories): ContractCase[] {
  return [
    ...(f.users ? userRepositoryContract(f.users) : []),
    ...(f.courses ? courseRepositoryContract(f.courses) : []),
    ...(f.terms ? termRepositoryContract(f.terms) : []),
    ...(f.organizations ? organizationRepositoryContract(f.organizations) : []),
    ...(f.departments ? departmentRepositoryContract(f.departments) : []),
    ...(f.enrollments ? enrollmentRepositoryContract(f.enrollments) : []),
    ...(f.content ? contentRepositoryContract(f.content) : []),
    ...(f.enrollmentRequests ? enrollmentRequestRepositoryContract(f.enrollmentRequests) : []),
    ...(f.delegations ? delegationRepositoryContract(f.delegations) : []),
    ...(f.guardianLinks ? guardianLinkRepositoryContract(f.guardianLinks) : []),
    ...(f.groups ? groupRepositoryContract(f.groups) : []),
    ...(f.coursePrerequisites ? coursePrerequisiteRepositoryContract(f.coursePrerequisites) : []),
  ];
}
