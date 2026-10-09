# Assessment

`src/domains/assessment/` — students handing work in and taking quizzes:
recording submissions with an attempt limit, counting attempts, and running a quiz:
generating a per-student attempt with the question order shuffled, saving the student's
answers, scoring them and (optionally) posting the score as a grade. Subpath:
`discendo-sdk/assessment`.

Assessment records *that* work was submitted and scores **quizzes**, which have one right
choice per question. It does not mark anything else: that is [grading](./GRADING.md), which
attaches a score to a submission this module created.

## At a glance

| | |
| --- | --- |
| **You import** | `AssessmentService`, `scoreQuiz`, the errors `AttemptClosedError`, `AttemptExpiredError`, `AttemptNotSubmittedError`, `InvalidAnswerError`, and the types in `types.ts` |
| **You implement** | `SubmissionRepository` and `QuizRepository` (defined here), plus, to enforce permissions, the `core` repositories `users`, `courses`, `enrollments`, `content` |
| **Optional seams** | a `PlagiarismCheckHook`; an `EventBus`; `autoGrade`, a `QuizGradeSink` (a `GradingService` fits) |
| **Emits events** | `assessment.submissionReceived`, `assessment.quizSubmitted` |
| **Permission actions** | `assessment.submit`, `assessment.startAttempt`, `assessment.answerQuiz`, `assessment.submitQuiz`, `assessment.viewAttempts`, `assessment.recordOffline` |
| **Enforcement** | opt-in: the fifth constructor argument, `{ policy, repos }` |

## Types (`types.ts`)

```ts
type SubmissionPayload =
  | { kind: 'text'; content: string }
  | { kind: 'file'; ref: string }       // a reference into the host's file store
  | { kind: 'url'; href: string }
  | { kind: 'none' }                    // offline or manually graded work
  | { kind: 'quiz'; attemptId: string }; // a submitted quiz attempt

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
  points?: number;           // what a right answer earns, default 1
}

interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[];   // the question ids in this attempt's own order
  startedAt: Date;
  submittedAt?: Date;        // set on submission; an attempt without it is open
  answers?: Record<string, number>;  // question id to the choice the student saved
  score?: number; maxScore?: number; late?: boolean;   // set on submission
  submissionId?: string;     // the Submission stored for it
  gradeEntryId?: string;     // the grade autoGrade recorded
}

interface QuizQuestionView {   // a question as a student sees it: no answer key
  id: string; prompt: string; choices: string[]; points?: number;
  selectedChoiceIndex?: number;   // what they have saved so far
}

interface QuestionResult {
  questionId: string;
  selectedChoiceIndex?: number;   // absent if unanswered
  correctChoiceIndex: number;
  correct: boolean; points: number; earned: number;
}

interface QuizResult {
  attemptId: string; quizId: string; userId: string;
  score: number; maxScore: number; submittedAt: Date; late: boolean;
  submissionId?: string; gradeEntryId?: string;
  questions?: QuestionResult[];   // the breakdown with the answer key: only when it may be shown
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
  // optional, recommended: take the next attempt number and check the limit in ONE atomic step
  createAttempt?(draft: Omit<Submission, 'id' | 'attemptNumber'>, maxAttempts?: number): Promise<Submission | null>;
}

interface QuizRepository {
  getQuestions(quizId: string): Promise<QuizQuestion[]>;
  createAttempt(attempt: Omit<QuizAttempt, 'id'>): Promise<QuizAttempt>;
  findAttempt(id: string): Promise<QuizAttempt | null>;
  findOpenAttempt(quizId: string, userId: string): Promise<QuizAttempt | null>;
  saveAnswer(attemptId: string, questionId: string, choiceIndex: number): Promise<QuizAttempt | null>;
  closeAttempt(attemptId: string, close: { submittedAt: Date; score: number; maxScore: number; late: boolean }): Promise<QuizAttempt | null>;
  updateAttempt(attemptId: string, patch: { submissionId?: string; gradeEntryId?: string }): Promise<QuizAttempt>;
}
```

The five quiz-answering methods are required, so a host that implemented the old two-method
`QuizRepository` has to add them (a compile error tells you). What each must do:

- **`findOpenAttempt(quizId, userId)`**: the person's attempt of this quiz with no `submittedAt`,
  newest first if there are several, or `null`.
- **`saveAnswer(attemptId, questionId, choiceIndex)`**: set `answers[questionId]` and keep the
  attempt's other answers, **only if the attempt exists and is still open**, and return it; `null`
  otherwise. Do it as one step in the store (a JSON-path update), not read-modify-write, so two answers
  saved at once do not lose each other.
- **`closeAttempt(attemptId, close)`**: set `submittedAt`, `score`, `maxScore` and `late` **only if the
  attempt is still open**, as one atomic step (`UPDATE ... WHERE submittedAt IS NULL`), and return the
  updated attempt or `null`. This is what makes a double submit score once.
- **`updateAttempt`**: store the `submissionId` and `gradeEntryId` the service attaches.

**`createAttempt?(draft, maxAttempts?)`** is optional, and recommended wherever an attempt limit
matters. Implement it as **one atomic step** (a transaction, a lock, or a conditional insert): the
repository assigns `attemptNumber` (the person's existing attempts for that content, plus one),
and if `maxAttempts` is given and they already have that many it stores nothing and returns
`null`, which the service reports as `No attempts remaining`. `submit` uses it (passing the limit),
and so does `recordOffline` (no limit, since staff are not capped), so a student's own submission
and a staff-recorded one racing each other get distinct numbers. Without it everything works as
before, with the race described in the limitations.

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
`QuizAttempt` with `startedAt` now. The attempt holds the *order of question ids*.

**If the student already has an open attempt of this quiz, that attempt is returned instead of a
new one** (`randomize` only matters for a new attempt). Starting over is therefore not a way to
see the questions again; a new attempt can be started once the last one is submitted.

## Taking a quiz

```ts
const attempt = await assessment.generateAttempt(quizId, studentId, true, actor);
const questions = await assessment.getAttemptQuestions(attempt.id, actor);   // no answer key
await assessment.saveAnswer(attempt.id, questions[0].id, 2, actor);          // as often as they like
const result = await assessment.submitAttempt(attempt.id, actor, { timeLimitSeconds: 1800 });
// result: { score, maxScore, late, submissionId, gradeEntryId?, ... }
```

### `getAttemptQuestions(attemptId, actor?): Promise<QuizQuestionView[]>`

The attempt's questions in the attempt's own order, as `QuizQuestionView`: **no
`correctChoiceIndex`**, plus `selectedChoiceIndex` for what the student has saved, so a page
can pick up where it left off. A question removed from the quiz since the attempt began is left
out. **Show a quiz to a student with this, never with `QuizRepository.getQuestions`**, whose
questions carry the answer key. Only the attempt's own student may ask (`assessment.answerQuiz`).

### `saveAnswer(attemptId, questionId, choiceIndex, actor?, { timeLimitSeconds? }): Promise<QuizAttempt>`

Saves one answer, replacing an earlier answer to the same question; call it as the student works so
nothing is lost if they stop. The question must be in the attempt and `choiceIndex` a whole number
that is one of its choices, or `InvalidAnswerError` (`reason`: `question-not-in-attempt` or
`choice-out-of-range`). A submitted attempt throws `AttemptClosedError`; after the time limit
`AttemptExpiredError`. `timeLimitSeconds` is passed by you on each call (the SDK stores no quiz
settings) and counts from `startedAt`; it must be a finite number above zero.

### `submitAttempt(attemptId, actor?, { timeLimitSeconds?, revealAnswers? }): Promise<QuizResult>`

1. Scores the saved answers with `scoreQuiz` and closes the attempt atomically (`closeAttempt`).
2. Stores a `Submission` with payload `{ kind: 'quiz', attemptId }`, numbered with the student's other
   submissions of that quiz, so [grading](./GRADING.md) can attach to it. It does **not** emit
   `assessment.submissionReceived` and starts no plagiarism check.
3. Emits `assessment.quizSubmitted`.
4. With `autoGrade`, records the score as a grade (below).

A submission after `timeLimitSeconds` is **flagged `late: true` but still scored**, from the answers
saved in time (answers after the limit were refused). The result has no answer key unless
`revealAnswers` is true.

It is **idempotent**: submitting again returns the same result, scores nothing twice and stores no
second submission; two submits at the same moment record one. **If it throws after scoring** (the
submission or the grade could not be stored) **the attempt is submitted and scored**, and calling it
again finishes whatever is missing, once. Only the attempt's own student may submit
(`assessment.submitQuiz`), even over an administrator.

### `getResult(attemptId, actor?, { revealAnswers? }): Promise<QuizResult>`

The score of a submitted attempt (`AttemptNotSubmittedError` before that). Staff of the section and
admins also get the per-question breakdown with the correct answers; **a student gets it only if you
pass `revealAnswers: true`**, because whether students may see the key (and when) is your policy. The
breakdown is worked out from the quiz as it is now, so if questions were edited since, it can disagree
with the stored score. Without enforcement it is included only when `revealAnswers` is true. With
enforcement this is `assessment.viewAttempts`: staff, or the attempt's own student.

### Scoring: `scoreQuiz(questions, answers, order?): QuizScore`

A pure function you can also call yourself. A right answer earns the question's `points` (default 1); a
wrong or missing answer earns 0, **never less**. Only the questions in `order` (the attempt's own list) are
scored, in that order, and a question removed from the quiz is skipped, so `maxScore` is what this
attempt could have earned. `points` must be a finite number from 0 up, or it throws. One choice per
question; there are no multi-select or written answers yet.

### Automatic grading: the `autoGrade` option

```ts
const grading = new GradingService(grades, bus, undefined, { systemGraders: ['system:quiz'] });
const assessment = new AssessmentService(subs, quizzes, hook, bus, enforcement, {
  autoGrade: { grading, source: 'system:quiz' },   // source is optional, default 'system:quiz'
});
```

On submission the score is recorded as a grade for the quiz's `Submission` through
`GradingService.recordSystemGrade` (see [GRADING.md](./GRADING.md)), once per attempt; the entry id is kept
as `gradeEntryId`. A quiz worth 0 points has no grade (grades need a maximum above zero). Without
`autoGrade`, the grade is yours to post, from `assessment.quizSubmitted` or the result.

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
| `getAttemptQuestions`, `saveAnswer` | `assessment.answerQuiz` | the attempt's own student only: no staff, not even an admin |
| `submitAttempt` | `assessment.submitQuiz` | the attempt's own student only |
| `getResult` | `assessment.viewAttempts` | staff of the section for anyone's (with the breakdown); a student for their own |
| `attemptsRemaining` | `assessment.viewAttempts` | staff (admin, instructor, TA) for anyone; a student for themselves |
| `recordOffline` | `assessment.recordOffline` | admins and instructors; a TA only when delegated. The student must be an active student of the section |

- **The section comes from the content node** (`repos.content`), never from the
  caller. For a quiz, `quizId` has to be the **id of the quiz's content node**. An
  id that is not a content node is refused. For the attempt methods the quiz and the owner come
  from the stored attempt, and **an unknown attempt is refused exactly like someone else's**; with no
  actor nothing is looked up.
- **A student cannot submit `{ kind: 'none' }`** with enforcement on: it throws a plain
  `Error` (after the permission check, so a stranger still just hears "refused"). Staff
  record offline work with `recordOffline`. Without enforcement `submit` accepts it, as
  before.
- **Only students submit.** Teachers, TAs, admins and guardians cannot submit or start
  attempts, even for a student in their own section, and a student must be an *active*
  student in that section (dropped, waitlisted and completed students are refused: a
  completed student gets no new submissions and no attempt counts).
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
after each stored submission. A failing listener never fails the submission.

`assessment.quizSubmitted` (`attemptId`, `quizId`, `submissionId`, `userId`, `score`, `maxScore`,
`late`) once per quiz attempt, when its submission is stored. A quiz attempt does not also emit
`assessment.submissionReceived`. See [EVENTS.md](./EVENTS.md).

## Known limitations

- **Without `createAttempt`, the attempt limit and the attempt numbers are not atomic.**
  `countAttempts` and `create` are separate calls, so two simultaneous submissions can both pass
  the limit and can share an attempt number. Provide `createAttempt` if the limit is strict (see
  below).
- **A failing plagiarism hook is swallowed without a trace** (see above), and its
  result is discarded. The SDK has no error channel for it yet.
- **Single-choice questions only.** No multi-select, true/false weighting, written answers or partial
  credit; the SDK has no negative marking either.
- **No attempt limit for quizzes.** `generateAttempt` takes no `maxAttempts`; quiz submissions do count
  in `attemptsRemaining`, so a host can check that before starting one.
- **Two simultaneous `generateAttempt` calls can each start an attempt**; the next call resumes the
  newest. A uniqueness rule on one open attempt per person and quiz in your store prevents it.
- **A half-finished submission is only finished by the student calling `submitAttempt` again.** If the
  server dies between closing an attempt and storing its submission, the attempt is scored but has no
  submission or grade until then, and a retry that lands in the same instant as the original can store
  two submissions.
- **A failing `autoGrade` is loud, not silent.** `submitAttempt` throws (the quiz is submitted; retry to
  grade it), which is the opposite of the plagiarism hook's swallowed errors.
- **The answer key is the host's to protect.** `QuizRepository.getQuestions` and `getResult`'s
  breakdown carry `correctChoiceIndex`; only `getAttemptQuestions` is safe to show a student.
- **The time limit is yours to pass on every call**, and uses the server's clock from `startedAt`.
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
| `test/atomic-repositories.test.ts` | attempt-limit and attempt-number races with and without `createAttempt`, including a staff-recorded offline submission racing a student's own |
| `test/assessment-permissions.test.ts` | all four methods with enforcement on, including `recordOffline` (who may, delegation, active-student target, numbering, no hook or event): own-only rules, staff, enrollment states, drafts, unknown content, guardians, the tenant wall, check ordering, no lookups before the actor is known, and behaviour with enforcement off |
| `test/assessment-events.test.ts` | `assessment.submissionReceived`, attempt numbers, no event when `maxAttempts` rejects, a throwing listener, working with no bus |
| `test/assessment-plagiarism.test.ts` | the hook receives the stored submission, is not awaited, and a rejecting or synchronously throwing hook neither fails the submission, leaks an unhandled rejection, nor stops the event |
| `test/assessment-quiz.test.ts` | `scoreQuiz`; resuming an open attempt; the answer-key-free view; saving answers (validation, closed, expired, races); submitting (scoring, the quiz submission and its numbering, idempotence, double submit, late flag, half-done recovery); `autoGrade`; `getResult` and who sees the breakdown; the two new student-only actions |
| `test/core-permissions.test.ts` | the three assessment rules ("assessment rules") |
