/**
 * The SDK never sends email/push itself — that's the host app's job.
 * We only emit typed events; the host wires a NotificationSink to
 * whatever delivery mechanism it already has (SendGrid, FCM, in-app, etc.)
 */
export type NotificationEvent =
  | { type: 'gradePosted'; userId: string; contentId: string; score: number }
  /** Held grades of one piece of content were released: tell the section's students who have one. */
  | { type: 'gradesReleased'; sectionId: string; contentId: string }
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
  /** Who started it (`CommunicationService.startThread`). Absent on threads made another way. */
  createdBy?: string;
  createdAt?: Date;
}

/**
 * Remembers which due-date reminders were already sent, so `sendDueDateReminders` can run on a
 * schedule (every hour, say) without telling anyone twice. `claim` must be atomic: store the key
 * and return true if it was not there, or return false if it was (an insert that ignores
 * duplicates). The key names the student, the content and the due date, so moving a due date
 * makes a fresh reminder due.
 */
export interface ReminderLog {
  claim(key: string): Promise<boolean>;
}
