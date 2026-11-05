import { describe, expect, it } from 'bun:test';
import { createInMemoryLms } from '../src/testing/index.js';
import { PermissionDeniedError } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';
import type { GradingScheme } from '../src/domains/grading/index.js';

const as = (actorId: string) => ({ actorId });
const scheme: GradingScheme = { categories: [{ name: 'assignment', weight: 0.5 }, { name: 'quiz', weight: 0.5 }] };

/** One school, one course section, an instructor, two students and a parent. */
async function school(options: { enforce?: boolean } = {}) {
  const lms = createInMemoryLms(options);
  const events: LmsEvent[] = [];
  lms.bus.on('*', (e) => void events.push(e));
  const org = { orgId: 'school' };
  lms.repos.organizations.seed({ id: 'school', name: 'Riverside High' });
  lms.repos.users.seed(
    { id: 'principal', roles: ['admin'], ...org },
    { id: 'ms-lee', roles: ['instructor'], ...org },
    { id: 'sam', roles: ['student'], ...org },
    { id: 'ana', roles: ['student'], ...org },
    { id: 'mom', roles: [], ...org },
  );
  lms.repos.courses.seedCourse({ id: 'bio', title: 'Biology', ...org }).seedSection({ id: 'bio-a', courseId: 'bio', status: 'published', capacity: 30 });
  const { enrollment } = lms.services;
  await enrollment.enroll({ userId: 'ms-lee', sectionId: 'bio-a', role: 'instructor' }, as('principal'));
  await enrollment.enroll({ userId: 'sam', sectionId: 'bio-a', role: 'student' }, as('principal'));
  await enrollment.enroll({ userId: 'ana', sectionId: 'bio-a', role: 'student' }, as('principal'));
  return { lms, events };
}

describe('createInMemoryLms: every service wired, enforcement on', () => {
  it('runs a term: content, a submission, a graded quiz, a final grade, a parent, an announcement and attendance', async () => {
    const { lms, events } = await school();
    const s = lms.services;

    // content: an assignment and a quiz, published by the instructor
    const essay = await s.content.createNode({ sectionId: 'bio-a', kind: 'assignment', title: 'Cell essay', orderIndex: 0, published: false }, as('ms-lee'));
    const quiz = await s.content.createNode({ sectionId: 'bio-a', kind: 'quiz', title: 'Cells quiz', orderIndex: 1, published: false }, as('ms-lee'));
    await s.content.publish(essay.id, as('ms-lee'));
    await s.content.publish(quiz.id, as('ms-lee'));
    lms.repos.quizzes.seedQuestions(quiz.id, [
      { id: 'q1', prompt: 'Powerhouse of the cell?', choices: ['Nucleus', 'Mitochondria'], correctChoiceIndex: 1 },
      { id: 'q2', prompt: 'Plants have cell walls?', choices: ['Yes', 'No'], correctChoiceIndex: 0 },
    ]);

    // the student submits the essay and the instructor grades it
    const submission = await s.assessment.submit(essay.id, 'sam', { kind: 'text', content: 'Cells are...' }, 2, as('sam'));
    expect(submission.attemptNumber).toBe(1);
    await s.grading.recordGrade(submission.id, 'sam', 18, 20, 'ms-lee', undefined, as('ms-lee'));

    // the student takes the quiz; submitting it records a grade automatically
    const attempt = await s.assessment.generateAttempt(quiz.id, 'sam', false, as('sam'));
    await s.assessment.saveAnswer(attempt.id, 'q1', 1, as('sam'));
    await s.assessment.saveAnswer(attempt.id, 'q2', 0, as('sam'));
    const result = await s.assessment.submitAttempt(attempt.id, as('sam'));
    expect(result.score).toBe(2);

    // the final grade comes from both, each in its own category (the content kind)
    expect(await s.grading.computeFinalGradeForUser('sam', 'bio-a', scheme, as('sam'))).toBe(95);

    // a parent, once linked by an admin, can read the grade too; the other student cannot
    await s.guardians.createLink('mom', 'sam', ['grades'], as('principal'));
    expect(await s.grading.computeFinalGradeForUser('sam', 'bio-a', scheme, as('mom'))).toBe(95);
    await expect(s.grading.computeFinalGradeForUser('sam', 'bio-a', scheme, as('ana'))).rejects.toBeInstanceOf(PermissionDeniedError);

    // an announcement reaches the notification sink
    await s.communication.postAnnouncement('bio-a', 'Lab on Friday', 'Bring goggles', 'students', as('ms-lee'));
    expect(lms.notifications.sent).toHaveLength(1);

    // a scheduled class: attendance taken through scheduling is read back through reporting
    lms.repos.scheduling.seedRoom({ id: 'lab-1', name: 'Lab 1', capacity: 30, features: ['lab'], orgId: 'school' });
    lms.repos.scheduling.seedGroup({ id: 'bio-a-group', sectionId: 'bio-a', size: 2 });
    lms.repos.scheduling.seedTemplate({
      id: 'bio-mon',
      sectionId: 'bio-a',
      teacherIds: ['ms-lee'],
      groupId: 'bio-a-group',
      roomId: 'lab-1',
      rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO'] },
      startTime: '09:00',
      endTime: '10:00',
      timezone: 'UTC',
      validFrom: new Date('2026-09-07T00:00:00Z'),
    });
    const [monday] = await s.scheduling.materializeOccurrences('bio-mon', new Date('2026-09-07T00:00:00Z'), new Date('2026-09-13T00:00:00Z'), as('principal'));
    await s.scheduling.recordAttendanceForOccurrence(monday!.id, 'sam', 'present', as('ms-lee'));
    const report = await s.reporting.attendanceForStudent('bio-a', 'sam', as('sam'));
    expect(report.summary).toEqual({ present: 1, absent: 0, excused: 0, late: 0, total: 1 });

    // everything was announced on the one bus
    const types = new Set(events.map((e) => e.type));
    const expected: Array<LmsEvent['type']> = [
      'enrollment.enrolled',
      'content.published',
      'assessment.submissionReceived',
      'assessment.quizSubmitted',
      'grading.gradePosted',
      'guardians.linkCreated',
    ];
    for (const t of expected) expect(types).toContain(t);
  });

  it('enforces permissions: a student cannot publish content or grade work', async () => {
    const { lms } = await school();
    const node = await lms.services.content.createNode({ sectionId: 'bio-a', kind: 'page', title: 'Notes', orderIndex: 0, published: false }, as('ms-lee'));
    await expect(lms.services.content.publish(node.id, as('sam'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(lms.services.content.publish(node.id)).rejects.toThrow();
  });

  it('keeps organizations apart', async () => {
    const { lms } = await school();
    lms.repos.users.seed({ id: 'outsider', roles: ['admin'], orgId: 'other-school' });
    await expect(
      lms.services.enrollment.enroll({ userId: 'ana', sectionId: 'bio-a', role: 'student' }, as('outsider')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('gives each LMS its own data', async () => {
    const one = await school();
    const two = createInMemoryLms();
    expect(await one.lms.repos.enrollments.countActive('bio-a')).toBe(3);
    expect(await two.repos.enrollments.countActive('bio-a')).toBe(0);
  });
});

describe('createInMemoryLms({ enforce: false })', () => {
  it('works with no actors at all, for quick experiments', async () => {
    const lms = createInMemoryLms({ enforce: false });
    lms.repos.users.seed({ id: 'sam', roles: ['student'] });
    lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
    await lms.services.enrollment.enroll({ userId: 'sam', sectionId: 's', role: 'student' });
    const node = await lms.services.content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW', orderIndex: 0, published: true });
    const sub = await lms.services.assessment.submit(node.id, 'sam', { kind: 'text', content: 'done' });
    await lms.services.grading.recordGrade(sub.id, 'sam', 7, 10, 'teacher');
    expect(await lms.services.grading.computeFinalGradeForUser('sam', 's', { categories: [{ name: 'assignment', weight: 1 }] })).toBe(70);
  });
});
