import { describe, expect, it } from 'bun:test';
import { PermissionDeniedError } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';
import { attendanceSheet, effectiveMarks, exportable, toCsv } from '../src/services/reporting/index.js';
import type { AttendanceRecord } from '../src/services/reporting/index.js';
import { createInMemoryLms } from '../src/testing/index.js';

const as = (actorId: string) => ({ actorId });
const HOUR = 3_600_000;

async function world() {
  const lms = createInMemoryLms();
  const events: LmsEvent[] = [];
  lms.bus.on('*', (e) => void events.push(e));
  lms.repos.users.seed(
    { id: 'admin', roles: ['admin'] },
    { id: 'teacher', roles: ['instructor'] },
    { id: 'stu', roles: ['student'], externalRef: 'S-001' },
    { id: 'ana', roles: ['student'] },
    { id: 'gone', roles: ['student'] },
  );
  lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
  const { enrollment } = lms.services;
  await enrollment.enroll({ userId: 'teacher', sectionId: 's', role: 'instructor' }, as('admin'));
  for (const u of ['stu', 'ana', 'gone']) await enrollment.enroll({ userId: u, sectionId: 's', role: 'student' }, as('admin'));
  const gone = await lms.repos.enrollments.findByUserAndSection('gone', 's');
  await enrollment.drop(gone!.id, as('admin'));
  const node = (over: { title?: string; published?: boolean; dueAt?: Date } = {}) =>
    lms.services.content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW', orderIndex: 0, published: true, ...over }, as('teacher'));
  return { lms, events, node };
}

describe('threads', () => {
  it('a student starts a thread with its first post, in their own name only', async () => {
    const { lms } = await world();
    const c = lms.services.communication;
    const t = await c.startThread('s', 'stu', 'Question on HW', 'What does 2b mean?', as('stu'));
    expect(t).toMatchObject({ sectionId: 's', title: 'Question on HW', createdBy: 'stu' });
    expect(t.posts.map((p) => [p.authorId, p.body])).toEqual([['stu', 'What does 2b mean?']]);
    await c.reply(t.id, 'teacher', 'It means...', as('teacher'));
    expect((await c.getThread(t.id, as('ana'))).posts).toHaveLength(2);
    await expect(c.startThread('s', 'ana', 'Fake', 'x', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(c.startThread('s', 'stu', '  ', 'x', as('stu'))).rejects.toThrow('title');
  });

  it('lists a section\'s threads, optionally for one piece of content, and refuses content of another section', async () => {
    const { lms, node } = await world();
    const c = lms.services.communication;
    const hw = await node();
    await c.startThread('s', 'stu', 'General', 'hi', as('stu'));
    await c.startThread('s', 'stu', 'About HW', 'hi', as('stu'), { contentId: hw.id });
    expect((await c.listThreads('s', as('ana'))).map((t) => t.title)).toEqual(['General', 'About HW']);
    expect((await c.listThreads('s', as('ana'), { contentId: hw.id })).map((t) => t.title)).toEqual(['About HW']);
    await expect(c.startThread('s', 'stu', 'X', 'x', as('stu'), { contentId: 'not-here' })).rejects.toThrow('not part of section');
  });

  it('keeps a thread on unpublished content from students, but not from staff', async () => {
    const { lms, node } = await world();
    const c = lms.services.communication;
    const draft = await node({ published: false, title: 'Draft' });
    const t = await c.startThread('s', 'teacher', 'Staff notes', 'x', as('teacher'), { contentId: draft.id });
    expect(await c.listThreads('s', as('stu'))).toEqual([]);
    await expect(c.getThread(t.id, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(c.reply(t.id, 'stu', 'sneaky', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await c.listThreads('s', as('teacher'))).toHaveLength(1);
    await lms.services.content.publish(draft.id, as('teacher'));
    expect(await c.listThreads('s', as('stu'))).toHaveLength(1);
  });
});

describe('due-date reminders', () => {
  it('tells each active student about published work due within the window, once', async () => {
    const { lms, node } = await world();
    const now = new Date('2026-10-01T09:00:00Z');
    const soon = await node({ title: 'Soon', dueAt: new Date(now.getTime() + 5 * HOUR) });
    await node({ title: 'Later', dueAt: new Date(now.getTime() + 72 * HOUR) });
    await node({ title: 'Past', dueAt: new Date(now.getTime() - HOUR) });
    await node({ title: 'Draft', published: false, dueAt: new Date(now.getTime() + HOUR) });

    const c = lms.services.communication;
    const first = await c.sendDueDateReminders('s', { within: 24 * HOUR, now });
    expect(first.map((r) => [r.userId, r.contentId]).sort()).toEqual([['ana', soon.id], ['stu', soon.id]]);
    expect(lms.notifications.sent.filter((n) => n.type === 'dueDateApproaching')).toHaveLength(2);
    // run again: nothing new
    expect(await c.sendDueDateReminders('s', { within: 24 * HOUR, now })).toEqual([]);
  });

  it('skips work already done, and reminds again when the due date moves', async () => {
    const { lms, node } = await world();
    const now = new Date('2026-10-01T09:00:00Z');
    const hw = await node({ dueAt: new Date(now.getTime() + 2 * HOUR) });
    const c = lms.services.communication;
    const sent = await c.sendDueDateReminders('s', { within: 24 * HOUR, now, isDone: async (u) => u === 'ana' });
    expect(sent.map((r) => r.userId)).toEqual(['stu']);
    await lms.services.content.updateNode(hw.id, { dueAt: new Date(now.getTime() + 4 * HOUR) }, as('teacher'));
    expect((await c.sendDueDateReminders('s', { within: 24 * HOUR, now })).map((r) => r.userId).sort()).toEqual(['ana', 'stu']);
  });

  it('keeps going when the sink fails, and reports each failure', async () => {
    const { lms, node, events } = await world();
    const now = new Date('2026-10-01T09:00:00Z');
    await node({ dueAt: new Date(now.getTime() + HOUR) });
    lms.notifications.dispatch = async () => {
      throw new Error('smtp down');
    };
    const sent = await lms.services.communication.sendDueDateReminders('s', { within: 2 * HOUR, now });
    expect(sent).toHaveLength(2);
    expect(events.filter((e) => e.type === 'communication.deliveryFailed')).toMatchObject([
      { channel: 'reminder', error: 'smtp down' },
      { channel: 'reminder', error: 'smtp down' },
    ]);
  });
});

describe('attendance', () => {
  const mark = (sessionId: string, userId: string, status: AttendanceRecord['status'], iso: string): AttendanceRecord => ({
    sessionId,
    userId,
    status,
    recordedAt: new Date(iso),
  });

  it('a later mark for the same session corrects the earlier one instead of counting twice', () => {
    const marks = [
      mark('mon', 'stu', 'absent', '2026-10-05T09:01:00Z'),
      mark('mon', 'stu', 'late', '2026-10-05T09:20:00Z'),
      mark('wed', 'stu', 'present', '2026-10-07T09:00:00Z'),
    ];
    expect(effectiveMarks(marks).map((m) => [m.sessionId, m.status])).toEqual([
      ['mon', 'late'],
      ['wed', 'present'],
    ]);
  });

  it('attendanceForStudent counts the corrected mark, keeps the history, and asks the store once', async () => {
    const { lms } = await world();
    const sessions = { sectionOf: async () => 's', sessionsInSection: async () => ['mon', 'wed'] };
    let perSession = 0;
    const repo = lms.repos.attendance;
    const counting = {
      record: repo.record.bind(repo),
      listForSessions: repo.listForSessions.bind(repo),
      listForSession: async (id: string) => {
        perSession++;
        return repo.listForSession(id);
      },
    };
    const { ReportingService } = await import('../src/services/reporting/index.js');
    const reporting = new ReportingService(counting, { sessions });
    await counting.record(mark('mon', 'stu', 'absent', '2026-10-05T09:01:00Z'));
    await counting.record(mark('mon', 'stu', 'late', '2026-10-05T09:20:00Z'));
    await counting.record(mark('wed', 'stu', 'present', '2026-10-07T09:00:00Z'));
    await counting.record(mark('wed', 'ana', 'absent', '2026-10-07T09:00:00Z'));
    const report = await reporting.attendanceForStudent('s', 'stu');
    expect(report.summary).toEqual({ present: 1, absent: 0, excused: 0, late: 1, total: 2 });
    expect(report.history).toHaveLength(3);
    expect(perSession).toBe(0);
  });

  it('attendanceSheet: a row per student, a column per session with the mark that counts, and totals', () => {
    const sheet = attendanceSheet(
      ['mon', 'wed'],
      ['stu', 'ana'],
      [
        mark('mon', 'stu', 'absent', '2026-10-05T09:01:00Z'),
        mark('mon', 'stu', 'present', '2026-10-05T09:30:00Z'),
        mark('wed', 'ana', 'late', '2026-10-07T09:10:00Z'),
        mark('wed', 'stranger', 'present', '2026-10-07T09:00:00Z'),
      ],
    );
    expect(toCsv(sheet)).toBe('userId,mon,wed,present,late,excused,absent\nstu,present,,1,0,0,0\nana,,late,0,1,0,0');
  });
});

describe('exports through the services', () => {
  it('exports the roster (staff only), with external references and dates', async () => {
    const { lms } = await world();
    const roster = await lms.services.reporting.exportRoster('s', as('teacher'));
    const rows = roster.toRows();
    expect(rows.map((r) => [r.userId, r.role, r.status])).toEqual([
      ['teacher', 'instructor', 'active'],
      ['stu', 'student', 'active'],
      ['ana', 'student', 'active'],
      ['gone', 'student', 'dropped'],
    ]);
    expect(rows.find((r) => r.userId === 'stu')?.externalRef).toBe('S-001');
    const active = await lms.services.reporting.exportRoster('s', as('teacher'), { status: 'active' });
    expect(active.toRows()).toHaveLength(3);
    await expect(lms.services.reporting.exportRoster('s', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('keeps exports staff-only even under a policy that lets students view reports', async () => {
    const { createRolePolicy } = await import('../src/core/index.js');
    const lax = createRolePolicy({ overrides: { 'reporting.view': { roles: ['admin', 'instructor', 'ta', 'student'] } } });
    const lms = createInMemoryLms({ policy: lax });
    lms.repos.users.seed({ id: 'admin', roles: ['admin'] }, { id: 'stu', roles: ['student'] });
    lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
    await lms.services.enrollment.enroll({ userId: 'stu', sectionId: 's', role: 'student' }, as('admin'));
    await expect(lms.services.reporting.exportRoster('s', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(lms.services.reporting.exportAttendance('s', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('exports attendance taken through scheduling as a sheet', async () => {
    const { lms } = await world();
    lms.repos.scheduling.seedGroup({ id: 'g', sectionId: 's', size: 2 });
    lms.repos.scheduling.seedTemplate({
      id: 't', sectionId: 's', teacherIds: ['teacher'], groupId: 'g',
      rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] }, startTime: '09:00', endTime: '10:00', timezone: 'UTC',
      validFrom: new Date('2026-10-05T00:00:00Z'),
    });
    const [monday] = await lms.services.scheduling.materializeOccurrences('t', new Date('2026-10-05T00:00:00Z'), new Date('2026-10-06T00:00:00Z'), as('admin'));
    await lms.services.scheduling.recordAttendanceForOccurrence(monday!.id, 'stu', 'present', as('teacher'));
    const sheet = await lms.services.reporting.exportAttendance('s', as('teacher'));
    expect(sheet.toRows()).toEqual([
      { userId: 'stu', [monday!.id]: 'present', present: 1, late: 0, excused: 0, absent: 0 },
      { userId: 'ana', [monday!.id]: '', present: 0, late: 0, excused: 0, absent: 0 },
    ]);
    await expect(lms.services.reporting.exportAttendance('s', as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('exports the gradebook: a column per piece of content, EX for excused, the final grade and letter; staff only', async () => {
    const { lms, node } = await world();
    const hw1 = await node({ title: 'HW1' });
    const hw2 = await node({ title: 'HW2' });
    const grade = async (contentId: string, userId: string, score: number) => {
      const sub = await lms.services.assessment.submit(contentId, userId, { kind: 'text', content: 'x' }, undefined, as(userId));
      await lms.services.grading.recordGrade(sub.id, userId, score, 10, 'teacher', undefined, as('teacher'));
    };
    await grade(hw1.id, 'stu', 9);
    await grade(hw2.id, 'stu', 6);
    await grade(hw1.id, 'ana', 7);
    await grade(hw2.id, 'ana', 1);
    await lms.services.accommodations.excuse(hw2.id, 'ana', as('teacher'));

    const scheme = { categories: [{ name: 'assignment', weight: 1 }] };
    const book = await lms.services.grading.exportGradebook('s', scheme, as('teacher'), {
      columns: [{ contentId: hw1.id, label: 'HW1' }, { contentId: hw2.id, label: 'HW2' }],
      scale: [{ minPercent: 70, label: 'Pass' }, { minPercent: 0, label: 'Fail' }],
    });
    expect(toCsv(book)).toBe('userId,HW1,HW2,final,letter\nstu,90,60,75,Pass\nana,70,EX,70,Pass');
    await expect(lms.services.grading.exportGradebook('s', scheme, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('toCsv', () => {
  it('formats dates as ISO, booleans and empties, and can write CRLF and a byte order mark', () => {
    const rows = exportable([{ when: new Date('2026-10-01T09:00:00Z'), ok: true, note: null, n: 3 }]);
    expect(toCsv(rows)).toBe('when,ok,note,n\n2026-10-01T09:00:00.000Z,true,,3');
    expect(toCsv(rows, { lineEnding: '\r\n', bom: true })).toBe('﻿when,ok,note,n\r\n2026-10-01T09:00:00.000Z,true,,3');
  });
});
