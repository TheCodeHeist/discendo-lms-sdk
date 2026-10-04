# Assessment

`src/domains/assessment/` — students handing work in and taking quizzes:
recording submissions with an attempt limit, counting attempts, and generating a
per-student quiz attempt with the question order shuffled. Subpath:
`discendo-sdk/assessment`.

Assessment records *that* work was submitted or a quiz was started. It does not mark
anything: that is [grading](./GRADING.md), which attaches a score to a submission
this module created.

## At a glance

| | |
| --- | --- |
| **You import** | `AssessmentService` and the types in `types.ts` |
| **You implement** | `SubmissionRepository` and `QuizRepository` (defined here), plus, to enforce permissions, the `core` repositories `users`, `courses`, `enrollments`, `content` |
| **Optional seams** | a `PlagiarismCheckHook`; an `EventBus` |
| **Emits events** | `assessment.submissionReceived` |
| **Permission actions** | `assessment.submit`, `assessment.startAttempt`, `assessment.viewAttempts`, `assessment.recordOffline` |
| **Enforcement** | opt-in: the fifth constructor argument, `{ policy, repos }` |

## Types (`types.ts`)

```ts
type SubmissionPayload =
  | { kind: 'text'; content: string }
  | { kind: 'file'; ref: string }       // a reference into the host's file store
  | { kind: 'url'; href: string }
  | { kind: 'none' };                   // offline or manually graded work

interface Submission {
  id: string;
  contentId: string;     // the assignment it was submitted to
  userId: string;
  payload: SubmissionPayload;
  submittedAt: Date;
  attemptNumber: number; // 1 for the first attempt
  recordedBy?: string;   // set only when staff recorded it with recordOffline
}

interface QuizQuestion {
  id: string;
  prompt: string;
  choices: string[];
  correctChoiceIndex: number;
}

interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[];   // the question ids in this attempt's own order
  startedAt: Date;
  submittedAt?: Date;
}

type PlagiarismCheckResult = { flagged: boolean; score?: number; details?: string };
type PlagiarismCheckHook = (submission: Submission) => Promise<PlagiarismCheckResult>;
```

`Rubric` (`{ contentId, criteria }`) and `Criterion` (`{ description, maxPoints }`)
are also exported. They are **types only**: no service reads or writes a rubric yet.

The file itself, the text or the URL is never interpreted by the SDK. It stores the
`payload` as given and hands it back.

## The repositories

```ts
interface SubmissionRepository {
  create(sub: Omit<Submission, 'id'>): Promise<Submission>;
  countAttempts(contentId: string, userId: string): Promise<number>;
}

interface QuizRepository {
  getQuestions(quizId: string): Promise<QuizQuestion[]>;
  createAttempt(attempt: Omit<QuizAttempt, 'id'>): Promise<QuizAttempt>;
}
```

## `AssessmentService`

```ts
new AssessmentService(
  submissions: SubmissionRepository,
  quizzes: QuizRepository,
  plagiarismHook?: PlagiarismCheckHook,
  events?: EventBus,
  enforcement?: { policy: PermissionPolicy; repos: AuthorizationRepos & Pick<RepositoryContext, 'content'> },
)
```

Every method takes a trailing `actor?: { actorId }`. It is required when `enforcement`
is set and ignored otherwise.

### `submit(contentId, userId, payload, maxAttempts?, actor?): Promise<Submission>`

Records a submission and returns it.

1. **(Enforcement on)** authorizes `assessment.submit` for this content (see below).
2. Counts the person's prior attempts at this content. If `maxAttempts` is given and
   already reached, throws `No attempts remaining`.
3. Stores the submission with `attemptNumber = prior attempts + 1`.
4. If a plagiarism hook was supplied, calls it **without waiting** (see
   [the plagiarism hook](#the-plagiarism-hook-read-this)).
5. Emits `assessment.submissionReceived`, also without waiting.

Pass `undefined` for `maxAttempts` for no limit. The limit is a value your code passes
on each call (from the assignment's settings, which you store); the SDK does not store
it.

```ts
await assessment.submit(
  'assign-1', student.id, { kind: 'text', content: 'My answer' },
  3,                               // at most three attempts
  { actorId: student.id },
);
```

### `attemptsRemaining(contentId, userId, maxAttempts, actor?): Promise<number>`

`max(0, maxAttempts - attempts used)`.

### `recordOffline(contentId, userId, actor?): Promise<Submission>`

Records work a student did **offline** (on paper, in a lab, in person), so it has a
submission that can be graded.

1. **(Enforcement on)** authorizes `assessment.recordOffline` for this content, then
   checks that `userId` is currently an **active student** of the content's section. A
   dropped, waitlisted or completed student, or anyone who is not a student there, is
   refused exactly like a forbidden call.
2. Counts the student's prior attempts and stores a `{ kind: 'none' }` submission with
   `attemptNumber = prior attempts + 1` and `recordedBy` set to the actor's id.

```ts
const sub = await assessment.recordOffline('assign-1', student.id, { actorId: teacher.id });
await grading.record(/* ... */ sub.id /* ... */);
```

- **Who may:** admins and instructors of the section. A TA only if an instructor
  delegated `assessment.recordOffline` to them (see [DELEGATION.md](./DELEGATION.md)).
  Students may not, even for themselves.
- **`kind: 'none'` only.** The method takes no payload, so it cannot be used to store
  text, a file or a URL on someone's behalf.
- **`recordedBy`** is the actor's id, and is **absent on a submission the student made
  themselves**, so the two can be told apart. Your `SubmissionRepository` must persist
  it; without enforcement and without an actor it is simply not set.
- **Not limited by `maxAttempts`**, it starts **no plagiarism check** and emits
  **no event** (events are being added in one round, later). Like the other methods, it
  works on unpublished content when the actor is staff.
- Without enforcement it needs no actor and checks nothing, as with the other methods.

### `generateAttempt(quizId, userId, randomize = true, actor?): Promise<QuizAttempt>`

Reads the quiz's questions, takes their ids, shuffles that order when `randomize` is
true (a Fisher-Yates shuffle, per attempt, not stored globally), and stores a new
`QuizAttempt` with `startedAt` now. The attempt holds the *order of question ids*; you
fetch the questions themselves when you present it.

## The plagiarism hook (read this)

```ts
const assessment = new AssessmentService(subs, quizzes, async (submission) => {
  try {
    await checker.check(submission);
  } catch (error) {
    logger.error(error);          // never let it throw
  }
  return { flagged: false };
});
```

The hook is **fire-and-forget by design**: a slow external check must not block a
submission. Two consequences you must know:

- **Its result is discarded.** The SDK does not store or act on `flagged`; if you want
  the outcome, persist it inside your hook.
- **A hook that throws or rejects is swallowed, silently.** The submission is already
  stored and is never failed by the hook, and the failure does not become an unhandled
  promise rejection. But the SDK does **not** report it anywhere, so an outage of your
  checker is invisible unless you log inside the hook, as above. The hook is started on
  a following microtask, not synchronously inside `submit`.

## Permissions

Turn enforcement on with the fifth constructor argument:

```ts
const assessment = new AssessmentService(subs, quizzes, hook, bus, {
  policy: createRolePolicy(),
  repos,        // users, courses, enrollments and content (and optionally guardianLinks, delegations)
});
```

Once set, every method requires an actor and refuses to run without one. The shape of
enforcement is the same as in [PERMISSIONS.md](./PERMISSIONS.md); assessment adds these
specifics.

| Method | Action | Who, by default |
| --- | --- | --- |
| `submit` | `assessment.submit` | the student themselves, for their own work only |
| `generateAttempt` | `assessment.startAttempt` | the student themselves, for their own attempt only |
| `attemptsRemaining` | `assessment.viewAttempts` | staff (admin, instructor, TA) for anyone; a student for themselves |
| `recordOffline` | `assessment.recordOffline` | admins and instructors; a TA only when delegated. The student must be an active student of the section |

- **The section comes from the content node** (`repos.content`), never from the
  caller. For a quiz, `quizId` has to be the **id of the quiz's content node**. An
  id that is not a content node is refused.
- **A student cannot submit `{ kind: 'none' }`** with enforcement on: it throws a plain
  `Error` (after the permission check, so a stranger still just hears "refused"). Staff
  record offline work with `recordOffline`. Without enforcement `submit` accepts it, as
  before.
- **Only students submit.** Teachers, TAs, admins and guardians cannot submit or start
  attempts, even for a student in their own section, and a student must be an *active*
  student in that section (dropped, waitlisted and completed students are refused).
  Staff record offline work with `recordOffline`.
- **Unpublished content is invisible to non-staff.** A student is refused on a draft
  assignment or quiz, while staff are not.
- **The permission check comes first.** It runs before the attempt limit, so nobody
  learns how many attempts someone else used, and nothing about the content is looked up
  before the actor is known.
- **Unknown content is refused exactly like forbidden content**, with the same
  `PermissionDeniedError` message.
- **A guardian gets nothing here**, whatever their link allows.

Nothing is emitted and nothing is stored for a refused call.

## Events

`assessment.submissionReceived` (`submissionId`, `contentId`, `userId`, `attemptNumber`)
after each stored submission. A failing listener never fails the submission. See
[EVENTS.md](./EVENTS.md).

## Known limitations

- **The attempt limit is not atomic.** `countAttempts` and `create` are separate calls,
  so two simultaneous submissions can both pass the check. If the limit is strict,
  enforce it in your repository as well.
- **A failing plagiarism hook is swallowed without a trace** (see above), and its
  result is discarded. The SDK has no error channel for it yet.
- **Quiz answers are not handled.** The module generates attempts but does not record
  answers, mark them, or set `submittedAt`. Scoring a quiz is your application's job.
- **Rubrics are types only.**
- **No prerequisite gating and no due dates** here. Use `ContentService.isUnlocked`
  ([CONTENT.md](./CONTENT.md)) and the availability windows in
  [CALENDAR.md](./CALENDAR.md).
- **The content kind is not checked.** Nothing stops `submit` being called on a page, or
  `generateAttempt` on an assignment.
- **The shuffle uses `Math.random`**: unseeded and not reproducible.
- `grading.view` covers a guardian's view of grades; there is no guardian access to
  attempts.

## Tests

| File | Covers |
| --- | --- |
| `test/assessment-permissions.test.ts` | all four methods with enforcement on, including `recordOffline` (who may, delegation, active-student target, numbering, no hook or event): own-only rules, staff, enrollment states, drafts, unknown content, guardians, the tenant wall, check ordering, no lookups before the actor is known, and behaviour with enforcement off |
| `test/assessment-events.test.ts` | `assessment.submissionReceived`, attempt numbers, no event when `maxAttempts` rejects, a throwing listener, working with no bus |
| `test/assessment-plagiarism.test.ts` | the hook receives the stored submission, is not awaited, and a rejecting or synchronously throwing hook neither fails the submission, leaks an unhandled rejection, nor stops the event |
| `test/core-permissions.test.ts` | the three assessment rules ("assessment rules") |
