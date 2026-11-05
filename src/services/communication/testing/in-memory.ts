/** In-memory implementations of the communication repositories, kept in this process only. */
import { InMemoryTable } from '../../../core/testing/table.js';
import type { AnnouncementRepository, ThreadRepository } from '../service.js';
import type { Announcement, NotificationEvent, NotificationSink, ReminderLog, Thread, ThreadPost } from '../types.js';

/** Stores `audience` as given; `listBySection` returns both channels, oldest first. */
export class InMemoryAnnouncementRepository implements AnnouncementRepository {
  private readonly announcements = new InMemoryTable<Announcement>('ann', 'Announcement');

  async create(a: Omit<Announcement, 'id'>): Promise<Announcement> {
    return this.announcements.insert(a);
  }

  async listBySection(sectionId: string): Promise<Announcement[]> {
    return this.announcements.where((a) => a.sectionId === sectionId);
  }
}

/** A thread is returned with its posts, oldest first. */
export class InMemoryThreadRepository implements ThreadRepository {
  private readonly threads = new InMemoryTable<Thread>('thread', 'Thread');
  private nextPost = 0;

  async create(t: Omit<Thread, 'id' | 'posts'>): Promise<Thread> {
    return this.threads.insert({ ...t, posts: [] });
  }

  async addPost(threadId: string, post: Omit<ThreadPost, 'id'>): Promise<ThreadPost> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    const stored: ThreadPost = { ...structuredClone(post), id: `post-${++this.nextPost}` };
    this.threads.update(threadId, { posts: [...thread.posts, stored] });
    return structuredClone(stored);
  }

  async findById(id: string): Promise<Thread | null> {
    return this.threads.get(id);
  }

  async listBySection(sectionId: string): Promise<Thread[]> {
    return this.threads.where((t) => t.sectionId === sectionId);
  }
}

/** A `ReminderLog` in a Set: `claim` is atomic because it neither awaits nor yields. */
export class InMemoryReminderLog implements ReminderLog {
  private readonly claimed = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }
}

/**
 * A `NotificationSink` that only remembers what it was given, for tests and demos: the SDK never
 * delivers anything itself, so this is where a demo can see what would have been sent.
 */
export class RecordingNotificationSink implements NotificationSink {
  readonly sent: NotificationEvent[] = [];

  async dispatch(event: NotificationEvent): Promise<void> {
    this.sent.push(structuredClone(event));
  }
}
