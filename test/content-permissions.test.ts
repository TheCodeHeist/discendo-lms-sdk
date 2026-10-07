import { describe, it, expect } from 'bun:test';
import { ContentService } from '../src/domains/content/index.js';
import type { PrerequisiteEdge } from '../src/domains/content/index.js';
import { createRolePolicy, EventBus, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
import type {
  ContentNode,
  Enrollment,
  GuardianLink,
  Identity,
  PermissionContext,
  PermissionPolicy,
  RepositoryContext,
  Role,
  TaGrant,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const sleep = () => new Promise((r) => setTimeout(r, 0));

/**
 * sec-1 and sec-2 belong to org-a, sec-open to a course with no organization. In sec-1: teacher
 * (instructor), ta (enr-3), stu and stu-2 (active), plus a dropped, a waitlisted and a completed
 * student. Nodes: n-pub-1 and n-pub-2 are published, n-draft-1 is a draft (all in sec-1),
 * n-other is published in sec-2.
 */
function buildWorld(opts: { policy?: PermissionPolicy; grants?: TaGrant[]; enforce?: boolean; edges?: PrerequisiteEdge[] } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  add('teacher', ['instructor']);
  add('teacher-2', ['instructor']);
  add('ta', ['ta']);
  for (const id of ['stu', 'stu-2', 'stu-sec2', 'stu-dropped', 'stu-wait', 'stu-done', 'parent', 'outsider']) add(id, ['student']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');
  add('stu-b', ['student'], 'org-b');

  const enrollments: Enrollment[] = [];
  let en = 0;
  const seed = (userId: string, sectionId: string, role: Role, status: Enrollment['status'] = 'active') =>
    enrollments.push({ id: `enr-${++en}`, userId, sectionId, role, status, enrolledAt: new Date() });
  seed('teacher', 'sec-1', 'instructor');
  seed('teacher-2', 'sec-2', 'instructor');
  seed('ta', 'sec-1', 'ta');
  seed('stu', 'sec-1', 'student');
  seed('stu-2', 'sec-1', 'student');
  seed('stu-sec2', 'sec-2', 'student');
  seed('stu-dropped', 'sec-1', 'student', 'dropped');
  seed('stu-wait', 'sec-1', 'student', 'waitlisted');
  seed('stu-done', 'sec-1', 'student', 'completed');

  const nodes = new Map<string, ContentNode>();
  let seq = 0;
  const put = (id: string, sectionId: string, published: boolean, parentId?: string, orderIndex = ++seq) =>
    nodes.set(id, {
      id,
      sectionId,
      kind: 'page',
      title: id,
      orderIndex,
      published,
      version: 1,
      ...(parentId ? { parentId } : {}),
    });
  put('n-pub-1', 'sec-1', true);
  put('n-draft-1', 'sec-1', false);
  put('n-pub-2', 'sec-1', true);
  put('n-other', 'sec-2', true);

  const links: GuardianLink[] = [
    { id: 'l1', guardianId: 'parent', wardId: 'stu', orgId: 'org-a', scopes: ['grades', 'attendance', 'schedule'], status: 'active', createdAt: new Date() },
  ];

  const calls = { create: 0, update: 0, reorder: [] as string[][], contentLookups: 0, listCalls: 0 };
  const repos: RepositoryContext = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) =>
        id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : id === 'course-open' ? { id, title: 'Open' } : null,
      findSection: async (id) =>
        ['sec-1', 'sec-2'].includes(id)
          ? { id, courseId: 'course-a', status: 'published' as const }
          : id === 'sec-open'
            ? { id, courseId: 'course-open', status: 'published' as const }
            : id === 'sec-orphan'
              ? { id, courseId: 'missing-course', status: 'published' as const }
              : null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => ({ ...e, id: `enr-${++en}` }),
      findById: async (id) => enrollments.find((e) => e.id === id) ?? null,
      update: async (id, patch) => ({ ...enrollments.find((e) => e.id === id)!, ...patch }),
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments].reverse().find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => enrollments.filter((e) => e.sectionId === sectionId),
      countActive: async () => 0,
    },
    content: {
      findById: async (id) => (calls.contentLookups++, nodes.get(id) ?? null),
      listBySection: async (sectionId) => (
        calls.listCalls++,
        [...nodes.values()].filter((n) => n.sectionId === sectionId).sort((a, b) => a.orderIndex - b.orderIndex)
      ),
      create: async (n) => {
        calls.create++;
        const node: ContentNode = { ...n, id: `new-${calls.create}`, version: 1 };
        nodes.set(node.id, node);
        return node;
      },
      update: async (id, patch) => {
        calls.update++;
        const updated = { ...nodes.get(id)!, ...patch };
        nodes.set(id, updated);
        return updated;
      },
      reorder: async (_sectionId, ids) => {
        calls.reorder.push(ids);
      },
    },
    terms: { findById: async () => null },
    guardianLinks: {
      findActive: async (g, w) => links.find((l) => l.guardianId === g && l.wardId === w && l.status === 'active') ?? null,
    },
    delegations: {
      create: async (g) => ({ ...g, id: 'grant-x' }),
      findById: async (id) => (opts.grants ?? []).find((g) => g.id === id) ?? null,
      listActiveForEnrollment: async (enrollmentId) =>
        (opts.grants ?? []).filter((g) => g.enrollmentId === enrollmentId && g.revokedAt === undefined),
      revoke: async (id, at) => ({ ...(opts.grants ?? [])[0]!, revokedAt: at }),
    },
  };

  const done = new Set<string>();
  const completion = { isComplete: async (userId: string, contentId: string) => done.has(`${userId}:${contentId}`) };
  const bus = new EventBus();
  const published: Array<{ contentId: string; sectionId: string; version: number }> = [];
  bus.on('content.published', (e) => {
    published.push(e);
  });
  const policy = opts.policy ?? createRolePolicy();
  const service = new ContentService(repos, completion, opts.edges ?? [], bus, opts.enforce === false ? {} : { policy });
  return { service, calls, nodes, published, done };
}

const ids = (list: ContentNode[]) => list.map((n) => n.id);
const grant = (over: Partial<TaGrant> = {}): TaGrant => ({
  id: 'g1',
  enrollmentId: 'enr-3',
  sectionId: 'sec-1',
  action: 'content.manage',
  grantedBy: 'teacher',
  grantedAt: new Date(),
  ...over,
});
const newNode = (over: Partial<Omit<ContentNode, 'id' | 'version'>> = {}): Omit<ContentNode, 'id' | 'version'> => ({
  sectionId: 'sec-1',
  kind: 'page',
  title: 'New',
  orderIndex: 9,
  published: false,
  ...over,
});

describe('ContentService.createNode with enforcement', () => {
  it.each(['teacher', 'root'])('lets %s create a node in the section', async (who) => {
    const w = buildWorld();
    await expect(w.service.createNode(newNode(), as(who))).resolves.toMatchObject({ sectionId: 'sec-1', published: false });
    expect(w.calls.create).toBe(1);
  });

  it.each(['stu', 'stu-dropped', 'stu-done', 'parent', 'ta', 'teacher-2', 'root-b', 'stu-b', 'outsider', 'nobody'])(
    'refuses %s, and creates nothing',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.createNode(newNode(), as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.create).toBe(0);
    },
  );

  it('lets a TA create nodes once content.manage is delegated to them, in that section only', async () => {
    await expect(buildWorld({ grants: [grant()] }).service.createNode(newNode(), as('ta'))).resolves.toBeDefined();
    const other = buildWorld({ grants: [grant({ sectionId: 'sec-2' })] });
    await expect(other.service.createNode(newNode(), as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const revoked = buildWorld({ grants: [grant({ revokedAt: new Date() })] });
    await expect(revoked.service.createNode(newNode(), as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const wrongAction = buildWorld({ grants: [grant({ action: 'communication.postAnnouncement' })] });
    await expect(wrongAction.service.createNode(newNode(), as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = buildWorld();
    await expect(w.service.createNode(newNode({ sectionId }), as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('requires an actor and looks nothing up without one', async () => {
    const w = buildWorld();
    await expect(w.service.createNode(newNode())).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.create).toBe(0);
    expect(w.calls.contentLookups).toBe(0);
  });

  it('accepts a parent in the same section', async () => {
    const w = buildWorld();
    await expect(w.service.createNode(newNode({ parentId: 'n-pub-1' }), as('teacher'))).resolves.toMatchObject({
      parentId: 'n-pub-1',
    });
  });

  it.each(['n-other', 'no-such-node'])('refuses a parent that is %s (another section, or missing), and creates nothing', async (parentId) => {
    const w = buildWorld();
    const err = await w.service.createNode(newNode({ parentId }), as('teacher')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermissionDeniedError);
    expect((err as Error).message).toContain('parent');
    expect(w.calls.create).toBe(0);
  });

  it('checks permission before the parent, so a stranger learns nothing about other sections\' nodes', async () => {
    const w = buildWorld();
    await expect(w.service.createNode(newNode({ parentId: 'n-other' }), as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.contentLookups).toBe(0);
  });

  it('asks the policy about content.manage in the node\'s section', async () => {
    const seen: Array<{ action: string; ctx: PermissionContext }> = [];
    const spy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
    const w = buildWorld({ policy: spy });
    await w.service.createNode(newNode(), as('teacher')).catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]!.action).toBe('content.manage');
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section?.role).toBe('instructor');
  });
});

describe('ContentService.publish with enforcement', () => {
  it('lets the section\'s instructor publish a draft: version goes up and one event is emitted', async () => {
    const w = buildWorld();
    const node = await w.service.publish('n-draft-1', as('teacher'));
    expect(node).toMatchObject({ id: 'n-draft-1', published: true, version: 2 });
    await sleep();
    expect(w.published).toMatchObject([{ contentId: 'n-draft-1', sectionId: 'sec-1', version: 2 }]);
  });

  it('lets a TA with the delegated action publish', async () => {
    const w = buildWorld({ grants: [grant()] });
    await expect(w.service.publish('n-draft-1', as('ta'))).resolves.toMatchObject({ published: true });
  });

  it.each(['stu', 'stu-done', 'parent', 'ta', 'teacher-2', 'root-b', 'outsider', 'nobody'])(
    'refuses %s: nothing changes and no event is emitted',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.publish('n-draft-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      await sleep();
      expect(w.calls.update).toBe(0);
      expect(w.nodes.get('n-draft-1')!.published).toBe(false);
      expect(w.published).toEqual([]);
    },
  );

  it('takes the section from the stored node, so an instructor cannot publish another section\'s node', async () => {
    const w = buildWorld();
    await expect(w.service.publish('n-other', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.publish('n-other', as('teacher-2'))).resolves.toMatchObject({ id: 'n-other' });
  });

  it('refuses an unknown node exactly like a forbidden one', async () => {
    const w = buildWorld();
    const err = await w.service.publish('no-such-node', as('root')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.update).toBe(0);
  });

  it('requires an actor and looks nothing up without one', async () => {
    const w = buildWorld();
    await expect(w.service.publish('n-draft-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.contentLookups).toBe(0);
  });
});

describe('ContentService.reorder with enforcement', () => {
  it('lets an instructor reorder the section\'s nodes', async () => {
    const w = buildWorld();
    await w.service.reorder('sec-1', ['n-pub-2', 'n-draft-1', 'n-pub-1'], as('teacher'));
    expect(w.calls.reorder).toEqual([['n-pub-2', 'n-draft-1', 'n-pub-1']]);
  });

  it('lets a TA with the delegated action reorder', async () => {
    const w = buildWorld({ grants: [grant()] });
    await w.service.reorder('sec-1', ['n-pub-2', 'n-pub-1'], as('ta'));
    expect(w.calls.reorder).toHaveLength(1);
  });

  it.each(['stu', 'parent', 'ta', 'teacher-2', 'root-b', 'outsider', 'nobody'])('refuses %s, and reorders nothing', async (who) => {
    const w = buildWorld();
    await expect(w.service.reorder('sec-1', ['n-pub-2', 'n-pub-1'], as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.reorder).toEqual([]);
  });

  it('refuses an unknown section for everyone, an admin included', async () => {
    const w = buildWorld();
    await expect(w.service.reorder('sec-none', [], as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each([
    ['a node of another section', ['n-pub-1', 'n-other']],
    ['an unknown node', ['n-pub-1', 'no-such-node']],
    ['the same node twice', ['n-pub-1', 'n-pub-1']],
  ])('refuses a list containing %s, and reorders nothing', async (_label, ids) => {
    const w = buildWorld();
    const err = await w.service.reorder('sec-1', ids, as('teacher')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.reorder).toEqual([]);
  });

  it('checks permission before the ids, so a stranger learns nothing about which nodes exist', async () => {
    const w = buildWorld();
    await expect(w.service.reorder('sec-1', ['n-other'], as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.listCalls).toBe(0);
  });

  it('accepts an empty list as a no-op', async () => {
    const w = buildWorld();
    await expect(w.service.reorder('sec-1', [], as('teacher'))).resolves.toBeUndefined();
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.reorder('sec-1', [])).rejects.toBeInstanceOf(ActorRequiredError);
  });
});

describe('ContentService.getNode: drafts are for staff only', () => {
  it.each(['stu', 'stu-2'])('lets %s read a published node of their section', async (who) => {
    const w = buildWorld();
    await expect(w.service.getNode('n-pub-1', as(who))).resolves.toMatchObject({ id: 'n-pub-1' });
  });

  it('refuses a student a draft', async () => {
    const w = buildWorld();
    await expect(w.service.getNode('n-draft-1', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['teacher', 'ta', 'root'])('lets %s (staff) read a draft', async (who) => {
    const w = buildWorld();
    await expect(w.service.getNode('n-draft-1', as(who))).resolves.toMatchObject({ id: 'n-draft-1', published: false });
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-sec2', 'outsider', 'parent', 'teacher-2', 'root-b', 'stu-b', 'nobody'])(
    'refuses %s even a published node (not an active member of the section, another section, or another organization)',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.getNode('n-pub-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    },
  );

  it('refuses an unknown node exactly like a forbidden one, with the same message', async () => {
    const w = buildWorld();
    const unknown = await w.service.getNode('no-such-node', as('root')).catch((e: unknown) => e);
    const forbidden = await w.service.getNode('n-pub-1', as('nobody')).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(PermissionDeniedError);
    expect((unknown as Error).message).toBe((forbidden as Error).message);
  });

  it('requires an actor and looks nothing up without one', async () => {
    const w = buildWorld();
    await expect(w.service.getNode('n-pub-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.contentLookups).toBe(0);
  });

  it('asks the policy about content.view in the node\'s section', async () => {
    const seen: Array<{ action: string; ctx: PermissionContext }> = [];
    const spy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
    const w = buildWorld({ policy: spy });
    await w.service.getNode('n-other', as('stu')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['content.view']);
    expect(seen[0]!.ctx.section?.role).toBeUndefined(); // stu is not in sec-2
  });
});

describe('ContentService.listNodes: drafts are for staff only', () => {
  it('gives a student only the published nodes, in the repository\'s order', async () => {
    const w = buildWorld();
    const list = await w.service.listNodes('sec-1', as('stu'));
    expect(list.map((n) => n.id)).toEqual(['n-pub-1', 'n-pub-2']);
  });

  it.each(['teacher', 'ta', 'root'])('gives %s (staff) every node, drafts included', async (who) => {
    const w = buildWorld();
    const list = await w.service.listNodes('sec-1', as(who));
    expect(list.map((n) => n.id)).toEqual(['n-pub-1', 'n-draft-1', 'n-pub-2']);
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-sec2', 'outsider', 'parent', 'teacher-2', 'root-b', 'nobody'])(
    'refuses %s, and does not even read the section\'s nodes',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.listNodes('sec-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.listCalls).toBe(0);
    },
  );

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = buildWorld();
    await expect(w.service.listNodes(sectionId, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.listNodes('sec-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.listCalls).toBe(0);
  });
});

describe('ContentService: a completed student keeps read-only access to published content', () => {
  it('lets them read a published node and list the published nodes', async () => {
    const w = buildWorld();
    await expect(w.service.getNode('n-pub-1', as('stu-done'))).resolves.toMatchObject({ id: 'n-pub-1' });
    expect(ids(await w.service.listNodes('sec-1', as('stu-done')))).toEqual(['n-pub-1', 'n-pub-2']);
  });

  it('still keeps drafts from them, exactly as for an active student', async () => {
    const w = buildWorld();
    await expect(w.service.getNode('n-draft-1', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses them another section\'s content', async () => {
    const w = buildWorld();
    await expect(w.service.getNode('n-other', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.listNodes('sec-2', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses them every write', async () => {
    const w = buildWorld();
    await expect(w.service.createNode(newNode(), as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.publish('n-draft-1', as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.reorder('sec-1', ['n-pub-1'], as('stu-done'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create + w.calls.update + w.calls.reorder.length).toBe(0);
  });

  it('gives a custom policy the completed role only for a read, never for a write', async () => {
    const seen: Array<{ action: string; completedRole: unknown }> = [];
    const spy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, completedRole: ctx.section?.completedRole }), false) };
    const w = buildWorld({ policy: spy });
    await w.service.getNode('n-pub-1', as('stu-done')).catch(() => {});
    await w.service.createNode(newNode(), as('stu-done')).catch(() => {});
    expect(seen.find((s) => s.action === 'content.view')!.completedRole).toBe('student');
    expect(seen.find((s) => s.action === 'content.manage')!.completedRole).toBeUndefined();
  });
});

describe('ContentService.isUnlocked (a pure check on the prerequisite edges)', () => {
  const edges: PrerequisiteEdge[] = [
    { contentId: 'quiz-2', requiresContentId: 'lesson-2' },
    { contentId: 'quiz-2', requiresContentId: 'quiz-1' },
    { contentId: 'lesson-2', requiresContentId: 'lesson-1' },
  ];

  it('is true for a node with no prerequisites', async () => {
    const w = buildWorld({ edges });
    expect(await w.service.isUnlocked('stu', 'lesson-1')).toBe(true);
  });

  it('needs EVERY prerequisite complete (AND)', async () => {
    const w = buildWorld({ edges });
    expect(await w.service.isUnlocked('stu', 'quiz-2')).toBe(false);
    w.done.add('stu:lesson-2');
    expect(await w.service.isUnlocked('stu', 'quiz-2')).toBe(false);
    w.done.add('stu:quiz-1');
    expect(await w.service.isUnlocked('stu', 'quiz-2')).toBe(true);
  });

  it('asks about the given person only', async () => {
    const w = buildWorld({ edges });
    w.done.add('stu-2:lesson-1');
    expect(await w.service.isUnlocked('stu', 'lesson-2')).toBe(false);
    expect(await w.service.isUnlocked('stu-2', 'lesson-2')).toBe(true);
  });

  it('looks at direct prerequisites only (completing lesson-2 is enough for quiz-2\'s first edge)', async () => {
    const w = buildWorld({ edges });
    w.done.add('stu:lesson-2');
    w.done.add('stu:quiz-1');
    expect(await w.service.isUnlocked('stu', 'quiz-2')).toBe(true); // lesson-1 was never completed
  });

  it('is not an access check: it needs no actor and answers even with enforcement on', async () => {
    const w = buildWorld({ edges });
    await expect(w.service.isUnlocked('nobody', 'lesson-1')).resolves.toBe(true);
  });

  it('cannot hang on a cycle', async () => {
    const cyc: PrerequisiteEdge[] = [
      { contentId: 'a', requiresContentId: 'b' },
      { contentId: 'b', requiresContentId: 'a' },
    ];
    const w = buildWorld({ edges: cyc });
    expect(await w.service.isUnlocked('stu', 'a')).toBe(false);
  });
});

describe('ContentService without enforcement', () => {
  it('behaves as before: no actor, no checks, no validation', async () => {
    const w = buildWorld({ enforce: false });
    const created = await w.service.createNode(newNode({ sectionId: 'anywhere', parentId: 'no-such-node' }));
    expect(created.sectionId).toBe('anywhere');
    await expect(w.service.publish('n-draft-1')).resolves.toMatchObject({ published: true, version: 2 });
    await w.service.reorder('sec-1', ['n-other', 'n-other', 'ghost']);
    expect(w.calls.reorder).toEqual([['n-other', 'n-other', 'ghost']]);
    await expect(w.service.publish('no-such-node')).rejects.toThrow('Content no-such-node not found');
    expect(w.calls.contentLookups).toBeGreaterThan(0);
  });

  it('reads whatever the repository has: getNode and listNodes show drafts too', async () => {
    const w = buildWorld({ enforce: false });
    await expect(w.service.getNode('n-draft-1')).resolves.toMatchObject({ published: false });
    expect((await w.service.listNodes('sec-1')).map((n) => n.id)).toEqual(['n-pub-1', 'n-draft-1', 'n-pub-2']);
    await expect(w.service.getNode('no-such-node')).rejects.toThrow('Content no-such-node not found');
  });
});
