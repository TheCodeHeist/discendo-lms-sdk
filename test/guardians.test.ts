import { describe, it, expect } from 'bun:test';
import {
  GuardianService,
  GuardianLinkExistsError,
  GuardianLinkNotFoundError,
  GuardianLinkTargetError,
  InvalidGuardianLinkError,
} from '../src/domains/guardians/index.js';
import {
  createRolePolicy,
  authorizeInSection,
  PermissionDeniedError,
  ActorRequiredError,
} from '../src/core/index.js';
import type {
  Enrollment,
  GuardianLink,
  GuardianLinkManagementRepository,
  GuardianScope,
  Identity,
  PermissionContext,
  PermissionPolicy,
  RepositoryContext,
  Role,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });

/**
 * org-a: root (admin), teacher (instructor of sec-1), teacher-2 (instructor of sec-2), ta, students
 * stu / stu-2 (active in sec-1), stu-dropped, stu-wait, stu-done, parents parent / parent-2 /
 * parent-dropped, outsider. org-b: root-b (admin), parent-b, ward-b. No organization: root-free
 * (admin), free-parent, free-ward. sec-1 and sec-2 are in org-a's course, sec-open is in a course
 * with no organization.
 */
function buildWorld(opts: { policy?: PermissionPolicy; seed?: Array<Omit<GuardianLink, 'id'>> } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId?: string) =>
    users.set(id, { id, roles, ...(orgId ? { orgId } : {}) });
  add('root', ['admin'], 'org-a');
  add('teacher', ['instructor'], 'org-a');
  add('teacher-2', ['instructor'], 'org-a');
  add('ta', ['ta'], 'org-a');
  for (const id of ['stu', 'stu-2', 'stu-dropped', 'stu-wait', 'stu-done', 'parent', 'parent-2', 'parent-dropped', 'outsider']) {
    add(id, ['student'], 'org-a');
  }
  add('root-b', ['admin'], 'org-b');
  add('parent-b', ['student'], 'org-b');
  add('ward-b', ['student'], 'org-b');
  add('root-free', ['admin']);
  add('free-parent', ['student']);
  add('free-ward', ['student']);

  const enrollments: Enrollment[] = [];
  let en = 0;
  const seed = (userId: string, sectionId: string, role: Role, status: Enrollment['status'] = 'active') =>
    enrollments.push({ id: `enr-${++en}`, userId, sectionId, role, status, enrolledAt: new Date() });
  seed('teacher', 'sec-1', 'instructor');
  seed('teacher-2', 'sec-2', 'instructor');
  seed('ta', 'sec-1', 'ta');
  seed('stu', 'sec-1', 'student');
  seed('stu-2', 'sec-1', 'student');
  seed('stu-dropped', 'sec-1', 'student', 'dropped');
  seed('stu-wait', 'sec-1', 'student', 'waitlisted');
  seed('stu-done', 'sec-1', 'student', 'completed');

  const links = new Map<string, GuardianLink>();
  let ln = 0;
  const calls = { create: 0, update: 0 };
  const guardianLinks: GuardianLinkManagementRepository = {
    findActive: async (g, w) => [...links.values()].find((l) => l.guardianId === g && l.wardId === w && l.status === 'active') ?? null,
    create: async (l) => {
      calls.create++;
      const row: GuardianLink = { ...l, id: `link-${++ln}` };
      links.set(row.id, row);
      return row;
    },
    findById: async (id) => links.get(id) ?? null,
    update: async (id, patch) => {
      calls.update++;
      const row = { ...links.get(id)!, ...patch };
      links.set(id, row);
      return row;
    },
    listByWard: async (w) => [...links.values()].filter((l) => l.wardId === w),
    listByGuardian: async (g) => [...links.values()].filter((l) => l.guardianId === g),
  };
  for (const l of opts.seed ?? []) {
    const row: GuardianLink = { ...l, id: `link-${++ln}` };
    links.set(row.id, row);
  }

  const repos = {
    users: { findById: async (id: string) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id: string) =>
        id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : id === 'course-open' ? { id, title: 'Open' } : null,
      findSection: async (id: string) =>
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
      create: async (e: Omit<Enrollment, 'id'>) => ({ ...e, id: `enr-${++en}` }),
      findById: async (id: string) => enrollments.find((e) => e.id === id) ?? null,
      update: async (id: string, patch: Partial<Enrollment>) => ({ ...enrollments.find((e) => e.id === id)!, ...patch }),
      findByUserAndSection: async (userId: string, sectionId: string) =>
        [...enrollments].reverse().find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId: string) => enrollments.filter((e) => e.sectionId === sectionId),
      countActive: async () => 0,
    },
    guardianLinks,
  };
  const policy = opts.policy ?? createRolePolicy();
  const service = new GuardianService(repos, { policy });
  return { service, calls, links, repos, policy, enrollments };
}

type World = ReturnType<typeof buildWorld>;
const link = (guardianId: string, wardId: string, scopes: GuardianScope[], over: Partial<GuardianLink> = {}): Omit<GuardianLink, 'id'> => ({
  guardianId,
  wardId,
  orgId: 'org-a',
  scopes,
  status: 'active',
  createdAt: new Date(),
  ...over,
});
const spyPolicy = () => {
  const seen: Array<{ action: string; ctx: PermissionContext }> = [];
  const policy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
  return { seen, policy };
};
/** Whether a guardian can read the ward's grades in sec-1 right now, through the real read side. */
const canReadGrades = (w: World, guardianId: string, wardId: string) =>
  authorizeInSection(w.policy, w.repos, 'grading.view', as(guardianId), { sectionId: 'sec-1', ownerId: wardId, afterCompletion: true }).then(
    () => true,
    () => false,
  );

describe('GuardianService.createLink', () => {
  it('lets an admin link a guardian to a ward; the ward\'s organization is stamped on it, never the caller\'s', async () => {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['grades', 'announcements'], as('root'));
    expect(l).toMatchObject({ guardianId: 'parent', wardId: 'stu', orgId: 'org-a', scopes: ['grades', 'announcements'], status: 'active' });
    expect(l.createdAt).toBeInstanceOf(Date);
    expect('revokedAt' in l).toBe(false);
    expect(w.calls.create).toBe(1);
  });

  it('is the link the read side then honors', async () => {
    const w = buildWorld();
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(false);
    await w.service.createLink('parent', 'stu', ['grades'], as('root'));
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(true);
    expect(await canReadGrades(w, 'parent', 'stu-2')).toBe(false); // only that ward
    expect(await canReadGrades(w, 'parent-2', 'stu')).toBe(false); // only that guardian
  });

  it('removes duplicate scopes, keeping the order', async () => {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['schedule', 'grades', 'schedule'], as('root'));
    expect(l.scopes).toEqual(['schedule', 'grades']);
  });

  it('may link a ward who is not enrolled anywhere or has dropped: a link belongs to the person, not a section', async () => {
    const w = buildWorld();
    await expect(w.service.createLink('parent', 'stu-dropped', ['grades'], as('root'))).resolves.toBeDefined();
    await expect(w.service.createLink('parent', 'outsider', ['grades'], as('root'))).resolves.toBeDefined();
  });

  it('lets one guardian have several wards, and one ward several guardians', async () => {
    const w = buildWorld();
    await w.service.createLink('parent', 'stu', ['grades'], as('root'));
    await w.service.createLink('parent', 'stu-2', ['grades'], as('root'));
    await w.service.createLink('parent-2', 'stu', ['grades'], as('root'));
    expect(w.calls.create).toBe(3);
  });

  it.each(['teacher', 'ta', 'stu', 'parent', 'outsider', 'nobody'])('refuses %s, and creates nothing', async (who) => {
    const w = buildWorld();
    await expect(w.service.createLink('parent', 'stu', ['grades'], as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.createLink('parent', 'stu', ['grades'])).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.create).toBe(0);
  });

  it('checks permission before anything else, so a stranger learns nothing about who exists or what is valid', async () => {
    const w = buildWorld();
    await expect(w.service.createLink('ghost', 'ghost', [], as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.createLink('parent-b', 'stu', ['everything'] as never, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('asks the policy about guardian.manageLinks, in the actor\'s organization', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.createLink('parent', 'stu', ['grades'], as('root')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['guardian.manageLinks']);
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section).toBeUndefined();
  });

  describe('the organization wall', () => {
    it.each([
      ['an admin of another organization', 'root-b', 'parent', 'stu'],
      ['a guardian of another organization', 'root', 'parent-b', 'stu'],
      ['a ward of another organization', 'root', 'parent', 'ward-b'],
      ['both people in another organization', 'root', 'parent-b', 'ward-b'],
      ['an admin with no organization and people in one', 'root-free', 'parent', 'stu'],
      ['an admin of an organization and people with none', 'root', 'free-parent', 'free-ward'],
    ])('refuses %s, and creates nothing', async (_label, actor, guardian, ward) => {
      const w = buildWorld();
      await expect(w.service.createLink(guardian, ward, ['grades'], as(actor))).rejects.toBeInstanceOf(GuardianLinkTargetError);
      expect(w.calls.create).toBe(0);
    });

    it('says exactly the same about someone who does not exist as about someone in another organization', async () => {
      const w = buildWorld();
      const unknown = await w.service.createLink('ghost', 'stu', ['grades'], as('root')).catch((e: unknown) => e);
      const foreign = await w.service.createLink('parent-b', 'stu', ['grades'], as('root')).catch((e: unknown) => e);
      expect(unknown).toBeInstanceOf(GuardianLinkTargetError);
      expect((unknown as Error).message).toBe((foreign as Error).message);
      expect((foreign as Error).message).not.toContain('org-');
    });

    it('works with no organizations at all: "no organization" matches only "no organization"', async () => {
      const w = buildWorld();
      const l = await w.service.createLink('free-parent', 'free-ward', ['grades'], as('root-free'));
      expect(l.guardianId).toBe('free-parent');
      expect('orgId' in l).toBe(false);
    });

    it('works in a second organization too', async () => {
      const w = buildWorld();
      await expect(w.service.createLink('parent-b', 'ward-b', ['grades'], as('root-b'))).resolves.toMatchObject({ orgId: 'org-b' });
    });
  });

  describe('what a link may be', () => {
    it('refuses a person as their own guardian', async () => {
      const w = buildWorld();
      await expect(w.service.createLink('stu', 'stu', ['grades'], as('root'))).rejects.toBeInstanceOf(InvalidGuardianLinkError);
      expect(w.calls.create).toBe(0);
    });

    it.each([
      ['no scopes', []],
      ['an unknown scope', ['grades', 'everything']],
      ['scopes that are not a list', 'grades'],
    ])('refuses %s', async (_label, scopes) => {
      const w = buildWorld();
      await expect(w.service.createLink('parent', 'stu', scopes as never, as('root'))).rejects.toBeInstanceOf(InvalidGuardianLinkError);
      expect(w.calls.create).toBe(0);
    });
  });

  describe('one active link per guardian and ward', () => {
    it('refuses a second active link, and leaves the first alone', async () => {
      const w = buildWorld();
      const first = await w.service.createLink('parent', 'stu', ['grades'], as('root'));
      await expect(w.service.createLink('parent', 'stu', ['grades', 'schedule'], as('root'))).rejects.toBeInstanceOf(GuardianLinkExistsError);
      expect(w.calls.create).toBe(1);
      expect(w.links.get(first.id)!.scopes).toEqual(['grades']);
    });

    it('allows a new link after the old one was revoked, as a new record', async () => {
      const w = buildWorld();
      const first = await w.service.createLink('parent', 'stu', ['grades'], as('root'));
      await w.service.revokeLink(first.id, as('root'));
      const second = await w.service.createLink('parent', 'stu', ['schedule'], as('root'));
      expect(second.id).not.toBe(first.id);
      expect(w.links.get(first.id)!.status).toBe('revoked');
    });

    it('ignores a repository answer that is not for this pair', async () => {
      const w = buildWorld();
      w.repos.guardianLinks.findActive = async () => ({ ...link('someone', 'else', ['grades']), id: 'wrong' });
      await expect(w.service.createLink('parent', 'stu', ['grades'], as('root'))).resolves.toBeDefined();
    });
  });
});

describe('GuardianService.updateScopes', () => {
  async function withLink() {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['grades', 'announcements'], as('root'));
    return { w, l };
  }

  it('lets an admin change what the guardian may see, and the read side follows', async () => {
    const { w, l } = await withLink();
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(true);
    const updated = await w.service.updateScopes(l.id, ['schedule'], as('root'));
    expect(updated.scopes).toEqual(['schedule']);
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(false);
    await w.service.updateScopes(l.id, ['grades', 'grades'], as('root'));
    expect(w.links.get(l.id)!.scopes).toEqual(['grades']);
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(true);
  });

  it.each(['teacher', 'ta', 'stu', 'parent', 'nobody'])('refuses %s, and changes nothing', async (who) => {
    const { w, l } = await withLink();
    const before = w.calls.update;
    await expect(w.service.updateScopes(l.id, ['schedule'], as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.update).toBe(before);
    expect(w.links.get(l.id)!.scopes).toEqual(['grades', 'announcements']);
  });

  it('requires an actor', async () => {
    const { w, l } = await withLink();
    await expect(w.service.updateScopes(l.id, ['grades'])).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('does not find a link of another organization, or one that does not exist, and says the same about both', async () => {
    const { w, l } = await withLink();
    const foreign = await w.service.updateScopes(l.id, ['grades'], as('root-b')).catch((e: unknown) => e);
    const unknown = await w.service.updateScopes('no-such-link', ['grades'], as('root')).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(GuardianLinkNotFoundError);
    expect(unknown).toBeInstanceOf(GuardianLinkNotFoundError);
    expect((foreign as Error).message).toBe((unknown as Error).message);
    expect(w.links.get(l.id)!.scopes).toEqual(['grades', 'announcements']);
  });

  it('refuses a revoked link, and bad scopes', async () => {
    const { w, l } = await withLink();
    await expect(w.service.updateScopes(l.id, [], as('root'))).rejects.toBeInstanceOf(InvalidGuardianLinkError);
    await expect(w.service.updateScopes(l.id, ['everything'] as never, as('root'))).rejects.toBeInstanceOf(InvalidGuardianLinkError);
    await w.service.revokeLink(l.id, as('root'));
    await expect(w.service.updateScopes(l.id, ['grades'], as('root'))).rejects.toBeInstanceOf(InvalidGuardianLinkError);
    expect(w.links.get(l.id)!.status).toBe('revoked');
  });

  it('looks nothing up for someone who may not manage links', async () => {
    const { w, l } = await withLink();
    let lookups = 0;
    const find = w.repos.guardianLinks.findById;
    w.repos.guardianLinks.findById = async (id) => (lookups++, find(id));
    await w.service.updateScopes(l.id, ['grades'], as('stu')).catch(() => {});
    expect(lookups).toBe(0);
  });
});

describe('GuardianService.revokeLink', () => {
  it('ends the guardian\'s access, stamps when, and keeps the record', async () => {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['grades'], as('root'));
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(true);
    const revoked = await w.service.revokeLink(l.id, as('root'));
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(w.links.has(l.id)).toBe(true);
    expect(await canReadGrades(w, 'parent', 'stu')).toBe(false);
  });

  it('is idempotent: a second revoke changes nothing, not even the time', async () => {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['grades'], as('root'));
    const first = await w.service.revokeLink(l.id, as('root'));
    const updates = w.calls.update;
    const second = await w.service.revokeLink(l.id, as('root'));
    expect(w.calls.update).toBe(updates);
    expect(second.revokedAt).toEqual(first.revokedAt);
  });

  it.each(['teacher', 'ta', 'stu', 'parent', 'nobody'])('refuses %s, and revokes nothing', async (who) => {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['grades'], as('root'));
    await expect(w.service.revokeLink(l.id, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.links.get(l.id)!.status).toBe('active');
  });

  it('does not find a link of another organization or an unknown one, and says the same about both', async () => {
    const w = buildWorld();
    const l = await w.service.createLink('parent', 'stu', ['grades'], as('root'));
    const foreign = await w.service.revokeLink(l.id, as('root-b')).catch((e: unknown) => e);
    const unknown = await w.service.revokeLink('no-such-link', as('root')).catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(GuardianLinkNotFoundError);
    expect((foreign as Error).message).toBe((unknown as Error).message);
    expect(w.links.get(l.id)!.status).toBe('active');
  });

  it('works for a link with no organization, only for an admin with none', async () => {
    const w = buildWorld();
    const l = await w.service.createLink('free-parent', 'free-ward', ['grades'], as('root-free'));
    await expect(w.service.revokeLink(l.id, as('root'))).rejects.toBeInstanceOf(GuardianLinkNotFoundError);
    await expect(w.service.revokeLink(l.id, as('root-free'))).resolves.toMatchObject({ status: 'revoked' });
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.revokeLink('x')).rejects.toBeInstanceOf(ActorRequiredError);
  });
});

describe('GuardianService.listWards', () => {
  const seeded = () =>
    buildWorld({
      seed: [
        link('parent', 'stu', ['grades']),
        link('parent', 'stu-2', ['announcements']),
        link('parent', 'stu-dropped', ['grades'], { status: 'revoked', revokedAt: new Date() }),
        link('parent', 'ward-b', ['grades'], { orgId: 'org-b' }), // corrupt: another organization
        link('parent-2', 'stu', ['grades']),
      ],
    });
  const wardsOf = (list: GuardianLink[]) => list.map((l) => l.wardId);

  it('gives an admin a guardian\'s active links, and no revoked or foreign ones', async () => {
    const w = seeded();
    expect(wardsOf(await w.service.listWards('parent', as('root')))).toEqual(['stu', 'stu-2']);
  });

  it('lets a guardian list their own links, so they know which ward to name', async () => {
    const w = seeded();
    expect(wardsOf(await w.service.listWards('parent', as('parent')))).toEqual(['stu', 'stu-2']);
    expect(wardsOf(await w.service.listWards('parent-2', as('parent-2')))).toEqual(['stu']);
  });

  it.each(['parent-2', 'teacher', 'ta', 'stu', 'outsider', 'nobody'])('refuses %s someone else\'s links', async (who) => {
    const w = seeded();
    await expect(w.service.listWards('parent', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('gives an admin of another organization nothing, and nothing for an unknown guardian', async () => {
    const w = seeded();
    expect(await w.service.listWards('parent', as('root-b'))).toEqual([]);
    expect(await w.service.listWards('ghost', as('root'))).toEqual([]);
  });

  it('does not read the links of someone the actor may not list', async () => {
    const w = seeded();
    let reads = 0;
    const list = w.repos.guardianLinks.listByGuardian;
    w.repos.guardianLinks.listByGuardian = async (g) => (reads++, list(g));
    await w.service.listWards('parent', as('stu')).catch(() => {});
    expect(reads).toBe(0);
  });

  it('requires an actor', async () => {
    await expect(seeded().service.listWards('parent')).rejects.toBeInstanceOf(ActorRequiredError);
  });
});

describe('GuardianService.guardiansOfSection (who to notify)', () => {
  const seeded = () =>
    buildWorld({
      seed: [
        link('parent', 'stu', ['grades', 'announcements']),
        link('parent', 'stu-2', ['announcements']),
        link('parent-2', 'stu-2', ['announcements']),
        link('parent-dropped', 'stu-dropped', ['announcements']),
        link('parent-dropped', 'stu-wait', ['announcements']),
        link('parent-dropped', 'stu-done', ['announcements']),
        link('free-parent', 'stu', ['announcements'], { status: 'revoked', revokedAt: new Date() }),
        link('parent-b', 'stu', ['announcements'], { orgId: 'org-b' }), // corrupt: wrong organization
        link('outsider', 'stu', ['grades']),
      ],
    });

  it('gives one entry per guardian, with their wards in that section, for guardians who hold the scope', async () => {
    const w = seeded();
    expect(await w.service.guardiansOfSection('sec-1', 'announcements', as('teacher'))).toEqual([
      { guardianId: 'parent', wardIds: ['stu', 'stu-2'] },
      { guardianId: 'parent-2', wardIds: ['stu-2'] },
    ]);
  });

  it('follows the scope asked about', async () => {
    const w = seeded();
    expect(await w.service.guardiansOfSection('sec-1', 'grades', as('root'))).toEqual([
      { guardianId: 'parent', wardIds: ['stu'] },
      { guardianId: 'outsider', wardIds: ['stu'] },
    ]);
    expect(await w.service.guardiansOfSection('sec-1', 'schedule', as('root'))).toEqual([]);
  });

  it('leaves out wards who are not active students: dropped, waitlisted and completed', async () => {
    const w = seeded();
    const ids = (await w.service.guardiansOfSection('sec-1', 'announcements', as('root'))).map((r) => r.guardianId);
    expect(ids).not.toContain('parent-dropped');
  });

  it('leaves out revoked links, and links from another organization', async () => {
    const w = seeded();
    const ids = (await w.service.guardiansOfSection('sec-1', 'announcements', as('root'))).map((r) => r.guardianId);
    expect(ids).not.toContain('free-parent');
    expect(ids).not.toContain('parent-b');
  });

  it('agrees with the read side: everyone listed can read the guardian channel, with the same rule', async () => {
    const w = seeded();
    for (const r of await w.service.guardiansOfSection('sec-1', 'announcements', as('root'))) {
      for (const wardId of r.wardIds) {
        await expect(
          authorizeInSection(w.policy, w.repos, 'communication.viewGuardianAnnouncements', as(r.guardianId), { sectionId: 'sec-1', ownerId: wardId }),
        ).resolves.toBeDefined();
      }
    }
  });

  it.each(['teacher', 'root'])('lets %s (an instructor of the section, or an admin) ask', async (who) => {
    const w = seeded();
    await expect(w.service.guardiansOfSection('sec-1', 'announcements', as(who))).resolves.toBeDefined();
  });

  it.each(['ta', 'stu', 'parent', 'teacher-2', 'root-b', 'outsider', 'nobody'])('refuses %s, and reads nothing', async (who) => {
    const w = seeded();
    await expect(w.service.guardiansOfSection('sec-1', 'announcements', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = seeded();
    await expect(w.service.guardiansOfSection(sectionId, 'announcements', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses a scope that does not exist', async () => {
    const w = seeded();
    await expect(w.service.guardiansOfSection('sec-1', 'everything' as never, as('root'))).rejects.toBeInstanceOf(InvalidGuardianLinkError);
  });

  it('asks the policy about guardian.listRecipients in the section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.guardiansOfSection('sec-1', 'announcements', as('teacher')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['guardian.listRecipients']);
    expect(seen[0]!.ctx.section?.role).toBe('instructor');
  });

  it('requires an actor and reads nothing without one', async () => {
    const w = seeded();
    let reads = 0;
    const list = w.repos.guardianLinks.listByWard;
    w.repos.guardianLinks.listByWard = async (id) => (reads++, list(id));
    await expect(w.service.guardiansOfSection('sec-1', 'announcements')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(reads).toBe(0);
  });
});
