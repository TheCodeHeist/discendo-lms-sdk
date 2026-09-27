import { describe, it, expect } from 'bun:test';
import { EnrollmentService } from '../src/enrollment/index.js';
import { EventBus } from '../src/core/index.js';
import type { RepositoryContext } from '../src/core/index.js';
import type { Enrollment, CourseSection } from '../src/core/index.js';

function makeRepos(): RepositoryContext & { _sections: Map<string, CourseSection> } {
  const enrollments = new Map<string, Enrollment>();
  const sections = new Map<string, CourseSection>();
  let counter = 0;

  const repos: RepositoryContext & { _sections: Map<string, CourseSection> } = {
    users: {
      findById: async () => null,
      findByExternalRef: async () => null,
    },
    courses: {
      findCourse: async () => null,
      findSection: async (id) => sections.get(id) ?? null,
      listSections: async () => [],
    },
    enrollments: {
      create: async (e) => {
        counter++;
        const entry: Enrollment = { ...e, id: `enr-${counter}` };
        enrollments.set(entry.id, entry);
        return entry;
      },
      update: async (id, patch) => {
        const existing = enrollments.get(id);
        if (!existing) throw new Error('not found');
        const updated = { ...existing, ...patch };
        enrollments.set(id, updated);
        return updated;
      },
      findByUserAndSection: async (userId, sectionId) =>
        [...enrollments.values()].find((e) => e.userId === userId && e.sectionId === sectionId) ?? null,
      listBySection: async (sectionId) => [...enrollments.values()].filter((e) => e.sectionId === sectionId),
      countActive: async (sectionId) =>
        [...enrollments.values()].filter((e) => e.sectionId === sectionId && e.status === 'active').length,
    },
    content: {
      findById: async () => null,
      listBySection: async () => [],
      create: async (n) => ({ ...n, id: 'c1', version: 1 }),
      update: async (id, patch) => ({ id, sectionId: 's1', kind: 'page', title: '', orderIndex: 0, published: false, version: 1, ...patch }),
      reorder: async () => {},
    },
    terms: {
      findById: async () => null,
    },
    _sections: sections,
  };

  return repos;
}

describe('EnrollmentService event emission', () => {
  it('emits enrollment.enrolled with active status on a normal enroll', async () => {
    const repos = makeRepos();
    repos._sections.set('sec-1', { id: 'sec-1', courseId: 'course-1', status: 'published' });

    const bus = new EventBus();
    const received: Array<{ type: string; status?: string }> = [];
    bus.on('enrollment.enrolled', (e) => {
      received.push(e);
    });

    const service = new EnrollmentService(repos, bus);
    await service.enroll({ userId: 'user-1', sectionId: 'sec-1', role: 'student' });

    // emission is fire-and-forget; give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe('active');
  });

  it('emits enrollment.enrolled with waitlisted status when the section is full', async () => {
    const repos = makeRepos();
    repos._sections.set('sec-1', { id: 'sec-1', courseId: 'course-1', status: 'published', capacity: 0 });

    const bus = new EventBus();
    const received: Array<{ status?: string }> = [];
    bus.on('enrollment.enrolled', (e) => {
      received.push(e);
    });

    const service = new EnrollmentService(repos, bus);
    await service.enroll({ userId: 'user-1', sectionId: 'sec-1', role: 'student', waitlistIfFull: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(received[0]?.status).toBe('waitlisted');
  });

  it('emits enrollment.dropped on drop', async () => {
    const repos = makeRepos();
    repos._sections.set('sec-1', { id: 'sec-1', courseId: 'course-1', status: 'published' });

    const bus = new EventBus();
    const received: Array<{ type: string }> = [];
    bus.on('enrollment.dropped', (e) => {
      received.push(e);
    });

    const service = new EnrollmentService(repos, bus);
    const enrollment = await service.enroll({ userId: 'user-1', sectionId: 'sec-1', role: 'student' });
    await service.drop(enrollment.id);
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
  });

  it('works with no EventBus supplied at all (fully optional)', async () => {
    const repos = makeRepos();
    repos._sections.set('sec-1', { id: 'sec-1', courseId: 'course-1', status: 'published' });

    const service = new EnrollmentService(repos); // no bus
    const enrollment = await service.enroll({ userId: 'user-1', sectionId: 'sec-1', role: 'student' });
    expect(enrollment.status).toBe('active');
  });
});
