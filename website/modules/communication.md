---
description: Learn how discendo-sdk/communication handles section announcements, discussion threads, and bridges SDK events to push/email notification sinks.
---

# Communication

`discendo-sdk/communication` handles section-wide announcements, threaded discussions, and routes SDK domain events to external notification dispatchers.

::: important The First Rule of Communication
**The SDK never sends emails, push notifications, or SMS.** That is your application's job. The SDK structures the data, enforces audience segregation, and emits typed events for your notification dispatchers to handle.
:::

---

## At a Glance

|                  |                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import**       | `import { CommunicationService, bridgeEventBusToNotificationSink } from 'discendo-sdk/communication'`                                                                                 |
| **Repositories** | `AnnouncementRepository`, `ThreadRepository`                                                                                                                                          |
| **Seams**        | `NotificationSink`                                                                                                                                                                    |
| **Events**       | `communication.deliveryFailed`                                                                                                                                                        |
| **Permissions**  | `communication.postAnnouncement`, `communication.postGuardianAnnouncement`, `communication.viewAnnouncements`, `communication.viewGuardianAnnouncements`, `communication.participate` |
| **Enforcement**  | Opt-in via constructor options `{ enforcement: { policy, repos } }`                                                                                                                   |

---

## Data Models

```ts
type AnnouncementAudience = "students" | "guardians";

interface Announcement {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  postedAt: Date;
  audience?: AnnouncementAudience; // Default: 'students'
}

interface ThreadPost {
  id: string;
  authorId: string;
  body: string;
  postedAt: Date;
}

interface Thread {
  id: string;
  contentId?: string; // Optionally tied to a specific assignment/lesson
  sectionId: string;
  title: string;
  posts: ThreadPost[];
}
```

---

## `CommunicationService`

```ts
new CommunicationService(
  announcements: AnnouncementRepository,
  threads: ThreadRepository,
  sink?: NotificationSink,
  options?: {
    enforcement?: { policy: PermissionPolicy; repos: RepositoryContext }
    onDeliveryError?: (err: unknown, announcement: Announcement) => void
  }
)
```

### Announcements

```ts
// 1. Post student announcement
await commsService.postAnnouncement(
  {
    sectionId: "sec-101",
    title: "Midterm Room Assigned",
    body: "The exam will take place in Auditorium B.",
    audience: "students",
  },
  { actorId: "u-instructor" },
);

// 2. Post guardian-only announcement (e.g. for parents)
await commsService.postAnnouncement(
  {
    sectionId: "sec-101",
    title: "Field Trip Permission Forms",
    body: "Please sign and return the forms by Friday.",
    audience: "guardians",
  },
  { actorId: "u-instructor" },
);
```

- **Audience Segregation:** Students cannot read guardian announcements; guardians cannot read student announcements.
- **Permissions:** Posting student announcements requires `communication.postAnnouncement` (instructors, delegable to TAs). Posting guardian announcements requires `communication.postGuardianAnnouncement` (instructors only).

### Discussion Threads

```ts
// Create discussion thread on an assignment
const thread = await commsService.createThread(
  {
    sectionId: "sec-101",
    contentId: "assign-lab1",
    title: "Question regarding Question 3",
  },
  { actorId: "u-student" },
);

// Post a reply
await commsService.reply(
  thread.id,
  "Remember to normalize your units before calculating velocity.",
  { actorId: "u-ta" },
);
```

Requires `communication.participate` (students, TAs, instructors).

---

## Bridging Events to Notifications

`discendo-sdk/communication` includes a built-in bridge that maps domain events from the `EventBus` into notification payloads:

```ts
import { bridgeEventBusToNotificationSink } from "discendo-sdk/communication";

// Define your delivery sink (e.g. SendGrid, Firebase, Novu)
const myNotificationSink: NotificationSink = {
  dispatch: async (event) => {
    switch (event.type) {
      case "gradePosted":
        await emailClient.sendGradeAlert(event.userId, event.score);
        break;
      case "announcementCreated":
        await pushClient.broadcastToSection(event.sectionId, event.title);
        break;
    }
  },
};

// Connect the bridge to your EventBus
bridgeEventBusToNotificationSink(bus, myNotificationSink, {
  resolveContentId: async (submissionId) => {
    const sub = await db.submissions.findById(submissionId);
    return sub?.contentId ?? null;
  },
});
```

---

## Known Limitations

- **No rich-text sanitize engine:** Markdown/HTML sanitization of announcement bodies must be performed by your application API before passing strings to the SDK.
- **No thread nesting:** Discussion threads support flat reply lists under a thread root; multi-level nested commentary trees are not natively modeled.
