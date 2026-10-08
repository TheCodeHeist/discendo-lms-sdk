# Events

`src/core/events.ts` — a small, dependency-free, typed publish/subscribe bus
that lets your application react to things happening inside the SDK (a student
enrolled, a grade posted, a class cancelled) without the SDK baking in side
effects, and without the SDK's modules importing each other. Exported from
`discendo-sdk/core`.

Modules never talk to one another directly. When something worth knowing about
happens, a service emits an event; whoever cares subscribes. That is how a
notification, an audit trail or a search index can follow what the SDK does
while the SDK stays ignorant of all three.

## Quick start

```ts
import { EventBus } from 'discendo-sdk/core';
import { EnrollmentService } from 'discendo-sdk/enrollment';
import { GradingService } from 'discendo-sdk/grading';

const bus = new EventBus({
  onHandlerError: (error, event) => logger.error({ error, type: event.type }),
});

// One bus, shared by every service that should emit.
const enrollment = new EnrollmentService(repos, bus);
const grading = new GradingService(gradeRepo, bus);

bus.on('enrollment.enrolled', async (e) => {
  await mailer.sendWelcome(e.userId, e.sectionId); // e is fully typed
});

bus.on('*', (e) => analytics.track(e.type, e)); // every event, whatever the type
```

Events are always optional. Services take the bus as an optional constructor
argument; leave it out and they simply emit nothing.

## The `EventBus` API

```ts
class EventBus {
  constructor(options?: { onHandlerError?: (error: unknown, event: LmsEvent) => void });

  on<T extends LmsEvent['type']>(type: T, handler: (event: LmsEventOfType<T>) => unknown): () => void;
  on(type: '*', handler: (event: LmsEvent) => unknown): () => void;

  once(/* same two forms as on */): () => void;

  emit(event: LmsEvent): Promise<void>;
}
```

- **`on(type, handler)`** registers a handler for one event type. The handler's
  parameter is narrowed to that variant, so `e.status` is available inside an
  `'enrollment.enrolled'` handler and not elsewhere. It returns an *unsubscribe*
  function. Registering the same function twice registers it twice.
- **`on('*', handler)`** receives every event, whatever its type. Use it for logging,
  analytics, audit trails, or to bridge the bus into another system.
- **`once(...)`** is `on` for a single delivery. The handler is removed *before*
  it runs, so it fires for at most one event even if it emits re-entrantly. The
  returned function cancels it if it has not fired yet. It accepts `'*'` too.
- **`emit(event)`** delivers an event and resolves when every handler has finished.
  Services call it for you; you only call it yourself when you add your own events
  (see "Extending").

### Delivery rules

These are guarantees you can rely on. Rules 1 (the ordering of the two groups), 2, 3 and 5 are covered directly by
`test/core-events.test.ts`; rule 4 follows from how `emit` is written and is
exercised only indirectly (by the `once` re-emission test).

1. **Order of starting.** For one `emit`, handlers registered for the event's exact
   type are started first, then wildcard handlers, each group in registration order.
   Handlers are **started** in that order but not **serialized**: an async handler is
   not awaited before the next one starts, so slow handlers run concurrently and
   finish in whatever order they finish. Do not rely on one handler completing before
   another begins.
2. **Failure isolation.** A handler that throws, synchronously or by returning a
   rejected promise, never stops the others and never makes `emit` reject. A
   buggy notification listener cannot break the enrollment that triggered it.
3. **Errors are not silent unless you let them be.** By default a handler's
   failure is discarded, because the SDK has no logger of its own. Pass
   `onHandlerError` to see them; it receives the error and the event.
4. **Snapshot.** Who receives an event is fixed when `emit` starts. A handler
   that subscribes or unsubscribes (as `once` does) cannot change the audience of
   the event currently being delivered.
5. **Handlers may return anything.** Only a returned promise is awaited, so
   one-liners like `(e) => received.push(e)` are fine.
6. **One event object.** Every handler receives the *same* object, not a copy, so
   treat it as read-only: a handler that mutates it changes what the handlers after it
   see.

### Fire and forget

Every service emits with `void this.events?.emit(...)`: it does **not** wait for
handlers. The consequence is deliberate and worth knowing:

- A slow handler never slows down the operation that triggered it.
- By the time `enroll()` resolves, its handlers may not have finished. If a test
  or a workflow needs to wait, `await` your own handler's completion (a promise
  you resolve inside the handler) instead of assuming the event has been handled.
- Events are **at-most-once and in-memory**. If the process dies between the
  database write and the handlers running, the event is gone. Do not treat the bus
  as a durable queue; if you need guaranteed delivery, write to your own outbox
  inside the same transaction as your repository call.

## Event catalog

Every event is a variant of the `LmsEvent` union, discriminated by `type`.

| `type` | Emitted by | When | Payload |
| --- | --- | --- | --- |
| `enrollment.enrolled` | `EnrollmentService` | a **new** enrollment record is created (single `enroll` and each successful row of `bulkEnroll`) | `enrollmentId`, `userId`, `sectionId`, `status` (`'active'` or `'waitlisted'`) |
| `enrollment.dropped` | `EnrollmentService.drop` | an enrollment is dropped | `enrollmentId`, `userId`, `sectionId` |
| `enrollment.requested` | `EnrollmentRequestService.request` | a student asks for a seat (not for a repeat of a pending request) | `requestId`, `userId`, `sectionId` |
| `enrollment.requestDecided` | `EnrollmentRequestService.withdraw`, `accept`, `modify`, `reject` | a request is settled | `requestId`, `userId`, `sectionId`, `decision` (`'accepted'`, `'rejected'` or `'withdrawn'`), `reviewerId?` (accepted and rejected), `enrollmentId?`, `enrollmentStatus?`, `grantedSectionId?` (accepted) |
| `enrollment.promoted` | `EnrollmentService.promoteFromWaitlist`, and `drop` with `promoteOnDrop` | a waitlisted person is made active | `enrollmentId`, `userId`, `sectionId`, `previousStatus` (`'waitlisted'`), `trigger` (`'manual'` or `'auto'`), `actorId?` (only a manual promotion with permissions enforced) |
| `grading.gradePosted` | `GradingService.recordGrade` | a grade is recorded, including a regrade that supersedes an earlier one | `gradeEntryId`, `submissionId`, `userId`, `score`, `maxScore`, `graderId` |
| `content.published` | `ContentService.publish` | content is published (each call bumps `version`) | `contentId`, `sectionId`, `version` |
| `assessment.submissionReceived` | `AssessmentService.submit` | a submission is stored | `submissionId`, `contentId`, `userId`, `attemptNumber` |
| `scheduling.occurrenceCancelled` | `SchedulingService.cancelOccurrence` | one occurrence is cancelled | `occurrenceId`, `templateId`, `note?`, and with enforcement on: `sectionId`, `actorId`, `actorRole?`, `previousStatus` |
| `scheduling.occurrenceRescheduled` | `SchedulingService.rescheduleOccurrence` | one occurrence is moved | `occurrenceId`, `templateId`, `date`, `roomId?`, `startTime?`, `endTime?`, and with enforcement on: `sectionId`, `actorId`, `actorRole?`, `from` |

Details that are easy to get wrong:

- **`enrollment.enrolled` is not emitted for a repeat call.** `enroll` is
  idempotent: if the person already has a non-dropped enrollment, that record is
  returned and nothing is emitted. A person who is re-enrolled after dropping gets
  a *new* record and a new event.
- **`occurrenceRescheduled` carries the occurrence's values after the move**, not
  the patch that was applied.
- **With scheduling enforcement on, both occurrence events say who did it**, for oversight.
  An instructor can cancel or move their own class without an admin, so an admin who wants to
  know listens for these: `actorId`, `actorRole` (`'admin'`, `'instructor'`, or `'ta'` when
  delegated) and `sectionId`. `occurrenceCancelled` also carries `previousStatus`, and
  `occurrenceRescheduled` carries `from`, where the occurrence was (`date`, `status`, and
  `roomId`, `startTime`, `endTime` with the template's values where the occurrence has none of
  its own). Without enforcement these fields are absent, because the service does not know the
  actor. The SDK sends nothing to admins itself: forward them to your audit log or
  notification channel, for instance `bus.on('scheduling.*', ...)` and filter on
  `actorRole !== 'admin'`.
- **`grading.gradePosted` identifies the work by `submissionId`, not `contentId`.**
  Grading does not know which content a submission belongs to, so a consumer that
  needs it must look it up (this is why the notification bridge takes a
  `resolveContentId` function).
- **A refused call emits nothing.** When enforcement is on and the permission
  check fails, the operation never starts, so no event is emitted.

### Not emitted yet

These are known gaps, planned as one round after the features land, so that the
event shapes are designed together:

- attendance recorded
- enrollment status changes other than enroll, drop and promotion (the first of the
  planned status-change events, `enrollment.promoted`, was added early because automatic
  promotion would otherwise be invisible to a host; `enrollment.requested` and
  `enrollment.requestDecided` were added with the request flow for the same reason: a host
  has to tell reviewers and students)
- content unpublished
- an `orgId` on events, so a listener can filter by tenant
- a `contentId` on `grading.gradePosted`
- anything about delegation or guardian links (a grant given or revoked, a link
  created)

Until then, a host that needs one of these can wrap the call (see
[ADMIN.md](./ADMIN.md)'s `withAudit`) or emit its own event.

## Bridging the bus to other systems

The bus is the single place to hook everything that happens, and
`on('*', ...)` makes bridging a few lines:

```ts
// Forward every event to an outbox, a queue or a log.
bus.on('*', (event) => queue.publish(event.type, event));
```

The SDK ships one ready-made bridge: `bridgeEventBusToNotificationSink` in
`discendo-sdk/communication`, which turns `grading.gradePosted` into a
`NotificationEvent` for a `NotificationSink`. See [COMMUNICATION.md](./COMMUNICATION.md).

## Extending the event set

Adding an event is additive and cannot disturb existing handlers:

1. Define an interface with a unique `type` literal in `events.ts`, named after
   its module (`'billing.invoicePaid'`).
2. Add it to the `LmsEvent` union.
3. Emit it from the service with `void this.events?.emit({ ... })`.
4. Add a test next to the existing `*-events.test.ts` files.

Keep payloads to ids and plain values, never whole entities. A listener should
look up what it needs, and ids stay stable when entity shapes change.

## Known limitations

- **At-most-once and in-memory.** No persistence, retry or replay (see "Fire and forget").
- **Ten event types.** The gaps listed under "Not emitted yet" are real: attendance,
  other enrollment status changes (completion, say), unpublishing, delegation and guardian changes.
- **No tenant on events.** An event carries no `orgId`, so a listener serving several
  organizations has to look it up.
- **No ordering between handlers and no priorities.** Handlers are started in
  registration order and run concurrently.
- **No filtering beyond type.** `on(type)` or `on('*')` only; filtering by section,
  user or anything else is up to the handler.
- **Handler failures are invisible by default.** Without `onHandlerError` they are dropped.
- **No typed way to add your own events** from outside the SDK without changing the
  `LmsEvent` union in `events.ts`.

## Tests

| File | Covers |
| --- | --- |
| `test/core-events.test.ts` | the bus: delivery, ordering (specific before wildcard), failure isolation, `onHandlerError`, unsubscribe, wildcard, `once` |
| `test/enrollment-events.test.ts` | `enrollment.enrolled` (active and waitlisted), `enrollment.dropped`, working with no bus |
| `test/enrollment-waitlist.test.ts` | `enrollment.promoted`: manual and automatic, its payload and actor |
| `test/enrollment-requests.test.ts` | `enrollment.requested`, `enrollment.requestDecided`: each decision's payload, and no event for an idempotent repeat |
| `test/grading-events.test.ts` | `grading.gradePosted` |
| `test/content-events.test.ts` | `content.published` |
| `test/assessment-events.test.ts` | `assessment.submissionReceived`, attempt numbers, no event when `maxAttempts` rejects, a throwing listener, working with no bus |
| `test/scheduling-service-events.test.ts` | the two scheduling events |
| `test/communication-event-bridge.test.ts` | the notification bridge |
