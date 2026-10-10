import { describe, it, expect } from 'bun:test';
import {
  GroupService,
  GroupNotFoundError,
  GroupFullError,
  AlreadyInGroupError,
  SelfSignupNotAllowedError,
} from '../src/domains/enrollment/index.js';
import type {
  SectionGroup,
  GroupMember,
  GroupRepository,
  CourseSection,
  Course,
  Enrollment,
  Identity,
  RepositoryContext,
  ActorContext,
} from '../src/core/index.js';
import {
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
} from '../src/core/index.js';

const as = (actorId: string): ActorContext => ({ actorId });

describe('GroupService (without enforcement)', () => {
  function buildService() {
    const groupsStore: SectionGroup[] = [];
    const membersStore: GroupMember[] = [];

    const groupRepo: GroupRepository = {
      create: async (g) => {
        const created: SectionGroup = { ...g, id: `grp-${groupsStore.length + 1}` };
        groupsStore.push(created);
        return created;
      },
      findById: async (id) => groupsStore.find((g) => g.id === id) ?? null,
      listBySection: async (secId, groupSet) =>
        groupsStore.filter((g) => g.sectionId === secId && (!groupSet || g.groupSet === groupSet)),
      delete: async (id) => {
        const idx = groupsStore.findIndex((g) => g.id === id);
        if (idx >= 0) {
          groupsStore.splice(idx, 1);
          return true;
        }
        return false;
      },
      addMember: async (m) => {
        const created: GroupMember = { ...m, id: `gm-${membersStore.length + 1}` };
        membersStore.push(created);
        return created;
      },
      removeMember: async (groupId, userId) => {
        const idx = membersStore.findIndex((m) => m.groupId === groupId && m.userId === userId);
        if (idx >= 0) {
          membersStore.splice(idx, 1);
          return true;
        }
        return false;
      },
      listMembers: async (groupId) => membersStore.filter((m) => m.groupId === groupId),
      findMember: async (groupId, userId) =>
        membersStore.find((m) => m.groupId === groupId && m.userId === userId) ?? null,
      listGroupsForUser: async (sectionId, userId) => {
        const userGroupIds = membersStore.filter((m) => m.userId === userId).map((m) => m.groupId);
        return groupsStore.filter((g) => g.sectionId === sectionId && userGroupIds.includes(g.id));
      },
    };

    const repos: RepositoryContext = {
      groups: groupRepo,
      users: { findById: async () => null, findByExternalRef: async () => null },
      courses: { findCourse: async () => null, findSection: async () => null, listSections: async () => [] },
      enrollments: {
        create: async () => ({} as never),
        findById: async () => null,
        update: async () => ({} as never),
        findByUserAndSection: async () => null,
        listBySection: async () => [],
        countActive: async () => 0,
      },
      content: { findById: async () => null, listBySection: async () => [], create: async () => ({} as never), update: async () => ({} as never), reorder: async () => {} },
      terms: { findById: async () => null },
    };

    const service = new GroupService(repos);
    return { service, groupsStore, membersStore };
  }

  it('creates and finds groups', async () => {
    const { service } = buildService();
    const grp = await service.createGroup('sec-1', 'Team Alpha', {
      maxMembers: 3,
      groupSet: 'Project',
    });

    expect(grp.id).toBe('grp-1');
    expect(grp.name).toBe('Team Alpha');
    expect(grp.maxMembers).toBe(3);
    expect(grp.groupSet).toBe('Project');

    const found = await service.findGroup('grp-1');
    expect(found).toEqual(grp);
  });

  it('lists groups by section and groupSet', async () => {
    const { service } = buildService();
    await service.createGroup('sec-1', 'Team Alpha', { groupSet: 'Project' });
    await service.createGroup('sec-1', 'Lab Pair 1', { groupSet: 'Labs' });
    await service.createGroup('sec-2', 'Other Sec', { groupSet: 'Project' });

    const allInSec1 = await service.listGroups('sec-1');
    expect(allInSec1).toHaveLength(2);

    const projectInSec1 = await service.listGroups('sec-1', { groupSet: 'Project' });
    expect(projectInSec1).toHaveLength(1);
    expect(projectInSec1[0]!.name).toBe('Team Alpha');
  });

  it('deletes a group', async () => {
    const { service } = buildService();
    await service.createGroup('sec-1', 'Team Alpha');
    expect(await service.deleteGroup('grp-1')).toBe(true);
    expect(await service.findGroup('grp-1')).toBeNull();
  });

  it('adds and removes members respecting capacity and uniqueness', async () => {
    const { service } = buildService();
    await service.createGroup('sec-1', 'Team Alpha', { maxMembers: 2 });

    const m1 = await service.addMember('grp-1', 'u-1');
    expect(m1.userId).toBe('u-1');
    expect(m1.groupId).toBe('grp-1');

    // Duplicate member refused
    await expect(service.addMember('grp-1', 'u-1')).rejects.toThrow(AlreadyInGroupError);

    // Second member allowed
    await service.addMember('grp-1', 'u-2');

    // Capacity reached
    await expect(service.addMember('grp-1', 'u-3')).rejects.toThrow(GroupFullError);

    // List members
    const members = await service.listMembers('grp-1');
    expect(members).toHaveLength(2);

    // Remove member frees a seat
    expect(await service.removeMember('grp-1', 'u-1')).toBe(true);
    expect(await service.listMembers('grp-1')).toHaveLength(1);

    // Now u-3 can be added
    await expect(service.addMember('grp-1', 'u-3')).resolves.toBeDefined();
  });

  it('allows self-signup when allowSelfSignup is true', async () => {
    const { service } = buildService();
    await service.createGroup('sec-1', 'Open Group', { maxMembers: 2, allowSelfSignup: true });
    await service.createGroup('sec-1', 'Closed Group', { allowSelfSignup: false });

    // Self-join open group
    const joined = await service.joinGroup('grp-1', 'student-1');
    expect(joined.userId).toBe('student-1');

    // Self-leave open group
    expect(await service.leaveGroup('grp-1', 'student-1')).toBe(true);

    // Self-join closed group refused
    await expect(service.joinGroup('grp-2', 'student-1')).rejects.toThrow(SelfSignupNotAllowedError);
  });
});

describe('GroupService (with permission enforcement)', () => {
  function buildEnforcedWorld() {
    const users = new Map<string, Identity>([
      ['admin-1', { id: 'admin-1', roles: ['admin'], orgId: 'org-1' }],
      ['inst-1', { id: 'inst-1', roles: ['instructor'], orgId: 'org-1' }],
      ['ta-1', { id: 'ta-1', roles: ['ta'], orgId: 'org-1' }],
      ['student-1', { id: 'student-1', roles: ['student'], orgId: 'org-1' }],
      ['student-2', { id: 'student-2', roles: ['student'], orgId: 'org-1' }],
      ['outsider-student', { id: 'outsider-student', roles: ['student'], orgId: 'org-1' }],
    ]);

    const section: CourseSection = { id: 'sec-1', courseId: 'crs-1', status: 'published' };
    const course: Course = { id: 'crs-1', title: 'Course 1', orgId: 'org-1' };

    const enrollments: Enrollment[] = [
      { id: 'e1', userId: 'inst-1', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() },
      { id: 'e2', userId: 'ta-1', sectionId: 'sec-1', role: 'ta', status: 'active', enrolledAt: new Date() },
      { id: 'e3', userId: 'student-1', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
      { id: 'e4', userId: 'student-2', sectionId: 'sec-1', role: 'student', status: 'active', enrolledAt: new Date() },
    ];

    const groupsStore: SectionGroup[] = [
      { id: 'grp-1', sectionId: 'sec-1', name: 'Open Group', allowSelfSignup: true, maxMembers: 2 },
    ];
    const membersStore: GroupMember[] = [];

    const groupRepo: GroupRepository = {
      create: async (g) => {
        const created: SectionGroup = { ...g, id: `grp-${groupsStore.length + 1}` };
        groupsStore.push(created);
        return created;
      },
      findById: async (id) => groupsStore.find((g) => g.id === id) ?? null,
      listBySection: async (secId, groupSet) =>
        groupsStore.filter((g) => g.sectionId === secId && (!groupSet || g.groupSet === groupSet)),
      delete: async (id) => {
        const idx = groupsStore.findIndex((g) => g.id === id);
        if (idx >= 0) {
          groupsStore.splice(idx, 1);
          return true;
        }
        return false;
      },
      addMember: async (m) => {
        const created: GroupMember = { ...m, id: `gm-${membersStore.length + 1}` };
        membersStore.push(created);
        return created;
      },
      removeMember: async (groupId, userId) => {
        const idx = membersStore.findIndex((m) => m.groupId === groupId && m.userId === userId);
        if (idx >= 0) {
          membersStore.splice(idx, 1);
          return true;
        }
        return false;
      },
      listMembers: async (groupId) => membersStore.filter((m) => m.groupId === groupId),
      findMember: async (groupId, userId) =>
        membersStore.find((m) => m.groupId === groupId && m.userId === userId) ?? null,
      listGroupsForUser: async (sectionId, userId) => {
        const userGroupIds = membersStore.filter((m) => m.userId === userId).map((m) => m.groupId);
        return groupsStore.filter((g) => g.sectionId === sectionId && userGroupIds.includes(g.id));
      },
    };

    const repos: RepositoryContext = {
      groups: groupRepo,
      users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
      courses: {
        findCourse: async (id) => (id === 'crs-1' ? course : null),
        findSection: async (id) => (id === 'sec-1' ? section : null),
        listSections: async () => [section],
      },
      enrollments: {
        create: async () => ({} as never),
        findById: async () => null,
        update: async () => ({} as never),
        findByUserAndSection: async (u, s) => enrollments.find((e) => e.userId === u && e.sectionId === s) ?? null,
        listBySection: async () => enrollments,
        countActive: async () => enrollments.length,
      },
      content: { findById: async () => null, listBySection: async () => [], create: async () => ({} as never), update: async () => ({} as never), reorder: async () => {} },
      terms: { findById: async () => null },
    };

    const service = new GroupService(repos, { policy: createRolePolicy() });
    return { service, groupsStore, membersStore };
  }

  it('requires an actor on every enforced call', async () => {
    const { service } = buildEnforcedWorld();
    await expect(service.createGroup('sec-1', 'Team')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'enrollment.manageGroups',
    });
    await expect(service.deleteGroup('grp-1')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'enrollment.manageGroups',
    });
    await expect(service.addMember('grp-1', 'student-1')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'enrollment.manageGroups',
    });
    await expect(service.joinGroup('grp-1', 'student-1')).rejects.toMatchObject({
      name: 'ActorRequiredError',
      action: 'content.view',
    });
  });

  it('allows admin and instructor to manage groups, refusing TA and student', async () => {
    const { service } = buildEnforcedWorld();
    await expect(service.createGroup('sec-1', 'Team Staff', {}, as('inst-1'))).resolves.toBeDefined();
    await expect(service.createGroup('sec-1', 'Team Admin', {}, as('admin-1'))).resolves.toBeDefined();

    await expect(service.createGroup('sec-1', 'Team TA', {}, as('ta-1'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'enrollment.manageGroups',
    });
    await expect(service.createGroup('sec-1', 'Team Student', {}, as('student-1'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'enrollment.manageGroups',
    });
  });

  it('refuses adding a user who is not an active student in the section', async () => {
    const { service } = buildEnforcedWorld();
    // outsider-student is not enrolled in sec-1
    await expect(service.addMember('grp-1', 'outsider-student', as('inst-1'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'enrollment.manageGroups',
    });
  });

  it('allows active student to self-join open group, but refuses joining on behalf of another student', async () => {
    const { service } = buildEnforcedWorld();
    // student-1 joins themselves
    await expect(service.joinGroup('grp-1', 'student-1', as('student-1'))).resolves.toBeDefined();

    // student-1 tries to join student-2
    await expect(service.joinGroup('grp-1', 'student-2', as('student-1'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: 'content.view',
    });
  });
});
