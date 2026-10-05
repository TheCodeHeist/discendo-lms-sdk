import type { Action, ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError } from '../../core/permissions.js';
import { authorizeInSection, isStaff } from '../../core/authorization.js';
import type { Authorized, AuthorizationRepos } from '../../core/authorization.js';
import type { Announcement, AnnouncementAudience, Thread, ThreadPost, NotificationSink } from './types.js';

export interface AnnouncementRepository {
  create(a: Omit<Announcement, 'id'>): Promise<Announcement>;
  listBySection(sectionId: string): Promise<Announcement[]>;
}

export interface ThreadRepository {
  create(t: Omit<Thread, 'id' | 'posts'>): Promise<Thread>;
  addPost(threadId: string, post: Omit<ThreadPost, 'id'>): Promise<ThreadPost>;
  findById(id: string): Promise<Thread | null>;
}

/** Everything needed to turn permission enforcement on, bundled so none of it can be forgotten. */
export interface CommunicationEnforcement {
  policy: PermissionPolicy;
  repos: AuthorizationRepos;
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
}

const AUDIENCES: readonly AnnouncementAudience[] = ['students', 'guardians'];

export class CommunicationService {
  constructor(
    private readonly announcements: AnnouncementRepository,
    private readonly threads: ThreadRepository,
    private readonly sink?: NotificationSink,
    private readonly options: CommunicationServiceOptions = {},
  ) {}

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
    audience: AnnouncementAudience = 'students',
    actor?: ActorContext,
  ) {
    if (!AUDIENCES.includes(audience)) throw new Error(`Unknown announcement audience: ${String(audience)}`);
    if (this.options.enforcement) {
      await this.authorizeOn(
        audience === 'guardians' ? 'communication.postGuardianAnnouncement' : 'communication.postAnnouncement',
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
    await this.notify({ type: 'announcementCreated', sectionId, title, audience }, announcement);
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
    if (!this.options.enforcement) return this.announcements.listBySection(sectionId);

    const asGuardian = options.wardId !== undefined;
    const auth = await this.authorizeOn(
      asGuardian ? 'communication.viewGuardianAnnouncements' : 'communication.viewAnnouncements',
      actor,
      sectionId,
      options.wardId,
    );
    const all = await this.announcements.listBySection(sectionId);
    const audienceOf = (a: Announcement): AnnouncementAudience => a.audience ?? 'students';
    if (asGuardian) return all.filter((a) => audienceOf(a) === 'guardians');
    return isStaff(auth.ctx) ? all : all.filter((a) => audienceOf(a) === 'students');
  }

  /**
   * Adds a post to a thread. With enforcement on (`actor` required) the actor needs
   * `communication.participate` in the thread's section, and the author is always the actor:
   * an `authorId` that is anyone else is refused, so nobody can post in another person's name.
   */
  async reply(threadId: string, authorId: string, body: string, actor?: ActorContext) {
    if (this.options.enforcement) {
      await this.authorizeOnThread(threadId, actor);
      if (authorId !== actor!.actorId) throw new PermissionDeniedError('communication.participate');
    }
    return this.threads.addPost(threadId, { authorId, body, postedAt: new Date() });
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
  private async notify(event: Parameters<NotificationSink['dispatch']>[0], announcement: Announcement): Promise<void> {
    const sink = this.sink;
    if (!sink) return;
    try {
      await sink.dispatch(event);
    } catch (error) {
      try {
        this.options.onDeliveryError?.(error, announcement);
      } catch {
        // a broken error handler must not fail the post either
      }
    }
  }

  /** Authorizes against a thread's section (taken from the stored thread) and returns the thread. */
  private async authorizeOnThread(threadId: string, actor: ActorContext | undefined): Promise<Thread> {
    // Only needed to find out which section this is about; skipped without an actor so the
    // caller gets "actor required" before anything about the thread is looked up.
    const thread = actor ? await this.threads.findById(threadId) : null;
    await this.authorizeOn('communication.participate', actor, thread?.sectionId);
    // authorizeOn has already refused a missing thread, so there is one here.
    return thread!;
  }

  private authorizeOn(
    action: Action,
    actor: ActorContext | undefined,
    sectionId: string | undefined,
    ownerId?: string,
  ): Promise<Authorized> {
    const e = this.options.enforcement!;
    return authorizeInSection(e.policy, e.repos, action, actor, { sectionId, ownerId });
  }
}
