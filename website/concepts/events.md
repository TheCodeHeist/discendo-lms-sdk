---
description: How Discendo SDK uses a dependency-free, typed EventBus for cross-module coordination and host notification delivery.
---

# Events

`discendo-sdk/core` exports `EventBus`, a typed publish/subscribe bus that allows your application to react to domain events—such as student enrollments, grade postings, or schedule cancellations—without tying the SDK to specific background workers, message queues, or notification providers.

---

## Quick Start

```ts
import { EventBus } from "discendo-sdk/core";
import { EnrollmentService } from "discendo-sdk/enrollment";
import { GradingService } from "discendo-sdk/grading";

const bus = new EventBus({
  onHandlerError: (err, event) => {
    logger.error({ err, eventType: event.type });
  },
});

// Pass the same bus to all services that emit events
const enrollment = new EnrollmentService(repos, bus);
const grading = new GradingService(gradeRepo, bus);

// Subscribe to a specific event (type-safe payload)
bus.on("enrollment.enrolled", async (event) => {
  // event is narrowed to EnrolledEvent
  console.log(
    `User ${event.userId} enrolled in ${event.sectionId} (status: ${event.status})`,
  );
  await sendWelcomeEmail(event.userId, event.sectionId);
});

// Subscribe to all events using wildcard '*'
bus.on("*", (event) => {
  auditLogger.log(event.type, event);
});
```

---

## The `EventBus` API

```ts
export class EventBus {
  constructor(options?: {
    onHandlerError?: (error: unknown, event: LmsEvent) => void;
  });

  // Specific event listener: returns an unsubscribe function
  on<T extends LmsEvent["type"]>(
    type: T,
    handler: (event: LmsEventOfType<T>) => unknown,
  ): () => void;

  // Wildcard listener for all events
  on(type: "*", handler: (event: LmsEvent) => unknown): () => void;

  // Runs once and auto-unsubscribes
  once<T extends LmsEvent["type"]>(
    type: T,
    handler: (event: LmsEventOfType<T>) => unknown,
  ): () => void;
  once(type: "*", handler: (event: LmsEvent) => unknown): () => void;

  // Emit an event (invoked by services)
  emit(event: LmsEvent): Promise<void>;
}
```

---

## Delivery Guarantees

The `EventBus` provides six specific operational guarantees:

### 1. Execution Order

When `emit(event)` runs, handlers registered for that exact event type are started first, followed by wildcard `*` handlers, in order of registration. Async handlers run concurrently via `Promise.allSettled`.

### 2. Failure Isolation

A handler that throws an error (or returns a rejected Promise) **never cancels other handlers** and **never causes `emit()` to reject**. A buggy email notification hook cannot abort an enrollment transaction.

### 3. Error Logging

Because the SDK does not bundle a logger, unhandled exceptions in listeners are captured and passed to the `onHandlerError` callback provided in the constructor.

### 4. Audience Snapshot

The list of listeners for an event is snapshotted when `emit()` begins. A listener that subscribes or unsubscribes during execution cannot alter the recipients of the event currently being delivered.

### 5. Return Values

Handlers may return any value or Promise. Only Promises are awaited.

### 6. Single Event Reference

All handlers receive the identical event object reference. Treat event payloads as strictly read-only.

---

## Fire-and-Forget Architecture

Inside SDK services, events are dispatched asynchronously:

```ts
void this.events?.emit({
  type: "enrollment.enrolled",
  enrollmentId: enrollment.id,
  userId: enrollment.userId,
  sectionId: enrollment.sectionId,
  status,
});
```

### Implications for Host Applications:

- **Zero Latency Overhead:** Slow email delivery or webhook calls in handlers will never delay the HTTP response returned by the service method.
- **At-Most-Once Delivery:** Events are held in-memory. If the server process crashes immediately after a database write, pending event handlers will not run. If guaranteed delivery is mandatory for your compliance needs, use a transactional outbox pattern in your repository.
- **Testing:** In automated tests, `await service.enroll(...)` resolves before event handlers finish. If your test asserts on event outcomes, await a Promise resolved inside your listener.

---

## Event Catalog

All events belong to the `LmsEvent` discriminated union, keyed on `type`:

| Category       | Event Type                         | Trigger                                       | Payload Summary                                                                     |
| -------------- | ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Enrollment** | `enrollment.enrolled`              | New enrollment created                        | `enrollmentId`, `userId`, `sectionId`, `status`, `orgId?`                           |
|                | `enrollment.dropped`               | Student dropped from section                  | `enrollmentId`, `userId`, `sectionId`, `orgId?`                                     |
|                | `enrollment.promoted`              | Waitlisted student promoted to active         | `enrollmentId`, `userId`, `sectionId`, `trigger` (`'manual'` \| `'auto'`), `orgId?` |
|                | `enrollment.promotionFailed`       | Background auto-promotion encountered error   | `sectionId`, `droppedEnrollmentId`, `error`, `orgId?`                               |
|                | `enrollment.requested`             | Student submitted seat request                | `requestId`, `userId`, `sectionId`, `orgId?`                                        |
|                | `enrollment.requestDecided`        | Seat request accepted, rejected, or withdrawn | `requestId`, `decision`, `reviewerId?`, `enrollmentId?`                             |
| **Grading**    | `grading.gradePosted`              | Score recorded or superseded                  | `gradeEntryId`, `submissionId`, `userId`, `score`, `maxScore`, `graderId`, `orgId?` |
| **Content**    | `content.nodeCreated`              | Page, assignment, or quiz added               | `nodeId`, `sectionId`, `kind`, `title`, `orgId?`                                    |
|                | `content.nodePublished`            | Node visibility toggled to published          | `nodeId`, `sectionId`, `version`, `orgId?`                                          |
|                | `content.nodesReordered`           | Structural sequence modified                  | `sectionId`, `orderedIds`, `orgId?`                                                 |
| **Assessment** | `assessment.submitted`             | Assignment submission uploaded                | `submissionId`, `contentId`, `userId`, `attemptNumber`, `orgId?`                    |
|                | `assessment.quizAttemptStarted`    | Quiz attempt started with generated questions | `attemptId`, `quizId`, `userId`, `attemptNumber`, `orgId?`                          |
|                | `assessment.quizAttemptSubmitted`  | Quiz attempt finished and scored              | `attemptId`, `score`, `autoScore`, `needsGrading`, `orgId?`                         |
| **Scheduling** | `scheduling.occurrenceCancelled`   | Specific date session cancelled               | `occurrenceId`, `reason`, `cancelledBy?`, `orgId?`                                  |
|                | `scheduling.occurrenceRescheduled` | Session moved to new time/room                | `occurrenceId`, `oldDate`, `newDate`, `roomId?`, `orgId?`                           |
| **Delegation** | `delegation.granted`               | Instructor delegated role to TA               | `grantId`, `instructorId`, `taId`, `actions`, `sectionId`, `orgId?`                 |
|                | `delegation.revoked`               | TA grant revoked                              | `grantId`, `revokedBy`, `orgId?`                                                    |
| **Guardians**  | `guardians.linkCreated`            | Parent-ward link created                      | `linkId`, `guardianId`, `wardId`, `scopes`, `orgId?`                                |
|                | `guardians.linkRevoked`            | Parent access revoked                         | `linkId`, `revokedBy`, `orgId?`                                                     |

---

## Bridging to Notifications

The `discendo-sdk/communication` package includes a built-in adapter to route domain events into a notification channel (email, SMS, push):

```ts
import { bridgeEventBusToNotificationSink } from "discendo-sdk/communication";

bridgeEventBusToNotificationSink(bus, myNotificationSink, {
  resolveContentId: async (submissionId) => {
    const sub = await db.submissions.findById(submissionId);
    return sub?.contentId ?? null;
  },
});
```

---

## Next Steps

- Learn how permissions gate actions in [Permissions](/concepts/permissions).
- Understand multi-tenant event filtering in [Tenancy](/concepts/tenancy).
