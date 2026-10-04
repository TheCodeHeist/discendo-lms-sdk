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
| **You import** | `CommunicationService`, `bridgeEventBusToNotificationSink`, and the types in `types.ts` |
| **You implement** | `AnnouncementRepository`, `ThreadRepository`, and a `NotificationSink` |
| **Emits events** | none itself; it *consumes* `grading.gradePosted` through the bridge |
| **Permission actions** | `communication.postAnnouncement` (delegable), `communication.participate` |
| **Enforcement** | **not yet.** The actions exist; the service does not check them |

## Types (`types.ts`)

```ts
type NotificationEvent =
  | { type: 'gradePosted'; userId: string; contentId: string; score: number }
  | { type: 'announcementCreated'; sectionId: string; title: string }
  | { type: 'dueDateApproaching'; userId: string; contentId: string; dueAt: Date };

interface NotificationSink {
  dispatch(event: NotificationEvent): Promise<void>;
}

interface Announcement { id: string; sectionId: string; title: string; body: string; postedAt: Date }
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
recipients (a section's students, a single user) and the channel is the sink's job.

## `CommunicationService`

```ts
new CommunicationService(
  announcements: AnnouncementRepository,
  threads: ThreadRepository,
  sink?: NotificationSink,
)
```

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

### `postAnnouncement(sectionId, title, body): Promise<Announcement>`

Stores the announcement (`postedAt` is now) and then sends
`{ type: 'announcementCreated', sectionId, title }` to the sink, if there is one.

**The sink is awaited, and its failure is not swallowed.** If `dispatch` throws, the
announcement has already been stored, but `postAnnouncement` rejects. The caller sees an
error for a post that exists. Wrap your sink so it never throws (catch and log inside
`dispatch`), or handle that case in the caller, or route notifications through the event
bridge below, which isolates failures.

### `reply(threadId, authorId, body): Promise<ThreadPost>`

Adds a post to a thread (`postedAt` is now) and returns it. The service does **no**
checking: it does not look up the thread, and it trusts `authorId` as given.

The service exposes only these two methods. `AnnouncementRepository.listBySection` and
`ThreadRepository.create` and `findById` are there for your own code (listing
announcements, starting a thread, reading one); there is no service method for them.

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
        const students = await roster.studentsOf(event.sectionId);
        return mailer.sendMany(students, event.title);
      }
      case 'dueDateApproaching':
        return push.send(event.userId, `Due ${event.dueAt.toISOString()}`);
    }
  },
};
```

## Permissions

| Action | Default |
| --- | --- |
| `communication.postAnnouncement` | admin, instructor; **delegable** to a TA |
| `communication.participate` | admin, instructor, ta, student |

`CommunicationService` does not enforce them yet, so check them with the policy at your own
API boundary ([PERMISSIONS.md](./PERMISSIONS.md)). Because `reply` trusts `authorId`, your
route must set it from the authenticated user, never from the request.

### Planned: a separate channel for guardians

Announcements to students and announcements to guardians are **two separate channels**.
An institution that wants the same message in both sends it twice, and a guardian sees only
what was addressed to guardians, for the sections their ward is in. This is not built
yet; see [GUARDIANS.md](./GUARDIANS.md).

## Known limitations

- **No permission enforcement yet.**
- **`dueDateApproaching` is defined but nothing produces it.** The SDK has no scheduler;
  your application would decide when to dispatch it.
- **A failing sink rejects `postAnnouncement` after the announcement is stored** (see above).
- **`reply` checks nothing** (thread existence, membership, the author).
- **No service methods to list announcements or to create and read threads.**
- **Only grades are bridged.**
- **No tests for `CommunicationService` itself.** Its behaviour was checked by running it;
  only the event bridge has tests.

## Tests

`test/communication-event-bridge.test.ts` — the bridge: translating a grade event, an async
`resolveContentId`, skipping unresolved submissions, forwarding nothing without a resolver,
ignoring other events, a failing sink, a throwing resolver, and unsubscribing.
