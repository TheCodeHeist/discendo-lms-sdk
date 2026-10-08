import { describe, it, expect } from 'bun:test';
import { EnrollmentService, SectionNotOpenError } from '../src/domains/enrollment/index.js';
import { EventBus, PermissionDeniedError, createRolePolicy, DEFAULT_RULES } from '../src/core/index.js';
import type { CourseSection, Enrollment, Identity, LmsEvent, RepositoryContext, Role } from '../src/core/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));
const as = (actorId: string) => ({ actorId });

type Seed = Partial<Enrollment> & Pick<Enrollment, 'userId' | 'sectionId'>;

/**
 * sec-pub: published, capacity 3, FULL: teacher (instructor), stu, stu-2 are active.
 * sec-open: published, no capacity. sec-draft / sec-arch: capacity 3, with teacher as instructor.
 * Waiting people (w1..w3) and anything else come in through `seeds`.
 */
function buildWorld(
  opts: {
    enforce?: boolean;
    promoteOnDrop?: boolean;
    atomic?: boolean;
    /** a gap inside countActive in which another call can slip in */
    slow?: boolean;
    failPromotionWrites?: boolean;
    /** runs just before the repository's atomic promotion, to let "somebody else" act first */
    beforePromote?: (enrollmentId: string) => void;
    seeds?: Seed[];
  } = {},
) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[]) => users.set(id, { id, roles, orgId: 'org-a' });
  for (const id of ['stu', 'stu-2', 'w1', 'w2', 'w3', 'newbie']) add(id, ['student']);
  add('teacher', ['instructor']);
  add('ta', ['ta']);
  add('root', ['admin']);

  const sections: Record<string, CourseSection> = {
    'sec-pub': { id: 'sec-pub', courseId: 'course-a', status: 'published', capacity: 3 },
    'sec-open': { id: 'sec-open', courseId: 'course-a', status: 'published' },
    'sec-draft': { id: 'sec-draft', courseId: 'course-a', status: 'draft', capacity: 3 },
    'sec-arch': { id: 'sec-arch', courseId: 'course-a', status: 'archived', capacity: 3 },
  };
  const rows: Enrollment[] = [];
  let seq = 0;
  const seed = (e: Seed) =>
    rows.push({ id: `enr-${String(++seq).padStart(2, '0')}`, role: 'student', status: 'active', enrolledAt: new Date('2026-09-01'), ...e });
  for (const s of ['sec-pub', 'sec-draft', 'sec-arch']) seed({ userId: 'teacher', sectionId: s, role: 'instructor' });
  seed({ userId: 'stu', sectionId: 'sec-pub' });
  seed({ userId: 'stu-2', sectionId: 'sec-pub' });
  for (const e of opts.seeds ?? []) seed(e);

  const calls = { update: 0, create: 0, list: 0, createIfSeatFree: 0, promoteIfSeatFree: [] as Array<{ id: string; capacity: number }> };
  const activeIn = (sectionId: string) => rows.filter((r) => r.sectionId === sectionId && r.status === 'active').length;

  const enrollments: RepositoryContext['enrollments'] = {
    create: async (e) => {
      calls.create++;
      const row = { ...e, id: `enr-${String(++seq).padStart(2, '0')}` } as Enrollment;
      rows.push(row);
      return row;
    },
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    update: async (id, patch) => {
      calls.update++;
      if (opts.failPromotionWrites && patch.status === 'active') throw new Error('database is down');
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`no row ${id}`);
      rows[i] = { ...rows[i]!, ...patch };
      return rows[i]!;
    },
    findByUserAndSection: async (userId, sectionId) =>
      [...rows].reverse().find((r) => r.userId === userId && r.sectionId === sectionId) ?? null,
    // Newest first, so a service that relies on the repository's order instead of sorting is caught.
    listBySection: async (sectionId, status) =>
      (calls.list++, rows).filter((r) => r.sectionId === sectionId && (!status || r.status === status)).reverse(),
    countActive: async (sectionId) => {
      const n = activeIn(sectionId);
      if (opts.slow) await sleep();
      return n;
    },
    ...(opts.atomic
      ? {
          createIfSeatFree: (e: Omit<Enrollment, 'id'>, capacity: number) => {
            calls.createIfSeatFree++;
            if (activeIn(e.sectionId) >= capacity) return Promise.resolve(null);
            const row = { ...e, id: `enr-${String(++seq).padStart(2, '0')}` } as Enrollment;
            rows.push(row);
            return Promise.resolve(row);
          },
          promoteIfSeatFree: (id: string, capacity: number) => {
            calls.promoteIfSeatFree.push({ id, capacity });
            opts.beforePromote?.(id);
            const i = rows.findIndex((r) => r.id === id);
            const row = rows[i];
            if (!row || row.status !== 'waitlisted') return Promise.resolve(null);
            if (activeIn(row.sectionId) >= capacity) return Promise.resolve(null);
            rows[i] = { ...row, status: 'active' };
            return Promise.resolve(rows[i]!);
          },
        }
      : {}),
  };

  const repos = {
    users: {
      findById: async (id: string) => users.get(id) ?? null,
      findByExternalRef: async () => null,
    },
    courses: {
      findCourse: async (id: string) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : null),
      findSection: async (id: string) => sections[id] ?? null,
      listSections: async () => [],
    },
    enrollments,
  } as Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'>;

  const bus = new EventBus();
  const events: LmsEvent[] = [];
  bus.on('*', (e) => void events.push(e));
  const service = new EnrollmentService(repos as RepositoryContext, bus, {
    ...(opts.enforce ? { policy: createRolePolicy() } : {}),
    ...(opts.promoteOnDrop ? { promoteOnDrop: true } : {}),
  });
  const row = (userId: string, sectionId = 'sec-pub') => rows.find((r) => r.userId === userId && r.sectionId === sectionId)!;
  /** Frees a seat directly in the store, without going through `drop`. */
  const vacate = (userId: string, sectionId = 'sec-pub') => {
    const r = row(userId, sectionId);
    r.status = 'dropped';
  };
  const promotedEvents = () => events.filter((e) => e.type === 'enrollment.promoted');
  return { service, rows, calls, events, row, vacate, promotedEvents, sections };
}

const waiting = (userId: string, enrolledAt: string, extra: Partial<Enrollment> = {}): Seed => ({
  userId,
  sectionId: 'sec-pub',
  status: 'waitlisted',
  enrolledAt: new Date(enrolledAt),
  ...extra,
});

describe('promoteFromWaitlist: who moves and in what order', () => {
  it('promotes the longest-waiting person first, by enrolledAt, whatever order the repository lists them in', async () => {
    const w = buildWorld({ seeds: [waiting('w2', '2026-09-03'), waiting('w1', '2026-09-02'), waiting('w3', '2026-09-04')] });
    w.vacate('stu');
    const promoted = await w.service.promoteFromWaitlist('sec-pub');
    expect(promoted.map((e) => e.userId)).toEqual(['w1']);
    expect(w.row('w1').status).toBe('active');
    expect(w.row('w2').status).toBe('waitlisted');
    expect(w.row('w3').status).toBe('waitlisted');
  });

  it('breaks a tie on enrolledAt by enrollment id, so the order never depends on the repository', async () => {
    const same = '2026-09-02T10:00:00Z';
    const w = buildWorld({ seeds: [waiting('w3', same), waiting('w1', same), waiting('w2', same)] });
    w.vacate('stu');
    w.vacate('stu-2');
    const promoted = await w.service.promoteFromWaitlist('sec-pub');
    // seeds got ids in the order they were given: w3 first, then w1, then w2
    expect(promoted.map((e) => e.userId)).toEqual(['w3', 'w1']);
  });

  it('fills exactly the free seats, no more', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02'), waiting('w2', '2026-09-03'), waiting('w3', '2026-09-04')] });
    w.vacate('stu');
    w.vacate('stu-2');
    const promoted = await w.service.promoteFromWaitlist('sec-pub');
    expect(promoted.map((e) => e.userId)).toEqual(['w1', 'w2']);
    expect(w.row('w3').status).toBe('waitlisted');
    expect(w.rows.filter((r) => r.sectionId === 'sec-pub' && r.status === 'active')).toHaveLength(3);
  });

  it('does nothing, and writes nothing, when the section is full', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02')] });
    await expect(w.service.promoteFromWaitlist('sec-pub')).resolves.toEqual([]);
    expect(w.calls.update).toBe(0);
    expect(w.calls.list).toBe(0); // no need to read the waitlist when there is no seat for anyone on it
    expect(w.row('w1').status).toBe('waitlisted');
    await sleep();
    expect(w.promotedEvents()).toEqual([]);
  });

  it('promotes nobody when the section is over capacity (it was lowered after people joined)', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02')] });
    w.sections['sec-pub']!.capacity = 1;
    await expect(w.service.promoteFromWaitlist('sec-pub')).resolves.toEqual([]);
    expect(w.calls.update).toBe(0);
    expect(w.calls.list).toBe(0);
  });

  it('does nothing when nobody is waiting', async () => {
    const w = buildWorld();
    w.vacate('stu');
    await expect(w.service.promoteFromWaitlist('sec-pub')).resolves.toEqual([]);
    expect(w.calls.update).toBe(0);
  });

  it('never promotes a dropped, completed or already active enrollment', async () => {
    const w = buildWorld({
      seeds: [waiting('w1', '2026-09-02', { status: 'dropped' }), waiting('w2', '2026-09-02', { status: 'completed' }), waiting('w3', '2026-09-05')],
    });
    w.vacate('stu');
    w.vacate('stu-2');
    const promoted = await w.service.promoteFromWaitlist('sec-pub');
    expect(promoted.map((e) => e.userId)).toEqual(['w3']);
    expect(w.row('w1').status).toBe('dropped');
    expect(w.row('w2').status).toBe('completed');
  });

  it('promotes everyone on the waitlist when the section has no capacity', async () => {
    const w = buildWorld({
      seeds: [
        { userId: 'w1', sectionId: 'sec-open', status: 'waitlisted', enrolledAt: new Date('2026-09-02') },
        { userId: 'w2', sectionId: 'sec-open', status: 'waitlisted', enrolledAt: new Date('2026-09-03') },
      ],
    });
    const promoted = await w.service.promoteFromWaitlist('sec-open');
    expect(promoted.map((e) => e.userId)).toEqual(['w1', 'w2']);
  });

  it('uses a raised capacity: seats that are free now are filled', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02'), waiting('w2', '2026-09-03')] });
    w.sections['sec-pub']!.capacity = 4;
    const promoted = await w.service.promoteFromWaitlist('sec-pub');
    expect(promoted.map((e) => e.userId)).toEqual(['w1']);
  });

  it('is idempotent: a second call promotes nobody and says nothing', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02'), waiting('w2', '2026-09-03')] });
    w.vacate('stu');
    await w.service.promoteFromWaitlist('sec-pub');
    await sleep();
    const updates = w.calls.update;
    await expect(w.service.promoteFromWaitlist('sec-pub')).resolves.toEqual([]);
    await sleep();
    expect(w.calls.update).toBe(updates);
    expect(w.promotedEvents()).toHaveLength(1);
  });

  it('refuses an unknown section', async () => {
    const w = buildWorld();
    await expect(w.service.promoteFromWaitlist('no-such-section')).rejects.toThrow('Section no-such-section not found');
  });
});

describe('promoteFromWaitlist: the event', () => {
  it('emits one enrollment.promoted per person, in promotion order, with who and how', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02'), waiting('w2', '2026-09-03')] });
    w.vacate('stu');
    w.vacate('stu-2');
    const [a, b] = await w.service.promoteFromWaitlist('sec-pub');
    await sleep();
    expect(w.promotedEvents()).toEqual([
      { type: 'enrollment.promoted', enrollmentId: a!.id, userId: 'w1', sectionId: 'sec-pub', previousStatus: 'waitlisted', trigger: 'manual' },
      { type: 'enrollment.promoted', enrollmentId: b!.id, userId: 'w2', sectionId: 'sec-pub', previousStatus: 'waitlisted', trigger: 'manual' },
    ]);
  });

  it('names the actor when permissions are enforced', async () => {
    const w = buildWorld({ enforce: true, seeds: [waiting('w1', '2026-09-02')] });
    w.vacate('stu');
    await w.service.promoteFromWaitlist('sec-pub', as('teacher'));
    await sleep();
    expect(w.promotedEvents()).toMatchObject([{ trigger: 'manual', actorId: 'teacher' }]);
  });

  it('works without a bus', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02')] });
    w.vacate('stu');
    const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments'> = {
      users: { findById: async () => null, findByExternalRef: async () => null },
      courses: { findCourse: async () => null, findSection: async (id) => (id === 'sec-pub' ? w.sections['sec-pub']! : null), listSections: async () => [] },
      enrollments: {
        create: async () => { throw new Error('unused'); },
        findById: async () => null,
        update: async (id, patch) => {
          const r = w.rows.find((x) => x.id === id)!;
          Object.assign(r, patch);
          return r;
        },
        findByUserAndSection: async () => null,
        listBySection: async (s, st) => w.rows.filter((r) => r.sectionId === s && (!st || r.status === st)),
        countActive: async (s) => w.rows.filter((r) => r.sectionId === s && r.status === 'active').length,
      },
    };
    const service = new EnrollmentService(repos as RepositoryContext);
    await expect(service.promoteFromWaitlist('sec-pub')).resolves.toHaveLength(1);
  });
});

describe('promoteFromWaitlist: section status', () => {
  const drafted = (status: 'draft' | 'archived') => {
    const id = status === 'draft' ? 'sec-draft' : 'sec-arch';
    const w = buildWorld({
      seeds: [
        { userId: 'w1', sectionId: id, status: 'waitlisted', enrolledAt: new Date('2026-09-02') },
        { userId: 'stu', sectionId: id },
      ],
    });
    w.vacate('stu', id);
    return { w, id };
  };

  it('refuses an archived section, even with allowDraft', async () => {
    const { w, id } = drafted('archived');
    await expect(w.service.promoteFromWaitlist(id)).rejects.toBeInstanceOf(SectionNotOpenError);
    await expect(w.service.promoteFromWaitlist(id, undefined, { allowDraft: true })).rejects.toMatchObject({ status: 'archived' });
    expect(w.row('w1', id).status).toBe('waitlisted');
  });

  it('refuses a draft section unless staff pass allowDraft', async () => {
    const { w, id } = drafted('draft');
    await expect(w.service.promoteFromWaitlist(id)).rejects.toMatchObject({ name: 'SectionNotOpenError', status: 'draft' });
    expect(w.calls.update).toBe(0);
    const promoted = await w.service.promoteFromWaitlist(id, undefined, { allowDraft: true });
    expect(promoted.map((e) => e.userId)).toEqual(['w1']);
  });
});

describe('promoteFromWaitlist: capacity races', () => {
  /** One seat is free and two people wait; two promotions run at the same time. */
  const raceWorld = (atomic: boolean) => {
    const w = buildWorld({ slow: true, atomic, seeds: [waiting('w1', '2026-09-02'), waiting('w2', '2026-09-03')] });
    w.vacate('stu');
    return w;
  };
  const activeCount = (w: ReturnType<typeof buildWorld>) => w.rows.filter((r) => r.sectionId === 'sec-pub' && r.status === 'active').length;

  it('WITHOUT promoteIfSeatFree, two simultaneous promotions can overfill the section (the documented limitation)', async () => {
    const w = raceWorld(false);
    await Promise.all([w.service.promoteFromWaitlist('sec-pub'), w.service.promoteFromWaitlist('sec-pub')]);
    expect(activeCount(w)).toBe(4);
  });

  it('WITH promoteIfSeatFree, the section is never overfilled, and the capacity is passed to the repository', async () => {
    const w = raceWorld(true);
    await Promise.all([w.service.promoteFromWaitlist('sec-pub'), w.service.promoteFromWaitlist('sec-pub')]);
    expect(activeCount(w)).toBe(3);
    expect(w.calls.promoteIfSeatFree.length).toBeGreaterThan(0);
    expect(w.calls.promoteIfSeatFree.every((c) => c.capacity === 3)).toBe(true);
  });

  it('with promoteIfSeatFree, a person someone else just promoted is skipped, not counted twice', async () => {
    const w = raceWorld(true);
    const [a, b] = await Promise.all([w.service.promoteFromWaitlist('sec-pub'), w.service.promoteFromWaitlist('sec-pub')]);
    expect(a.length + b.length).toBe(1);
    await sleep();
    expect(w.promotedEvents()).toHaveLength(1);
  });

  it('with promoteIfSeatFree, skips someone who was just promoted elsewhere and still fills the seat for the next in line', async () => {
    const w: ReturnType<typeof buildWorld> = buildWorld({
      atomic: true,
      seeds: [waiting('w1', '2026-09-02'), waiting('w2', '2026-09-03'), waiting('w3', '2026-09-04')],
      // another process promotes w1 just as we are about to
      beforePromote: (id) => {
        if (id === w.row('w1').id) w.row('w1').status = 'active';
      },
    });
    w.vacate('stu');
    w.vacate('stu-2');
    const promoted = await w.service.promoteFromWaitlist('sec-pub');
    expect(promoted.map((e) => e.userId)).toEqual(['w2']);
    expect(w.row('w2').status).toBe('active');
    expect(w.row('w3').status).toBe('waitlisted');
  });

  it('does not use promoteIfSeatFree for a section with no capacity (there is no seat to check)', async () => {
    const w = buildWorld({ atomic: true, seeds: [{ userId: 'w1', sectionId: 'sec-open', status: 'waitlisted' }] });
    await w.service.promoteFromWaitlist('sec-open');
    expect(w.calls.promoteIfSeatFree).toEqual([]);
    expect(w.row('w1', 'sec-open').status).toBe('active');
  });
});

describe('promoteFromWaitlist: permissions', () => {
  const world = () => buildWorld({ enforce: true, seeds: [waiting('w1', '2026-09-02')] });

  it('is allowed for the section\'s instructor and for an admin', async () => {
    for (const actor of ['teacher', 'root']) {
      const w = world();
      w.vacate('stu');
      await expect(w.service.promoteFromWaitlist('sec-pub', as(actor))).resolves.toHaveLength(1);
    }
  });

  it('is refused for a student (even the one waiting), a TA, an outsider, and with no actor at all, and nothing changes', async () => {
    const w = buildWorld({
      enforce: true,
      seeds: [waiting('w1', '2026-09-02'), { userId: 'ta', sectionId: 'sec-pub', role: 'ta' }, { userId: 'newbie', sectionId: 'sec-open' }],
    });
    w.vacate('stu');
    for (const actor of ['stu-2', 'w1', 'ta', 'newbie']) {
      await expect(w.service.promoteFromWaitlist('sec-pub', as(actor))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.promoteFromWaitlist('sec-pub')).rejects.toThrow();
    expect(w.calls.update).toBe(0);
    expect(w.row('w1').status).toBe('waitlisted');
  });

  it('is refused for an instructor of a different section', async () => {
    const w = buildWorld({ enforce: true, seeds: [{ userId: 'w1', sectionId: 'sec-open', status: 'waitlisted' }] });
    await expect(w.service.promoteFromWaitlist('sec-open', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses an unknown section exactly like a forbidden one', async () => {
    const w = world();
    const forbidden = await w.service.promoteFromWaitlist('sec-open', as('stu')).catch((e) => e);
    const missing = await w.service.promoteFromWaitlist('no-such-section', as('stu')).catch((e) => e);
    expect(forbidden).toBeInstanceOf(PermissionDeniedError);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect(missing.message).toBe(forbidden.message.replace('sec-open', 'no-such-section'));
  });

  it('checks permission BEFORE the section status: a student learns nothing about an archived section', async () => {
    const w = buildWorld({ enforce: true, seeds: [{ userId: 'stu', sectionId: 'sec-arch' }] });
    await expect(w.service.promoteFromWaitlist('sec-arch', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.promoteFromWaitlist('sec-arch', as('teacher'))).rejects.toBeInstanceOf(SectionNotOpenError);
  });

  it('is a built-in action for admin and instructor only, and is not delegable', () => {
    const rule = DEFAULT_RULES['enrollment.promoteWaitlist'];
    expect([...rule.roles].sort()).toEqual(['admin', 'instructor']);
    expect('delegable' in rule).toBe(false);
    expect('ownRoles' in rule).toBe(false);
  });
});

describe('promoteOnDrop', () => {
  const full = (promoteOnDrop: boolean, extra: Seed[] = []) =>
    buildWorld({ promoteOnDrop, seeds: [waiting('w2', '2026-09-03'), waiting('w1', '2026-09-02'), ...extra] });

  it('is off by default: dropping leaves the waitlist alone', async () => {
    const w = full(false);
    await w.service.drop(w.row('stu').id);
    await sleep();
    expect(w.row('w1').status).toBe('waitlisted');
    expect(w.promotedEvents()).toEqual([]);
  });

  it('when on, dropping an active enrollment promotes the longest-waiting person into the seat', async () => {
    const w = full(true);
    const dropped = await w.service.drop(w.row('stu').id);
    await sleep();
    expect(dropped).toMatchObject({ userId: 'stu', status: 'dropped' });
    expect(w.row('w1').status).toBe('active');
    expect(w.row('w2').status).toBe('waitlisted');
    expect(w.promotedEvents()).toMatchObject([{ userId: 'w1', trigger: 'auto', previousStatus: 'waitlisted' }]);
    expect(w.promotedEvents()[0]).not.toHaveProperty('actorId');
  });

  it('still emits enrollment.dropped, and the dropped event comes before the promotion', async () => {
    const w = full(true);
    await w.service.drop(w.row('stu').id);
    await sleep();
    expect(w.events.map((e) => e.type)).toEqual(['enrollment.dropped', 'enrollment.promoted']);
  });

  it('does not promote when a waitlisted, completed or already dropped enrollment is dropped', async () => {
    const w = full(true, [waiting('w3', '2026-09-04', { status: 'completed' })]);
    w.vacate('stu');
    await w.service.drop(w.row('w2').id); // waitlisted
    await expect(w.service.drop(w.row('w3').id)).rejects.toThrow(); // completed
    await w.service.drop(w.row('stu').id); // already dropped
    await sleep();
    expect(w.row('w1').status).toBe('waitlisted');
    expect(w.promotedEvents()).toEqual([]);
  });

  it('does not promote anyone when an idempotent drop changes nothing', async () => {
    const w = full(true);
    await w.service.drop(w.row('stu').id);
    await sleep();
    w.row('w1').status = 'waitlisted'; // put the world back, to see that a repeated drop does not run again
    await w.service.drop(w.row('stu').id);
    await sleep();
    expect(w.row('w1').status).toBe('waitlisted');
  });

  it('never fails the drop when the promotion fails: the person is dropped, the waitlist stays', async () => {
    const w = buildWorld({ promoteOnDrop: true, failPromotionWrites: true, seeds: [waiting('w1', '2026-09-02')] });
    const dropped = await w.service.drop(w.row('stu').id);
    expect(dropped.status).toBe('dropped');
    expect(w.row('w1').status).toBe('waitlisted');
    // ...and the explicit method can sweep up later
  });

  it('skips a draft or archived section silently', async () => {
    for (const [id, other] of [['sec-draft', 'a'], ['sec-arch', 'b']] as const) {
      const w = buildWorld({
        promoteOnDrop: true,
        seeds: [
          { userId: 'stu', sectionId: id },
          { userId: 'stu-2', sectionId: id },
          { userId: 'w1', sectionId: id, status: 'waitlisted', enrolledAt: new Date('2026-09-02') },
        ],
      });
      await expect(w.service.drop(w.row('stu', id).id)).resolves.toMatchObject({ status: 'dropped' });
      expect(w.row('w1', id).status).toBe('waitlisted');
      void other;
    }
  });

  it('with permissions on, a student dropping themselves promotes someone else without needing the promote permission', async () => {
    const w = buildWorld({ enforce: true, promoteOnDrop: true, seeds: [waiting('w1', '2026-09-02')] });
    const dropped = await w.service.drop(w.row('stu').id, as('stu'));
    await sleep();
    expect(dropped.userId).toBe('stu');
    expect(w.row('w1').status).toBe('active');
    expect(w.promotedEvents()).toMatchObject([{ trigger: 'auto' }]);
    expect(w.promotedEvents()[0]).not.toHaveProperty('actorId');
  });

  it('a refused drop promotes nobody', async () => {
    const w = buildWorld({ enforce: true, promoteOnDrop: true, seeds: [waiting('w1', '2026-09-02')] });
    await expect(w.service.drop(w.row('stu-2').id, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.row('w1').status).toBe('waitlisted');
  });

  it('uses promoteIfSeatFree when the repository has it', async () => {
    const w = buildWorld({ atomic: true, promoteOnDrop: true, seeds: [waiting('w1', '2026-09-02')] });
    await w.service.drop(w.row('stu').id);
    expect(w.calls.promoteIfSeatFree).toHaveLength(1);
    expect(w.row('w1').status).toBe('active');
  });
});

describe('enroll: newcomers do not jump the waitlist', () => {
  const enrollNewbie = (w: ReturnType<typeof buildWorld>, waitlistIfFull = true) =>
    w.service.enroll({ userId: 'newbie', sectionId: 'sec-pub', role: 'student', waitlistIfFull });

  it('waitlists a newcomer when a seat is free but people are already waiting', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02')] });
    w.vacate('stu');
    const e = await enrollNewbie(w);
    expect(e.status).toBe('waitlisted');
    await sleep();
    expect(w.events).toMatchObject([{ type: 'enrollment.enrolled', status: 'waitlisted' }]);
  });

  it('refuses a newcomer who did not ask for the waitlist, and says why', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02')] });
    w.vacate('stu');
    await expect(enrollNewbie(w, false)).rejects.toThrow(/waitlist/i);
    expect(w.calls.create).toBe(0);
  });

  it('does not even try to take the seat atomically while somebody is waiting', async () => {
    const w = buildWorld({ atomic: true, seeds: [waiting('w1', '2026-09-02')] });
    w.vacate('stu');
    const e = await enrollNewbie(w);
    expect(e.status).toBe('waitlisted');
    expect(w.calls.createIfSeatFree).toBe(0);
  });

  it('takes a free seat as before when nobody is waiting', async () => {
    for (const atomic of [false, true]) {
      const w = buildWorld({ atomic });
      w.vacate('stu');
      await expect(enrollNewbie(w)).resolves.toMatchObject({ status: 'active' });
    }
  });

  it('ignores waitlist entries that are no longer waiting', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02', { status: 'dropped' }), waiting('w2', '2026-09-02', { status: 'completed' })] });
    w.vacate('stu');
    await expect(enrollNewbie(w)).resolves.toMatchObject({ status: 'active' });
  });

  it('does not look at the waitlist of a section with no capacity, or of another section', async () => {
    const w = buildWorld({ seeds: [{ userId: 'w1', sectionId: 'sec-open', status: 'waitlisted' }] });
    w.vacate('stu');
    await expect(enrollNewbie(w)).resolves.toMatchObject({ status: 'active' });
    await expect(w.service.enroll({ userId: 'w2', sectionId: 'sec-open', role: 'student' })).resolves.toMatchObject({ status: 'active' });
  });

  it('applies to bulk imports too: the rows go onto the waitlist', async () => {
    const w = buildWorld({ seeds: [waiting('w1', '2026-09-02')] });
    w.vacate('stu');
    const e = await w.service.enroll({ userId: 'w3', sectionId: 'sec-pub', role: 'student', waitlistIfFull: true });
    expect(e.status).toBe('waitlisted');
  });
});
