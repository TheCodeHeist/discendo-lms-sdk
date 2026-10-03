import { describe, it, expect } from 'bun:test';
import { EnrollmentService } from '../src/domains/enrollment/index.js';
import {
  EventBus,
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
  TenantMismatchError,
} from '../src/core/index.js';
import type {
  RepositoryContext,
  Enrollment,
  Identity,
  Role,
  PermissionPolicy,
  LmsEvent,
} from '../src/core/index.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A small world: two organizations, a few sections, and people in different positions. */
/** `null` means no policy at all (enforcement off); omitting the argument uses the default role policy. */
async function buildWorld(policy: PermissionPolicy | null = createRolePolicy()) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId: string, externalRef?: string) => {
    const u: Identity = externalRef === undefined ? { id, roles, orgId } : { id, roles, orgId, externalRef };
    users.set(id, u);
    return u;
  };
  add('root', ['admin'], 'org-a');
  add('root-b', ['admin'], 'org-b');
  add('teacher', ['instructor'], 'org-a');
  add('teacher-2', ['instructor'], 'org-a'); // instructor only in sec-a2
  add('ta', ['ta'], 'org-a');
  add('stu', ['student'], 'org-a');
  add('stu-2', ['student'], 'org-a');
  add('newbie', ['student'], 'org-a', 'ext-newbie');
  add('former-teacher', ['instructor'], 'org-a');
  add('outsider', ['student'], 'org-b');

  const courses = new Map([
    ['course-a', { id: 'course-a', title: 'A', orgId: 'org-a' }],
    ['course-b', { id: 'course-b', title: 'B', orgId: 'org-b' }],
    ['course-open', { id: 'course-open', title: 'Open' }],
  ]);
  const sections = new Map([
    ['sec-a1', { id: 'sec-a1', courseId: 'course-a', status: 'published' as const }],
    ['sec-a2', { id: 'sec-a2', courseId: 'course-a', status: 'published' as const }],
    ['sec-b', { id: 'sec-b', courseId: 'course-b', status: 'published' as const }],
    ['sec-open', { id: 'sec-open', courseId: 'course-open', status: 'published' as const }],
    ['sec-orphan', { id: 'sec-orphan', courseId: 'missing-course', status: 'published' as const }],
  ]);
  const store = new Map<string, Enrollment>();
  let n = 0;
  const calls = { findByExternalRef: 0, update: 0, create: 0 };

  const repos: RepositoryContext = {
    users: {
      findById: async (id) => users.get(id) ?? null,
      findByExternalRef: async (ref) => {
        calls.findByExternalRef++;
        return [...users.values()].find((u) => u.externalRef === ref) ?? null;
      },
    },
    courses: {
      findCourse: async (id) => courses.get(id) ?? null,
      findSection: async (id) => sections.get(id) ?? null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => {
        calls.create++;
        const entry: Enrollment = { ...e, id: `enr-${++n}` };
        store.set(entry.id, entry);
        return entry;
      },
      findById: async (id) => store.get(id) ?? null,
      update: async (id, patch) => {
        calls.update++;
        const updated = { ...store.get(id)!, ...patch };
        store.set(id, updated);
        return updated;
      },
      findByUserAndSection: async (userId, sectionId) =>
        [...store.values()].find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId, status) =>
        [...store.values()].filter((e) => e.sectionId === sectionId && (status === undefined || e.status === status)),
      countActive: async (sectionId) =>
        [...store.values()].filter((e) => e.sectionId === sectionId && e.status === 'active').length,
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

  // Seed memberships directly through the repository (no service, no permission checks).
  const seed = (userId: string, sectionId: string, role: Role, status: Enrollment['status'] = 'active') =>
    repos.enrollments.create({ userId, sectionId, role, status, enrolledAt: new Date() });
  await seed('teacher', 'sec-a1', 'instructor');
  await seed('teacher-2', 'sec-a2', 'instructor');
  await seed('ta', 'sec-a1', 'ta');
  const stuEnrollment = await seed('stu', 'sec-a1', 'student');
  const stu2Enrollment = await seed('stu-2', 'sec-a1', 'student');
  await seed('former-teacher', 'sec-a1', 'instructor', 'dropped');
  calls.create = 0; // count only what the tests do

  const bus = new EventBus();
  const events: LmsEvent[] = [];
  bus.on('*', (e) => events.push(e));

  const service = new EnrollmentService(repos, bus, policy ? { policy } : {});
  return { service, repos, users, store, calls, events, stuEnrollment, stu2Enrollment, sections };
}

const as = (actorId: string) => ({ actorId });
const NEWBIE = { userId: 'newbie', sectionId: 'sec-a1', role: 'student' as Role };

describe('EnrollmentService permissions: enabling enforcement', () => {
  it('behaves exactly as before when no policy is configured (no actor needed)', async () => {
    const w = await buildWorld(null);
    await expect(w.service.enroll(NEWBIE)).resolves.toMatchObject({ status: 'active' });
    // 5 seeded (including one dropped) + the one just enrolled
    await expect(w.service.listRoster('sec-a1')).resolves.toHaveLength(6);
  });

  it('with a policy, every method refuses to run without an actor', async () => {
    const w = await buildWorld();
    const before = w.store.size;
    await expect(w.service.enroll(NEWBIE)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.drop(w.stuEnrollment.id)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.listRoster('sec-a1')).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.bulkEnroll('sec-a1', [{ userExternalRef: 'ext-newbie', role: 'student' }])).rejects.toBeInstanceOf(
      ActorRequiredError,
    );
    expect(w.store.size).toBe(before);
    expect(w.store.get(w.stuEnrollment.id)!.status).toBe('active');
  });

  it('reports a missing actor as a bug (ActorRequiredError), not as a permission denial', async () => {
    const w = await buildWorld();
    const err = await w.service.enroll(NEWBIE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActorRequiredError);
    expect(err).not.toBeInstanceOf(PermissionDeniedError);
  });

  it('looks up nothing before noticing the actor is missing', async () => {
    const w = await buildWorld();
    await w.service.bulkEnroll('sec-a1', [{ userExternalRef: 'ext-newbie', role: 'student' }]).catch(() => {});
    expect(w.calls.findByExternalRef).toBe(0);
  });
});

describe('EnrollmentService permissions: enroll', () => {
  it('lets an instructor of the section enroll a student', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('teacher'))).resolves.toMatchObject({ userId: 'newbie', status: 'active' });
  });

  it('lets a same-organization admin enroll, without being enrolled themselves', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('root'))).resolves.toMatchObject({ status: 'active' });
  });

  it.each(['ta', 'stu', 'stu-2'])('refuses %s', async (actorId) => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as(actorId))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('refuses an instructor of a DIFFERENT section, whatever their account role says', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('teacher-2'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses an instructor whose enrollment was dropped', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('former-teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("refuses an admin from another organization", async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('root-b'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('refuses an unknown actor', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('nobody'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses an unknown actor on an UNSCOPED course too, where no organization check can catch them', async () => {
    const w = await buildWorld();
    const open = { userId: 'newbie', sectionId: 'sec-open', role: 'student' as Role };
    await expect(w.service.enroll(open, as('nobody'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
    // ...while a real admin can use the same unscoped course.
    await expect(w.service.enroll(open, as('root'))).resolves.toMatchObject({ status: 'active' });
  });

  it('still applies the target-user tenant check to an authorized actor', async () => {
    const w = await buildWorld();
    await expect(
      w.service.enroll({ userId: 'outsider', sectionId: 'sec-a1', role: 'student' }, as('teacher')),
    ).rejects.toBeInstanceOf(TenantMismatchError);
  });

  it('emits no event and creates nothing when refused', async () => {
    const w = await buildWorld();
    await w.service.enroll(NEWBIE, as('stu')).catch(() => {});
    await flush();
    expect(w.events).toEqual([]);
    expect(w.calls.create).toBe(0);
  });

  it('takes effect immediately when an admin is demoted (actor is read from the repository)', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll(NEWBIE, as('root'))).resolves.toBeDefined();
    w.users.set('root', { id: 'root', roles: ['student'], orgId: 'org-a' });
    await expect(
      w.service.enroll({ userId: 'stu-2', sectionId: 'sec-a2', role: 'student' }, as('root')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('EnrollmentService permissions: no probing for what exists', () => {
  it('does not reveal an existing enrollment to someone who may not enroll (idempotent shortcut)', async () => {
    const w = await buildWorld();
    // stu-2 is already enrolled in sec-a1; a student asking must be refused, not handed the record.
    await expect(
      w.service.enroll({ userId: 'stu-2', sectionId: 'sec-a1', role: 'student' }, as('stu')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('answers a missing section with the same denial an existing-but-forbidden one gets, for everyone', async () => {
    const w = await buildWorld();
    for (const actorId of ['stu', 'teacher', 'root']) {
      const missing = await w.service.enroll({ ...NEWBIE, sectionId: 'no-such' }, as(actorId)).catch((e: unknown) => e);
      expect(missing).toBeInstanceOf(PermissionDeniedError);
      expect((missing as Error).message).not.toContain('not found');
    }
    const forbidden = await w.service.enroll(NEWBIE, as('stu')).catch((e: unknown) => e);
    expect((forbidden as Error).message).toBe('Not permitted: enrollment.enroll');
  });

  it('denies a section whose course cannot be found, because its organization is unknown', async () => {
    const w = await buildWorld();
    await expect(
      w.service.enroll({ userId: 'newbie', sectionId: 'sec-orphan', role: 'student' }, as('root')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('answers a missing enrollment to drop() with a denial for everyone, admins included', async () => {
    const w = await buildWorld();
    for (const actorId of ['stu', 'root']) {
      await expect(w.service.drop('no-such-enrollment', as(actorId))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect(w.calls.update).toBe(0);
  });
});

describe('EnrollmentService permissions: role escalation', () => {
  it('lets an instructor grant ta and student', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll({ ...NEWBIE, role: 'ta' }, as('teacher'))).resolves.toMatchObject({ role: 'ta' });
    await expect(
      w.service.enroll({ userId: 'outsider-free', sectionId: 'sec-a1', role: 'student' }, as('teacher')),
    ).rejects.not.toBeInstanceOf(PermissionDeniedError); // allowed to try; fails later for an unrelated reason (unknown user)
  });

  it.each(['admin', 'instructor'] as const)('refuses an instructor granting %s, and creates nothing', async (role) => {
    const w = await buildWorld();
    await expect(w.service.enroll({ ...NEWBIE, role }, as('teacher'))).rejects.toMatchObject({
      name: 'PermissionDeniedError',
      action: `enrollment.grantRole.${role}`,
    });
    expect(w.calls.create).toBe(0);
  });

  it('refuses an instructor promoting THEMSELVES to admin', async () => {
    const w = await buildWorld();
    await expect(
      w.service.enroll({ userId: 'teacher', sectionId: 'sec-a1', role: 'admin' }, as('teacher')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('lets an admin grant instructor and admin', async () => {
    const w = await buildWorld();
    await expect(w.service.enroll({ ...NEWBIE, role: 'instructor' }, as('root'))).resolves.toMatchObject({ role: 'instructor' });
    await expect(w.service.enroll({ userId: 'stu-2', sectionId: 'sec-a2', role: 'admin' }, as('root'))).resolves.toMatchObject({ role: 'admin' });
  });

  it('lets an institution tighten it: only admins may grant ta', async () => {
    const w = await buildWorld(createRolePolicy({ overrides: { 'enrollment.grantRole.ta': { roles: ['admin'] } } }));
    await expect(w.service.enroll({ ...NEWBIE, role: 'ta' }, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.enroll({ ...NEWBIE, role: 'ta' }, as('root'))).resolves.toBeDefined();
  });
});

describe('EnrollmentService permissions: a misbehaving policy never opens the door', () => {
  it.each([[undefined], ['yes'], [1], [{}]])('treats a policy answer of %p as a denial', async (answer) => {
    const w = await buildWorld({ can: (() => answer) as never });
    await expect(w.service.enroll(NEWBIE, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.create).toBe(0);
  });

  it('lets a throwing policy abort the call without enrolling anyone', async () => {
    const w = await buildWorld({
      can: () => {
        throw new Error('policy backend down');
      },
    });
    await expect(w.service.enroll(NEWBIE, as('root'))).rejects.toThrow('policy backend down');
    expect(w.calls.create).toBe(0);
  });

  it('supports an async custom policy', async () => {
    const w = await buildWorld({ can: async (_a, ctx) => ctx.actor.id === 'root' });
    await expect(w.service.enroll(NEWBIE, as('root'))).resolves.toBeDefined();
    await expect(w.service.enroll({ ...NEWBIE, userId: 'stu-2', sectionId: 'sec-a2' }, as('teacher'))).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});

describe('EnrollmentService permissions: drop', () => {
  it('lets a student drop themselves', async () => {
    const w = await buildWorld();
    await expect(w.service.drop(w.stuEnrollment.id, as('stu'))).resolves.toMatchObject({ status: 'dropped' });
  });

  it("refuses a student dropping a classmate, and leaves them enrolled", async () => {
    const w = await buildWorld();
    await expect(w.service.drop(w.stu2Enrollment.id, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.store.get(w.stu2Enrollment.id)!.status).toBe('active');
    expect(w.calls.update).toBe(0);
  });

  it('lets an instructor drop a student but not a TA', async () => {
    const w = await buildWorld();
    await expect(w.service.drop(w.stu2Enrollment.id, as('teacher'))).resolves.toMatchObject({ status: 'dropped' });
    await expect(w.service.drop(w.stuEnrollment.id, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("refuses another organization's admin and another section's instructor", async () => {
    const w = await buildWorld();
    await expect(w.service.drop(w.stuEnrollment.id, as('root-b'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.drop(w.stuEnrollment.id, as('teacher-2'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.store.get(w.stuEnrollment.id)!.status).toBe('active');
  });

  it('emits no event when refused', async () => {
    const w = await buildWorld();
    await w.service.drop(w.stu2Enrollment.id, as('stu')).catch(() => {});
    await flush();
    expect(w.events).toEqual([]);
  });
});

describe('EnrollmentService permissions: listRoster', () => {
  it.each(['teacher', 'ta', 'root'])('allows %s', async (actorId) => {
    const w = await buildWorld();
    await expect(w.service.listRoster('sec-a1', undefined, as(actorId))).resolves.toBeArray();
  });

  it.each(['stu', 'teacher-2', 'former-teacher', 'root-b', 'nobody'])('refuses %s', async (actorId) => {
    const w = await buildWorld();
    await expect(w.service.listRoster('sec-a1', undefined, as(actorId))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('denies a missing section, admins included', async () => {
    const w = await buildWorld();
    await expect(w.service.listRoster('no-such', undefined, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('passes the status filter through for an authorized actor', async () => {
    const w = await buildWorld();
    const dropped = await w.service.listRoster('sec-a1', 'dropped', as('root'));
    expect(dropped.map((e) => e.userId)).toEqual(['former-teacher']);
  });
});

describe('EnrollmentService permissions: bulkEnroll', () => {
  const rows = (role: Role) => [{ userExternalRef: 'ext-newbie', role }];

  it('is admin-only by default', async () => {
    const w = await buildWorld();
    await expect(w.service.bulkEnroll('sec-a1', rows('student'), as('root'))).resolves.toMatchObject({ succeeded: 1 });
    const w2 = await buildWorld();
    await expect(w2.service.bulkEnroll('sec-a1', rows('student'), as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w2.calls.findByExternalRef).toBe(0);
  });

  it('checks each row\'s role, reports the refused ones, and carries on with the rest', async () => {
    const w = await buildWorld(createRolePolicy({ overrides: { 'enrollment.bulkEnroll': { roles: ['admin', 'instructor'] } } }));
    const report = await w.service.bulkEnroll(
      'sec-a1',
      [
        { userExternalRef: 'ext-newbie', role: 'admin' }, // instructor may not grant admin
        { userExternalRef: 'ext-newbie', role: 'student' },
      ],
      as('teacher'),
    );
    expect(report.succeeded).toBe(1);
    expect(report.failed).toEqual([{ row: { userExternalRef: 'ext-newbie', role: 'admin' }, reason: 'not permitted' }]);
    expect([...w.store.values()].filter((e) => e.userId === 'newbie').map((e) => e.role)).toEqual(['student']);
  });

  it('treats a policy that throws on a row as "not permitted" for that row only', async () => {
    const base = createRolePolicy();
    const w = await buildWorld({
      can: (action, ctx) => {
        if (action === 'enrollment.grantRole.ta') throw new Error('boom');
        return base.can(action, ctx);
      },
    });
    const report = await w.service.bulkEnroll(
      'sec-a1',
      [
        { userExternalRef: 'ext-newbie', role: 'ta' },
        { userExternalRef: 'ext-newbie', role: 'student' },
      ],
      as('root'),
    );
    expect(report.succeeded).toBe(1);
    expect(report.failed[0]!.reason).toBe('not permitted');
  });

  it('never reveals "user not found" for a role the actor may not grant', async () => {
    const w = await buildWorld(createRolePolicy({ overrides: { 'enrollment.bulkEnroll': { roles: ['admin', 'instructor'] } } }));
    const report = await w.service.bulkEnroll('sec-a1', [{ userExternalRef: 'ext-nobody', role: 'admin' }], as('teacher'));
    expect(report.failed[0]!.reason).toBe('not permitted');
    expect(w.calls.findByExternalRef).toBe(0);
  });
});
