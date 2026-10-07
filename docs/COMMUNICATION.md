# Communication

`src/services/communication/` — announcements to a section, discussion thread
replies, and the bridge that turns SDK events into notifications. Subpath:
`discendo-sdk/communication`.

The first rule of this module: **the SDK never sends email, push or SMS.** That is
your application's job, with whatever you already use (SendGrid, FCM, an in-app
inbox). The SDK emits typed events; you plug a `NotificationSink` into your own
delivery mechanism.

## At a glance

| | |
| --- | --- |
| **You import** | `CommunicationService`, `CommunicationEnforcement`, `CommunicationServiceOptions`, `bridgeEventBusToNotificationSink`, and the types in `types.ts` |
| **You implement** | `AnnouncementRepository`, `ThreadRepository`, and a `NotificationSink` |
| **Emits events** | none itself; it *consumes* `grading.gradePosted` through the bridge |
| **Permission actions** | `communication.postAnnouncement` (delegable), `communication.postGuardianAnnouncement`, `communication.viewAnnouncements`, `communication.viewGuardianAnnouncements`, `communication.participate` |
| **Enforcement** | opt-in: `{ enforcement: { policy, repos } }` in the fourth constructor argument |

## Types (`types.ts`)

```ts
type NotificationEvent =
  | { type: 'gradePosted'; userId: string; contentId: string; score: number }
  | { type: 'announcementCreated'; sectionId: string; title: string; audience: AnnouncementAudience }
  | { type: 'dueDateApproaching'; userId: string; contentId: string; dueAt: Date };

type AnnouncementAudience = 'students' | 'guardians';

interface NotificationSink {
  dispatch(event: NotificationEvent): Promise<void>;
}

interface Announcement {
  id: string; sectionId: string; title: string; body: string; postedAt: Date;
  audience?: AnnouncementAudience;   // missing on old records, which count as 'students'
}
interface ThreadPost   { id: string; authorId: string; body: string; postedAt: Date }
interface Thread {
  id: string;
  contentId?: string;     // optionally tied to a piece of content
  sectionId: string;
  title: string;
  posts: ThreadPost[];
}
```

A `NotificationEvent` says *what happened*, not *who to tell*. Working out the
recipients and the channel is the sink's job. For an announcement the event carries the
**audience**: a sink must send a `guardians` announcement to guardians only and a
`students` one to students only, or the two channels leak into each other.

## `CommunicationService`

```ts
new CommunicationService(
  announcements: AnnouncementRepository,
  threads: ThreadRepository,
  sink?: NotificationSink,
  options?: {
    enforcement?: { policy: PermissionPolicy; repos: AuthorizationRepos };
    onDeliveryError?: (error: unknown, announcement: Announcement) => void;
  },
)
```

When `enforcement` is set, every method takes a trailing `actor?: { actorId }` that is
required; without it the actor is ignored and nothing is checked. The `repos` need `users`,
`courses`, `enrollments`, and, if you use them, `guardianLinks` and `delegations`.

```ts
interface AnnouncementRepository {
  create(a: Omit<Announcement, 'id'>): Promise<Announcement>;
  listBySection(sectionId: string): Promise<Announcement[]>;
}
interface ThreadRepository {
  create(t: Omit<Thread, 'id' | 'posts'>): Promise<Thread>;
  addPost(threadId: string, post: Omit<ThreadPost, 'id'>): Promise<ThreadPost>;
  findById(id: string): Promise<Thread | null>;
}
```

### `postAnnouncement(sectionId, title, body, audience = 'students', actor?): Promise<Announcement>`

Stores the announcement (`postedAt` is now, with its `audience`) and then sends
`{ type: 'announcementCreated', sectionId, title, audience }` to the sink, if there is one.
An `audience` that is not `'students'` or `'guardians'` throws before anything else.

- **Two channels.** `students` is the default. `guardians` is a separate channel for the
  guardians of the section's students. An institution that wants both sends twice.
- **(Enforcement on)** the students' channel needs `communication.postAnnouncement` (a TA
  only if delegated); the guardians' channel needs `communication.postGuardianAnnouncement`,
  for **admins and instructors only, and it can never be delegated**. A delegation of it that
  is stored anyway has no effect.
- **A failing sink never fails the post.** The announcement is already stored, so a sink that
  rejects or throws is caught and the announcement is returned. Pass `onDeliveryError` to hear
  about it (it gets the error and the announcement). Without that handler the failure is
  **discarded silently**, so a dead notification channel is invisible. A throwing handler is
  ignored too. This applies with or without enforcement. The sink is still awaited, so a
  slow sink slows the call.

### `listAnnouncements(sectionId, actor?, { wardId? }): Promise<Announcement[]>`

A section's announcements, in the repository's order. **With enforcement:**

| You call it as | Needs | You get |
| --- | --- | --- |
| a student (no `wardId`) | `communication.viewAnnouncements`, an active student of the section | the **students'** channel only |
| staff (no `wardId`) | the same, as admin, instructor or TA | **both** channels |
| a guardian, naming `wardId` | `communication.viewGuardianAnnouncements`: a verified, active link to that ward with the `announcements` scope, and the ward an active student of the section | the **guardians'** channel only |
| staff, naming `wardId` | the same, as staff | the guardians' channel only |

A guardian who does not name a ward is refused (a guardian is not a student), and a student
who names a ward is refused unless they are staff. A record without an `audience` counts as a
students' announcement. The section's announcements are not even read for a refused caller.
**Without enforcement** it returns everything the repository has, both channels.

### `reply(threadId, authorId, body, actor?): Promise<ThreadPost>`

Adds a post to a thread (`postedAt` is now) and returns it. Without enforcement it does **no**
checking: it does not look up the thread, and it trusts `authorId` as given.

**With enforcement** the actor needs `communication.participate` in the **thread's** section
(taken from the stored thread, so a student of section 1 cannot reach a section 2 thread), and
**`authorId` must be the actor's own id**: anyone else's is refused, so nobody can post in
another person's name, a teacher included. An unknown thread is refused exactly like a
forbidden one. Guardians cannot reply.

### `getThread(threadId, actor?): Promise<Thread>`

Reads a thread with its posts. With enforcement it needs `communication.participate` in the
thread's section. Without it, an unknown thread throws `Thread <id> not found`.

`ThreadRepository.create` is not exposed by the service: starting a thread is still your
code's job.

## The event bridge

`bridgeEventBusToNotificationSink` subscribes to the shared [event bus](./EVENTS.md) and
forwards events that have a notification equivalent to your sink. Today there is one:
`grading.gradePosted` becomes `gradePosted`.

```ts
import { bridgeEventBusToNotificationSink } from 'discendo-sdk/communication';

const unsubscribe = bridgeEventBusToNotificationSink(bus, sink, {
  resolveContentId: async (submissionId) => submissions.contentIdOf(submissionId),
  onError: (error) => logger.error(error),
});
// later: unsubscribe();
```

| Option | Why |
| --- | --- |
| `resolveContentId(submissionId)` | `grading.gradePosted` identifies work by `submissionId`, but a `gradePosted` notification needs the `contentId`, and grading cannot know it. You own the submission store, so you supply the lookup (sync or async). **Without it, grade events are not forwarded at all.** Returning `undefined` skips that grade rather than dispatching a made-up id |
| `onError(error)` | Called when the sink fails or `resolveContentId` throws. The bridge never lets these propagate: a broken notification channel must not surface as a failure in whatever emitted the event. Default: discarded |

It returns an **unsubscribe** function, and other bus events (enrollment, scheduling and
so on) are ignored. Adding a notification for one later means adding a `NotificationEvent`
variant and a case in the bridge.

## Writing a sink

```ts
const sink: NotificationSink = {
  async dispatch(event) {
    switch (event.type) {
      case 'gradePosted':
        return push.send(event.userId, `A grade was posted`);
      case 'announcementCreated': {
        // two separate channels: never send one to the other's readers
        const people = event.audience === 'guardians'
          ? await guardians.guardiansOfSection(event.sectionId, 'announcements', poster)
          : await roster.studentsOf(event.sectionId);
        return mailer.sendMany(people, event.title);
      }
      case 'dueDateApproaching':
        return push.send(event.userId, `Due ${event.dueAt.toISOString()}`);
    }
  },
};
```

## Permissions

Turn enforcement on with `enforcement` in the fourth constructor argument:

```ts
const communication = new CommunicationService(announcements, threads, sink, {
  enforcement: { policy, repos },
  onDeliveryError: (error, announcement) => logger.error({ error, id: announcement.id }),
});

await communication.postAnnouncement('sec-1', 'Trip on Friday', '...', 'guardians', { actorId: teacher.id });
await communication.listAnnouncements('sec-1', { actorId: parent.id }, { wardId: child.id });
```

| Method | Action | Who |
| --- | --- | --- |
| `postAnnouncement` (students) | `communication.postAnnouncement` | admins and instructors; a TA only when delegated |
| `postAnnouncement` (guardians) | `communication.postGuardianAnnouncement` | admins and instructors only; **not delegable** |
| `listAnnouncements` (no ward) | `communication.viewAnnouncements` | active members of the section (students: their channel; staff: both) |
| `listAnnouncements` (with ward) | `communication.viewGuardianAnnouncements` | guardians whose link has the `announcements` scope (see [GUARDIANS.md](./GUARDIANS.md)); staff |
| `reply`, `getThread` | `communication.participate` | active members of the thread's section; `reply` only as yourself |

- **The two channels are separate in every direction.** A guardian never reads the students'
  channel, a student never reads the guardians', and holding one posting action does not give
  the other. Staff read both.
- **The section is the thread's, or the one you name**, and a missing section, course or
  thread is refused like a forbidden one, for every actor.
- **Students must be active** in the section; dropped, waitlisted and completed students are
  refused.
- **The permission check comes first**, and nothing is looked up before the actor is known.
- Nothing is stored, sent or notified for a refused call.
- Without `enforcement` the service behaves as it always has, except that a failing sink no
  longer fails the post, `postAnnouncement` stores an `audience`, and there are two more
  methods.

## Known limitations

- **Your repository must store `audience`**, and your sink must act on it. The SDK cannot
  stop a sink that ignores the audience from notifying the wrong people.
- **The sink must still resolve the guardians.** `GuardianService.guardiansOfSection(sectionId,
  'announcements', actor)` lists them (see [GUARDIANS.md](./GUARDIANS.md)), but it needs an
  actor who is an instructor of the section or an admin, so a queued job has to carry the poster
  or an admin.
- **A failing sink is discarded unless you pass `onDeliveryError`.** There is no
  `deliveryFailed` event yet; it is planned for the events round.
- **A thread tied to unpublished content is still readable** by students of the section
  (`Thread.contentId` is not checked against the content's draft state).
- **A completed student cannot read announcements or threads.** Read-only access after
  completion covers grades and content only; the guardian channel is not extended to a
  completed ward either. Widening it would mean adding `afterCompletion` to the view rules
  and having this service opt in.
- **No service method to start a thread.**
- **`dueDateApproaching` is defined but nothing produces it.** The SDK has no scheduler;
  your application would decide when to dispatch it.
- **Only grades are bridged.** The bridge does not forward announcements: the service
  notifies the sink itself.
- **Only the service is guarded.** Your own code can still use the repositories directly.

## Tests

| File | Covers |
| --- | --- |
| `test/communication-event-bridge.test.ts` | the bridge: translating a grade event, an async `resolveContentId`, skipping unresolved submissions, forwarding nothing without a resolver, ignoring other events, a failing sink, a throwing resolver, and unsubscribing |
| `test/communication-permissions.test.ts` | every method with enforcement on (both channels in both directions, delegation, guardian links and scopes, author = actor, thread sections, unknown and orphaned targets, check ordering, no lookups before the actor is known), a failing or throwing sink with and without `onDeliveryError`, and behaviour with enforcement off |
