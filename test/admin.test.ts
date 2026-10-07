import { describe, it, expect } from 'bun:test';
import { AdminService, withAudit, diffObjects, AuditWriteFailedError } from '../src/services/admin/index.js';
import type { AuditEntry, AuditRepository } from '../src/services/admin/index.js';
import { createRolePolicy, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
import type { Identity, PermissionContext, PermissionPolicy, Role } from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });

/**
 * org-a: root (admin), teacher (instructor), ta, stu. org-b: root-b (admin). No organization:
 * root-free (admin). The audit store starts with one entry per organization about the same target,
 * and one with no organization (written before organizations existed).
 */
function buildWorld(opts: { policy?: PermissionPolicy; enforce?: boolean; failAppend?: boolean; entries?: Array<Omit<AuditEntry, 'id'>> } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId?: string) => users.set(id, { id, roles, ...(orgId ? { orgId } : {}) });
  add('root', ['admin'], 'org-a');
  add('teacher', ['instructor'], 'org-a');
  add('ta', ['ta'], 'org-a');
  add('stu', ['student'], 'org-a');
  add('root-b', ['admin'], 'org-b');
  add('root-free', ['admin']);

  const T = (n: number) => new Date(Date.UTC(2026, 9, n));
  const stored: AuditEntry[] = [];
  let seq = 0;
  const calls = { append: 0, list: 0, userLookups: 0 };
  const audit: AuditRepository = {
    append: async (e) => {
      calls.append++;
      if (opts.failAppend) throw new Error('database down');
      const row = { ...e, id: `audit-${++seq}` };
      stored.push(row);
      return row;
    },
    listForTarget: async (targetId) => (calls.list++, stored.filter((e) => e.targetId === targetId)),
  };
  for (const e of opts.entries ?? [
    { actorId: 'teacher', orgId: 'org-a', action: 'grade.record', targetId: 'sub-1', timestamp: T(1) },
    { actorId: 'teacher', orgId: 'org-a', action: 'grade.record', targetId: 'sub-1', timestamp: T(2), outcome: 'denied' as const },
    { actorId: 'someone', orgId: 'org-b', action: 'grade.record', targetId: 'sub-1', timestamp: T(3) },
    { actorId: 'old', action: 'grade.record', targetId: 'sub-1', timestamp: T(4) },
  ]) {
    stored.push({ ...e, id: `audit-${++seq}` });
  }

  const repos = { users: { findById: async (id: string) => (calls.userLookups++, users.get(id) ?? null), findByExternalRef: async () => null } };
  const policy = opts.policy ?? createRolePolicy();
  const service = new AdminService(audit, opts.enforce === false ? {} : { enforcement: { policy, repos } });
  return { service, audit, stored, calls };
}

const spyPolicy = () => {
  const seen: Array<{ action: string; ctx: PermissionContext }> = [];
  const policy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
  return { seen, policy };
};

describe('withAudit', () => {
  it('runs the call, then writes who did what to what, and returns the call\'s result', async () => {
    const w = buildWorld({ entries: [] });
    const order: string[] = [];
    const result = await withAudit(
      { append: async (e) => (order.push('append'), w.audit.append(e)), listForTarget: w.audit.listForTarget },
      'grade.record', 'sub-1', 'teacher', async () => (order.push('fn'), 42),
    );
    expect(result).toBe(42);
    expect(order).toEqual(['fn', 'append']);
    expect(w.stored).toHaveLength(1);
    expect(w.stored[0]).toMatchObject({ actorId: 'teacher', action: 'grade.record', targetId: 'sub-1' });
    expect(w.stored[0]!.timestamp).toBeInstanceOf(Date);
    expect('diff' in w.stored[0]!).toBe(false);
    expect('orgId' in w.stored[0]!).toBe(false);
  });

  it('records only successes: a call that throws leaves no entry, and its error is the caller\'s', async () => {
    const w = buildWorld({ entries: [] });
    const boom = new Error('nope');
    await expect(withAudit(w.audit, 'x', 't', 'a', async () => { throw boom; })).rejects.toBe(boom);
    expect(w.stored).toEqual([]);
  });

  it('makes noise when the entry cannot be written, and says the action DID happen and hands back its result', async () => {
    const w = buildWorld({ entries: [], failAppend: true });
    let happened = false;
    const err = await withAudit(w.audit, 'x', 't', 'a', async () => { happened = true; return 'done'; }).catch((e: unknown) => e);
    expect(happened).toBe(true);
    expect(err).toBeInstanceOf(AuditWriteFailedError);
    expect(err).toBeInstanceOf(Error);
    const failure = err as AuditWriteFailedError;
    expect(failure.completed).toBe(true);
    expect(failure.result).toBe('done');
    expect((failure.cause as Error).message).toBe('database down');
    expect(failure.message).toContain('audit');
  });
});

describe('AdminService.history with enforcement', () => {
  it('gives an admin their own organization\'s entries for the target, refusals included, and no one else\'s', async () => {
    const w = buildWorld();
    const entries = await w.service.history('sub-1', as('root'));
    expect(entries.map((e) => [e.actorId, e.outcome])).toEqual([['teacher', undefined], ['teacher', 'denied']]);
  });

  it('keeps the organizations apart in both directions, and "no organization" matches only "no organization"', async () => {
    const w = buildWorld();
    expect((await w.service.history('sub-1', as('root-b'))).map((e) => e.actorId)).toEqual(['someone']);
    expect((await w.service.history('sub-1', as('root-free'))).map((e) => e.actorId)).toEqual(['old']);
  });

  it('gives nothing about a target that belongs to someone else, and does not say whether it exists', async () => {
    const w = buildWorld();
    expect(await w.service.history('sub-9', as('root'))).toEqual([]);
    const w2 = buildWorld({ entries: [{ actorId: 'someone', orgId: 'org-b', action: 'a', targetId: 'secret', timestamp: new Date() }] });
    expect(await w2.service.history('secret', as('root'))).toEqual([]);
    expect(await w2.service.history('does-not-exist', as('root'))).toEqual([]);
  });

  it.each(['teacher', 'ta', 'stu', 'nobody'])('refuses %s, and reads nothing', async (who) => {
    const w = buildWorld();
    await expect(w.service.history('sub-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.list).toBe(0);
  });

  it('requires an actor, and reads nothing without one', async () => {
    const w = buildWorld();
    await expect(w.service.history('sub-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.list).toBe(0);
  });

  it('ignores an entry the repository returns for some other target', async () => {
    const w = buildWorld();
    w.audit.listForTarget = async () => [...w.stored, { id: 'x', actorId: 'a', orgId: 'org-a', action: 'a', targetId: 'other', timestamp: new Date() }];
    const entries = await w.service.history('sub-1', as('root'));
    expect(entries.every((e) => e.targetId === 'sub-1')).toBe(true);
  });

  it('asks the policy about admin.viewAuditLog, in the actor\'s organization, with no section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.history('sub-1', as('root')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['admin.viewAuditLog']);
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section).toBeUndefined();
  });

  it('is not made available by a delegation or by being an instructor of anything', async () => {
    const w = buildWorld();
    await expect(w.service.history('sub-1', { actorId: 'teacher', roles: ['admin'] } as never)).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('AdminService.audited', () => {
  it('runs the call, then records it as the real actor in the actor\'s real organization, and returns the result', async () => {
    const w = buildWorld({ entries: [] });
    const result = await w.service.audited('grade.record', 'sub-1', as('teacher'), async () => 'ok');
    expect(result).toBe('ok');
    expect(w.stored).toHaveLength(1);
    expect(w.stored[0]).toMatchObject({ actorId: 'teacher', orgId: 'org-a', action: 'grade.record', targetId: 'sub-1' });
    expect(w.stored[0]!.timestamp).toBeInstanceOf(Date);
    expect('outcome' in w.stored[0]!).toBe(false);
  });

  it('takes the organization from the stored account, never from what the caller says', async () => {
    const w = buildWorld({ entries: [] });
    await w.service.audited('x', 't', { actorId: 'teacher', orgId: 'org-b', roles: ['admin'] } as never, async () => 1);
    expect(w.stored[0]!.orgId).toBe('org-a');
  });

  it('writes no organization for an actor who has none', async () => {
    const w = buildWorld({ entries: [] });
    await w.service.audited('x', 't', as('root-free'), async () => 1);
    expect('orgId' in w.stored[0]!).toBe(false);
  });

  it('records a call by anyone, since it only records what the host\'s authorized call just did', async () => {
    const w = buildWorld({ entries: [] });
    await w.service.audited('assessment.submit', 'sub-1', as('stu'), async () => 1);
    expect(w.stored[0]).toMatchObject({ actorId: 'stu', orgId: 'org-a' });
  });

  it('refuses an actor who does not exist, without running the call', async () => {
    const w = buildWorld({ entries: [] });
    let ran = false;
    await expect(w.service.audited('x', 't', as('ghost'), async () => { ran = true; })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(ran).toBe(false);
    expect(w.stored).toEqual([]);
  });

  it('requires an actor, and does not run the call without one', async () => {
    const w = buildWorld({ entries: [] });
    let ran = false;
    await expect(w.service.audited('x', 't', undefined as never, async () => { ran = true; })).rejects.toBeInstanceOf(ActorRequiredError);
    expect(ran).toBe(false);
  });

  it('stores a diff when given one, and none otherwise', async () => {
    const w = buildWorld({ entries: [] });
    const diff = diffObjects({ score: 70, note: 'a' }, { score: 85, note: 'a' });
    await w.service.audited('grade.record', 'sub-1', as('teacher'), async () => 1, { diff });
    await w.service.audited('grade.record', 'sub-2', as('teacher'), async () => 1);
    expect(w.stored[0]!.diff).toEqual({ score: { before: 70, after: 85 } });
    expect('diff' in w.stored[1]!).toBe(false);
  });

  it('records only successes by default: a call that throws leaves nothing, and a refusal too', async () => {
    const w = buildWorld({ entries: [] });
    const boom = new Error('nope');
    await expect(w.service.audited('x', 't', as('teacher'), async () => { throw boom; })).rejects.toBe(boom);
    const denied = new PermissionDeniedError('grading.record');
    await expect(w.service.audited('x', 't', as('teacher'), async () => { throw denied; })).rejects.toBe(denied);
    expect(w.stored).toEqual([]);
  });

  describe('recording refusals is opt-in', () => {
    it('with recordDenials, a permission refusal is written as "denied" and then rethrown unchanged', async () => {
      const w = buildWorld({ entries: [] });
      const denied = new PermissionDeniedError('grading.record');
      await expect(
        w.service.audited('grade.record', 'sub-1', as('stu'), async () => { throw denied; }, { recordDenials: true }),
      ).rejects.toBe(denied);
      expect(w.stored).toHaveLength(1);
      expect(w.stored[0]).toMatchObject({ actorId: 'stu', orgId: 'org-a', action: 'grade.record', targetId: 'sub-1', outcome: 'denied' });
      expect('diff' in w.stored[0]!).toBe(false);
    });

    it('only refusals: other errors, and a missing actor, are still not recorded', async () => {
      const w = buildWorld({ entries: [] });
      await expect(w.service.audited('x', 't', as('stu'), async () => { throw new Error('bug'); }, { recordDenials: true })).rejects.toThrow('bug');
      await expect(
        w.service.audited('x', 't', as('stu'), async () => { throw new ActorRequiredError('grading.record'); }, { recordDenials: true }),
      ).rejects.toBeInstanceOf(ActorRequiredError);
      expect(w.stored).toEqual([]);
    });

    it('a recorded refusal is visible to an admin of the organization, marked as one', async () => {
      const w = buildWorld({ entries: [] });
      await w.service.audited('x', 't', as('stu'), async () => { throw new PermissionDeniedError('a'); }, { recordDenials: true }).catch(() => {});
      const [entry] = await w.service.history('t', as('root'));
      expect(entry).toMatchObject({ actorId: 'stu', outcome: 'denied' });
    });

    it('makes noise when the refusal cannot be written: the failure says it was a refusal, and carries it', async () => {
      const w = buildWorld({ entries: [], failAppend: true });
      const denied = new PermissionDeniedError('grading.record');
      const err = await w.service.audited('x', 't', as('stu'), async () => { throw denied; }, { recordDenials: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuditWriteFailedError);
      expect((err as AuditWriteFailedError).completed).toBe(false);
      expect((err as AuditWriteFailedError).refusal).toBe(denied);
      expect(((err as AuditWriteFailedError).cause as Error).message).toBe('database down');
    });
  });

  it('makes noise when the entry cannot be written, and hands back the result of the call that did happen', async () => {
    const w = buildWorld({ entries: [], failAppend: true });
    const err = await w.service.audited('x', 't', as('teacher'), async () => 'done').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuditWriteFailedError);
    expect((err as AuditWriteFailedError).completed).toBe(true);
    expect((err as AuditWriteFailedError).result).toBe('done');
  });

  it('is read back by the admins of the same organization and by no one else', async () => {
    const w = buildWorld({ entries: [] });
    await w.service.audited('grade.record', 'sub-1', as('teacher'), async () => 1);
    expect(await w.service.history('sub-1', as('root'))).toHaveLength(1);
    expect(await w.service.history('sub-1', as('root-b'))).toEqual([]);
    expect(await w.service.history('sub-1', as('root-free'))).toEqual([]);
  });
});

describe('AdminService without enforcement', () => {
  it('history returns what the repository has, with no actor and no checks', async () => {
    const w = buildWorld({ enforce: false });
    expect(await w.service.history('sub-1')).toHaveLength(4);
    expect(w.calls.userLookups).toBe(0);
  });

  it('audited records the actor\'s id, looks no one up, and writes no organization', async () => {
    const w = buildWorld({ enforce: false, entries: [] });
    await w.service.audited('x', 't', as('whoever'), async () => 1);
    expect(w.stored[0]).toMatchObject({ actorId: 'whoever' });
    expect('orgId' in w.stored[0]!).toBe(false);
    expect(w.calls.userLookups).toBe(0);
  });

  it('audited still makes noise on a failed write, and still records refusals when asked', async () => {
    const failing = buildWorld({ enforce: false, entries: [], failAppend: true });
    await expect(failing.service.audited('x', 't', as('a'), async () => 1)).rejects.toBeInstanceOf(AuditWriteFailedError);
    const w = buildWorld({ enforce: false, entries: [] });
    await w.service.audited('x', 't', as('a'), async () => { throw new PermissionDeniedError('a'); }, { recordDenials: true }).catch(() => {});
    expect(w.stored[0]).toMatchObject({ outcome: 'denied' });
  });
});

describe('diffObjects', () => {
  it('lists only what changed, with the old and the new value', () => {
    expect(diffObjects({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, c: 3 })).toEqual({ b: { before: 2, after: 5 } });
  });

  it('includes a key that was added or removed', () => {
    expect(diffObjects({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: { before: undefined, after: 2 } });
    expect(diffObjects({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: { before: 2, after: undefined } });
  });

  it('does not report nested objects, arrays or dates that are equal but not the same object', () => {
    const before = { tags: ['a', 'b'], owner: { id: 1, name: 'x' }, due: new Date('2026-10-01') };
    const after = { tags: ['a', 'b'], owner: { id: 1, name: 'x' }, due: new Date('2026-10-01') };
    expect(diffObjects(before, after)).toEqual({});
  });

  it('does report them when they differ', () => {
    expect(diffObjects({ tags: ['a'] }, { tags: ['a', 'b'] })).toEqual({ tags: { before: ['a'], after: ['a', 'b'] } });
    expect(diffObjects({ owner: { id: 1 } }, { owner: { id: 2 } })).toHaveProperty('owner');
    expect(diffObjects({ due: new Date('2026-10-01') }, { due: new Date('2026-10-02') })).toHaveProperty('due');
  });

  it('treats NaN as equal to itself, and null as different from undefined', () => {
    expect(diffObjects({ n: Number.NaN }, { n: Number.NaN })).toEqual({});
    expect(diffObjects({ v: null }, { v: undefined })).toHaveProperty('v');
  });

  it('gives an empty diff for identical objects', () => {
    expect(diffObjects({}, {})).toEqual({});
    expect(diffObjects({ a: 1 }, { a: 1 })).toEqual({});
  });
});
