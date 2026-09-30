# HyperLMS SDK — Documentation

A framework- and database-agnostic TypeScript SDK of LMS (Learning Management
System) logic, built on Bun. The SDK provides typed domain models, pure
calculation functions, and repository-interface-driven services for the
core concerns of a learning platform — from a single-tutor setup to a
multi-department university. It never assumes a specific database, ORM, web
framework, or UI: every module exposes interfaces the host application
implements against whatever stack it already uses.

This documentation reflects the project as it currently stands. It is not
aspirational — every type, method, and behavior described here exists in the
codebase and (where noted) has been behaviorally tested, not just
typechecked.

## How the SDK is organized

Each top-level folder under `src/` is an independent module with its own
`index.ts` barrel export, and is independently importable via a package
subpath (e.g. `hyperlms-sdk/grading`, `hyperlms-sdk/scheduling`). Modules do not import
from each other except where explicitly noted (e.g. several modules import
shared primitives from `core`). This means a host app can adopt one module
(say, just `grading`) without pulling in the rest.

| Module            | Subpath                      | What it covers                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **core**          | `hyperlms-sdk/core`          | Shared primitives: `Id`, `Course`, `CourseSection`, `Enrollment`, `ContentNode`, `AcademicTerm`, and the `RepositoryContext` bundle other modules are built on                                                                                     |
| **enrollment**    | `hyperlms-sdk/enrollment`    | Enrolling/dropping students, waitlisting at capacity, bulk roster import                                                                                                                                                                           |
| **content**       | `hyperlms-sdk/content`       | Content tree management, publishing/versioning, prerequisite gating                                                                                                                                                                                |
| **assessment**    | `hyperlms-sdk/assessment`    | Submissions, attempt limits, quiz attempt generation with randomization, a plagiarism-check seam                                                                                                                                                   |
| **grading**       | `hyperlms-sdk/grading`       | Grade recording with full audit history, weighted final-grade calculation, late penalties, letter grades                                                                                                                                           |
| **communication** | `hyperlms-sdk/communication` | Announcements, discussion threads, a typed notification-event seam                                                                                                                                                                                 |
| **scheduling**    | `hyperlms-sdk/scheduling`    | Class-routine/timetable management: recurring session templates, materialized occurrences, conflict detection, availability rules, room matching, teacher qualifications, an auto-scheduling solver with soft-constraint preferences, and (under `scheduling/calendar`) assignment due-date windows and iCal export. By far the largest module — start with `src/domains/scheduling/README.md` |
| **reporting**     | `hyperlms-sdk/reporting`     | Attendance recording, CSV export for any tabular data, completion-percentage calculation                                                                                                                                                           |
| **admin**         | `hyperlms-sdk/admin`         | Audit logging (`withAudit` wrapper + `AdminService`)                                                                                                                                                                                               |
| **interop**       | `hyperlms-sdk/interop`       | Type-only seams for LTI launch/grade-passback, generic auth token verification, and content package (SCORM/xAPI) import — deliberately does not implement any protocol itself                                                                      |

## Design principles that hold across every module

These aren't aspirations — they're patterns you'll see repeated in every
module's code, and relying on them will make extending the SDK predictable:

- **Repository-interface pattern.** Every module that touches persistence
  defines its own repository interface(s) (e.g. `GradeRepository`,
  `SchedulingRepository`) rather than importing a database client. The host
  app implements these against Prisma, Drizzle, raw SQL, or an in-memory
  store for tests. The SDK's `package.json` declares zero database
  dependencies.
- **Services are constructor-injected.** A module's `*Service` class takes
  its repository (or repositories) as constructor arguments. There is no
  global state, no singleton registry, and no dependency-injection
  framework — plain constructor parameters throughout.
- **Pure functions separated from services.** Calculation logic that doesn't
  need to touch a repository is exported as standalone pure functions (e.g.
  `computeFinalGrade`, `applyLatePolicy`, `checkAvailability`,
  `checkRoomSuitability`, `solveSchedule`). This makes the core logic
  trivially unit-testable and reusable in contexts like previewing a result
  before committing it.
- **Never hard-delete; prefer status transitions and audit trails.** Grades
  are superseded, not overwritten (`GradeEntry.supersededBy`). Enrollments
  are dropped, not deleted (`status: 'dropped'`). Class occurrences are
  cancelled, not deleted (`status: 'cancelled'`). This preserves history for
  reporting and audit without extra ceremony from the caller.
- **UTC timestamps everywhere internally.** Every `Timestamp`/`Date` field
  the SDK produces or consumes is UTC. Local-timezone conversion is
  explicitly a host-app, presentation-layer concern — doing it inside SDK
  logic is called out in comments as a source of off-by-one-timezone bugs.
- **Protocol/vendor integrations are seams, not implementations.** The
  `interop` module and hooks like `PlagiarismCheckHook` and
  `NotificationSink` define _where_ a third-party concern plugs into the
  SDK's flow, without the SDK trying to implement LTI, SAML, OIDC, email
  delivery, or plagiarism detection itself.
- **Zero required runtime dependencies.** `package.json` lists `zod` as a
  `peerDependency`, but as of this snapshot no module actually imports it —
  the SDK has no hard runtime dependencies today. `typescript` and
  `@types/bun` are dev-only.

## Module interdependencies

Most modules depend only on `core` (for shared types like `Id` and
`RepositoryContext`). A few notable exceptions:

- `admin`'s `withAudit` helper is designed to wrap calls into _any_ other
  module's service methods, but doesn't import them directly — it's generic
  over `() => Promise<T>`.
- `scheduling` is fully self-contained aside from importing `Id`/`Timestamp`
  from `core`. It does not depend on `enrollment`, `content`, or any other
  module, and nothing in `scheduling` currently reads from `CourseSection`
  directly — it uses its own `sectionId: Id` fields as a loose reference the
  host app resolves however it needs to.
- `calendar` (assignment due-date windows, iCal export) lives inside
  `scheduling` as `scheduling/calendar/`. It shares no code with the
  class-routine logic — it sits there because both answer "is this thing
  available right now?", one for assignments, one for teachers/rooms/groups.
  It is still importable on its own via `hyperlms-sdk/scheduling/calendar`.

## Project structure on disk

The SDK is organized into layers. Each layer folder has a `README.md`
stating its rule, and `test/architecture.test.ts` enforces those rules in CI.

```
src/
  core/         shared primitives + EventBus. Imports nothing else in the SDK.
  domains/      modules that own a primary entity a host app persists
    enrollment/   content/   assessment/   grading/
    scheduling/   (rules/, solver/, calendar/, testing/ — see its README)
  services/     cross-cutting modules that consume/aggregate what domains produce
    communication/   reporting/   admin/
  interop/      pluggable protocol seams only (LTI, SSO, SCORM/xAPI)
  index.ts      root barrel — re-exports every module
test/
  architecture.test.ts   enforces the layering rules
  *-events.test.ts       EventBus + per-service event emission
  grading.test.ts, scheduling*.test.ts
```

**Where does a new module go?** Does it own an entity with its own
identity and lifecycle that a host app would have a table for? Put it in
`domains/`. Does it mostly react to or summarize what domains already
produced? Put it in `services/`. Is it a protocol seam with no
implementation? `interop/`. A module may import only `core` and its own
files — never another domain or service. Coordinate through the shared
`EventBus` instead.

## Runtime & tooling

- **Runtime:** Bun (uses `bun:test` for the test runner; `bun-types` in
  `tsconfig.json`'s `types` array)
- **Language:** TypeScript, `strict: true`, plus the stricter
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` — both of
  which have caught real bugs during development (see `SCHEDULING.md`'s
  history notes)
- **Module system:** ESM throughout (`"type": "module"`,
  `module`/`moduleResolution: "NodeNext"`), so internal imports use explicit
  `.js` extensions even though the source is `.ts`
- **Build:** `tsc -p tsconfig.json` emits to `dist/`, matching the
  `package.json` `exports` map exactly (one entry per module subpath)
- **Test:** `bun test` (see `SCHEDULING.md` for a note on how this
  documentation's own verification was performed, since the authoring
  environment did not have Bun installed)

## Where to go next

- **`docs/SCHEDULING.md`** — the class-routine/timetable module in full: domain
  model, every service method, the auto-scheduling solver's algorithm and
  known limitations, and the full test inventory.
- **`docs/OTHER_MODULES.md`** — complete reference for the other eight modules
  (core, enrollment, content, assessment, grading, communication, calendar,
  reporting, admin, interop) with every type and method signature.
- **`docs/GETTING_STARTED.md`** — a practical guide to wiring the SDK into a host
  app: implementing repositories, constructing services, and a worked
  example using the scheduling module end to end.
