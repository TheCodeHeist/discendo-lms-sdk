import { describe, expect, it } from 'bun:test';
import { InvalidContentChangeError, InvalidPrerequisiteError } from '../src/domains/content/index.js';
import { ContentNotAvailableError, PermissionDeniedError, contentAvailability } from '../src/core/index.js';
import type { ContentNode, LmsEvent } from '../src/core/index.js';
import { createInMemoryLms } from '../src/testing/index.js';

const as = (actorId: string) => ({ actorId });
const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);

async function world() {
  const lms = createInMemoryLms();
  const events: LmsEvent[] = [];
  lms.bus.on('*', (e) => void events.push(e));
  lms.repos.users.seed(
    { id: 'admin', roles: ['admin'] },
    { id: 'teacher', roles: ['instructor'] },
    { id: 'stu', roles: ['student'] },
  );
  lms.repos.courses
    .seedCourse({ id: 'c', title: 'C' })
    .seedSection({ id: 's', courseId: 'c', status: 'published' })
    .seedSection({ id: 's2', courseId: 'c', status: 'published' });
  await lms.services.enrollment.enroll({ userId: 'teacher', sectionId: 's', role: 'instructor' }, as('admin'));
  await lms.services.enrollment.enroll({ userId: 'teacher', sectionId: 's2', role: 'instructor' }, as('admin'));
  await lms.services.enrollment.enroll({ userId: 'stu', sectionId: 's', role: 'student' }, as('admin'));
  const content = lms.services.content;
  const make = (over: Partial<Omit<ContentNode, 'id' | 'version'>> = {}) =>
    content.createNode({ sectionId: 's', kind: 'assignment', title: 'HW', orderIndex: 0, published: true, ...over }, as('teacher'));
  return { lms, content, make, events };
}

describe('contentAvailability', () => {
  const at = new Date('2026-10-10T12:00:00Z');
  it('is not-yet-open before availableFrom, closed after availableUntil, open otherwise, both ends inclusive', () => {
    expect(contentAvailability({}, at)).toBe('open');
    expect(contentAvailability({ availableFrom: new Date('2026-10-11T00:00:00Z') }, at)).toBe('not-yet-open');
    expect(contentAvailability({ availableUntil: new Date('2026-10-09T00:00:00Z') }, at)).toBe('closed');
    expect(contentAvailability({ availableFrom: at, availableUntil: at }, at)).toBe('open');
  });
});

describe('ContentService.updateNode', () => {
  it('edits, bumps the version, and announces which fields changed', async () => {
    const { content, make, events } = await world();
    const node = await make();
    const due = days(7);
    const updated = await content.updateNode(node.id, { title: 'Essay 1', dueAt: due }, as('teacher'));
    expect(updated).toMatchObject({ title: 'Essay 1', dueAt: due, version: node.version + 1 });
    expect(events.find((e) => e.type === 'content.updated')).toEqual({
      type: 'content.updated',
      contentId: node.id,
      sectionId: 's',
      version: node.version + 1,
      changedFields: ['title', 'dueAt'],
      updatedBy: 'teacher',
    });
  });

  it('clears a date with null, and changes nothing (no new version) for a patch that changes nothing', async () => {
    const { content, make } = await world();
    const node = await make({ dueAt: days(3) });
    const cleared = await content.updateNode(node.id, { dueAt: null }, as('teacher'));
    expect(cleared.dueAt).toBeUndefined();
    expect('dueAt' in cleared).toBe(false);
    const same = await content.updateNode(node.id, { title: cleared.title }, as('teacher'));
    expect(same.version).toBe(cleared.version);
  });

  it('refuses an empty title, dates out of order, and a parent in another section or below the node', async () => {
    const { content, make } = await world();
    const parent = await make({ title: 'Unit 1' });
    const child = await make({ title: 'Lesson', parentId: parent.id });
    const elsewhere = await content.createNode({ sectionId: 's2', kind: 'page', title: 'X', orderIndex: 0, published: true }, as('teacher'));
    await expect(content.updateNode(child.id, { title: '  ' }, as('teacher'))).rejects.toBeInstanceOf(InvalidContentChangeError);
    await expect(content.updateNode(child.id, { availableFrom: days(5), availableUntil: days(1) }, as('teacher'))).rejects.toBeInstanceOf(InvalidContentChangeError);
    await expect(content.updateNode(child.id, { dueAt: days(9), availableUntil: days(8) }, as('teacher'))).rejects.toThrow('dueAt must not be after availableUntil');
    await expect(content.updateNode(child.id, { parentId: elsewhere.id }, as('teacher'))).rejects.toBeInstanceOf(InvalidContentChangeError);
    await expect(content.updateNode(parent.id, { parentId: child.id }, as('teacher'))).rejects.toThrow('under itself');
    await expect(content.updateNode(parent.id, { parentId: parent.id }, as('teacher'))).rejects.toThrow('under itself');
  });

  it('refuses dates out of order when a node is created too', async () => {
    const { make } = await world();
    await expect(make({ availableFrom: days(2), availableUntil: days(1) })).rejects.toBeInstanceOf(InvalidContentChangeError);
  });

  it('is for staff only', async () => {
    const { content, make } = await world();
    const node = await make();
    await expect(content.updateNode(node.id, { title: 'Mine now' }, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('content history', () => {
  it('records every create, edit, publish and unpublish as a full snapshot, with who and what changed', async () => {
    const { content, make } = await world();
    const node = await make({ published: false, title: 'Draft' });
    await content.updateNode(node.id, { title: 'Final' }, as('teacher'));
    await content.publish(node.id, as('teacher'));
    await content.unpublish(node.id, as('teacher'));
    const history = await content.listRevisions(node.id, as('teacher'));
    expect(history.map((r) => [r.version, r.change, r.snapshot.title, r.snapshot.published, r.changedBy])).toEqual([
      [1, 'created', 'Draft', false, 'teacher'],
      [2, 'updated', 'Final', false, 'teacher'],
      [3, 'published', 'Final', true, 'teacher'],
      [4, 'unpublished', 'Final', false, 'teacher'],
    ]);
    expect(history[1]?.changedFields).toEqual(['title']);
  });

  it('restores an earlier version as a new edit, leaving the history and the published state alone', async () => {
    const { content, make } = await world();
    const opens = days(-1);
    const node = await make({ title: 'Original', availableFrom: opens });
    await content.updateNode(node.id, { title: 'Changed', availableFrom: null, dueAt: days(4) }, as('teacher'));
    const restored = await content.restoreRevision(node.id, 1, as('teacher'));
    expect(restored).toMatchObject({ title: 'Original', availableFrom: opens, published: true, version: 3 });
    expect(restored.dueAt).toBeUndefined();
    const history = await content.listRevisions(node.id, as('teacher'));
    expect(history.map((r) => r.snapshot.title)).toEqual(['Original', 'Changed', 'Original']);
    await expect(content.restoreRevision(node.id, 99, as('teacher'))).rejects.toThrow('no version 99');
  });

  it('keeps the history from students', async () => {
    const { content, make } = await world();
    const node = await make();
    await expect(content.listRevisions(node.id, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('stored prerequisites', () => {
  it('can be added and removed while running, and isUnlocked follows them', async () => {
    const { lms, content, make } = await world();
    const a = await make({ title: 'A' });
    const b = await make({ title: 'B' });
    await content.addPrerequisite(b.id, a.id, as('teacher'));
    expect(await content.listPrerequisites(b.id, as('stu'))).toEqual([a.id]);
    expect(await content.isUnlocked('stu', b.id)).toBe(false);
    lms.completion.markComplete('stu', a.id);
    expect(await content.isUnlocked('stu', b.id)).toBe(true);
    expect(await content.removePrerequisite(b.id, a.id, as('teacher'))).toBe(true);
    expect(await content.listPrerequisites(b.id, as('teacher'))).toEqual([]);
  });

  it('refuses a self-requirement, another section, and a cycle (direct or longer); adding twice keeps one', async () => {
    const { content, make } = await world();
    const a = await make({ title: 'A' });
    const b = await make({ title: 'B' });
    const c = await make({ title: 'C' });
    const other = await content.createNode({ sectionId: 's2', kind: 'page', title: 'X', orderIndex: 0, published: true }, as('teacher'));
    await expect(content.addPrerequisite(a.id, a.id, as('teacher'))).rejects.toBeInstanceOf(InvalidPrerequisiteError);
    await expect(content.addPrerequisite(a.id, other.id, as('teacher'))).rejects.toBeInstanceOf(InvalidPrerequisiteError);
    await content.addPrerequisite(b.id, a.id, as('teacher'));
    await content.addPrerequisite(c.id, b.id, as('teacher'));
    await expect(content.addPrerequisite(a.id, b.id, as('teacher'))).rejects.toThrow('cycle');
    await expect(content.addPrerequisite(a.id, c.id, as('teacher'))).rejects.toThrow('cycle');
    const again = await content.addPrerequisite(b.id, a.id, as('teacher'));
    expect(await content.listPrerequisites(b.id, as('teacher'))).toEqual([again.requiresContentId]);
  });

  it('only staff may change them', async () => {
    const { content, make } = await world();
    const a = await make();
    const b = await make();
    await expect(content.addPrerequisite(b.id, a.id, as('stu'))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('dates and access', () => {
  it('checkAccess explains why a student cannot open or submit, combining dates, publishing and prerequisites', async () => {
    const { lms, content, make } = await world();
    const intro = await make({ title: 'Intro' });
    const later = await make({ title: 'Later', availableFrom: days(2) });
    const closed = await make({ title: 'Closed', availableFrom: days(-9), availableUntil: days(-1) });
    const locked = await make({ title: 'Locked' });
    const draft = await make({ title: 'Draft', published: false });
    await content.addPrerequisite(locked.id, intro.id, as('teacher'));

    expect(await content.checkAccess('stu', intro.id)).toEqual({ canOpen: true, canSubmit: true, published: true, availability: 'open', missingPrerequisites: [] });
    expect(await content.checkAccess('stu', later.id)).toMatchObject({ canOpen: false, canSubmit: false, availability: 'not-yet-open' });
    expect(await content.checkAccess('stu', closed.id)).toMatchObject({ canOpen: true, canSubmit: false, availability: 'closed' });
    expect(await content.checkAccess('stu', locked.id)).toMatchObject({ canOpen: false, missingPrerequisites: [intro.id] });
    expect(await content.checkAccess('stu', draft.id)).toMatchObject({ canOpen: false, published: false });
    lms.completion.markComplete('stu', intro.id);
    expect(await content.checkAccess('stu', locked.id)).toMatchObject({ canOpen: true });
    expect(await content.checkAccess('stu', later.id, { now: days(3) })).toMatchObject({ canOpen: true, availability: 'open' });
  });

  it('a student cannot open content before it opens, but sees it listed; staff can open it', async () => {
    const { content, make } = await world();
    const later = await make({ availableFrom: days(2) });
    const error = await content.getNode(later.id, as('stu')).catch((e) => e);
    expect(error).toBeInstanceOf(ContentNotAvailableError);
    expect(error.availability).toBe('not-yet-open');
    expect((await content.listNodes('s', as('stu'))).map((n) => n.id)).toContain(later.id);
    await expect(content.getNode(later.id, as('teacher'))).resolves.toMatchObject({ id: later.id });
  });

  it('a student cannot submit before it opens or after it closes', async () => {
    const { lms, make } = await world();
    const early = await make({ availableFrom: days(1) });
    const late = await make({ availableFrom: days(-5), availableUntil: days(-1) });
    const submit = (id: string) => lms.services.assessment.submit(id, 'stu', { kind: 'text', content: 'x' }, undefined, as('stu'));
    await expect(submit(early.id)).rejects.toMatchObject({ name: 'ContentNotAvailableError', availability: 'not-yet-open' });
    await expect(submit(late.id)).rejects.toMatchObject({ name: 'ContentNotAvailableError', availability: 'closed' });
  });

  it('a quiz that closes mid-attempt: no new answers, but the attempt can still be submitted with what was saved', async () => {
    const { lms, content, make } = await world();
    const quiz = await make({ kind: 'quiz', title: 'Quiz' });
    lms.repos.quizzes.seedQuestions(quiz.id, [
      { id: 'q1', type: 'true_false', prompt: '?', correctAnswer: true },
      { id: 'q2', type: 'true_false', prompt: '?', correctAnswer: false },
    ]);
    const s = lms.services.assessment;
    const attempt = await s.generateAttempt(quiz.id, 'stu', false, as('stu'));
    await s.saveAnswer(attempt.id, 'q1', true, as('stu'));
    await content.updateNode(quiz.id, { availableUntil: days(-0.001) }, as('teacher'));
    await expect(s.saveAnswer(attempt.id, 'q2', false, as('stu'))).rejects.toBeInstanceOf(ContentNotAvailableError);
    await expect(s.submitAttempt(attempt.id, as('stu'))).resolves.toMatchObject({ score: 1, maxScore: 2 });
    await expect(s.generateAttempt(quiz.id, 'stu', false, as('stu'))).rejects.toBeInstanceOf(ContentNotAvailableError);
  });
});
