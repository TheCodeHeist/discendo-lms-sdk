/**
 * The SDK never sends email/push itself — that's the host app's job.
 * We only emit typed events; the host wires a NotificationSink to
 * whatever delivery mechanism it already has (SendGrid, FCM, in-app, etc.)
 */
export type NotificationEvent =
  | { type: 'gradePosted'; userId: string; contentId: string; score: number }
  | { type: 'announcementCreated'; sectionId: string; title: string }
  | { type: 'dueDateApproaching'; userId: string; contentId: string; dueAt: Date };

export interface NotificationSink {
  dispatch(event: NotificationEvent): Promise<void>;
}

export interface Announcement {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  postedAt: Date;
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
