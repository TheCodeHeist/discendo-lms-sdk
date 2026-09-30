import { describe, it, expect } from 'bun:test';
import { ContentService } from '../src/domains/content/index.js';
import { EventBus } from '../src/core/index.js';
import type { RepositoryContext } from '../src/core/index.js';
import type { ContentNode } from '../src/core/index.js';

function makeRepos(): RepositoryContext {
  const nodes = new Map<string, ContentNode>();
  return {
    users: { findById: async () => null, findByExternalRef: async () => null },
    courses: { findCourse: async () => null, findSection: async () => null, listSections: async () => [] },
    enrollments: {
      create: async (e) => ({ ...e, id: 'e1' }),
      update: async (id, patch) => ({ id, userId: 'u', sectionId: 's', role: 'student', status: 'active', enrolledAt: new Date(), ...patch }),
      findByUserAndSection: async () => null,
      listBySection: async () => [],
      countActive: async () => 0,
    },
    content: {
      findById: async (id) => nodes.get(id) ?? null,
      listBySection: async () => [...nodes.values()],
      create: async (n) => {
        const node: ContentNode = { ...n, id: 'content-1', version: 1 };
        nodes.set(node.id, node);
        return node;
      },
      update: async (id, patch) => {
        const existing = nodes.get(id);
        if (!existing) throw new Error('not found');
        const updated = { ...existing, ...patch };
        nodes.set(id, updated);
        return updated;
      },
      reorder: async () => {},
    },
    terms: { findById: async () => null },
  };
}

describe('ContentService event emission', () => {
  it('emits content.published when a node is published', async () => {
    const repos = makeRepos();
    const bus = new EventBus();
    const received: Array<{ contentId: string; version: number }> = [];
    bus.on('content.published', (e) => {
      received.push(e);
    });

    const completion = { isComplete: async () => true };
    const service = new ContentService(repos, completion, [], bus);

    const node = await service.createNode({
      sectionId: 'sec-1',
      kind: 'page',
      title: 'Intro',
      orderIndex: 0,
      published: false,
    });
    await service.publish(node.id);
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.version).toBe(2);
  });

  it('works with no EventBus supplied at all', async () => {
    const repos = makeRepos();
    const completion = { isComplete: async () => true };
    const service = new ContentService(repos, completion); // no prerequisites, no bus
    const node = await service.createNode({
      sectionId: 'sec-1',
      kind: 'page',
      title: 'Intro',
      orderIndex: 0,
      published: false,
    });
    const published = await service.publish(node.id);
    expect(published.published).toBe(true);
  });
});
