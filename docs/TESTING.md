# Testing and In-Memory Repositories

`discendo-sdk/testing` gives you three things:

1. **`createInMemoryLms()`**: every service in the SDK, wired to each other and to in-memory
   storage, in one call. You can try the SDK, write a demo or test your own application code
   without writing any database code.
2. **An in-memory implementation of every repository interface** the SDK defines. Use them in
   your tests, or read them as a reference for what each method has to do.
3. **A contract suite for every repository interface.** These are checks you run against *your*
   database implementation to confirm it behaves the way the SDK's services expect. They cover
   things like "the most recent enrollment", "only if still pending", and "concurrent calls never
   overfill a section".

Nothing in the rest of the SDK imports this subpath, and nothing in it is needed in production.

| At a glance | |
| --- | --- |
| Import from | `discendo-sdk/testing` |
| Source | `src/testing/` (the wiring), plus a `testing/` folder inside each module (that module's in-memory repositories and contract suites) |
| You implement | nothing |
| Runtime dependencies | none; the contract suites do not depend on any test runner |

## Quick start: a working LMS in one call

```ts
import { createInMemoryLms } from "discendo-sdk/testing";

const lms = createInMemoryLms(); // enforcement on, built-in role policy, a fresh EventBus
const as = (actorId: string) => ({ actorId });

// Seed what the SDK only reads: people, courses, sections.
lms.repos.users.seed(
  { id: "principal", roles: ["admin"] },
  { id: "ms-lee", roles: ["instructor"] },
  { id: "sam", roles: ["student"] },
);
lms.repos.courses
  .seedCourse({ id: "bio", title: "Biology" })
  .seedSection({ id: "bio-a", courseId: "bio", status: "published", capacity: 30 });

// From here on it is the real services, with permission checks.
const { enrollment, content, assessment, grading } = lms.services;
await enrollment.enroll({ userId: "ms-lee", sectionId: "bio-a", role: "instructor" }, as("principal"));
await enrollment.enroll({ userId: "sam", sectionId: "bio-a", role: "student" }, as("principal"));

const essay = await content.createNode(
  { sectionId: "bio-a", kind: "assignment", title: "Cell essay", orderIndex: 0, published: false },
  as("ms-lee"),
);
await content.publish(essay.id, as("ms-lee"));

const sub = await assessment.submit(essay.id, "sam", { kind: "text", content: "Cells are..." }, 2, as("sam"));
await grading.recordGrade(sub.id, "sam", 18, 20, "ms-lee", undefined, as("ms-lee"));

await grading.computeFinalGradeForUser("sam", "bio-a", { categories: [{ name: "assignment", weight: 1 }] }, as("sam")); // 90
```

### What `createInMemoryLms(options?)` returns

| Field | What it is |
| --- | --- |
| `services` | `enrollment`, `enrollmentRequests`, `groups`, `prerequisites`, `content`, `assessment`, `rubrics`, `peerReviews`, `grading`, `accommodations`, `delegation`, `guardians`, `scheduling`, `communication`, `reporting`, `admin` |
| `repos` | every repository, by name: the twelve core ones (`users`, `courses`, `enrollments`, `content`, ...) plus `submissions`, `quizzes`, `rubrics`, `rubricEvaluations`, `peerReviews`, `grades`, `extensions`, `excusals`, `scheduling`, `attendance`, `announcements`, `threads`, `audit` |
| `bus` | the `EventBus` every service emits to |
| `policy` | the permission policy in force |
| `notifications` | a `RecordingNotificationSink`: its `sent` array is what `CommunicationService` would have delivered |
| `completion` | an `InMemoryCompletionTracker` for `ContentService.isUnlocked` (`markComplete(userId, contentId)`; a submission also counts) |
| `locators` | the `SubmissionLocator` and `SessionLocator` the SDK asks a host for, as wired here |

| Option | Default | Effect |
| --- | --- | --- |
| `enforce` | `true` | Permission enforcement in every service that has it. With `false`, calls need no actor. Delegation, guardians, enrollment requests and accommodations always enforce, so they need an actor either way |
| `policy` | `createRolePolicy()` | The policy to enforce |
| `bus` | `new EventBus()` | The bus every service emits to |
| `contentPrerequisites` | `[]` | The `PrerequisiteEdge`s `ContentService.isUnlocked` checks |
| `categoryOf` | the content's `kind` | Which grading-scheme category a piece of content's grades count towards |

**How the parts are joined.** Some links the SDK leaves to the host, because each module may only
import `core`. This is how `createInMemoryLms` makes them:

- A grade finds its section, category and content through its submission's content node. That is
  both the `SubmissionLocator` grading uses for permissions and the placement
  `InMemoryGradeRepository` needs for `listForUserInSection`.
- A class session in reporting is a scheduling occurrence, and its section comes from the
  occurrence's template.
- Submitting a quiz records its grade through `GradingService.recordSystemGrade` under the grader
  name `IN_MEMORY_QUIZ_GRADER` (`'system:quiz'`), which is allowed in this setup.
- Quiz time limits include the student's active extension (`AccommodationService`'s extensions).
- One `InMemoryAttendanceRepository` backs both `SchedulingService` and `ReportingService`.

## The in-memory repositories

Every one is a class you can construct on its own. Each instance has its own data and its own id
sequence (`enr-1`, `enr-2`, ...). They hand out copies, so changing a returned object never changes
what is stored, as with a real database. They implement **every optional atomic method**
(`createIfSeatFree`, `promoteIfSeatFree`, `decideIfPending`, `createAttempt`, `supersedeIfCurrent`).
Each of these does its check and its write with no `await` in between, so it really is atomic in a
single process.

| Module | Classes |
| --- | --- |
| core | `InMemoryUserRepository`, `InMemoryCourseRepository`, `InMemoryTermRepository`, `InMemoryOrganizationRepository`, `InMemoryDepartmentRepository` (these only read in the SDK, so they add `seed`/`seedCourse`/`seedSection`), `InMemoryEnrollmentRepository`, `InMemoryContentRepository`, `InMemoryEnrollmentRequestRepository`, `InMemoryDelegationRepository`, `InMemoryGuardianLinkRepository`, `InMemoryGroupRepository`, `InMemoryCoursePrerequisiteRepository` |
| content | `InMemoryCompletionTracker` (a `CompletionChecker`) |
| assessment | `InMemorySubmissionRepository` (adds `findById`, `listByContent`), `InMemoryQuizRepository` (`seedQuestions`), `InMemoryRubricRepository`, `InMemoryRubricEvaluationRepository`, `InMemoryPeerReviewRepository` |
| grading | `InMemoryGradeRepository` (`place(submissionId, { sectionId, category, contentId })`, or a `locate` function), `InMemoryTimeExtensionRepository`, `InMemoryExcusalRepository` |
| scheduling | `InMemorySchedulingRepository` (both `SchedulingRepository` and `SchedulingSettingsRepository`; `seedTemplate`, `seedRoom`, `seedGroup`, ...) |
| communication | `InMemoryAnnouncementRepository`, `InMemoryThreadRepository`, `RecordingNotificationSink` |
| reporting | `InMemoryAttendanceRepository`, `InMemorySessionLocator` |
| admin | `InMemoryAuditRepository` |

A few choices worth knowing, all of them within what the interfaces allow:

- `countActive` counts every active enrollment, staff included, so a TA takes a seat. This is the
  default the SDK documents.
- Saving a rubric for content that already has one keeps the old rubric. Evaluations made against
  it keep pointing at it, and `findByContentId` returns the newest.
- Deleting a group also removes its memberships.
- A repeat attendance mark is a second record, as [REPORTING.md](./REPORTING.md) describes.

`InMemoryTable` is the storage underneath all of them, and it is exported. Use it to write an
in-memory version of an interface of your own.

## Contract suites: check your own repositories

When you implement a repository against your database, run its contract suite in your own tests.
Each suite is a plain list of `{ name, run }` cases, and `run` throws a `ContractViolation` when
your implementation gets something wrong. So it works with any test runner:

```ts
// Vitest; for Jest drop the import, for Bun import from "bun:test"
import { describe, it } from "vitest";
import { enrollmentRepositoryContract, gradeRepositoryContract } from "discendo-sdk/testing";

describe("PostgresEnrollmentRepository", () => {
  // The factory is called once per case: hand back a repository on empty tables.
  for (const c of enrollmentRepositoryContract(async () => new PostgresEnrollmentRepository(await freshDb()))) {
    it(c.name, c.run);
  }
});
```

There is one suite per interface:

| Module | Suites |
| --- | --- |
| core | `userRepositoryContract`, `courseRepositoryContract`, `termRepositoryContract`, `organizationRepositoryContract`, `departmentRepositoryContract`, `enrollmentRepositoryContract`, `contentRepositoryContract`, `enrollmentRequestRepositoryContract`, `delegationRepositoryContract`, `guardianLinkRepositoryContract`, `groupRepositoryContract`, `coursePrerequisiteRepositoryContract`; all at once with `coreRepositoryContracts({ ... })` |
| assessment | `submissionRepositoryContract`, `quizRepositoryContract`, `rubricRepositoryContract`, `rubricEvaluationRepositoryContract`, `peerReviewRepositoryContract`; all at once with `assessmentRepositoryContracts({ ... })` |
| grading | `gradeRepositoryContract`, `timeExtensionRepositoryContract`, `excusalRepositoryContract`; all at once with `gradingRepositoryContracts({ ... })` |
| scheduling | `schedulingRepositoryContract`, `schedulingSettingsRepositoryContract` |
| communication | `announcementRepositoryContract`, `threadRepositoryContract`; both with `communicationRepositoryContracts({ ... })` |
| reporting | `attendanceRepositoryContract` |
| admin | `auditRepositoryContract` |

**Factories that receive data.** Some interfaces have no create method, because the SDK only reads
those records. Their factory is handed the rows to seed first:

- users, courses and sections, terms, organizations and departments;
- a quiz's questions;
- scheduling's rooms, groups and qualifications.

`gradeRepositoryContract` hands over where each submission belongs (section, category and
content), because `listForUserInSection` must return that and a `GradeEntry` does not carry it.

**Optional methods.** A case about an optional method (`createIfSeatFree`, `decideIfPending`, ...)
passes without doing anything when your repository does not have that method. When you do
implement one, its concurrency case fires several calls at once and checks that the limit holds.

The helpers the suites are built from are exported too, for writing contract suites of your own:
`check`, `checkEqual`, `idsOf`, `suite`, `deepEqual`, and the `ContractCase` and
`RepositoryFactory` types.

## Known limitations

- **One process only.** The in-memory repositories are atomic because JavaScript runs one thing at
  a time. They are not shared between processes or workers, and nothing is saved when the process
  exits.
- **A contract suite cannot prove atomicity.** Its concurrency cases make simultaneous calls and
  check the result, so they catch an implementation that reads and writes in separate steps with
  a gap between them. A race that only shows up under real load can still pass.
- **The contracts check what the SDK relies on, not everything an implementation does.** Ordering
  is only checked where the SDK depends on it. A list's order is otherwise left to you.
- **`createInMemoryLms` makes some choices for you.** The grade category is the content's `kind`
  unless you pass `categoryOf`. Quiz auto-grading is always on. There is no plagiarism hook. To
  wire things differently, build the services yourself from the in-memory repositories.
- **Seeding bypasses the services**, and so bypasses their checks. Seeded rows are stored exactly as
  given.

## Tests

| File | Covers |
| --- | --- |
| `test/testing-contracts.test.ts` | every in-memory repository passes its contract suite; there is one suite per repository interface |
| `test/testing-contracts-catch-bugs.test.ts` | the suites fail realistic broken implementations: the oldest enrollment instead of the newest, a check-then-write `createIfSeatFree`, an update that replaces instead of merging, wrong attempt numbering, read-modify-write quiz answers, a double close, an unconditional supersede, revoked excusals dropped, posts lost |
| `test/testing-in-memory-lms.test.ts` | `createInMemoryLms` end to end with enforcement: content, a submission and grade, an auto-graded quiz, a final grade, a guardian, an announcement, attendance through scheduling read by reporting, the organization wall, separate instances, and `enforce: false` |
