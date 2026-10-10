# `domains/`

Modules here each own a **primary entity** a host application persists as
its own record — an enrollment, a piece of content, a grade, a class
routine. If you're building a plugin or a new module and asking "does this
belong in `domains/`?", ask: *does the thing I'm modeling have its own
identity and lifecycle that a host app's database would have a table for?*
If yes, it's a domain module. If your module mostly reacts to or
summarizes what domain modules already produced, it belongs in
`../services/` instead — see that folder's README for the contrast.

## What's here

- **`enrollment/`** ([docs](../../docs/ENROLLMENT.md)) — the join entity between a user and a course section:
  enrolling, dropping, waitlisting and promotion, student enrollment requests, bulk roster import.
- **`content/`** ([docs](../../docs/CONTENT.md)) — the content tree (pages, assignments, quizzes, files)
  a course section is built from: publishing, versioning, prerequisite
  gating.
- **`assessment/`** ([docs](../../docs/ASSESSMENT.md)) — submissions and quiz attempts: attempt limits,
  question randomization, a plagiarism-check seam.
- **`grading/`** ([docs](../../docs/GRADING.md)) — grade entries and the calculations built on them:
  weighted categories, late penalties, letter grades, a full audit trail
  via `supersededBy` (grades are never overwritten, only superseded).
- **`delegation/`** ([docs](../../docs/DELEGATION.md)) — grants an instructor hands to a teaching assistant in
  one section (`TaGrant`): the TA may then do specific delegable actions,
  until the instructor revokes them or the TA's enrollment ends.
- **`guardians/`** ([docs](../../docs/GUARDIANS.md)) — admins creating, changing and revoking the links that give a
  parent or guardian read-only access to a ward, and listing a section's guardians to notify.
- **`scheduling/`** ([docs](../../docs/SCHEDULING.md), calendar: [docs](../../docs/CALENDAR.md)) — by far the largest domain module: recurring class
  routines (`ClassSessionTemplate`), materialized calendar occurrences,
  conflict detection, resource availability, room matching, teacher
  qualifications, an auto-scheduling solver, and (nested under
  `scheduling/calendar/`) assignment due-date windows and iCal export.
  See `scheduling/README.md` for why due-date calendars live inside the
  scheduling domain rather than as their own top-level module.

## Conventions every domain module follows

- **Repository-interface pattern.** A domain module defines the
  repository interface(s) its persistence needs (e.g. `GradeRepository`,
  `SchedulingRepository`) rather than importing a database client
  directly. The host app implements these against whatever it already
  uses — Prisma, Drizzle, raw SQL, an in-memory store for tests.
- **Services are constructor-injected**, no globals, no service locator.
  A module's `*Service` class takes its repository (or repositories) —
  and, where relevant, an optional `EventBus` from `../../core/events.js`
  — as constructor parameters.
- **Depend only on `core`.** A domain module never imports another domain
  or service module directly. If two domains need to coordinate (e.g.
  scheduling wanting to know about enrollment), that coordination happens
  through the shared `EventBus` in `core`, or through the host app calling
  both services — never through one domain reaching into another's
  internals. This is what keeps a domain module adoptable on its own: a
  host app using only `grading` should never be forced to pull in
  `scheduling`.
- **Never hard-delete; prefer status transitions.** Grades are superseded,
  enrollments are dropped (not removed), occurrences are cancelled (not
  removed). This preserves history for reporting/audit without extra
  ceremony from callers.
- **Emit events for things other modules might want to react to.**
  Anything a host app plausibly wants to hook into — an enrollment, a
  grade posting, content publishing — goes through `EventBus.emit(...)`,
  fire-and-forget, rather than as a direct side effect baked into the
  service. See `../../core/README.md` for the full rationale and the
  event catalog.
