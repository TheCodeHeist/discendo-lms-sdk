import { describe, it, expect } from 'bun:test';
import { GuardianService } from '../src/domains/guardians/index.js';
import { createRolePolicy, EventBus } from '../src/core/index.js';
import type {
  GuardianLink,
  GuardianLinkManagementRepository,
  Identity,
  PermissionPolicy,
  RepositoryContext,
  Role,
  LmsEvent,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const sleep = () => new Promise((r) => setTimeout(r, 0));

function buildWorld(opts: { noBus?: boolean } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId?: string) =>
    users.set(id, { id, roles, ...(orgId ? { orgId } : {}) });
  add('root', ['admin'], 'org-a');
  add('parent', ['student'], 'org-a');
  add('ward', ['student'], 'org-a');

  const links = new Map<string, GuardianLink>();
  let ln = 0;
  const guardianLinks: GuardianLinkManagementRepository = {
    create: async (l) => {
      const entry: GuardianLink = { ...l, id: `link-${++ln}` };
      links.set(entry.id, entry);
      return entry;
    },
    update: async (id, patch) => {
      const existing = links.get(id);
      if (!existing) throw new Error('not found');
      const updated = { ...existing, ...patch };
      links.set(id, updated);
      return updated;
    },
    findById: async (id) => links.get(id) ?? null,
    findActive: async (guardianId, wardId) =>
      [...links.values()].find((l) => l.guardianId === guardianId && l.wardId === wardId && l.status === 'active') ?? null,
    listByGuardian: async (guardianId) =>
      [...links.values()].filter((l) => l.guardianId === guardianId),
    listByWard: async (wardId) =>
      [...links.values()].filter((l) => l.wardId === wardId),
  };

  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'> & { guardianLinks: GuardianLinkManagementRepository } = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: { findCourse: async () => null, findSection: async () => null, listSections: async () => [] },
    enrollments: {
      create: async (e) => ({ ...e, id: 'e1' }),
      update: async (id, patch) => ({ id, userId: 'u', sectionId: 's', role: 'student', status: 'active', enrolledAt: new Date(), ...patch }),
      findById: async () => null,
      findByUserAndSection: async () => null,
      listBySection: async () => [],
      countActive: async () => 0,
    },
    guardianLinks,
  };

  const policy = createRolePolicy();
  const bus = opts.noBus ? undefined : new EventBus();
  const events: LmsEvent[] = [];
  if (bus) {
    bus.on('*', (e) => events.push(e));
  }

  const service = new GuardianService(repos, { policy, events: bus });
  return { service, events, links };
}

describe('GuardianService event emission', () => {
  it('emits guardians.linkCreated when a link is created', async () => {
    const { service, events } = buildWorld();
    const link = await service.createLink('parent', 'ward', ['grades', 'attendance'], as('root'));
    await sleep();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'guardians.linkCreated',
      linkId: link.id,
      guardianId: 'parent',
      wardId: 'ward',
      scopes: ['grades', 'attendance'],
      orgId: 'org-a',
    });
  });

  it('emits guardians.scopesUpdated when scopes are updated', async () => {
    const { service, events } = buildWorld();
    const link = await service.createLink('parent', 'ward', ['grades'], as('root'));
    await sleep();
    expect(events).toHaveLength(1);

    await service.updateScopes(link.id, ['grades', 'schedule'], as('root'));
    await sleep();

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'guardians.scopesUpdated',
      linkId: link.id,
      guardianId: 'parent',
      wardId: 'ward',
      scopes: ['grades', 'schedule'],
      orgId: 'org-a',
    });
  });

  it('emits guardians.linkRevoked when an active link is revoked', async () => {
    const { service, events } = buildWorld();
    const link = await service.createLink('parent', 'ward', ['grades'], as('root'));
    await sleep();
    expect(events).toHaveLength(1);

    await service.revokeLink(link.id, as('root'));
    await sleep();

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'guardians.linkRevoked',
      linkId: link.id,
      guardianId: 'parent',
      wardId: 'ward',
      orgId: 'org-a',
    });
  });

  it('does not emit guardians.linkRevoked when revoking an already revoked link', async () => {
    const { service, events } = buildWorld();
    const link = await service.createLink('parent', 'ward', ['grades'], as('root'));
    await service.revokeLink(link.id, as('root'));
    await sleep();
    expect(events).toHaveLength(2);

    await service.revokeLink(link.id, as('root'));
    await sleep();
    expect(events).toHaveLength(2); // no duplicate event
  });

  it('works with no EventBus configured', async () => {
    const { service } = buildWorld({ noBus: true });
    const link = await service.createLink('parent', 'ward', ['grades'], as('root'));
    expect(link.id).toBeDefined();
    const updated = await service.updateScopes(link.id, ['grades', 'schedule'], as('root'));
    expect(updated.scopes).toEqual(['grades', 'schedule']);
    const revoked = await service.revokeLink(link.id, as('root'));
    expect(revoked.status).toBe('revoked');
  });
});
