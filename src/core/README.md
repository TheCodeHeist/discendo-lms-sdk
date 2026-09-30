# `core/`

Shared primitives every other module is built on. Nothing in `core`
imports anything else in the SDK — everything else can safely import from
`core`. This is the one folder every module, in every layer, is allowed to
depend on directly.

## What's here

- **`types.ts`** — `Id`, `Timestamp`, `Role`, `Organization`,
  `Course`/`CourseSection` (the template-vs-running-instance split),
  `Enrollment`, `ContentNode`, `AcademicTerm`.
- **`repositories.ts`** — the repository interfaces `enrollment` and
  `content` are built against, bundled as `RepositoryContext`.
- **`tenancy.ts`** — `sameOrg`, `assertSameOrg` and `TenantMismatchError`,
  the shared vocabulary for multi-tenant checks. A course's `orgId` is the
  source of truth; sections, enrollments and content inherit it. Unset
  everywhere means no checks run. Details: `docs/OTHER_MODULES.md`.
- **`events.ts`** — `EventBus`, the SDK's cross-cutting event/hook system.
  Read on if you're wondering "where do event handlers live" — that's
  answered below.

## The `EventBus`: one bus, not one service

If you're looking for a single "events service" that receives and
*handles* everything centrally: that's deliberately not how this works,
and the distinction matters. `EventBus` is a **dispatch mechanism only** —
it has no knowledge of what enrollment, grading, or scheduling actually
mean. The *logic* that reacts to an event (recomputing a final grade,
sending a notification, writing a report row) stays inside whichever
module owns that concern. Centralizing the dispatch *mechanism* while
keeping reaction *logic* distributed is what stops the SDK from becoming
one giant tangled module where every domain secretly knows about every
other domain.

What's genuinely centralized:

- **One `EventBus` instance**, constructed once by the host app and passed
  into every service that should be able to emit or listen.
- **One typed event catalog** — the `LmsEvent` union in `events.ts` — so
  every module's events are dispatched through the same `on`/`emit`
  surface instead of each module inventing its own pub/sub.

What's intentionally *not* centralized: the handlers themselves. A handler
that reacts to `grading.gradePosted` by sending an email belongs wherever
your host app's email logic lives (or in a `services/communication`
`NotificationSink` implementation) — not bolted onto `core`.

### Wiring it in a host app

```ts
import { EventBus } from "discendo-sdk/core";
import { EnrollmentService } from "discendo-sdk/enrollment";
import { GradingService } from "discendo-sdk/grading";

const bus = new EventBus({
  onHandlerError: (err, event) => logger.error("event handler failed", { err, event }),
});

// Register reactions wherever they conceptually belong in YOUR app —
// this is the "unified" part: one place to look for what listens to what.
bus.on("grading.gradePosted", async (e) => {
  await notifyStudent(e.userId, e.score);
});
bus.on("enrollment.enrolled", async (e) => {
  await syncToRegistrar(e.enrollmentId);
});

// '*' receives every event: handy for audit logs or forwarding to another system.
bus.on("*", (e) => auditLog.append(e.type, e));

// once() fires a single time, then removes itself.
bus.once("content.published", (e) => warmCache(e.contentId));

// Every service that takes an EventBus gets the SAME instance.
const enrollmentService = new EnrollmentService(repos, bus);
const gradingService = new GradingService(gradeRepo, bus);
```

### Listening rules

- `on(type, handler)` / `once(type, handler)` listen for one event type;
  passing `"*"` instead listens for all of them. Both return an unsubscribe
  function.
- For a single event, handlers registered for its exact type run before
  `"*"` handlers. A handler is never called twice for one event.
- A handler may return anything. Only a returned promise is awaited, so
  `(e) => received.push(e)` is a valid handler.
- Events emitted today: `enrollment.enrolled`, `enrollment.dropped`,
  `grading.gradePosted`, `content.published`,
  `assessment.submissionReceived`, `scheduling.occurrenceCancelled` and
  `scheduling.occurrenceRescheduled`. Services that emit take the bus as an
  optional trailing constructor argument (`AssessmentService` as its 4th,
  `SchedulingService` as its 3rd).

Passing an `EventBus` to a service is always optional — omit it and the
service behaves exactly as if events didn't exist, with zero overhead.
See `events.ts`'s module doc for the full event catalog and the
failure-isolation guarantees (a throwing handler never breaks another
handler, and never breaks the operation that triggered the event).
