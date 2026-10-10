import { describe, it, expect } from 'bun:test';
import {
  EnrollmentService,
  EnrollmentRequestService,
  AlreadyEnrolledError,
  RequestNotPendingError,
  InvalidRequestModificationError,
  SectionNotOpenError,
} from '../src/domains/enrollment/index.js';
import {
  ActorRequiredError,
  DEFAULT_RULES,
  EventBus,
  PermissionDeniedError,
  createRolePolicy,
} from '../src/core/index.js';
import type {
  CourseSection,
  Enrollment,
  EnrollmentRequest,
  Identity,
  LmsEvent,
  RepositoryContext,
  Role,
} from '../src/core/index.js';

const sleep = () => new Promise((r) => setTimeout(r, 0));
const as = (actorId: string) => ({ actorId });

/**
 * org-a, course-a: sec-a (published, capacity 2), sec-a2 (published, no capacity), sec-draft, sec-arch.
 * org-a, course-c: sec-c (published). org-b, course-b: sec-b.
 * People: alice, bob (students, org-a), eve (student, org-b), teacher (instructor of sec-a only),
 * ta (TA of sec-a), root (admin, org-a), root-b (admin, org-b), prof (instructor by role, never a student).
 * sec-a starts with one active seat taken by `teacher`, so one seat is free.
 */
function buildWorld(
  opts: {
    atomic?: boolean;
    /** a gap inside request lookups in which another call can slip in */
    slow?: boolean;
    overrides?: Record<string, { roles?: Role[] }>;
    seeds?: Array<Partial<Enrollment> & Pick<Enrollment, 'userId' | 'sectionId'>>;
    requests?: Array<Partial<EnrollmentRequest> & Pick<EnrollmentRequest, 'userId' | 'sectionId'>>;
    noBus?: boolean;
  } = {},
) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  for (const id of ['alice', 'bob', 'carol']) add(id, ['student']);
  add('eve', ['student'], 'org-b');
  add('teacher', ['instructor']);
  add('prof', ['instructor']);
  add('ta', ['ta']);
  add('root', ['admin']);
  add('root-b', ['admin'], 'org-b');

  const courses = new Map([
    ['course-a', { id: 'course-a', title: 'A', orgId: 'org-a' }],
    ['course-c', { id: 'course-c', title: 'C', orgId: 'org-a' }],
    ['course-b', { id: 'course-b', title: 'B', orgId: 'org-b' }],
  ]);
  const sections: Record<string, CourseSection> = {
    'sec-a': { id: 'sec-a', courseId: 'course-a', status: 'published', capacity: 2 },
    'sec-a2': { id: 'sec-a2', courseId: 'course-a', status: 'published' },
    'sec-draft': { id: 'sec-draft', courseId: 'course-a', status: 'draft' },
    'sec-arch': { id: 'sec-arch', courseId: 'course-a', status: 'archived' },
    'sec-c': { id: 'sec-c', courseId: 'course-c', status: 'published' },
    'sec-b': { id: 'sec-b', courseId: 'course-b', status: 'published' },
    'sec-orphan': { id: 'sec-orphan', courseId: 'course-missing', status: 'published' },
  };

  const rows: Enrollment[] = [];
  let eseq = 0;
  const seed = (e: Partial<Enrollment> & Pick<Enrollment, 'userId' | 'sectionId'>) =>
    rows.push({ id: `enr-${++eseq}`, role: 'student', status: 'active', enrolledAt: new Date('2026-09-01'), ...e });
  seed({ userId: 'teacher', sectionId: 'sec-a', role: 'instructor' });
  seed({ userId: 'ta', sectionId: 'sec-a', role: 'ta' });
  // capacity 2 with teacher and ta both active would be full: make the TA a section-a2 TA instead
  rows.pop();
  seed({ userId: 'ta', sectionId: 'sec-a2', role: 'ta' });
  for (const e of opts.seeds ?? []) seed(e);

  const reqs: EnrollmentRequest[] = [];
  let rseq = 0;
  const seedReq = (r: Partial<EnrollmentRequest> & Pick<EnrollmentRequest, 'userId' | 'sectionId'>) =>
    reqs.push({ id: `req-${++rseq}`, status: 'pending', requestedAt: new Date('2026-10-01'), ...r });
  for (const r of opts.requests ?? []) seedReq(r);
  const reqCalls = { create: 0, update: 0, decideIfPending: 0 };

  const enrollments: RepositoryContext['enrollments'] = {
    create: async (e) => {
      const row = { ...e, id: `enr-${++eseq}` } as Enrollment;
      rows.push(row);
      return row;
    },
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    update: async (id, patch) => {
      const i = rows.findIndex((r) => r.id === id);
      rows[i] = { ...rows[i]!, ...patch };
      return rows[i]!;
    },
    findByUserAndSection: async (userId, sectionId) =>
      [...rows].reverse().find((r) => r.userId === userId && r.sectionId === sectionId) ?? null,
    listBySection: async (sectionId, status) => rows.filter((r) => r.sectionId === sectionId && (!status || r.status === status)),
    countActive: async (sectionId) => rows.filter((r) => r.sectionId === sectionId && r.status === 'active').length,
  };

  const enrollmentRequests: NonNullable<RepositoryContext['enrollmentRequests']> = {
    create: async (r) => {
      reqCalls.create++;
      const row = { ...r, id: `req-${++rseq}` } as EnrollmentRequest;
      reqs.push(row);
      return row;
    },
    findById: async (id) => {
      const found = reqs.find((r) => r.id === id) ?? null;
      const copy = found ? { ...found } : null;
      if (opts.slow) await sleep();
      return copy;
    },
    update: async (id, patch) => {
      reqCalls.update++;
      const i = reqs.findIndex((r) => r.id === id);
      reqs[i] = { ...reqs[i]!, ...patch };
      return reqs[i]!;
    },
    findPending: async (userId, sectionId) =>
      reqs.find((r) => r.userId === userId && r.sectionId === sectionId && r.status === 'pending') ?? null,
    listBySection: async (sectionId, status) => reqs.filter((r) => r.sectionId === sectionId && (!status || r.status === status)),
    listByUser: async (userId) => reqs.filter((r) => r.userId === userId),
    ...(opts.atomic
      ? {
          decideIfPending: async (id: string, patch: Partial<Omit<EnrollmentRequest, 'id'>>) => {
            reqCalls.decideIfPending++;
            const i = reqs.findIndex((r) => r.id === id);
            if (i < 0 || reqs[i]!.status !== 'pending') return null;
            reqs[i] = { ...reqs[i]!, ...patch };
            return reqs[i]!;
          },
        }
      : {}),
  };

  const repos = {
    users: { findById: async (id: string) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id: string) => courses.get(id) ?? null,
      findSection: async (id: string) => sections[id] ?? null,
      listSections: async () => [],
    },
    enrollments,
    enrollmentRequests,
  } as unknown as RepositoryContext;

  const policy = createRolePolicy(opts.overrides ? { overrides: opts.overrides } : {});
  const bus = opts.noBus ? undefined : new EventBus();
  const events: LmsEvent[] = [];
  bus?.on('*', (e) => void events.push(e));
  const enrollment = new EnrollmentService(repos, bus, { policy });
  const service = new EnrollmentRequestService(
    repos as RepositoryContext & { enrollmentRequests: NonNullable<RepositoryContext['enrollmentRequests']> },
    enrollment,
    bus,
    { policy },
  );

  const request = (id: string) => reqs.find((r) => r.id === id)!;
  const ofType = <T extends LmsEvent['type']>(type: T) => events.filter((e) => e.type === type);
  const enrolledRows = (sectionId: string, userId: string) => rows.filter((r) => r.sectionId === sectionId && r.userId === userId);
  return { service, reqs, rows, reqCalls, events, request, ofType, enrolledRows, sections };
}

const pending = (userId: string, sectionId = 'sec-a', extra: Partial<EnrollmentRequest> = {}) => ({ userId, sectionId, ...extra });

describe('request', () => {
  it('creates a pending request for the actor themself, enrolls nobody, and says so once', async () => {
    const w = buildWorld();
    const r = await w.service.request('sec-a', as('alice'), { note: 'I would love a seat' });
    await sleep();
    expect(r).toMatchObject({ userId: 'alice', sectionId: 'sec-a', status: 'pending', note: 'I would love a seat' });
    expect(r.requestedAt).toBeInstanceOf(Date);
    expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
    expect(w.ofType('enrollment.requested')).toEqual([{ type: 'enrollment.requested', requestId: r.id, userId: 'alice', sectionId: 'sec-a' }]);
  });

  it('needs an actor, and refuses an unknown one', async () => {
    const w = buildWorld();
    await expect(w.service.request('sec-a', undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.request('sec-a', as('nobody'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.reqCalls.create).toBe(0);
  });

  it('refuses someone who is not a student by role', async () => {
    const w = buildWorld();
    await expect(w.service.request('sec-a', as('prof'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.request('sec-a', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('refuses another organization, a missing section and a draft with the SAME error, so none can be probed', async () => {
    const w = buildWorld();
    const errors = await Promise.all(
      [
        w.service.request('sec-b', as('alice')), // another organization
        w.service.request('no-such-section', as('alice')),
        w.service.request('sec-orphan', as('alice')), // its course cannot be found
        w.service.request('sec-draft', as('alice')),
        w.service.request('sec-a', as('eve')), // eve is in org-b
      ].map((p) => p.catch((e) => e)),
    );
    for (const e of errors) expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    expect(w.reqCalls.create).toBe(0);
  });

  it('tells a student that an archived section is closed', async () => {
    const w = buildWorld();
    await expect(w.service.request('sec-arch', as('alice'))).rejects.toBeInstanceOf(SectionNotOpenError);
  });

  it('refuses someone who is already enrolled, waitlisted or completed, but not someone who dropped', async () => {
    for (const status of ['active', 'waitlisted', 'completed'] as const) {
      const w = buildWorld({ seeds: [{ userId: 'alice', sectionId: 'sec-a2', status }] });
      await expect(w.service.request('sec-a2', as('alice'))).rejects.toBeInstanceOf(AlreadyEnrolledError);
    }
    const w = buildWorld({ seeds: [{ userId: 'alice', sectionId: 'sec-a2', status: 'dropped' }] });
    await expect(w.service.request('sec-a2', as('alice'))).resolves.toMatchObject({ status: 'pending' });
  });

  it('is idempotent: asking again while pending returns the same request, with no new record and no event', async () => {
    const w = buildWorld();
    const first = await w.service.request('sec-a', as('alice'));
    await sleep();
    const again = await w.service.request('sec-a', as('alice'), { note: 'a different note' });
    await sleep();
    expect(again.id).toBe(first.id);
    expect(again.note).toBeUndefined();
    expect(w.reqCalls.create).toBe(1);
    expect(w.ofType('enrollment.requested')).toHaveLength(1);
  });

  it('lets someone ask again after a rejection or a withdrawal, as a new request', async () => {
    for (const status of ['rejected', 'withdrawn'] as const) {
      const w = buildWorld({ requests: [pending('alice', 'sec-a', { status })] });
      const r = await w.service.request('sec-a', as('alice'));
      expect(r.id).not.toBe('req-1');
      expect(r.status).toBe('pending');
    }
  });

  it('keeps two different students\' requests apart', async () => {
    const w = buildWorld();
    const a = await w.service.request('sec-a', as('alice'));
    const b = await w.service.request('sec-a', as('bob'));
    expect(a.id).not.toBe(b.id);
  });
});

describe('withdraw and listMine', () => {
  it('lets the student withdraw their own pending request, once, with one event', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const r = await w.service.withdraw('req-1', as('alice'));
    await sleep();
    expect(r).toMatchObject({ status: 'withdrawn' });
    const again = await w.service.withdraw('req-1', as('alice'));
    await sleep();
    expect(again.status).toBe('withdrawn');
    expect(w.ofType('enrollment.requestDecided')).toEqual([
      { type: 'enrollment.requestDecided', requestId: 'req-1', userId: 'alice', sectionId: 'sec-a', decision: 'withdrawn' },
    ]);
  });

  it('refuses someone else\'s request and an unknown one in the same way, and nobody else can withdraw it', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const others = await Promise.all(
      [w.service.withdraw('req-1', as('bob')), w.service.withdraw('req-1', as('root')), w.service.withdraw('nope', as('alice'))].map((p) =>
        p.catch((e) => e),
      ),
    );
    for (const e of others) expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(new Set(others.map((e) => e.message)).size).toBe(1);
    expect(w.request('req-1').status).toBe('pending');
    await expect(w.service.withdraw('req-1', undefined)).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it('cannot withdraw a request that was already decided', async () => {
    for (const status of ['accepted', 'rejected'] as const) {
      const w = buildWorld({ requests: [pending('alice', 'sec-a', { status })] });
      await expect(w.service.withdraw('req-1', as('alice'))).rejects.toBeInstanceOf(RequestNotPendingError);
      expect(w.request('req-1').status).toBe(status);
    }
  });

  it('lists only the actor\'s own requests, every status', async () => {
    const w = buildWorld({
      requests: [pending('alice'), pending('bob'), pending('alice', 'sec-a2', { status: 'rejected' })],
    });
    expect((await w.service.listMine(as('alice'))).map((r) => r.id).sort()).toEqual(['req-1', 'req-3']);
    await expect(w.service.listMine(undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.listMine(as('nobody'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('listRequests', () => {
  const world = () =>
    buildWorld({ requests: [pending('alice'), pending('bob', 'sec-a', { status: 'rejected' }), pending('carol', 'sec-a2')] });

  it('lets an admin list a section\'s requests, optionally by status, and no other section\'s', async () => {
    const w = world();
    expect((await w.service.listRequests('sec-a', undefined, as('root'))).map((r) => r.id).sort()).toEqual(['req-1', 'req-2']);
    expect((await w.service.listRequests('sec-a', 'pending', as('root'))).map((r) => r.id)).toEqual(['req-1']);
  });

  it('refuses a student, a TA, the section\'s own instructor (by default), another organization\'s admin, and no actor', async () => {
    const w = world();
    for (const actor of ['alice', 'ta', 'teacher', 'root-b']) {
      await expect(w.service.listRequests('sec-a', undefined, as(actor))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.listRequests('sec-a', undefined, undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    await expect(w.service.listRequests('no-such-section', undefined, as('alice'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('is a built-in action: admin only, not delegable, no own-resource shortcut', () => {
    const rule = DEFAULT_RULES['enrollment.reviewRequest'];
    expect([...rule.roles]).toEqual(['admin']);
    expect('delegable' in rule).toBe(false);
    expect('ownRoles' in rule).toBe(false);
  });

  it('follows an override: a host can let a section\'s instructors review, for their own section only', async () => {
    const w = buildWorld({
      overrides: { 'enrollment.reviewRequest': { roles: ['admin', 'instructor'] } },
      requests: [pending('alice'), pending('carol', 'sec-a2')],
    });
    await expect(w.service.listRequests('sec-a', undefined, as('teacher'))).resolves.toHaveLength(1);
    await expect(w.service.listRequests('sec-a2', undefined, as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('accept', () => {
  it('enrolls the student as an active student, records the decision, and emits both events', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const done = await w.service.accept('req-1', as('root'), { note: 'welcome' });
    await sleep();
    const enr = w.enrolledRows('sec-a', 'alice');
    expect(enr).toHaveLength(1);
    expect(enr[0]).toMatchObject({ role: 'student', status: 'active' });
    expect(done).toMatchObject({
      status: 'accepted',
      reviewerId: 'root',
      reviewNote: 'welcome',
      enrollmentId: enr[0]!.id,
      grantedSectionId: 'sec-a',
    });
    expect(done.reviewedAt).toBeInstanceOf(Date);
    expect(w.ofType('enrollment.requestDecided')).toEqual([
      {
        type: 'enrollment.requestDecided',
        requestId: 'req-1',
        userId: 'alice',
        sectionId: 'sec-a',
        decision: 'accepted',
        reviewerId: 'root',
        enrollmentId: enr[0]!.id,
        enrollmentStatus: 'active',
        grantedSectionId: 'sec-a',
      },
    ]);
    expect(w.ofType('enrollment.enrolled')).toHaveLength(1);
  });

  it('puts the student on the waitlist when the section is full, and says so', async () => {
    const w = buildWorld({ seeds: [{ userId: 'carol', sectionId: 'sec-a' }], requests: [pending('alice')] });
    const done = await w.service.accept('req-1', as('root'));
    await sleep();
    expect(w.enrolledRows('sec-a', 'alice')[0]!.status).toBe('waitlisted');
    expect(done.status).toBe('accepted');
    expect(w.ofType('enrollment.requestDecided')).toMatchObject([{ enrollmentStatus: 'waitlisted' }]);
  });

  it('keeps the request pending and enrolls nobody when the section is full and the reviewer refuses the waitlist', async () => {
    const w = buildWorld({ seeds: [{ userId: 'carol', sectionId: 'sec-a' }], requests: [pending('alice')] });
    await expect(w.service.accept('req-1', as('root'), { waitlistIfFull: false })).rejects.toThrow(/capacity/);
    await sleep();
    expect(w.request('req-1').status).toBe('pending');
    expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
    expect(w.ofType('enrollment.requestDecided')).toEqual([]);
  });

  it('does not let an accepted student jump people who are already waiting', async () => {
    const w = buildWorld({ seeds: [{ userId: 'carol', sectionId: 'sec-a', status: 'waitlisted' }], requests: [pending('alice')] });
    await w.service.accept('req-1', as('root'));
    expect(w.enrolledRows('sec-a', 'alice')[0]!.status).toBe('waitlisted');
  });

  it('is idempotent: accepting again returns the same decision, with no second enrollment and no second event', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const first = await w.service.accept('req-1', as('root'));
    await sleep();
    const again = await w.service.accept('req-1', as('root'));
    await sleep();
    expect(again).toEqual(first);
    expect(w.enrolledRows('sec-a', 'alice')).toHaveLength(1);
    expect(w.ofType('enrollment.requestDecided')).toHaveLength(1);
  });

  it('refuses a request that was rejected or withdrawn', async () => {
    for (const status of ['rejected', 'withdrawn'] as const) {
      const w = buildWorld({ requests: [pending('alice', 'sec-a', { status })] });
      await expect(w.service.accept('req-1', as('root'))).rejects.toBeInstanceOf(RequestNotPendingError);
      expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
    }
  });

  it('is refused for a student, a TA, an instructor, another organization\'s admin, and no actor, and nothing changes', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    for (const actor of ['alice', 'ta', 'teacher', 'root-b']) {
      await expect(w.service.accept('req-1', as(actor))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.accept('req-1', undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.request('req-1').status).toBe('pending');
    expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
    expect(w.reqCalls.update + w.reqCalls.decideIfPending).toBe(0);
  });

  it('refuses an unknown request exactly like a forbidden one, even for an admin', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const forbidden = await w.service.accept('req-1', as('alice')).catch((e) => e);
    const missing = await w.service.accept('nope', as('root')).catch((e) => e);
    expect(forbidden).toBeInstanceOf(PermissionDeniedError);
    expect(missing).toBeInstanceOf(PermissionDeniedError);
    expect(missing.message).toBe(forbidden.message);
  });

  it('leaves the request pending when the section has closed since, so the reviewer can reject it', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    w.sections['sec-a']!.status = 'archived';
    await expect(w.service.accept('req-1', as('root'))).rejects.toBeInstanceOf(SectionNotOpenError);
    expect(w.request('req-1').status).toBe('pending');
    await expect(w.service.reject('req-1', as('root'))).resolves.toMatchObject({ status: 'rejected' });
  });

  it('reuses an enrollment the student already got another way, instead of creating a second one', async () => {
    const w = buildWorld({ requests: [pending('alice')], seeds: [{ userId: 'alice', sectionId: 'sec-a' }] });
    const done = await w.service.accept('req-1', as('root'));
    expect(w.enrolledRows('sec-a', 'alice')).toHaveLength(1);
    expect(done.enrollmentId).toBe(w.enrolledRows('sec-a', 'alice')[0]!.id);
  });

  it('works without an event bus', async () => {
    const w = buildWorld({ noBus: true, requests: [pending('alice')] });
    await expect(w.service.accept('req-1', as('root'))).resolves.toMatchObject({ status: 'accepted' });
  });
});

describe('accept: two reviewers at once', () => {
  const race = (atomic: boolean) => buildWorld({ atomic, slow: true, requests: [pending('alice')] });

  it('WITHOUT decideIfPending, both reviewers record a decision (the documented limitation), though the student is enrolled once', async () => {
    const w = race(false);
    await Promise.all([w.service.accept('req-1', as('root')), w.service.accept('req-1', as('root'))]);
    await sleep();
    expect(w.enrolledRows('sec-a', 'alice')).toHaveLength(1);
    expect(w.ofType('enrollment.requestDecided')).toHaveLength(2);
  });

  it('WITH decideIfPending, only one decision is recorded and announced, and both callers get the accepted request', async () => {
    const w = race(true);
    const [a, b] = await Promise.all([w.service.accept('req-1', as('root')), w.service.accept('req-1', as('root'))]);
    await sleep();
    expect(w.enrolledRows('sec-a', 'alice')).toHaveLength(1);
    expect(w.ofType('enrollment.requestDecided')).toHaveLength(1);
    expect(a.status).toBe('accepted');
    expect(b.status).toBe('accepted');
  });

  it('WITH decideIfPending, an accept that loses the race to a reject is told the request is no longer pending', async () => {
    const w = race(true);
    const results = await Promise.allSettled([w.service.reject('req-1', as('root')), w.service.accept('req-1', as('root'))]);
    await sleep();
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(RequestNotPendingError);
    expect(w.request('req-1').status).toBe('rejected');
    expect(w.ofType('enrollment.requestDecided')).toMatchObject([{ decision: 'rejected' }]);
  });
});

describe('modify', () => {
  it('accepts the student into a different section of the same course and records both sections', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const done = await w.service.modify('req-1', 'sec-a2', as('root'), { note: 'moved to the evening class' });
    await sleep();
    expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
    expect(w.enrolledRows('sec-a2', 'alice')).toHaveLength(1);
    expect(done).toMatchObject({
      status: 'accepted',
      sectionId: 'sec-a',
      grantedSectionId: 'sec-a2',
      reviewNote: 'moved to the evening class',
      enrollmentId: w.enrolledRows('sec-a2', 'alice')[0]!.id,
    });
    expect(w.ofType('enrollment.requestDecided')).toMatchObject([
      { decision: 'accepted', sectionId: 'sec-a', grantedSectionId: 'sec-a2', enrollmentStatus: 'active' },
    ]);
  });

  it('refuses a section of another course, the same section, and one that does not exist, and leaves the request pending', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    await expect(w.service.modify('req-1', 'sec-c', as('root'))).rejects.toBeInstanceOf(InvalidRequestModificationError);
    await expect(w.service.modify('req-1', 'sec-a', as('root'))).rejects.toBeInstanceOf(InvalidRequestModificationError);
    await expect(w.service.modify('req-1', 'no-such-section', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.request('req-1').status).toBe('pending');
    expect(w.rows.filter((r) => r.userId === 'alice')).toEqual([]);
  });

  it('refuses a closed target section and leaves the request pending', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    await expect(w.service.modify('req-1', 'sec-arch', as('root'))).rejects.toBeInstanceOf(SectionNotOpenError);
    expect(w.request('req-1').status).toBe('pending');
  });

  it('refuses a draft target section unless the reviewer passes allowDraft', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    await expect(w.service.modify('req-1', 'sec-draft', as('root'))).rejects.toMatchObject({ name: 'SectionNotOpenError', status: 'draft' });
    expect(w.request('req-1').status).toBe('pending');
    await expect(w.service.modify('req-1', 'sec-draft', as('root'), { allowDraft: true })).resolves.toMatchObject({
      status: 'accepted',
      grantedSectionId: 'sec-draft',
    });
  });

  it('needs the reviewer to be allowed to review in the TARGET section too', async () => {
    const w = buildWorld({
      overrides: { 'enrollment.reviewRequest': { roles: ['admin', 'instructor'] } },
      requests: [pending('alice')],
    });
    await expect(w.service.modify('req-1', 'sec-a2', as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.request('req-1').status).toBe('pending');
    expect(w.enrolledRows('sec-a2', 'alice')).toEqual([]);
  });

  it('is refused for people who may not review, with the request untouched', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    for (const actor of ['alice', 'ta', 'teacher', 'root-b']) {
      await expect(w.service.modify('req-1', 'sec-a2', as(actor))).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    await expect(w.service.modify('req-1', 'sec-a2', undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.request('req-1').status).toBe('pending');
  });

  it('waitlists the student when the target section is full', async () => {
    const w = buildWorld({ requests: [pending('alice', 'sec-a2')], seeds: [{ userId: 'bob', sectionId: 'sec-a' }] });
    // sec-a has capacity 2: the teacher and bob hold both seats.
    await w.service.modify('req-1', 'sec-a', as('root'));
    expect(w.enrolledRows('sec-a', 'alice')[0]!.status).toBe('waitlisted');
  });

  it('is idempotent: a request already accepted comes back as it is, whatever section is named', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const first = await w.service.modify('req-1', 'sec-a2', as('root'));
    const again = await w.service.accept('req-1', as('root'));
    expect(again).toEqual(first);
    expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
  });
});

describe('reject', () => {
  it('records the refusal with who and why, enrolls nobody, and emits one event', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const done = await w.service.reject('req-1', as('root'), { note: 'prerequisite missing' });
    await sleep();
    expect(done).toMatchObject({ status: 'rejected', reviewerId: 'root', reviewNote: 'prerequisite missing' });
    expect(done.reviewedAt).toBeInstanceOf(Date);
    expect(done.enrollmentId).toBeUndefined();
    expect(w.enrolledRows('sec-a', 'alice')).toEqual([]);
    expect(w.ofType('enrollment.requestDecided')).toEqual([
      {
        type: 'enrollment.requestDecided',
        requestId: 'req-1',
        userId: 'alice',
        sectionId: 'sec-a',
        decision: 'rejected',
        reviewerId: 'root',
      },
    ]);
  });

  it('is idempotent, and refuses a request that was accepted or withdrawn', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const first = await w.service.reject('req-1', as('root'));
    await sleep();
    await expect(w.service.reject('req-1', as('root'))).resolves.toEqual(first);
    await sleep();
    expect(w.ofType('enrollment.requestDecided')).toHaveLength(1);
    for (const status of ['accepted', 'withdrawn'] as const) {
      const x = buildWorld({ requests: [pending('alice', 'sec-a', { status })] });
      await expect(x.service.reject('req-1', as('root'))).rejects.toBeInstanceOf(RequestNotPendingError);
    }
  });

  it('is refused for people who may not review, and for an unknown request, identically', async () => {
    const w = buildWorld({ requests: [pending('alice')] });
    const errors = await Promise.all(
      [w.service.reject('req-1', as('alice')), w.service.reject('req-1', as('teacher')), w.service.reject('nope', as('root'))].map((p) =>
        p.catch((e) => e),
      ),
    );
    for (const e of errors) expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(new Set(errors.map((e) => e.message)).size).toBe(1);
    await expect(w.service.reject('req-1', undefined)).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.request('req-1').status).toBe('pending');
  });

  it('uses decideIfPending when the repository has it', async () => {
    const w = buildWorld({ atomic: true, requests: [pending('alice')] });
    await w.service.reject('req-1', as('root'));
    expect(w.reqCalls.decideIfPending).toBe(1);
    expect(w.reqCalls.update).toBe(0);
  });
});
