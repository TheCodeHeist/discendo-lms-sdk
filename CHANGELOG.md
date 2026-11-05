# Changelog

All notable changes to `discendo-sdk`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). Before 1.0, a minor version can
change the API; every such change is described in [docs/MIGRATION.md](./docs/MIGRATION.md).

## [0.2.0] - 2026-11-05

The first release published to npm.

### Modules

Every module is a subpath export (`discendo-sdk/<module>`) and has its own page in [docs/](./docs/INDEX.md).

- **core**: the shared types, the repository interfaces, a typed `EventBus`, organizations (a hard
  tenant wall) and departments, and a role-based permission policy. The policy covers guardians,
  instructor-to-TA delegation, read-only access after completion, and department-scoped admins.
- **enrollment**: enrolling and dropping, capacity and waitlists (with optional automatic
  promotion), bulk roster import, student enrollment requests, groups, and course prerequisites.
- **content**: the content tree, publishing, editing with a full version history, open, close and
  due dates, prerequisites staff can change, and `checkAccess`.
- **assessment**: submissions with attempt limits, group work, rubrics, peer review, a
  plagiarism-check seam, and quizzes. Quizzes support single and multiple choice (all-or-nothing or
  partial credit), true/false, short answer, numeric and essay questions, negative marking, time
  limits with extensions, attempt limits, hand scoring, and automatic grading.
- **grading**: grades that are never overwritten (regrades supersede), weighted final grades with
  dropped scores, late penalties, letter grades, curves and GPA, extensions and excusals, holding
  grades until released, a student's grade list, a final grade with its working shown, and a
  gradebook export.
- **scheduling**: timetables from recurring templates, conflict, availability and room checks,
  teacher qualifications, an auto-scheduling solver with soft constraints, attendance, and
  calendar windows with iCal export.
- **communication**: announcements on separate student and guardian channels, discussion threads,
  due-date reminders, and a bridge from events to your notification sink.
- **reporting**: attendance (corrections replace earlier marks), roster and attendance exports,
  and spreadsheet-safe CSV.
- **admin**: audit logging, and a searchable, paginated audit log confined to each organization.
- **delegation** and **guardians**: instructors handing selected actions to their TAs, and
  read-only guardian access through scoped links.
- **interop**: type-only seams for LTI, SSO and SCORM/xAPI.
- **testing**: `createInMemoryLms()` (every service wired to in-memory storage), an in-memory
  implementation of every repository interface, and a runner-agnostic contract suite per interface
  to check your own repositories against.

### Since 0.1.0

If you used 0.1.0 (from GitHub), see [docs/MIGRATION.md](./docs/MIGRATION.md).

#### Changed
- Every service takes one config object: `new XService({ repos, policy, events, ... })`. The
  positional constructors still work, and are deprecated.
- `QuizRepository.saveAnswer` takes a `QuizAnswer` (number, number list, boolean or text): store
  answers as JSON.
- `ContentRepository.update` must clear a field given as `undefined`.
- A second attendance mark for a session is a correction: the latest counts.
- Node 20 or later is required. The quiz shuffle uses Web Crypto instead of `node:crypto`, so the
  SDK also runs in browsers, Deno and edge runtimes.

#### Added
Everything new in the modules above since 0.1.0: question types, grade release,
content history and dates, threads and reminders, exports, department admins, audit search, and
`discendo-sdk/testing`.

#### Fixed
- The quiz shuffle no longer imports `node:crypto`, which broke bundles for the browser and edge.
- Many examples in the documentation that did not match the code.

## [0.1.0] - 2026-10-11

The first release, on GitHub only (not published to npm): the modules, the permission model,
organizations, the scheduling solver, and the documentation site.

[0.2.0]: https://github.com/TheCodeHeist/discendo-lms-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/TheCodeHeist/discendo-lms-sdk/releases/tag/v0.1.0
