# DiscendoLMS SDK — Documentation

A framework- and database-agnostic TypeScript SDK of LMS (Learning Management
System) logic, built on Bun. The SDK provides typed domain models, pure
calculation functions, and repository-interface-driven services for the
core concerns of a learning platform — from a single-tutor setup to a
multi-department university. It never assumes a specific database, ORM, web
framework, or UI: every module exposes interfaces the host application
implements against whatever stack it already uses.

This documentation describes the project as it currently stands. It is not
aspirational: every type, method and behaviour described here exists in the
codebase, and each page says plainly what is **not** built or not tested yet
under "Known limitations".

## Start here

| If you want to… | Read |
| --- | --- |
| wire the SDK into an application | [GETTING_STARTED.md](./GETTING_STARTED.md) |
| understand the shared types and the repositories you implement | [CORE.md](./CORE.md) |
| decide who may do what, and turn enforcement on | [PERMISSIONS.md](./PERMISSIONS.md) |
| host several institutions in one deployment | [TENANCY.md](./TENANCY.md) |
| react to things the SDK does | [EVENTS.md](./EVENTS.md) |

## The modules

Each module has its own page. Every page follows the same shape: an at-a-glance
table (what you import, what you implement, events, permission actions), the
types, the service methods, permissions, events, known limitations, and the
tests that cover it.

| Module | Subpath | Page | What it covers |
| --- | --- | --- | --- |
| **core** | `discendo-sdk/core` | [CORE.md](./CORE.md) | Shared types (`Course`, `Enrollment`, `ContentNode`, ...), the repository interfaces and `RepositoryContext` |
| core: events | `discendo-sdk/core` | [EVENTS.md](./EVENTS.md) | The typed `EventBus` and the catalog of events |
| core: tenancy | `discendo-sdk/core` | [TENANCY.md](./TENANCY.md) | Organizations (the tenant wall) and optional departments |
| core: permissions | `discendo-sdk/core` | [PERMISSIONS.md](./PERMISSIONS.md) | Roles, the default rule table, policies, and how services enforce them |
| core: guardians | `discendo-sdk/core` | [GUARDIANS.md](./GUARDIANS.md) | Read-only access for a student's parent or guardian, through a link |
| **enrollment** | `discendo-sdk/enrollment` | [ENROLLMENT.md](./ENROLLMENT.md) | Enrolling and dropping, waitlisting at capacity, bulk roster import |
| **delegation** | `discendo-sdk/delegation` | [DELEGATION.md](./DELEGATION.md) | Instructors handing selected permissions to their TAs, and taking them back |
| **content** | `discendo-sdk/content` | [CONTENT.md](./CONTENT.md) | The content tree, publishing and versioning, prerequisite gating |
| **assessment** | `discendo-sdk/assessment` | [ASSESSMENT.md](./ASSESSMENT.md) | Submissions, attempt limits, quiz attempts with randomization, a plagiarism-check seam |
| **grading** | `discendo-sdk/grading` | [GRADING.md](./GRADING.md) | Grade recording with full history, weighted final grades, late penalties, letter grades |
| **scheduling** | `discendo-sdk/scheduling` | [SCHEDULING.md](./SCHEDULING.md) | Timetables: recurring templates, occurrences, conflicts, availability, room matching and an auto-scheduling solver. By far the largest module |
| scheduling: calendar | `discendo-sdk/scheduling/calendar` | [CALENDAR.md](./CALENDAR.md) | Availability windows (locked, open, closed) and iCal export of due dates |
| **communication** | `discendo-sdk/communication` | [COMMUNICATION.md](./COMMUNICATION.md) | Announcements, thread replies, and the bridge from events to a notification sink |
| **reporting** | `discendo-sdk/reporting` | [REPORTING.md](./REPORTING.md) | Attendance, completion percentage, CSV export |
| **admin** | `discendo-sdk/admin` | [ADMIN.md](./ADMIN.md) | Audit logging with `withAudit` and `AdminService` |
| **interop** | `discendo-sdk/interop` | [INTEROP.md](./INTEROP.md) | Type-only seams for LTI, SSO and SCORM/xAPI import |

### What is built, and what enforces permissions

| Module | Permission enforcement |
| --- | --- |
| enrollment, grading, assessment, content, communication, delegation | **yes**: opt-in (delegation always) |
| scheduling, reporting, admin | not yet: the actions exist, the services do not check them |

See [PERMISSIONS.md](./PERMISSIONS.md) for how to turn it on and what to do for the
rest.

## Design principles that hold across every module

These aren't aspirations; they are patterns you will see repeated in every
module's code, and relying on them makes extending the SDK predictable.

- **Repository-interface pattern.** Every module that touches persistence
  defines its own repository interface(s) (`GradeRepository`,
  `SchedulingRepository`, ...) rather than importing a database client. The host
  implements these against Prisma, Drizzle, raw SQL, or an in-memory store for
  tests. The SDK declares no database dependency.
- **Services are constructor-injected.** A module's `*Service` class takes its
  repositories as constructor arguments. There is no global state, no singleton
  registry and no dependency-injection framework.
- **Pure functions separated from services.** Calculation logic that doesn't
  need a repository is exported as standalone pure functions (`computeFinalGrade`,
  `applyLatePolicy`, `checkAvailability`, `solveSchedule`, ...), so it is trivially
  testable and reusable, for example to preview a result before committing it.
- **Never hard-delete; prefer status changes and audit trails.** Grades are
  superseded, not overwritten. Enrollments are dropped, not deleted. Class
  occurrences are cancelled, not deleted. Grants and links are revoked, not removed.
- **UTC timestamps everywhere internally.** Local-time conversion is a
  presentation concern for the host, at the edge.
- **Seams, not implementations, for outside concerns.** `interop`,
  `PlagiarismCheckHook` and `NotificationSink` define *where* LTI, SAML, email
  delivery or plagiarism detection plug in, without the SDK implementing any of it.
- **Optional wiring stays optional.** Events, hooks, permission enforcement and the
  optional repositories can all be left out, and the module behaves as it always did.
- **Enforcement fails closed.** With a policy configured, anything not clearly
  allowed is refused: no actor, an unknown actor, an unknown target, a policy that
  throws. A refusal for an unknown target looks exactly like a refusal for a
  forbidden one, so ids cannot be probed.
- **Authorization comes first.** An enforcing service checks permission before it
  looks anything else up, so a refused caller learns nothing.
- **Organizations are a hard wall.** Nobody acts across one, not even an admin;
  departments inside an organization are only a way to sort courses.
- **The SDK does not authenticate.** It trusts the `actorId` you pass and verifies
  everything else about that person itself.

## Module interdependencies

**A module may import only `core` and its own files, never another domain or
service.** Modules coordinate through the shared [EventBus](./EVENTS.md) instead.
`test/architecture.test.ts` enforces this, so a change that breaks it fails CI.

That is what lets a host adopt one module (say, just `grading`) without pulling in the
rest. A few notes:

- `admin`'s `withAudit` wraps calls into *any* other module without importing it; it is
  generic over `() => Promise<T>`.
- `grading` cannot import `assessment`, so it asks the host for a `SubmissionLocator`
  to find where a submission lives. `assessment`, by contrast, finds the section through
  `core`'s content repository.
- `scheduling` and `reporting` share an attendance shape *structurally* (a matching
  interface in each), so one repository implementation serves both.
- `calendar` sits inside `scheduling` but shares no code with it.

## Project structure on disk

```
src/
  core/         shared types, repository interfaces, EventBus, tenancy, permissions.
                Imports nothing else in the SDK.
  domains/      modules that own a primary entity a host persists
    enrollment/   content/   assessment/   grading/   delegation/
    scheduling/   (rules/, solver/, calendar/, testing/ — see its README)
  services/     cross-cutting modules that consume what domains produce
    communication/   reporting/   admin/
  interop/      pluggable protocol seams only (LTI, SSO, SCORM/xAPI)
  index.ts      root barrel — re-exports every module
test/
  architecture.test.ts   enforces the layering rules
  docs.test.ts           keeps these docs in step with the code
  *-events.test.ts, *-permissions.test.ts, *-tenancy.test.ts, scheduling*.test.ts, ...
docs/            these pages
```

Each layer folder has a `README.md` stating its rule.

**Where does a new module go?** Does it own an entity with its own identity and
lifecycle that a host would have a table for? Put it in `domains/`. Does it mostly react
to or summarize what domains already produced? Put it in `services/`. Is it a protocol
seam with no implementation? `interop/`.

## Runtime and tooling

- **Runtime:** Bun (`bun:test` is the test runner; `bun-types` is in `tsconfig.json`).
- **Language:** TypeScript with `strict: true`, plus the stricter
  `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
- **Module system:** ESM throughout (`"type": "module"`, `NodeNext`), so internal imports
  use explicit `.js` extensions even though the source is `.ts`.
- **Build:** `tsc -p tsconfig.json` emits to `dist/`, matching the `package.json`
  `exports` map (one entry per module subpath).
- **Dependencies:** none at runtime. `zod` is declared as a peer dependency but nothing
  imports it yet.
- **Checks:** `npx tsc --noEmit` typechecks the source, but not the tests (and `bun test`
  does not typecheck either), so the tests are typechecked separately. See "Verifying a
  change" in the [root README](../README.md).
