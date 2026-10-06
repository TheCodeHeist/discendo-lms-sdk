# `services/`

Modules here are **cross-cutting** — they consume or aggregate what
`../domains/` modules produce, rather than owning a primary entity with
its own independent lifecycle. The test: if you deleted every domain
module, would this module have anything meaningful left to do on its own?
For everything in this folder, the honest answer is no — `reporting` has
nothing to summarize without enrollments/occurrences to summarize,
`communication` has no announcements-about-nothing, `admin`'s audit log
has no calls worth auditing. That's precisely why these live in their own
layer instead of sitting flat alongside `enrollment` or `grading` — they
read as a different *kind* of module once you know to look for this, even
though the file shapes (`types.ts`/`service.ts`/`index.ts`) look identical
to a domain module's.

## What's here

- **`communication/`** ([docs](../../docs/COMMUNICATION.md)) — announcements, discussion threads, and a
  `NotificationSink` seam other modules' events can be routed through (the
  SDK never sends actual email/push/SMS itself).
- **`reporting/`** ([docs](../../docs/REPORTING.md)) — attendance recording and reading, now enforced (`AttendanceRecord.sessionId`
  is meant to reference a `scheduling.ClassOccurrence.id`, though nothing
  enforces that link at the type level — see `scheduling`'s
  `attendance.ts` for the validated integration point) and a generic
  `toCsv` export usable by anything implementing `Exportable`.
- **`admin/`** ([docs](../../docs/ADMIN.md)) — audit logging. `withAudit(...)` is a free function that
  wraps any other service's mutation to append an audit entry, rather than
  every domain service having to know how to log itself.

## How a `services/` module relates to `domains/`

Nothing in `services/` imports a `domains/` module directly, and nothing
in `domains/` imports a `services/` module directly either — the only
sanctioned connection between the two layers is:

1. **The shared `EventBus`** (`../core/events.js`) — a domain service emits
   an event; a host app wires a `services/` module (or its own code) to
   listen for it. `communication.CommunicationService` doesn't subscribe to the bus
   itself, but `communication` ships `bridgeEventBusToNotificationSink(bus,
   sink, { resolveContentId })` (`communication/event-bridge.ts`), which
   forwards `grading.gradePosted` to a `NotificationSink` as a `gradePosted`
   notification. The bus event carries a `submissionId` while the
   notification needs a `contentId`, so the host supplies `resolveContentId`
   to look it up; without it, grade events are not forwarded. Other bus
   events have no `NotificationEvent` equivalent yet and are ignored.
2. **Loose ID references** — `reporting.AttendanceRecord.sessionId` is
   typed as a plain `Id`, not a hard reference to
   `scheduling.ClassOccurrence`. The host app (or, for the validated path,
   `scheduling.SchedulingService.recordAttendanceForOccurrence`, which
   accepts anything shaped like `reporting.AttendanceRepository`) is what
   actually connects them.

This keeps every module in both layers independently adoptable — a host
app using only `grading` and `enrollment` never has to pull in `admin` or
`reporting` just because they happen to exist in the same package.

## Conventions

Same as `domains/` — repository-interface pattern, constructor injection,
no hard-delete where history matters. The one difference: a `services/`
module's repository interfaces tend to be narrower and more generic
(`AttendanceRepository`, `AuditRepository`) since they're built to
summarize *anything* shaped a certain way, not to own one specific kind of
record the way a domain's repository does.
