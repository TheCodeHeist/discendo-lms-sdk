# Migration Guide

What changed in ways that touch **your** code, and what to do about it. Most changes since the
first release candidate add things, and need nothing from you. This page lists only the ones that
do, most likely to affect you first.

| Change | Affects you if | Effort |
| --- | --- | --- |
| [Services take one config object](#1-services-take-one-config-object) | you construct any service | search and replace; the old form still works, with a deprecation warning in your editor |
| [Quiz answers are stored as JSON](#2-quiz-answers-are-stored-as-json) | you implemented `QuizRepository` | a column type, and the contract suite |
| [A content update can clear a field](#3-a-content-update-can-clear-a-field) | you implemented `ContentRepository` | map `undefined` to `NULL` |
| [Node 20 or later](#4-node-20-or-later) | you run on Node 18 | upgrade Node |
| [Smaller behaviour changes](#5-smaller-behaviour-changes) | you rely on the exact output of a few methods | read the list |

The [contract suites](./TESTING.md) check most of this for you: run them against your repositories
after upgrading.

## 1. Services take one config object

Every service is now built the same way:

```ts
new XService({
  repos: { ... },   // the repositories it uses, by name, plus users/courses/enrollments for permission checks
  policy,           // optional: turns permission enforcement on (required by the services that always enforce)
  events: bus,      // optional: the EventBus it emits to
  ...settings,      // that service's own options, under the same names as before
});
```

Before, each service had its own argument order, and enforcement was switched on in three
different ways (`{ policy }`, `{ enforcement: { policy, repos } }`, or a separate argument).

**The old constructors still work** for this release. They are marked `@deprecated`, so your editor
shows them struck through, and they behave exactly as before. They will be removed in a later
release. With the new form, a repository that enforcement needs and you left out is reported as a
`ServiceConfigError` when the service is built. Before, it showed up as a refusal on the first call.

| Service | Before | Now |
| --- | --- | --- |
| `EnrollmentService` | `(repos, bus, { policy, promoteOnDrop })` | `({ repos, events: bus, policy, promoteOnDrop })` |
| `EnrollmentRequestService` | `(repos, enrollment, bus, { policy })` | `({ repos, enrollment, events: bus, policy })` |
| `GroupService` | `(repos, { policy })` | `({ repos, policy })` |
| `PrerequisiteService` | `(repos, { policy, gradeSource })` | `({ repos, policy, gradeSource })` |
| `ContentService` | `(repos, completion, edges, bus, { policy, revisions, prerequisites })` | `({ repos: { ...repos, contentRevisions, contentPrerequisites }, completion, fixedPrerequisites: edges, events: bus, policy })` |
| `AssessmentService` | `(submissions, quizzes, hook, bus, { policy, repos }, { extensions, autoGrade })` | `({ repos: { submissions, quizzes, ...repos }, plagiarismHook: hook, events: bus, policy, extensions, autoGrade })` |
| `RubricService` | `(repos, { policy })` | `({ repos, policy })` |
| `PeerReviewService` | `(repos, { policy })` | `({ repos, policy })` |
| `GradingService` | `(grades, bus, { policy, repos, submissions }, { excusals, releases, allowExtraCredit, systemGraders })` | `({ repos: { grades, excusals, releases, ...repos }, submissions, events: bus, policy, allowExtraCredit, systemGraders })` |
| `AccommodationService` | `(repos, bus, { policy })` | `({ repos, events: bus, policy })` |
| `DelegationService` | `(repos, { policy, delegableActions }, bus)` | `({ repos, events: bus, policy, delegableActions })` |
| `GuardianService` | `(repos, { policy }, bus)` | `({ repos, events: bus, policy })` |
| `SchedulingService` | `(scheduling, recorder, bus, { enforcement: { policy, repos }, settings })` | `({ repos: { scheduling, attendance: recorder, settings, ...repos }, events: bus, policy })` |
| `CommunicationService` | `(announcements, threads, sink, { enforcement: { policy, repos }, onDeliveryError, reminders }, bus)` | `({ repos: { announcements, threads, content, enrollments, reminderLog, ...repos }, sink, events: bus, policy, onDeliveryError })` |
| `ReportingService` | `(attendance, { sessions, enforcement: { policy, repos }, roster }, bus)` | `({ repos: { attendance, ...repos }, sessions, events: bus, policy })` |
| `AdminService` | `(audit, { enforcement: { policy, repos: { users } } })` | `({ repos: { audit, users }, policy })` |
| `CalendarService` | `()` | unchanged |

A few things moved into `repos`, because they are repositories:

- grading's `excusals` and `releases`;
- scheduling's `settings` and attendance recorder;
- content's revision and prerequisite stores (`contentRevisions`, `contentPrerequisites`).

Communication's reminders no longer need their own `reminders` option. They work when `repos` holds
`content` and `enrollments`, and `repos.reminderLog` sends each reminder once. Reporting's exports read
the roster from `repos.enrollments` (and `repos.users`), so there is no `roster` option either.

`isServiceConfig`, `requireRepos`, `ServiceConfigError` and `AUTHORIZATION_REPOS` are exported from
`core`, for services of your own that want the same shape.

## 2. Quiz answers are stored as JSON

Quizzes now have six question types (see [ASSESSMENT.md](./ASSESSMENT.md)). An answer is a
`QuizAnswer`: a number (single choice, numeric), a list of numbers (multiple choice), a boolean
(true/false) or text (short answer, essay).

**If you implemented `QuizRepository`:**

- `saveAnswer(attemptId, questionId, answer)` receives a `QuizAnswer`, not always a number. If
  `answers` is a map of integers in your store, make it JSON.
- `closeAttempt` can be given `pendingReview`, and `updateAttempt` can be given `score`, `maxScore`,
  `pendingReview` and `manualScores`. Store and merge them like the other fields.
- Optionally add `saveManualScore`, so two graders scoring the same attempt at the same moment cannot
  lose a score.

Existing single-choice quizzes and their stored answers keep working unchanged. Run
`quizRepositoryContract`.

## 3. A content update can clear a field

`ContentRepository.update(id, patch)` now takes a `ContentNodeUpdate`. **A field present in the patch
with the value `undefined` must be cleared.** That is how `ContentService.updateNode` removes a date
or a parent.

- **SQL or an ORM:** map `undefined` to `NULL`. Some ORMs (Prisma, for one) treat `undefined` as "leave
  it alone" and would silently keep the old date.
- **A document store or a test fake:** use `applyContentUpdate(node, patch)` from `core`. An `update`
  written as `{ ...node, ...patch }` still behaves correctly, but no longer typechecks under
  `exactOptionalPropertyTypes`.

`contentRepositoryContract` checks it. Nodes also gained optional `availableFrom`, `availableUntil`
and `dueAt` columns.

## 4. Node 20 or later

`engines.node` is now `>=20`. The quiz shuffle uses the Web Crypto API (`globalThis.crypto`)
instead of `node:crypto`. That lets the SDK run in browsers, Deno and edge runtimes, and Node only
has it built in from version 20. Node 18 is end-of-life.

## 5. Smaller behaviour changes

Nothing here breaks a build, but each changes an output you might rely on.

- **Attendance corrections.** A second mark for the same session no longer counts twice:
  `attendanceForStudent` counts the latest one, and `summary` follows. Every mark is still stored
  and returned in the new `history`.
- **Dates are enforced when content has them.** With enforcement on, a student cannot open content
  before `availableFrom`, or submit, start a quiz or save an answer outside its dates
  (`ContentNotAvailableError`). Content without dates behaves as before.
- **A quiz attempt can wait for review.** A quiz with an essay question is submitted with
  `pendingReview: true`, and its automatic grade is recorded only once staff score the essay.
- **`generateAttempt` checks the content kind** with enforcement on: starting a quiz attempt on
  content that is not a `quiz` throws `WrongContentKindError`.
- **Results carry more.** `QuestionResult` has `type`, `status`, `answer` and `correctAnswer`;
  `QuizResult` has `pendingReview`; `QuizQuestionView` has `type` and `answer`. The existing fields
  are unchanged.
- **Two new built-in actions,** `assessment.gradeQuiz` and `grading.release` (the second is
  delegable). A policy built with `createRolePolicy` gets them automatically. A policy of your own
  refuses them until you add rules.
- **Department admins.** An account with `adminOfDepartments` is an admin in those departments'
  sections. A custom policy must read the verified `section.departmentAdmin` flag (or use
  `effectiveRoles`), never the identity field.
