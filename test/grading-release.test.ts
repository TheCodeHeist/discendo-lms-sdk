import { describe, expect, it } from 'bun:test';
import { computeFinalGrade, explainFinalGrade } from '../src/domains/grading/index.js';
import type { GradeEntry, GradingScheme } from '../src/domains/grading/index.js';
import { PermissionDeniedError } from '../src/core/index.js';
import type { LmsEvent } from '../src/core/index.js';
import { bridgeEventBusToNotificationSink, type NotificationEvent } from '../src/services/communication/index.js';
import { createInMemoryLms } from '../src/testing/index.js';

const scheme: GradingScheme = {
  categories: [
    { name: 'assignment', weight: 0.6, dropLowestN: 1 },
    { name: 'quiz', weight: 0.4 },
  ],
};
const entry = (id: string, score: number, maxScore = 10): GradeEntry => ({
  id,
  submissionId: `sub-${id}`,
  userId: 'stu',
  score,
  maxScore,
  graderId: 't',
  gradedAt: new Date('2026-10-01'),
});

describe('explainFinalGrade', () => {
  it('shows each category, what was counted and dropped, and agrees with computeFinalGrade', () => {
    const byCategory = new Map([
      ['assignment', [entry('a1', 5), entry('a2', 9), entry('a3', 7)]],
      ['quiz', [entry('q1', 8)]],
    ]);
    const x = explainFinalGrade(byCategory, scheme);
    expect(x.categories).toEqual([
      { name: 'assignment', weight: 0.6, effectiveWeight: 0.6, percent: 80, counted: ['a3', 'a2'], dropped: ['a1'] },
      { name: 'quiz', weight: 0.4, effectiveWeight: 0.4, percent: 80, counted: ['q1'], dropped: [] },
    ]);
    expect(x.percent).toBeCloseTo(80);
    expect(x.percent).toBe(computeFinalGrade(byCategory, scheme));
    expect(x.skipped).toEqual([]);
  });

  it('renormalizes when a category has nothing yet, and says so', () => {
    const x = explainFinalGrade(new Map([['quiz', [entry('q1', 5)]]]), scheme);
    expect(x.percent).toBe(50);
    expect(x.categories[0]).toMatchObject({ name: 'assignment', percent: null, effectiveWeight: 0, counted: [] });
    expect(x.categories[1]).toMatchObject({ effectiveWeight: 1 });
  });

  it('reports the rows it cannot count, with why, instead of quietly skipping them', () => {
    const byCategory = new Map([
      ['quiz', [entry('ok', 6), entry('zero-max', 1, 0), entry('negative', -1), entry('nan', Number.NaN)]],
      ['extra', [entry('stray', 10)]],
    ]);
    const x = explainFinalGrade(byCategory, scheme);
    expect(x.percent).toBe(60);
    expect(x.skipped).toEqual([
      { entryId: 'zero-max', category: 'quiz', reason: 'invalid-max-score' },
      { entryId: 'negative', category: 'quiz', reason: 'invalid-score' },
      { entryId: 'nan', category: 'quiz', reason: 'invalid-score' },
    ]);
    expect(x.uncategorized).toEqual([{ entryId: 'stray', category: 'extra' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Grade release, through a fully wired in-memory LMS
// ---------------------------------------------------------------------------------------------

const as = (actorId: string) => ({ actorId });
const finalScheme: GradingScheme = { categories: [{ name: 'assignment', weight: 1 }] };

async function world(gradeRelease: 'manual' | 'immediate' = 'manual') {
  const lms = createInMemoryLms({ gradeRelease });
  const events: LmsEvent[] = [];
  lms.bus.on('*', (e) => void events.push(e));
  const notified: NotificationEvent[] = [];
  bridgeEventBusToNotificationSink(lms.bus, { dispatch: async (n) => void notified.push(n) });
  lms.repos.users.seed(
    { id: 'admin', roles: ['admin'] },
    { id: 'teacher', roles: ['instructor'] },
    { id: 'ta', roles: ['ta'] },
    { id: 'stu', roles: ['student'] },
    { id: 'mom', roles: [] },
  );
  lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
  const { enrollment, content, assessment, grading, guardians } = lms.services;
  await enrollment.enroll({ userId: 'teacher', sectionId: 's', role: 'instructor' }, as('admin'));
  await enrollment.enroll({ userId: 'ta', sectionId: 's', role: 'ta' }, as('admin'));
  await enrollment.enroll({ userId: 'stu', sectionId: 's', role: 'student' }, as('admin'));
  await guardians.createLink('mom', 'stu', ['grades'], as('admin'));
  const hw = await content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW1', orderIndex: 0, published: true }, as('teacher'));
  const hw2 = await content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW2', orderIndex: 1, published: true }, as('teacher'));
  const grade = async (contentId: string, score: number) => {
    const sub = await assessment.submit(contentId, 'stu', { kind: 'text', content: '...' }, undefined, as('stu'));
    return grading.recordGrade(sub.id, 'stu', score, 10, 'teacher', undefined, as('teacher'));
  };
  const posted = () => events.filter((e): e is Extract<LmsEvent, { type: 'grading.gradePosted' }> => e.type === 'grading.gradePosted');
  return { lms, grading, hw, hw2, grade, events, posted, notified };
}

describe('grade release (manual)', () => {
  it('holds a grade from the student and their guardian until released; staff always see it', async () => {
    const { grading, hw, grade } = await world();
    await grade(hw.id, 7);

    expect(await grading.listGradesForUser('stu', 's', as('stu'))).toEqual([]);
    expect(await grading.listGradesForUser('stu', 's', as('mom'))).toEqual([]);
    expect(await grading.computeFinalGradeForUser('stu', 's', finalScheme, as('stu'))).toBe(0);

    const staffView = await grading.listGradesForUser('stu', 's', as('teacher'));
    expect(staffView).toHaveLength(1);
    expect(staffView[0]).toMatchObject({ contentId: hw.id, score: 7, percent: 70, released: false, excused: false, category: 'assignment' });
    expect(await grading.computeFinalGradeForUser('stu', 's', finalScheme, as('teacher'))).toBe(70);

    await grading.releaseGrades('s', hw.id, as('teacher'));
    expect(await grading.listGradesForUser('stu', 's', as('stu'))).toMatchObject([{ score: 7, released: true }]);
    expect(await grading.computeFinalGradeForUser('stu', 's', finalScheme, as('mom'))).toBe(70);
  });

  it('releases per piece of content: only the released work counts for the student', async () => {
    const { grading, hw, hw2, grade } = await world();
    await grade(hw.id, 10);
    await grade(hw2.id, 4);
    await grading.releaseGrades('s', hw.id, as('teacher'));
    expect(await grading.computeFinalGradeForUser('stu', 's', finalScheme, as('stu'))).toBe(100);
    expect(await grading.computeFinalGradeForUser('stu', 's', finalScheme, as('teacher'))).toBe(70);
    expect(await grading.computeLetterGradeForUser('stu', 's', finalScheme, [{ minPercent: 90, label: 'A' }, { minPercent: 0, label: 'C' }], as('stu'))).toBe('A');
  });

  it('can hide released grades again, keeping the release as history', async () => {
    const { lms, grading, hw, grade, events } = await world();
    await grade(hw.id, 7);
    const release = await grading.releaseGrades('s', hw.id, as('teacher'));
    const hidden = await grading.hideGrades('s', hw.id, as('teacher'));
    expect(hidden).toMatchObject({ id: release.id, hiddenBy: 'teacher' });
    expect(await grading.listGradesForUser('stu', 's', as('stu'))).toEqual([]);
    expect(await grading.hideGrades('s', hw.id, as('teacher'))).toBeNull();
    expect(await lms.repos.gradeReleases.history('s')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'grading.gradesHidden')).toHaveLength(1);
  });

  it('releasing twice keeps the one release and announces it once', async () => {
    const { grading, hw, events } = await world();
    const first = await grading.releaseGrades('s', hw.id, as('teacher'));
    const second = await grading.releaseGrades('s', hw.id, as('teacher'));
    expect(second.id).toBe(first.id);
    expect(events.filter((e) => e.type === 'grading.gradesReleased')).toEqual([
      { type: 'grading.gradesReleased', sectionId: 's', contentId: hw.id, releaseId: first.id, releasedBy: 'teacher' },
    ]);
    expect(await grading.listReleases('s', as('stu'))).toMatchObject([{ contentId: hw.id }]);
  });

  it('only staff with grading.release may release: not a student, not a TA unless delegated', async () => {
    const { lms, grading, hw } = await world();
    await expect(grading.releaseGrades('s', hw.id, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(grading.releaseGrades('s', hw.id, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(grading.hideGrades('s', hw.id, as('ta'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await lms.services.delegation.grant('s', 'ta', 'grading.release', as('teacher'));
    await expect(grading.releaseGrades('s', hw.id, as('ta'))).resolves.toMatchObject({ releasedBy: 'ta' });
  });

  it('marks a held grade released: false on grading.gradePosted, and true once its work is released', async () => {
    const { grading, hw, grade, posted } = await world();
    await grade(hw.id, 7);
    await grading.releaseGrades('s', hw.id, as('teacher'));
    await grade(hw.id, 9);
    expect(posted().map((e) => e.released)).toEqual([false, true]);
  });

  it('notifies the student of a held grade only when it is released', async () => {
    const { grading, hw, grade, notified } = await world();
    await grade(hw.id, 7);
    await new Promise((r) => setTimeout(r, 0));
    expect(notified).toEqual([]);
    await grading.releaseGrades('s', hw.id, as('teacher'));
    await new Promise((r) => setTimeout(r, 0));
    expect(notified).toEqual([{ type: 'gradesReleased', sectionId: 's', contentId: hw.id }]);
  });
});

describe('grade release off (immediate, the default)', () => {
  it('shows every grade at once, marks it released, and notifies as before', async () => {
    const { grading, hw, grade, posted, notified } = await world('immediate');
    await grade(hw.id, 7);
    await new Promise((r) => setTimeout(r, 0));
    expect(await grading.listGradesForUser('stu', 's', as('stu'))).toMatchObject([{ score: 7, released: true }]);
    expect(posted()[0]?.released).toBeUndefined();
    expect(notified).toMatchObject([{ type: 'gradePosted', userId: 'stu', score: 7 }]);
    await expect(grading.releaseGrades('s', hw.id, as('teacher'))).rejects.toThrow('GradeReleaseRepository');
  });
});

describe('explainGradeForUser and listGradesForUser', () => {
  it('lists current grades only (a regrade replaces the old one), marks excused work, and leaves it out of the grade', async () => {
    const { lms, grading, hw, hw2, grade } = await world('immediate');
    const first = await grade(hw.id, 4);
    const [sub] = await lms.repos.submissions.listByContent(hw.id);
    await grading.recordGrade(sub!.id, 'stu', 8, 10, 'teacher', first.id, as('teacher'));
    await grade(hw2.id, 2);
    await lms.services.accommodations.excuse(hw2.id, 'stu', as('teacher'));

    const grades = await grading.listGradesForUser('stu', 's', as('stu'));
    expect(grades.map((g) => [g.contentId, g.score, g.excused])).toEqual([
      [hw.id, 8, false],
      [hw2.id, 2, true],
    ]);
    const x = await grading.explainGradeForUser('stu', 's', finalScheme, as('stu'));
    expect(x.percent).toBe(80);
    expect(x.categories[0]?.counted).toHaveLength(1);
    expect(x.grades).toHaveLength(2);
  });

  it('finds a bad row written behind the service, instead of quietly not counting it', async () => {
    const { lms, grading, hw, grade } = await world('immediate');
    await grade(hw.id, 9);
    const [sub] = await lms.repos.submissions.listByContent(hw.id);
    const bad = await lms.repos.grades.create({ submissionId: sub!.id, userId: 'stu', score: 5, maxScore: 0, graderId: 'import', gradedAt: new Date() });
    const x = await grading.explainGradeForUser('stu', 's', finalScheme, as('teacher'));
    expect(x.percent).toBe(90);
    expect(x.skipped).toEqual([{ entryId: bad.id, category: 'assignment', reason: 'invalid-max-score' }]);
  });

  it('is refused to anyone who may not see the grades', async () => {
    const { lms, grading } = await world();
    lms.repos.users.seed({ id: 'stranger', roles: ['student'] });
    await expect(grading.listGradesForUser('stu', 's', as('stranger'))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(grading.explainGradeForUser('stu', 's', finalScheme, as('stranger'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('without enforcement, includes held grades unless releasedOnly is asked for', async () => {
    const lms = createInMemoryLms({ enforce: false, gradeRelease: 'manual' });
    lms.repos.users.seed({ id: 'stu', roles: ['student'] });
    lms.repos.courses.seedCourse({ id: 'c', title: 'C' }).seedSection({ id: 's', courseId: 'c', status: 'published' });
    const node = await lms.services.content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW', orderIndex: 0, published: true });
    const sub = await lms.services.assessment.submit(node.id, 'stu', { kind: 'text', content: 'x' });
    await lms.services.grading.recordGrade(sub.id, 'stu', 6, 10, 'teacher');
    expect(await lms.services.grading.listGradesForUser('stu', 's')).toMatchObject([{ released: false }]);
    expect(await lms.services.grading.listGradesForUser('stu', 's', undefined, { releasedOnly: true })).toEqual([]);
  });
});
