import { describe, it, expect } from 'bun:test';
import { DelegationService } from '../src/domains/delegation/index.js';
import { createRolePolicy, EventBus } from '../src/core/index.js';
import type {
  Enrollment,
  Identity,
  PermissionPolicy,
  RepositoryContext,
  Role,
  TaGrant,
  LmsEvent,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const sleep = () => new Promise((r) => setTimeout(r, 0));

async function buildWorld(opts: { noBus?: boolean } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  add('teacher', ['instructor']);
  add('ta', ['ta']);
  add('root', ['admin']);

  const enrollments: Enrollment[] = [];
  let en = 0;
  const repos: RepositoryContext = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : null),
      findSection: async (id) => (id === 'sec-1' ? { id, courseId: 'course-a', status: 'published' as const } : null),
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => {
        const entry: Enrollment = { ...e, id: `enr-${++en}` };
        enrollments.push(entry);
        return entry;
      },
      findById: async (id) => enrollments.find((e) => e.id === id) ?? null,
      update: async (id, patch) => {
        const i = enrollments.findIndex((e) => e.id === id);
        enrollments[i] = { ...enrollments[i]!, ...patch };
        return enrollments[i]!;
      },
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments].reverse().find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => enrollments.filter((e) => e.sectionId === sectionId),
      countActive: async () => 0,
    },
    content: {
      findById: async () => null,
      listBySection: async () => [],
      create: async (x) => ({ ...x, id: 'c', version: 1 }),
      update: async (id, patch) => ({ id, sectionId: 's', kind: 'page', title: '', orderIndex: 0, published: false, version: 1, ...patch }),
      reorder: async () => {},
    },
    terms: { findById: async () => null },
  };

  await repos.enrollments.create({ userId: 'teacher', sectionId: 'sec-1', role: 'instructor', status: 'active', enrolledAt: new Date() });
  const taEnrollment = await repos.enrollments.create({ userId: 'ta', sectionId: 'sec-1', role: 'ta', status: 'active', enrolledAt: new Date() });

  const grants: TaGrant[] = [];
  let gn = 0;
  const delegations = {
    create: async (g: Omit<TaGrant, 'id'>) => {
      const grant: TaGrant = { ...g, id: `grant-${++gn}` };
      grants.push(grant);
      return grant;
    },
    findById: async (id: string) => grants.find((g) => g.id === id) ?? null,
    listActiveForEnrollment: async (enrollmentId: string) =>
      grants.filter((g) => g.enrollmentId === enrollmentId && g.revokedAt === undefined),
    revoke: async (id: string, at: Date) => {
      const i = grants.findIndex((g) => g.id === id);
      grants[i] = { ...grants[i]!, revokedAt: at };
      return grants[i]!;
    },
  };

  const policy = createRolePolicy();
  const bus = opts.noBus ? undefined : new EventBus();
  const events: LmsEvent[] = [];
  if (bus) {
    bus.on('*', (e) => events.push(e));
  }

  const service = new DelegationService(
    { ...repos, delegations },
    { policy, delegableActions: ['grading.grantExtension', 'content.manage'], events: bus },
  );

  return { service, events, taEnrollment, grants };
}

describe('DelegationService event emission', () => {
  it('emits delegation.granted when a new grant is created', async () => {
    const { service, events, taEnrollment } = await buildWorld();
    const grant = await service.grant('sec-1', 'ta', 'grading.grantExtension', as('teacher'));
    await sleep();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'delegation.granted',
      grantId: grant.id,
      enrollmentId: taEnrollment.id,
      sectionId: 'sec-1',
      action: 'grading.grantExtension',
      grantedBy: 'teacher',
      orgId: 'org-a',
    });
  });

  it('does not emit delegation.granted when returning an existing identical active grant', async () => {
    const { service, events } = await buildWorld();
    await service.grant('sec-1', 'ta', 'grading.grantExtension', as('teacher'));
    await sleep();
    expect(events).toHaveLength(1);

    await service.grant('sec-1', 'ta', 'grading.grantExtension', as('teacher'));
    await sleep();
    expect(events).toHaveLength(1); // idempotent, no new event
  });

  it('emits delegation.revoked when an active grant is revoked', async () => {
    const { service, events, taEnrollment } = await buildWorld();
    const grant = await service.grant('sec-1', 'ta', 'grading.grantExtension', as('teacher'));
    await sleep();
    expect(events).toHaveLength(1);

    await service.revoke(grant.id, as('teacher'));
    await sleep();

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'delegation.revoked',
      grantId: grant.id,
      enrollmentId: taEnrollment.id,
      sectionId: 'sec-1',
      action: 'grading.grantExtension',
      revokedBy: 'teacher',
      orgId: 'org-a',
    });
  });

  it('does not emit delegation.revoked when revoking an already revoked grant', async () => {
    const { service, events } = await buildWorld();
    const grant = await service.grant('sec-1', 'ta', 'grading.grantExtension', as('teacher'));
    await service.revoke(grant.id, as('teacher'));
    await sleep();
    expect(events).toHaveLength(2);

    await service.revoke(grant.id, as('teacher'));
    await sleep();
    expect(events).toHaveLength(2); // no redundant event
  });

  it('works smoothly with no EventBus configured', async () => {
    const { service } = await buildWorld({ noBus: true });
    const grant = await service.grant('sec-1', 'ta', 'grading.grantExtension', as('teacher'));
    expect(grant.id).toBeDefined();
    const revoked = await service.revoke(grant.id, as('teacher'));
    expect(revoked.revokedAt).toBeDefined();
  });
});
