import { describe, it, expect } from 'bun:test';
import {
  authorizeWithinOwnOrg,
  assertInActorOrg,
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
} from '../src/core/index.js';
import type { Identity, PermissionContext, PermissionPolicy } from '../src/core/index.js';

const people: Identity[] = [
  { id: 'root', roles: ['admin'], orgId: 'org-a' },
  { id: 'free', roles: ['admin'] },
  { id: 'stu', roles: ['student'], orgId: 'org-a' },
];
const repos = { users: { findById: async (id: string) => people.find((p) => p.id === id) ?? null, findByExternalRef: async () => null } };
const as = (actorId: string) => ({ actorId });

describe('authorizeWithinOwnOrg (an action that belongs to no section)', () => {
  it('requires an actor, and refuses an unknown one', async () => {
    const policy = createRolePolicy();
    await expect(authorizeWithinOwnOrg(policy, repos, 'guardian.manageLinks', undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(authorizeWithinOwnOrg(policy, repos, 'guardian.manageLinks', as('ghost'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('takes the roles and the organization from the stored person, never from the caller', async () => {
    const seen: PermissionContext[] = [];
    const policy: PermissionPolicy = { can: (_a, ctx) => (seen.push(ctx), true) };
    await authorizeWithinOwnOrg(policy, repos, 'x.y', { actorId: 'root', roles: ['student'], orgId: 'org-z' } as never);
    expect(seen[0]!.actor).toMatchObject({ id: 'root', roles: ['admin'], orgId: 'org-a' });
    expect(seen[0]!.resourceOrgId).toBe('org-a');
    expect(seen[0]!.section).toBeUndefined();
    expect(seen[0]!.guardian).toBeUndefined();
  });

  it('passes the owner through, for the "own records" rule', async () => {
    const seen: PermissionContext[] = [];
    const policy: PermissionPolicy = { can: (_a, ctx) => (seen.push(ctx), true) };
    await authorizeWithinOwnOrg(policy, repos, 'x.y', as('stu'), { ownerId: 'stu' });
    expect(seen[0]!.resourceOwnerId).toBe('stu');
  });

  it('lets the policy refuse, and throws when it throws', async () => {
    const deny: PermissionPolicy = { can: () => false };
    await expect(authorizeWithinOwnOrg(deny, repos, 'x.y', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const boom: PermissionPolicy = { can: () => { throw new Error('policy bug'); } };
    await expect(authorizeWithinOwnOrg(boom, repos, 'x.y', as('root'))).rejects.toThrow('policy bug');
  });

  it('returns the authorized person, so the caller can compare organizations', async () => {
    const auth = await authorizeWithinOwnOrg(createRolePolicy(), repos, 'guardian.manageLinks', as('root'));
    expect(auth.ctx.actor.id).toBe('root');
  });
});

describe('assertInActorOrg', () => {
  it('passes only for the actor\'s own organization, and "no organization" matches only "no organization"', async () => {
    const a = await authorizeWithinOwnOrg(createRolePolicy(), repos, 'guardian.manageLinks', as('root'));
    const f = await authorizeWithinOwnOrg(createRolePolicy(), repos, 'guardian.manageLinks', as('free'));
    expect(() => assertInActorOrg(a, 'org-a', 'guardian.manageLinks')).not.toThrow();
    expect(() => assertInActorOrg(a, 'org-b', 'guardian.manageLinks')).toThrow(PermissionDeniedError);
    expect(() => assertInActorOrg(a, undefined, 'guardian.manageLinks')).toThrow(PermissionDeniedError);
    expect(() => assertInActorOrg(f, undefined, 'guardian.manageLinks')).not.toThrow();
    expect(() => assertInActorOrg(f, 'org-a', 'guardian.manageLinks')).toThrow(PermissionDeniedError);
  });
});
