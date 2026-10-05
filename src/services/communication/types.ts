/**
 * The SDK never sends email/push itself — that's the host app's job.
 * We only emit typed events; the host wires a NotificationSink to
 * whatever delivery mechanism it already has (SendGrid, FCM, in-app, etc.)
 */
export type NotificationEvent =
  | { type: 'gradePosted'; userId: string; contentId: string; score: number }
  | { type: 'announcementCreated'; sectionId: string; title: string; audience: AnnouncementAudience }
  | { type: 'dueDateApproaching'; userId: string; contentId: string; dueAt: Date };

/**
 * Announcements go out on two separate channels. `students` reaches the section's students;
 * `guardians` reaches the guardians of its students. An institution that wants a message on
 * both posts it twice.
 */
export type AnnouncementAudience = 'students' | 'guardians';

export interface NotificationSink {
  dispatch(event: NotificationEvent): Promise<void>;
}

export interface Announcement {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  postedAt: Date;
  /** Which channel it was posted to. A record without one (from before channels) counts as `students`. */
  audience?: AnnouncementAudience;
}

export interface ThreadPost {
  id: string;
  authorId: string;
  body: string;
  postedAt: Date;
}

export interface Thread {
  id: string;
  contentId?: string; // optionally tied to a piece of content
  sectionId: string;
  title: string;
  posts: ThreadPost[];
}
