import type { Announcement, Thread, ThreadPost, NotificationSink } from './types.js';

export interface AnnouncementRepository {
  create(a: Omit<Announcement, 'id'>): Promise<Announcement>;
  listBySection(sectionId: string): Promise<Announcement[]>;
}

export interface ThreadRepository {
  create(t: Omit<Thread, 'id' | 'posts'>): Promise<Thread>;
  addPost(threadId: string, post: Omit<ThreadPost, 'id'>): Promise<ThreadPost>;
  findById(id: string): Promise<Thread | null>;
}

export class CommunicationService {
  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly threads: ThreadRepository,
    private readonly sink?: NotificationSink,
  ) {}

  async postAnnouncement(sectionId: string, title: string, body: string) {
    const announcement = await this.announcements.create({
      sectionId,
      title,
      body,
      postedAt: new Date(),
    });
    await this.sink?.dispatch({ type: 'announcementCreated', sectionId, title });
    return announcement;
  }

  async reply(threadId: string, authorId: string, body: string) {
    return this.threads.addPost(threadId, { authorId, body, postedAt: new Date() });
  }
}
