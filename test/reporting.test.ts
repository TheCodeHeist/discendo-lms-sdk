import { describe, it, expect } from 'bun:test';
import { ReportingService, toCsv } from '../src/services/reporting/index.js';
import type { AttendanceRecord, AttendanceRepository, SessionLocator } from '../src/services/reporting/index.js';
import { createRolePolicy, PermissionDeniedError, ActorRequiredError } from '../src/core/index.js';
import type {
  Enrollment,
  GuardianLink,
  GuardianScope,
  Identity,
  PermissionContext,
  PermissionPolicy,
  RepositoryContext,
  Role,
  TaGrant,
} from '../src/core/index.js';

const as = (actorId: string) => ({ actorId });
const T = (n: number) => new Date(Date.UTC(2026, 9, n, 9, 0, 0));

/**
 * org-a: root (admin), teacher (instructor of sec-1), teacher-2 (instructor of sec-2), ta (enr-3 in
 * sec-1), students stu / stu-2 (active in sec-1), stu-dropped, stu-wait, stu-done, stu-sec2 (sec-2),
 * parents parent (ward stu, attendance) / parent-noscope (grades only) / parent-dropped (ward
 * stu-dropped), outsider. org-b: root-b, stu-b (sec-b). Sessions: sess-1 and sess-2 are in sec-1,
 * sess-3 in sec-2, sess-b in sec-b, sess-orphan in a section whose course is missing.
 */
function buildWorld(
  opts: { policy?: PermissionPolicy; grants?: TaGrant[]; enforce?: boolean; sessions?: boolean; marks?: AttendanceRecord[] } = {},
) {
  const users = new Map<string, Identity>();
  const add = (id: string, roles: Role[], orgId = 'org-a') => users.set(id, { id, roles, orgId });
  add('root', ['admin']);
  add('teacher', ['instructor']);
  add('teacher-2', ['instructor']);
  add('ta', ['ta']);
  for (const id of ['stu', 'stu-2', 'stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'parent', 'parent-noscope', 'parent-dropped', 'outsider']) {
    add(id, ['student']);
  }
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
  seed('stu-b', 'sec-b', 'student');

  const link = (id: string, guardianId: string, wardId: string, scopes: GuardianScope[]): GuardianLink => ({
    id, guardianId, wardId, orgId: 'org-a', scopes, status: 'active', createdAt: new Date(),
  });
  const links = [
    link('l1', 'parent', 'stu', ['attendance']),
    link('l2', 'parent-noscope', 'stu', ['grades']),
    link('l3', 'parent-dropped', 'stu-dropped', ['attendance']),
  ];

  const sectionCourse: Record<string, string> = { 'sec-1': 'course-a', 'sec-2': 'course-a', 'sec-b': 'course-b', 'sec-orphan': 'missing-course' };
  const repos: Pick<RepositoryContext, 'users' | 'courses' | 'enrollments' | 'guardianLinks' | 'delegations'> = {
    users: { findById: async (id) => users.get(id) ?? null, findByExternalRef: async () => null },
    courses: {
      findCourse: async (id) => (id === 'course-a' ? { id, title: 'A', orgId: 'org-a' } : id === 'course-b' ? { id, title: 'B', orgId: 'org-b' } : null),
      findSection: async (id) => (sectionCourse[id] ? { id, courseId: sectionCourse[id]!, status: 'published' as const } : null),
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

  const stored: AttendanceRecord[] = [
    ...(opts.marks ?? [
      { sessionId: 'sess-1', userId: 'stu', status: 'present', recordedAt: T(5) },
      { sessionId: 'sess-1', userId: 'stu-2', status: 'absent', recordedAt: T(5) },
      { sessionId: 'sess-2', userId: 'stu', status: 'late', recordedAt: T(12) },
      { sessionId: 'sess-2', userId: 'stu-2', status: 'present', recordedAt: T(12) },
      { sessionId: 'sess-3', userId: 'stu-sec2', status: 'present', recordedAt: T(5) },
      { sessionId: 'sess-1', userId: 'stu-dropped', status: 'excused', recordedAt: T(5) },
    ] as AttendanceRecord[]),
  ];
  const calls = { record: 0, list: 0, sectionOf: 0, inSection: 0 };
  const attendance: AttendanceRepository = {
    record: async (e) => void (calls.record++, stored.push(e)),
    listForSession: async (sessionId) => (calls.list++, stored.filter((r) => r.sessionId === sessionId)),
  };
  const sessionSection: Record<string, string> = { 'sess-1': 'sec-1', 'sess-2': 'sec-1', 'sess-3': 'sec-2', 'sess-b': 'sec-b', 'sess-orphan': 'sec-orphan' };
  const sessions: SessionLocator = {
    sectionOf: async (id) => (calls.sectionOf++, sessionSection[id] ?? null),
    sessionsInSection: async (sectionId) => (calls.inSection++, Object.keys(sessionSection).filter((s) => sessionSection[s] === sectionId)),
  };

  const policy = opts.policy ?? createRolePolicy();
  const service = new ReportingService(attendance, {
    ...(opts.sessions === false ? {} : { sessions }),
    ...(opts.enforce === false ? {} : { enforcement: { policy, repos } }),
  });
  return { service, stored, calls, attendance, sessions, repos };
}

const mark = (over: Partial<AttendanceRecord> = {}): AttendanceRecord => ({
  sessionId: 'sess-1', userId: 'stu', status: 'present', recordedAt: T(19), ...over,
});
const grant = (action: string, over: Partial<TaGrant> = {}): TaGrant => ({
  id: `g-${action}`, enrollmentId: 'enr-3', sectionId: 'sec-1', action, grantedBy: 'teacher', grantedAt: new Date(), ...over,
});
const spyPolicy = () => {
  const seen: Array<{ action: string; ctx: PermissionContext }> = [];
  const policy: PermissionPolicy = { can: (action, ctx) => (seen.push({ action, ctx }), false) };
  return { seen, policy };
};

describe('ReportingService.recordAttendance with enforcement', () => {
  it('lets the section\'s instructor record a mark for an active student, stamped with the server\'s clock and who recorded it', async () => {
    const w = buildWorld();
    const before = Date.now();
    await w.service.recordAttendance(mark(), as('teacher'));
    const saved = w.stored.at(-1)!;
    expect(saved).toMatchObject({ sessionId: 'sess-1', userId: 'stu', status: 'present', recordedBy: 'teacher' });
    expect(saved.recordedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved.recordedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('ignores a backdated time, a claimed recorder and any extra field the caller supplies', async () => {
    const w = buildWorld();
    await w.service.recordAttendance({ ...mark({ recordedAt: new Date('1999-01-01') }), recordedBy: 'someone-else', evil: 1 } as never, as('teacher'));
    const saved = w.stored.at(-1)! as unknown as Record<string, unknown>;
    expect((saved.recordedAt as Date).getFullYear()).toBeGreaterThan(2000);
    expect(saved.recordedBy).toBe('teacher');
    expect('evil' in saved).toBe(false);
  });

  it('lets an admin, and a TA once reporting.recordAttendance is delegated to them', async () => {
    await expect(buildWorld().service.recordAttendance(mark(), as('root'))).resolves.toBeUndefined();
    const w = buildWorld({ grants: [grant('reporting.recordAttendance')] });
    await w.service.recordAttendance(mark(), as('ta'));
    expect(w.stored.at(-1)!).toMatchObject({ recordedBy: 'ta' });
  });

  it('gives a TA nothing by default, and ignores a revoked, foreign-section or other-action delegation', async () => {
    for (const grants of [
      [],
      [grant('reporting.recordAttendance', { revokedAt: new Date() })],
      [grant('reporting.recordAttendance', { sectionId: 'sec-2' })],
      [grant('scheduling.recordAttendance')],
    ]) {
      const w = buildWorld({ grants });
      await expect(w.service.recordAttendance(mark(), as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.record).toBe(0);
    }
  });

  it.each(['stu', 'stu-2', 'parent', 'teacher-2', 'root-b', 'outsider', 'nobody'])('refuses %s, and records nothing', async (who) => {
    const w = buildWorld();
    await expect(w.service.recordAttendance(mark(), as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.record).toBe(0);
  });

  it.each(['stu-dropped', 'stu-wait', 'stu-done', 'stu-sec2', 'stu-b', 'teacher', 'ta', 'root', 'ghost'])(
    'refuses to record a mark for %s, who is not an active student of that section',
    async (userId) => {
      const w = buildWorld();
      await expect(w.service.recordAttendance(mark({ userId }), as('teacher'))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.record).toBe(0);
    },
  );

  it.each([
    ['unknown', 'sess-none', 'root'],
    ['in a section whose course is missing', 'sess-orphan', 'root'],
    ['in another section', 'sess-3', 'teacher'],
    ['in another organization', 'sess-b', 'root'],
  ])('refuses a session that is %s', async (_label, sessionId, who) => {
    const w = buildWorld();
    await expect(w.service.recordAttendance(mark({ sessionId, userId: 'stu-sec2' }), as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.record).toBe(0);
  });

  it('takes the section from the locator: the instructor of the session\'s own section may', async () => {
    const w = buildWorld();
    await expect(w.service.recordAttendance(mark({ sessionId: 'sess-3', userId: 'stu-sec2' }), as('teacher-2'))).resolves.toBeUndefined();
  });

  it('refuses a status that does not exist, after the permission check', async () => {
    const w = buildWorld();
    await expect(w.service.recordAttendance(mark({ status: 'asleep' as never }), as('teacher'))).rejects.toThrow('status');
    await expect(w.service.recordAttendance(mark({ status: 'asleep' as never }), as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.record).toBe(0);
  });

  it('requires an actor, and looks nothing up without one', async () => {
    const w = buildWorld();
    await expect(w.service.recordAttendance(mark())).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.sectionOf).toBe(0);
    expect(w.calls.record).toBe(0);
  });

  it('asks the policy about reporting.recordAttendance in the session\'s section', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.recordAttendance(mark(), as('teacher')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['reporting.recordAttendance']);
    expect(seen[0]!.ctx.resourceOrgId).toBe('org-a');
    expect(seen[0]!.ctx.section?.role).toBe('instructor');
  });
});

describe('ReportingService.listAttendanceForSession (staff only)', () => {
  it.each(['teacher', 'ta', 'root'])('gives %s every mark of the session', async (who) => {
    const w = buildWorld();
    const marks = await w.service.listAttendanceForSession('sess-1', as(who));
    expect(marks.map((m) => m.userId).sort()).toEqual(['stu', 'stu-2', 'stu-dropped']);
  });

  it.each(['stu', 'stu-2', 'stu-dropped', 'stu-done', 'parent', 'teacher-2', 'root-b', 'outsider', 'nobody'])(
    'refuses %s, and does not read the marks',
    async (who) => {
      const w = buildWorld();
      await expect(w.service.listAttendanceForSession('sess-1', as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
      expect(w.calls.list).toBe(0);
    },
  );

  it.each(['sess-none', 'sess-orphan'])('refuses an unknown or orphaned session (%s), even for an admin', async (id) => {
    const w = buildWorld();
    await expect(w.service.listAttendanceForSession(id, as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.listAttendanceForSession('sess-1')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.list).toBe(0);
  });

  it('refuses even a custom policy that would let a student through, since only staff may list a whole session', async () => {
    const lax: PermissionPolicy = { can: () => true };
    const w = buildWorld({ policy: lax });
    await expect(w.service.listAttendanceForSession('sess-1', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(w.service.listAttendanceForSession('sess-1', as('teacher'))).resolves.toHaveLength(3);
  });
});

describe('ReportingService.attendanceForStudent: your own, your ward\'s, or anyone\'s if you are staff', () => {
  it('gives a student their own marks across the section\'s sessions, oldest first, with a summary', async () => {
    const w = buildWorld();
    const report = await w.service.attendanceForStudent('sec-1', 'stu', as('stu'));
    expect(report.records.map((r) => [r.sessionId, r.status])).toEqual([['sess-1', 'present'], ['sess-2', 'late']]);
    expect(report.summary).toEqual({ present: 1, absent: 0, excused: 0, late: 1, total: 2 });
  });

  it('never includes a classmate\'s marks, or another section\'s', async () => {
    const w = buildWorld();
    const report = await w.service.attendanceForStudent('sec-1', 'stu', as('stu'));
    expect(report.records.every((r) => r.userId === 'stu')).toBe(true);
  });

  it.each(['teacher', 'ta', 'root'])('lets %s (staff) read any student\'s', async (who) => {
    const w = buildWorld();
    const report = await w.service.attendanceForStudent('sec-1', 'stu-2', as(who));
    expect(report.summary).toEqual({ present: 1, absent: 1, excused: 0, late: 0, total: 2 });
  });

  it('gives staff an empty report for someone with no marks, or who is not a student there', async () => {
    const w = buildWorld();
    expect((await w.service.attendanceForStudent('sec-1', 'teacher', as('root'))).summary.total).toBe(0);
  });

  it('lets a guardian read their ward\'s, with the attendance scope', async () => {
    const w = buildWorld();
    const report = await w.service.attendanceForStudent('sec-1', 'stu', as('parent'));
    expect(report.summary.total).toBe(2);
  });

  it.each([
    ['a student asking about a classmate', 'stu', 'stu-2', 'sec-1'],
    ['a guardian without the attendance scope', 'parent-noscope', 'stu', 'sec-1'],
    ['a guardian asking about someone else\'s ward', 'parent', 'stu-2', 'sec-1'],
    ['a guardian of a ward who has dropped', 'parent-dropped', 'stu-dropped', 'sec-1'],
    ['a guardian asking about a section their ward is not in', 'parent', 'stu', 'sec-2'],
    ['a dropped student about themselves', 'stu-dropped', 'stu-dropped', 'sec-1'],
    ['a waitlisted student about themselves', 'stu-wait', 'stu-wait', 'sec-1'],
    ['a completed student about themselves', 'stu-done', 'stu-done', 'sec-1'],
    ['a student of another section', 'stu-sec2', 'stu', 'sec-1'],
    ['an admin of another organization', 'root-b', 'stu', 'sec-1'],
    ['a stranger', 'outsider', 'stu', 'sec-1'],
    ['an instructor of another section', 'teacher-2', 'stu', 'sec-1'],
  ])('refuses %s, and reads no marks', async (_label, who, userId, sectionId) => {
    const w = buildWorld();
    await expect(w.service.attendanceForStudent(sectionId, userId, as(who))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(w.calls.list).toBe(0);
    expect(w.calls.inSection).toBe(0);
  });

  it.each(['sec-none', 'sec-orphan'])('refuses an unknown or orphaned section (%s), even for an admin', async (sectionId) => {
    const w = buildWorld();
    await expect(w.service.attendanceForStudent(sectionId, 'stu', as('root'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('reads one session at a time, once each, and only that section\'s sessions', async () => {
    const w = buildWorld();
    await w.service.attendanceForStudent('sec-1', 'stu', as('stu'));
    expect(w.calls.inSection).toBe(1);
    expect(w.calls.list).toBe(2); // sess-1 and sess-2; not sess-3
  });

  it('requires an actor', async () => {
    const w = buildWorld();
    await expect(w.service.attendanceForStudent('sec-1', 'stu')).rejects.toBeInstanceOf(ActorRequiredError);
    expect(w.calls.list).toBe(0);
  });

  it('asks the policy about reporting.view, naming the student as the owner, and the guardian link when there is one', async () => {
    const { seen, policy } = spyPolicy();
    const w = buildWorld({ policy });
    await w.service.attendanceForStudent('sec-1', 'stu', as('parent')).catch(() => {});
    await w.service.attendanceForStudent('sec-1', 'stu', as('stu')).catch(() => {});
    expect(seen.map((s) => s.action)).toEqual(['reporting.view', 'reporting.view']);
    expect(seen[0]!.ctx.resourceOwnerId).toBe('stu');
    expect(seen[0]!.ctx.guardian).toMatchObject({ wardId: 'stu' });
    expect(seen[1]!.ctx.guardian).toBeUndefined();
    expect(seen[1]!.ctx.section?.completedRole).toBeUndefined(); // completion never widens attendance
  });
});

describe('the session locator', () => {
  it('is required: enforcement without one cannot be built', () => {
    const w = buildWorld();
    expect(() => new ReportingService(w.attendance, { enforcement: { policy: createRolePolicy(), repos: w.repos } })).toThrow('SessionLocator');
  });

  it('is needed by attendanceForStudent even without enforcement, and the error says so', async () => {
    const w = buildWorld({ enforce: false, sessions: false });
    await expect(w.service.attendanceForStudent('sec-1', 'stu')).rejects.toThrow('SessionLocator');
  });
});

describe('without enforcement the service behaves as it always has', () => {
  it('recordAttendance is a pass-through: no actor, no checks, the record exactly as given', async () => {
    const w = buildWorld({ enforce: false });
    const record = { ...mark({ sessionId: 'whatever', userId: 'anyone', recordedAt: new Date('1999-01-01') }), extra: 1 };
    await w.service.recordAttendance(record as never);
    expect(w.stored.at(-1)).toBe(record as never);
    expect('recordedBy' in w.stored.at(-1)!).toBe(false);
    expect(w.calls.sectionOf).toBe(0);
  });

  it('lists and reports with no actor and no checks', async () => {
    const w = buildWorld({ enforce: false });
    expect(await w.service.listAttendanceForSession('sess-1')).toHaveLength(3);
    expect((await w.service.attendanceForStudent('sec-1', 'stu-2')).summary.total).toBe(2);
  });
});

describe('computeCompletionPercent', () => {
  const w = buildWorld({ enforce: false });
  const pct = (total: number, done: number) => w.service.computeCompletionPercent(total, done);

  it('rounds the ratio to a whole percent', () => {
    expect(pct(3, 1)).toBe(33);
    expect(pct(3, 2)).toBe(67);
    expect(pct(4, 4)).toBe(100);
    expect(pct(10, 0)).toBe(0);
  });

  it('is 0 when there is nothing to complete', () => {
    expect(pct(0, 0)).toBe(0);
    expect(pct(0, 5)).toBe(0);
  });

  it('never goes above 100 or below 0', () => {
    expect(pct(2, 3)).toBe(100);
    expect(pct(2, -1)).toBe(0);
    expect(pct(-4, 2)).toBe(0);
  });

  it('treats anything that is not a finite number as 0', () => {
    expect(pct(Number.NaN, 1)).toBe(0);
    expect(pct(4, Number.NaN)).toBe(0);
    expect(pct(Number.POSITIVE_INFINITY, 1)).toBe(0);
    expect(pct(4, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('toCsv', () => {
  const csv = (rows: Array<Record<string, string | number>>, options?: { sanitizeFormulas?: boolean }) =>
    toCsv({ toRows: () => rows }, options);

  it('writes a header from the first row, then the rows, separated by newlines with none at the end', () => {
    expect(csv([{ name: 'Ada', final: 92 }, { name: 'Bob', final: 7 }])).toBe('name,final\nAda,92\nBob,7');
  });

  it('gives an empty string for no rows', () => {
    expect(csv([])).toBe('');
  });

  it('drops a key the first row did not have, and leaves a missing one empty', () => {
    expect(csv([{ a: 1, b: 2 }, { a: 3, c: 4 } as never])).toBe('a,b\n1,2\n3,');
  });

  it('quotes cells with a comma, a quote or a line break, doubling the quotes', () => {
    expect(csv([{ t: 'a,b', u: 'say "hi"', v: 'x\ny' }])).toBe('t,u,v\n"a,b","say ""hi""","x\ny"');
  });

  it('quotes a cell with a carriage return too', () => {
    expect(csv([{ t: 'a\rb' }])).toBe('t\n"a\rb"');
  });

  describe('spreadsheet formula injection', () => {
    it.each(['=', '+', '-', '@', '\t', '\r'])('neutralizes a text cell that starts with %j by prefixing a quote', (lead) => {
      const out = csv([{ name: `${lead}HYPERLINK("http://evil")` }]);
      expect(out.split('\n')[1]!.replace(/^"/, '').startsWith("'")).toBe(true);
    });

    it('neutralizes the classic payloads', () => {
      expect(csv([{ n: '=1+1' }])).toBe("n\n'=1+1");
      expect(csv([{ n: '@SUM(A1:A2)' }])).toBe("n\n'@SUM(A1:A2)");
      expect(csv([{ n: '-2+3' }])).toBe("n\n'-2+3");
      expect(csv([{ n: '+cmd|calc' }])).toBe("n\n'+cmd|calc");
    });

    it('does this before quoting, so a payload with a comma stays one safe cell', () => {
      expect(csv([{ n: '=SUM(1,2)' }])).toBe('n\n"\'=SUM(1,2)"');
    });

    it('leaves numbers alone: a negative number is a number, not a formula', () => {
      expect(csv([{ n: -5, m: 0.5, k: 1e21 }])).toBe(`n,m,k\n-5,0.5,${String(1e21)}`);
    });

    it('leaves text alone when the dangerous character is not first', () => {
      expect(csv([{ n: 'a=b', m: 'x-y', o: 'name@example.com', p: '' }])).toBe('n,m,o,p\na=b,x-y,name@example.com,');
    });

    it('cleans the header cells too', () => {
      expect(csv([{ '=evil': 1 }])).toBe("'=evil\n1");
    });

    it('can be switched off for data you trust, and then writes the text exactly as it is', () => {
      expect(csv([{ n: '=1+1' }], { sanitizeFormulas: false })).toBe('n\n=1+1');
      expect(csv([{ n: '=1+1' }], {})).toBe("n\n'=1+1");
    });
  });
});
