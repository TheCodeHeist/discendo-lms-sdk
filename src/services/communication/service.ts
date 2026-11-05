import type {
  Action,
  ActorContext,
  PermissionPolicy,
} from "../../core/permissions.js";
import { PermissionDeniedError } from "../../core/permissions.js";
import { authorizeInSection, isStaff } from "../../core/authorization.js";
import type {
  Authorized,
  AuthorizationRepos,
} from "../../core/authorization.js";
import type { EventBus } from "../../core/events.js";
import type { ContentRepository, EnrollmentRepository } from "../../core/repositories.js";
import type {
  Announcement,
  AnnouncementAudience,
  NotificationEvent,
  ReminderLog,
  Thread,
  ThreadPost,
  NotificationSink,
} from "./types.js";

export interface AnnouncementRepository {
  create(a: Omit<Announcement, "id">): Promise<Announcement>;
  listBySection(sectionId: string): Promise<Announcement[]>;
}

export interface ThreadRepository {
  create(t: Omit<Thread, "id" | "posts">): Promise<Thread>;
  addPost(threadId: string, post: Omit<ThreadPost, "id">): Promise<ThreadPost>;
  findById(id: string): Promise<Thread | null>;
  /** OPTIONAL: every thread of a section, with its posts. Needed by `listThreads`. */
  listBySection?(sectionId: string): Promise<Thread[]>;
}

/** Everything needed to turn permission enforcement on, bundled so none of it can be forgotten. */
export interface CommunicationEnforcement {
  policy: PermissionPolicy;
  /**
   * With `content` too, a thread tied to content that is not published is kept from anyone who
   * is not staff, and `startThread` checks that its content belongs to the section.
   */
  repos: AuthorizationRepos & { content?: Pick<ContentRepository, "findById"> };
}

/** What `sendDueDateReminders` reads and remembers (the `reminders` option). */
export interface DueDateReminderOptions {
  content: Pick<ContentRepository, "listBySection">;
  enrollments: Pick<EnrollmentRepository, "listBySection">;
  /** Without it every run sends again; with it each reminder goes out once. */
  log?: ReminderLog;
}

export interface CommunicationServiceOptions {
  /**
   * Turns on permission enforcement. Once set, every public method requires an `{ actorId }`
   * argument and refuses to run without one. Leave it unset and the service behaves as it
   * always has: no actor, no permission checks.
   */
  enforcement?: CommunicationEnforcement;
  /**
   * Called when the notification sink fails (or throws) after an announcement was stored. The
   * announcement is kept and returned either way; this is how you find out. A throwing handler
   * is ignored. Default: the failure is discarded.
   */
  onDeliveryError?: (error: unknown, announcement: Announcement) => void;
  /** Optional EventBus to emit delivery failure events to. */
  events?: EventBus | undefined;
  /** Turns on `sendDueDateReminders`. */
  reminders?: DueDateReminderOptions;
}

const AUDIENCES: readonly AnnouncementAudience[] = ["students", "guardians"];

export class CommunicationService {
  private readonly events?: EventBus | undefined;

  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly threads: ThreadRepository,
    private readonly sink?: NotificationSink,
    private readonly options: CommunicationServiceOptions = {},
    events?: EventBus,
  ) {
    this.events = events ?? options.events;
  }

  /**
   * Posts an announcement to one of the two channels (`students` by default). With enforcement on
   * (`actor` required) the students' channel needs `communication.postAnnouncement` (delegable to
   * a TA) and the guardians' channel needs `communication.postGuardianAnnouncement` (admins and
   * instructors only, never delegable). The notification carries the audience so the host can
   * tell the channels apart. A failing sink never fails the post: see `onDeliveryError`.
   */
  async postAnnouncement(
    sectionId: string,
    title: string,
    body: string,
    audience: AnnouncementAudience = "students",
    actor?: ActorContext,
  ) {
    if (!AUDIENCES.includes(audience))
      throw new Error(`Unknown announcement audience: ${String(audience)}`);
    if (this.options.enforcement) {
      await this.authorizeOn(
        audience === "guardians"
          ? "communication.postGuardianAnnouncement"
          : "communication.postAnnouncement",
        actor,
        sectionId,
      );
    }

    const announcement = await this.announcements.create({
      sectionId,
      title,
      body,
      postedAt: new Date(),
      audience,
    });
    await this.notify(
      { type: "announcementCreated", sectionId, title, audience },
      announcement,
    );
    return announcement;
  }

  /**
   * Lists a section's announcements. With enforcement on (`actor` required):
   *  - without `wardId` it is the students' channel: any active member of the section may read it
   *    (`communication.viewAnnouncements`); students get the student announcements only, staff
   *    get both channels;
   *  - with `wardId` it is the guardians' channel: a guardian whose verified link to that ward
   *    includes the `announcements` scope, while the ward is an active student there, gets the
   *    guardian announcements only (`communication.viewGuardianAnnouncements`). Staff who name a
   *    ward get that channel only too.
   * A record with no audience counts as a student announcement. Without enforcement it returns
   * everything the repository has.
   */
  async listAnnouncements(
    sectionId: string,
    actor?: ActorContext,
    options: { wardId?: string } = {},
  ): Promise<Announcement[]> {
    if (!this.options.enforcement)
      return this.announcements.listBySection(sectionId);

    const asGuardian = options.wardId !== undefined;
    const auth = await this.authorizeOn(
      asGuardian
        ? "communication.viewGuardianAnnouncements"
        : "communication.viewAnnouncements",
      actor,
      sectionId,
      options.wardId,
    );
    const all = await this.announcements.listBySection(sectionId);
    const audienceOf = (a: Announcement): AnnouncementAudience =>
      a.audience ?? "students";
    if (asGuardian) return all.filter((a) => audienceOf(a) === "guardians");
    return isStaff(auth.ctx)
      ? all
      : all.filter((a) => audienceOf(a) === "students");
  }

  /**
   * Starts a discussion thread in a section, with its first post, optionally tied to a piece of
   * content. With enforcement on (`actor` required) the actor needs `communication.participate` in
   * the section (students may start threads), the author is always the actor, and, when the
   * enforcement repos include `content`, the content must be a node of that section. Returns the
   * thread with its first post.
   */
  async startThread(
    sectionId: string,
    authorId: string,
    title: string,
    body: string,
    actor?: ActorContext,
    options: { contentId?: string } = {},
  ): Promise<Thread> {
    if (title.trim() === "") throw new Error("A thread needs a title");
    if (this.options.enforcement) {
      await this.authorizeOn("communication.participate", actor, sectionId);
      if (authorId !== actor!.actorId) throw new PermissionDeniedError("communication.participate");
      const content = this.options.enforcement.repos.content;
      if (options.contentId !== undefined && content) {
        const node = await content.findById(options.contentId);
        if (!node || node.sectionId !== sectionId) {
          throw new Error(`Content ${options.contentId} is not part of section ${sectionId}`);
        }
      }
    }
    const createdAt = new Date();
    const thread = await this.threads.create({
      sectionId,
      title,
      createdBy: authorId,
      createdAt,
      ...(options.contentId !== undefined ? { contentId: options.contentId } : {}),
    });
    const post = await this.threads.addPost(thread.id, { authorId, body, postedAt: createdAt });
    return { ...thread, posts: [...thread.posts, post] };
  }

  /**
   * A section's threads, optionally only those tied to one piece of content. Needs
   * `ThreadRepository.listBySection`. With enforcement on, needs `communication.participate` in
   * the section, and someone who is not staff does not see threads tied to unpublished content
   * (when the enforcement repos include `content`).
   */
  async listThreads(
    sectionId: string,
    actor?: ActorContext,
    options: { contentId?: string } = {},
  ): Promise<Thread[]> {
    const list = this.threads.listBySection?.bind(this.threads);
    if (!list) throw new Error("listThreads needs ThreadRepository.listBySection");
    let staff = true;
    if (this.options.enforcement) {
      staff = isStaff((await this.authorizeOn("communication.participate", actor, sectionId)).ctx);
    }
    const threads = (await list(sectionId)).filter(
      (t) => options.contentId === undefined || t.contentId === options.contentId,
    );
    if (staff) return threads;
    const visible: Thread[] = [];
    for (const t of threads) if (await this.contentVisible(t)) visible.push(t);
    return visible;
  }

  /**
   * Tells each active student of a section about the published work due soon: content whose
   * `dueAt` falls after `now` and within `within` milliseconds. Dispatches one `dueDateApproaching`
   * per student and content to the sink, and returns them. Needs the `reminders` option.
   *
   * Run it on a schedule. With a `ReminderLog` each reminder goes out once, however often you run
   * it, and a moved due date makes a new one due. `isDone(userId, contentId)` skips work a student
   * has already handed in (assessment's submission count fits). It takes no actor and checks no
   * permission, so call it from your own server code only, never from a client.
   */
  async sendDueDateReminders(
    sectionId: string,
    options: { within: number; now?: Date; isDone?: (userId: string, contentId: string) => Promise<boolean> },
  ): Promise<Array<Extract<NotificationEvent, { type: "dueDateApproaching" }>>> {
    const reminders = this.options.reminders;
    if (!reminders) throw new Error("sendDueDateReminders needs the reminders option");
    if (!Number.isFinite(options.within) || options.within <= 0) throw new Error("within must be a number of milliseconds above 0");
    const now = (options.now ?? new Date()).getTime();
    const due = (await reminders.content.listBySection(sectionId)).filter(
      (n) => n.published && n.dueAt !== undefined && n.dueAt.getTime() > now && n.dueAt.getTime() <= now + options.within,
    );
    if (due.length === 0) return [];
    const students = (await reminders.enrollments.listBySection(sectionId, "active")).filter((e) => e.role === "student");

    const sent: Array<Extract<NotificationEvent, { type: "dueDateApproaching" }>> = [];
    for (const node of due) {
      for (const { userId } of students) {
        if (await options.isDone?.(userId, node.id)) continue;
        const key = `${userId}\u0000${node.id}\u0000${node.dueAt!.toISOString()}`;
        if (reminders.log && !(await reminders.log.claim(key))) continue;
        const event = { type: "dueDateApproaching" as const, userId, contentId: node.id, dueAt: node.dueAt! };
        await this.dispatchQuietly(event, sectionId, node.title);
        sent.push(event);
      }
    }
    return sent;
  }

  /**
   * Adds a post to a thread. With enforcement on (`actor` required) the actor needs
   * `communication.participate` in the thread's section, and the author is always the actor:
   * an `authorId` that is anyone else is refused, so nobody can post in another person's name.
   */
  async reply(
    threadId: string,
    authorId: string,
    body: string,
    actor?: ActorContext,
  ) {
    if (this.options.enforcement) {
      await this.authorizeOnThread(threadId, actor);
      if (authorId !== actor!.actorId)
        throw new PermissionDeniedError("communication.participate");
    }
    return this.threads.addPost(threadId, {
      authorId,
      body,
      postedAt: new Date(),
    });
  }

  /**
   * Reads a thread with its posts. With enforcement on (`actor` required) the actor needs
   * `communication.participate` in the thread's section. An unknown thread is refused exactly
   * like a forbidden one. Without enforcement an unknown thread throws `Thread <id> not found`.
   */
  async getThread(threadId: string, actor?: ActorContext): Promise<Thread> {
    if (this.options.enforcement) {
      return this.authorizeOnThread(threadId, actor);
    }
    const thread = await this.threads.findById(threadId);
    if (!thread) throw new Error(`Thread ${threadId} not found`);
    return thread;
  }

  /** Tells the sink, never letting a failure reach the caller: the announcement is already stored. */
  private async notify(
    event: Parameters<NotificationSink["dispatch"]>[0],
    announcement: Announcement,
  ): Promise<void> {
    const failed = await this.dispatchQuietly(event, announcement.sectionId, announcement.title);
    if (failed === undefined) return;
    try {
      this.options.onDeliveryError?.(failed, announcement);
    } catch {
      // a broken error handler must not fail the post either
    }
  }

  /** Dispatches to the sink; a failure is announced as `communication.deliveryFailed` and returned, never thrown. */
  private async dispatchQuietly(event: NotificationEvent, sectionId: string, title: string): Promise<unknown> {
    const sink = this.sink;
    if (!sink) return undefined;
    try {
      await sink.dispatch(event);
      return undefined;
    } catch (error) {
      void this.events?.emit({
        type: "communication.deliveryFailed",
        channel: event.type === "announcementCreated" ? "announcement" : "reminder",
        error: error instanceof Error ? error.message : String(error),
        sectionId,
        title,
      });
      return error ?? new Error("delivery failed");
    }
  }

  /** Whether a thread may be shown to someone who is not staff: its content, if any, is published. */
  private async contentVisible(thread: Thread): Promise<boolean> {
    const content = this.options.enforcement?.repos.content;
    if (!content || thread.contentId === undefined) return true;
    return (await content.findById(thread.contentId))?.published === true;
  }

  /** Authorizes against a thread's section (taken from the stored thread) and returns the thread. */
  private async authorizeOnThread(
    threadId: string,
    actor: ActorContext | undefined,
  ): Promise<Thread> {
    // Only needed to find out which section this is about; skipped without an actor so the
    // caller gets "actor required" before anything about the thread is looked up.
    const thread = actor ? await this.threads.findById(threadId) : null;
    const auth = await this.authorizeOn(
      "communication.participate",
      actor,
      thread?.sectionId,
    );
    // authorizeOn has already refused a missing thread, so there is one here.
    if (!isStaff(auth.ctx) && !(await this.contentVisible(thread!))) {
      throw new PermissionDeniedError("communication.participate");
    }
    return thread!;
  }

  private authorizeOn(
    action: Action,
    actor: ActorContext | undefined,
    sectionId: string | undefined,
    ownerId?: string,
  ): Promise<Authorized> {
    const e = this.options.enforcement!;
    return authorizeInSection(e.policy, e.repos, action, actor, {
      sectionId,
      ownerId,
    });
  }
}
