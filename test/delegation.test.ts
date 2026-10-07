import { describe, it, expect } from 'bun:test';
import { DelegationService, ActionNotDelegableError, NotAnActiveTaError } from '../src/domains/delegation/index.js';
import { EnrollmentService } from '../src/domains/enrollment/index.js';
import { createRolePolicy, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
import type {
  Enrollment,
  Identity,
  PermissionContext,
  PermissionPolicy,
  RepositoryContext,
  Role,
  TaGrant,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });

/**
 * Two organizations. sec-1 and sec-2 belong to org-a. Everyone below is an org-a person unless
 * noted. Enrollment lookups return the MOST RECENT record for a user and section, like a real
 * repository should once someone has been dropped and re-enrolled.
 */
async function buildWorld(opts: { policy?: PermissionPolicy; delegationRepo?: boolean } = {}) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  for (const id of ['teacher', 'teacher-2']) add(id, ['instructor']);
  for (const id of ['ta', 'ta2', 'ta-both', 'ta-dropped', 'ta-waitlisted']) add(id, ['ta']);
  for (const id of ['stu', 'newbie', 'newbie2']) add(id, ['student']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');

  const enrollments: Enrollment[] = [];
  let en = 0;
  const repos: RepositoryContext = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : null),
      findSection: async (id) =>
        ['sec-1', 'sec-2'].includes(id) ? { id, courseId: 'course-a', status: 'published' as const } : null,
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
  const seed = async (userId: string, sectionId: string, role: Role, status: Enrollment['status'] = 'active') =>
    repos.enrollments.create({ userId, sectionId, role, status, enrolledAt: new Date() });
  await seed('teacher', 'sec-1', 'instructor');
  await seed('teacher-2', 'sec-2', 'instructor');
  const taEnrollment = await seed('ta', 'sec-1', 'ta');
  await seed('ta2', 'sec-1', 'ta');
  await seed('ta-both', 'sec-1', 'ta');
  await seed('ta-both', 'sec-2', 'ta');
  await seed('ta-dropped', 'sec-1', 'ta', 'dropped');
  await seed('ta-waitlisted', 'sec-1', 'ta', 'waitlisted');
  const stuEnrollment = await seed('stu', 'sec-1', 'student');

  // Delegations, in memory. A test can replace the lookup to make the repository misbehave.
  const grants: TaGrant[] = [];
  const calls = { create: 0, revoke: 0 };
  let gn = 0;
  let activeLookup: (enrollmentId: string) => TaGrant[] = (id) =>
    grants.filter((g) => g.enrollmentId === id && g.revokedAt === undefined);
  const delegations = {
    create: async (g: Omit<TaGrant, 'id'>) => {
      calls.create++;
      const grant: TaGrant = { ...g, id: `grant-${++gn}` };
      grants.push(grant);
      return grant;
    },
    findById: async (id: string) => grants.find((g) => g.id === id) ?? null,
    listActiveForEnrollment: async (enrollmentId: string) => activeLookup(enrollmentId),
    revoke: async (id: string, at: Date) => {
      calls.revoke++;
      const i = grants.findIndex((g) => g.id === id);
      grants[i] = { ...grants[i]!, revokedAt: at };
      return grants[i]!;
    },
  };
  if (opts.delegationRepo !== false) repos.delegations = delegations;

  const policy = opts.policy ?? createRolePolicy();
  const enrollment = new EnrollmentService(repos, undefined, { policy });
  const delegation = new DelegationService(repos as never, { policy });

  /** Writes a grant straight into the store, bypassing the service (for misbehaving-repo tests). */
  const insertGrant = (g: Partial<TaGrant> & Pick<TaGrant, 'enrollmentId' | 'action'>): TaGrant => {
    const grant: TaGrant = {
      id: `grant-${++gn}`,
      sectionId: 'sec-1',
      grantedBy: 'teacher',
      grantedAt: new Date(),
      ...g,
    };
    grants.push(grant);
    return grant;
  };

  return {
    enrollment,
    delegation,
    repos,
    users,
    enrollments,
    grants,
    calls,
    taEnrollment,
    stuEnrollment,
    insertGrant,
    setActiveLookup: (fn: typeof activeLookup) => {
      activeLookup = fn;
    },
  };
}

type World = Awaited<ReturnType<typeof buildWorld>>;
const NEWBIE = { userId: 'newbie', sectionId: 'sec-1', role: 'student' as Role };
const BOTH = ['enrollment.enroll', 'enrollment.grantRole.student'];
const giveBoth = async (w: World, to = 'ta', by = 'teacher') => {
  for (const action of BOTH) await w.delegation.grant('sec-1', to, action, as(by));
};

describe('DelegationService.grant', () => {
  it('lets an instructor hand a delegable action to a TA in their section', async () => {
    const w = await buildWorld();
    const grant = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    expect(grant).toMatchObject({
      enrollmentId: w.taEnrollment.id,
      sectionId: 'sec-1',
      action: 'content.manage',
      grantedBy: 'teacher',
    });
    expect(grant.revokedAt).toBeUndefined();
    expect(w.grants).toHaveLength(1);
  });

  it('lets an admin who is not enrolled do the same', async () => {
    const w = await buildWorld();
    await expect(w.delegation.grant('sec-1', 'ta', 'content.manage', as('root'))).resolves.toMatchObject({ grantedBy: 'root' });
  });

  it('refuses without an actor and stores nothing', async () => {
    const w = await buildWorld();
    await expect(w.delegation.grant('sec-1', 'ta', 'content.manage')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.create).toBe(0);
  });

  it.each(['ta', 'ta2', 'stu', 'teacher-2', 'root-b', 'nobody'])('refuses %s, and stores nothing', async (who) => {
    const w = await buildWorld();
    await expect(w.delegation.grant('sec-1', 'ta', 'content.manage', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('answers an unknown section exactly like a forbidden one', async () => {
    const w = await buildWorld();
    const missing = await w.delegation.grant('no-such', 'ta', 'content.manage', as('teacher')).catch((e: unknown) => e);
    const forbidden = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('stu')).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect((missing as Error).message).toBe((forbidden as Error).message);
  });

  it('checks authorization before anything about the action or the target', async () => {
    const w = await buildWorld();
    // a student asking to delegate a non-delegable action to a non-TA learns nothing but "not permitted"
    const err = await w.delegation.grant('sec-1', 'stu', 'enrollment.bulkEnroll', as('stu')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
  });

  it.each(['enrollment.bulkEnroll', 'grading.record', 'enrollment.grantRole.ta', 'enrollment.grantRole.instructor', 'delegation.grant', 'admin.viewAuditLog', 'no.such.action'])(
    'refuses to delegate %s, even for an admin, and stores nothing',
    async (action) => {
      const w = await buildWorld();
      for (const who of ['teacher', 'root']) {
        await expect(w.delegation.grant('sec-1', 'ta', action, as(who))).rejects.toBeInstanceOf(ActionNotDelegableError);
      }
      expect(w.calls.create).toBe(0);
    },
  );

  it('delegates nothing when the policy does not say which actions are delegable (fails closed)', async () => {
    const opaque: PermissionPolicy = { can: () => true };
    const w = await buildWorld({ policy: opaque });
    await expect(w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'))).rejects.toBeInstanceOf(ActionNotDelegableError);
    expect(w.calls.create).toBe(0);
  });

  it('refuses to delegate an action the grantor does not hold themselves', async () => {
    const policy = createRolePolicy({ overrides: { 'content.manage': { roles: ['admin'], delegable: true } } });
    const w = await buildWorld({ policy });
    await expect(w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
    await expect(w.delegation.grant('sec-1', 'ta', 'content.manage', as('root'))).resolves.toMatchObject({ action: 'content.manage' });
  });

  it.each(['stu', 'newbie', 'teacher', 'ta-dropped', 'ta-waitlisted', 'nobody'])(
    'refuses a target who is not an active TA in the section (%s)',
    async (target) => {
      const w = await buildWorld();
      await expect(w.delegation.grant('sec-1', target, 'content.manage', as('teacher'))).rejects.toBeInstanceOf(NotAnActiveTaError);
      expect(w.calls.create).toBe(0);
    },
  );

  it('refuses a TA of a different section', async () => {
    const w = await buildWorld();
    await expect(w.delegation.grant('sec-2', 'ta', 'content.manage', as('teacher-2'))).rejects.toBeInstanceOf(NotAnActiveTaError);
  });

  it('is idempotent: granting twice stores one grant and returns it', async () => {
    const w = await buildWorld();
    const a = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    const b = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    expect(b.id).toBe(a.id);
    expect(w.calls.create).toBe(1);
  });

  it('creates a fresh grant after a revoke', async () => {
    const w = await buildWorld();
    const a = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    await w.delegation.revoke(a.id, as('teacher'));
    const b = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    expect(b.id).not.toBe(a.id);
    expect(w.calls.create).toBe(2);
  });
});

describe('DelegationService.revoke', () => {
  it.each(['teacher', 'root'])('lets %s revoke a grant', async (who) => {
    const w = await buildWorld();
    const g = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    const revoked = await w.delegation.revoke(g.id, as(who));
    expect(revoked.revokedAt).toBeInstanceOf(Date);
  });

  it.each(['ta', 'stu', 'teacher-2', 'root-b', 'nobody'])('refuses %s, and revokes nothing', async (who) => {
    const w = await buildWorld();
    const g = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    await expect(w.delegation.revoke(g.id, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.revoke).toBe(0);
  });

  it('refuses without an actor', async () => {
    const w = await buildWorld();
    const g = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    await expect(w.delegation.revoke(g.id)).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('answers an unknown grant exactly like a forbidden one', async () => {
    const w = await buildWorld();
    const g = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    const missing = await w.delegation.revoke('no-such', as('teacher')).catch((e: unknown) => e);
    const forbidden = await w.delegation.revoke(g.id, as('stu')).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect((missing as Error).message).toBe((forbidden as Error).message);
  });

  it('is idempotent: revoking twice revokes once', async () => {
    const w = await buildWorld();
    const g = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    await w.delegation.revoke(g.id, as('teacher'));
    await expect(w.delegation.revoke(g.id, as('teacher'))).resolves.toMatchObject({ id: g.id });
    expect(w.calls.revoke).toBe(1);
  });

  it('refuses an instructor of a different section', async () => {
    const w = await buildWorld();
    const g = await w.delegation.grant('sec-1', 'ta-both', 'content.manage', as('teacher'));
    await expect(w.delegation.revoke(g.id, as('teacher-2'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('DelegationService.list', () => {
  const setup = async () => {
    const w = await buildWorld();
    await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    await w.delegation.grant('sec-1', 'ta', 'communication.postAnnouncement', as('teacher'));
    await w.delegation.grant('sec-1', 'ta2', 'content.manage', as('teacher'));
    return w;
  };

  it.each(['teacher', 'root', 'ta'])('lets %s see the TA\'s active grants', async (who) => {
    const w = await setup();
    const list = await w.delegation.list('sec-1', 'ta', as(who));
    expect(list.map((g) => g.action).sort()).toEqual(['communication.postAnnouncement', 'content.manage']);
  });

  it.each(['ta2', 'stu', 'teacher-2', 'root-b', 'nobody'])('refuses %s', async (who) => {
    const w = await setup();
    await expect(w.delegation.list('sec-1', 'ta', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('lists only active grants', async () => {
    const w = await setup();
    const [first] = await w.delegation.list('sec-1', 'ta', as('teacher'));
    await w.delegation.revoke(first!.id, as('teacher'));
    expect(await w.delegation.list('sec-1', 'ta', as('teacher'))).toHaveLength(1);
  });

  it('returns nothing for someone who is not an active TA there', async () => {
    const w = await setup();
    expect(await w.delegation.list('sec-1', 'stu', as('teacher'))).toEqual([]);
    expect(await w.delegation.list('sec-1', 'ta-dropped', as('teacher'))).toEqual([]);
  });

  it('refuses without an actor', async () => {
    const w = await setup();
    await expect(w.delegation.list('sec-1', 'ta')).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('shows nothing for a dropped TA or a student even if grants are stored against their enrollment', async () => {
    const w = await setup();
    const dropped = w.enrollments.find((e) => e.userId === 'ta-dropped')!;
    w.insertGrant({ enrollmentId: dropped.id, action: 'content.manage' });
    w.insertGrant({ enrollmentId: w.stuEnrollment.id, action: 'content.manage' });
    expect(await w.delegation.list('sec-1', 'ta-dropped', as('teacher'))).toEqual([]);
    expect(await w.delegation.list('sec-1', 'stu', as('teacher'))).toEqual([]);
  });

  it('does not trust a repository that returns other TAs\', other sections\' or revoked grants', async () => {
    const w = await setup();
    const ta2 = w.enrollments.find((e) => e.userId === 'ta2')!;
    const mine = w.enrollments.find((e) => e.userId === 'ta' && e.sectionId === 'sec-1')!;
    const wrong = [
      w.insertGrant({ enrollmentId: ta2.id, action: 'content.manage' }),
      w.insertGrant({ enrollmentId: mine.id, action: 'content.manage', sectionId: 'sec-2' }),
      w.insertGrant({ enrollmentId: mine.id, action: 'content.manage', revokedAt: new Date() }),
    ];
    const real = w.grants.filter((g) => g.enrollmentId === mine.id && g.sectionId === 'sec-1' && g.revokedAt === undefined);
    w.setActiveLookup(() => [...wrong, ...real]);
    const list = await w.delegation.list('sec-1', 'ta', as('teacher'));
    expect(list.map((g) => g.id).sort()).toEqual(real.map((g) => g.id).sort());
  });
});

describe('DelegationService.grant with a misbehaving repository', () => {
  it('never hands back someone else\'s grant as the existing one, it creates the TA\'s own', async () => {
    const w = await buildWorld();
    const ta2 = w.enrollments.find((e) => e.userId === 'ta2')!;
    const theirs = w.insertGrant({ enrollmentId: ta2.id, action: 'content.manage' });
    w.setActiveLookup(() => [theirs]); // asked about ta, the repo answers with ta2's grant
    const grant = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    expect(grant.id).not.toBe(theirs.id);
    expect(grant.enrollmentId).toBe(w.taEnrollment.id);
    expect(w.calls.create).toBe(1);
  });

  it('does not treat a revoked or other-section grant as already granted', async () => {
    const w = await buildWorld();
    const stale = [
      w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'content.manage', revokedAt: new Date() }),
      w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'content.manage', sectionId: 'sec-2' }),
    ];
    w.setActiveLookup(() => stale);
    const grant = await w.delegation.grant('sec-1', 'ta', 'content.manage', as('teacher'));
    expect(stale.map((g) => g.id)).not.toContain(grant.id);
    expect(w.calls.create).toBe(1);
  });
});

describe('what a delegated grant actually lets a TA do (through EnrollmentService)', () => {
  it('a TA with no grants cannot enroll anyone', async () => {
    const w = await buildWorld();
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('needs both enroll and the student grant: either one alone is not enough', async () => {
    const w = await buildWorld();
    await w.delegation.grant('sec-1', 'ta', 'enrollment.enroll', as('teacher'));
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    const w2 = await buildWorld();
    await w2.delegation.grant('sec-1', 'ta', 'enrollment.grantRole.student', as('teacher'));
    await expect(w2.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('with both, the TA can enroll a student, but not a TA or an instructor', async () => {
    const w = await buildWorld();
    await giveBoth(w);
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).resolves.toMatchObject({ userId: 'newbie', role: 'student' });
    for (const role of ['ta', 'instructor', 'admin'] as const) {
      await expect(w.enrollment.enroll({ ...NEWBIE, userId: 'newbie2', role }, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
  });

  it('does not let the TA do anything else: bulk enroll, drop, or manage delegation', async () => {
    const w = await buildWorld();
    await giveBoth(w);
    await expect(w.enrollment.bulkEnroll('sec-1', [], as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.enrollment.drop(w.stuEnrollment.id, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.delegation.grant('sec-1', 'ta2', 'content.manage', as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('does not apply to a different TA', async () => {
    const w = await buildWorld();
    await giveBoth(w, 'ta');
    await expect(w.enrollment.enroll(NEWBIE, as('ta2'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('does not apply in a different section', async () => {
    const w = await buildWorld();
    await giveBoth(w, 'ta-both');
    await expect(w.enrollment.enroll(NEWBIE, as('ta-both'))).resolves.toBeDefined();
    await expect(w.enrollment.enroll({ ...NEWBIE, userId: 'newbie2', sectionId: 'sec-2' }, as('ta-both'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('stops working the moment it is revoked', async () => {
    const w = await buildWorld();
    await giveBoth(w);
    const [first] = await w.delegation.list('sec-1', 'ta', as('teacher'));
    await w.delegation.revoke(first!.id, as('teacher'));
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('ends with the TA\'s enrollment: a re-enrolled TA starts with nothing', async () => {
    const w = await buildWorld();
    await giveBoth(w);
    await w.enrollment.drop(w.taEnrollment.id, as('teacher'));
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError); // dropped
    const again = await w.enrollment.enroll({ userId: 'ta', sectionId: 'sec-1', role: 'ta' }, as('teacher'));
    expect(again.id).not.toBe(w.taEnrollment.id);
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError); // grants did not carry over
    await giveBoth(w); // the instructor can hand them out again
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).resolves.toBeDefined();
  });

  it('is ignored when a grant was stored for an action that is not delegable', async () => {
    const w = await buildWorld();
    w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'enrollment.bulkEnroll' });
    w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'enrollment.grantRole.ta' });
    w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'enrollment.enroll' });
    await expect(w.enrollment.bulkEnroll('sec-1', [], as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.enrollment.enroll({ ...NEWBIE, role: 'ta' }, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('gives a student nothing, even if the repository hands back grants for them', async () => {
    const w = await buildWorld();
    const sneaky = w.insertGrant({ enrollmentId: w.stuEnrollment.id, action: 'enrollment.enroll' });
    w.insertGrant({ enrollmentId: w.stuEnrollment.id, action: 'enrollment.grantRole.student' });
    w.setActiveLookup(() => w.grants.filter((g) => g.id !== 'none'));
    expect(sneaky.enrollmentId).toBe(w.stuEnrollment.id);
    await expect(w.enrollment.enroll(NEWBIE, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('does not trust a repository that returns another TA\'s, another section\'s, or a revoked grant', async () => {
    const w = await buildWorld();
    const ta2Enrollment = w.enrollments.find((e) => e.userId === 'ta2')!;
    const taBothSec2 = w.enrollments.find((e) => e.userId === 'ta-both' && e.sectionId === 'sec-2')!;
    const otherTa = BOTH.map((action) => w.insertGrant({ enrollmentId: ta2Enrollment.id, action }));
    const otherSection = BOTH.map((action) => w.insertGrant({ enrollmentId: w.taEnrollment.id, action, sectionId: 'sec-2' }));
    const revoked = BOTH.map((action) => w.insertGrant({ enrollmentId: w.taEnrollment.id, action, revokedAt: new Date() }));
    const sec2Grants = BOTH.map((action) => w.insertGrant({ enrollmentId: taBothSec2.id, action, sectionId: 'sec-2' }));
    expect(sec2Grants).toHaveLength(2);
    w.setActiveLookup(() => [...otherTa, ...otherSection, ...revoked]); // whatever TA 'ta' asks for
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    w.setActiveLookup(() => sec2Grants); // grants that belong to ta-both's sec-2 enrollment
    await expect(w.enrollment.enroll(NEWBIE, as('ta-both'))).rejects.toBeInstanceOf(PermissionDeniedError); // asked in sec-1
  });

  it('gives a custom policy only grants that check out, and only for a TA', async () => {
    const seen: Array<unknown> = [];
    const spy: PermissionPolicy = {
      can: (_a: string, ctx: PermissionContext) => (seen.push(ctx.section?.delegated), false),
    };
    const w = await buildWorld({ policy: spy });
    w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'content.manage' });
    w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'enrollment.enroll', revokedAt: new Date() });
    w.insertGrant({ enrollmentId: 'enr-other', action: 'communication.postAnnouncement' });
    w.insertGrant({ enrollmentId: w.taEnrollment.id, action: 'enrollment.grantRole.student', sectionId: 'sec-2' });
    w.setActiveLookup(() => w.grants.filter(() => true));
    await w.enrollment.enroll(NEWBIE, as('ta')).catch(() => {});
    expect(seen).toEqual([['content.manage']]);

    seen.length = 0;
    await w.enrollment.enroll(NEWBIE, as('stu')).catch(() => {});
    expect(seen).toEqual([undefined]); // a student's context carries no delegated grants at all
  });

  it('fails closed when the host has not configured a delegation repository', async () => {
    const w = await buildWorld({ delegationRepo: false });
    for (const action of BOTH) w.insertGrant({ enrollmentId: w.taEnrollment.id, action });
    await expect(w.enrollment.enroll(NEWBIE, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('does not look grants up for anyone who is not a TA', async () => {
    const w = await buildWorld();
    let lookups = 0;
    w.setActiveLookup(() => (lookups++, []));
    await w.enrollment.listRoster('sec-1', undefined, as('teacher')).catch(() => {});
    await w.enrollment.listRoster('sec-1', undefined, as('stu')).catch(() => {});
    await w.enrollment.listRoster('sec-1', undefined, as('root')).catch(() => {});
    expect(lookups).toBe(0);
    await w.enrollment.listRoster('sec-1', undefined, as('ta')).catch(() => {});
    expect(lookups).toBe(1);
  });
});
