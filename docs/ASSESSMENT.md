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
| **Optional seams** | a `PlagiarismCheckHook`; an `EventBus`; `autoGrade`, a `QuizGradeSink` (a `GradingService` fits); `extensions`, an `ExtensionSource` (extra quiz time) |
| **Emits events** | `assessment.submissionReceived`, `assessment.quizSubmitted` |
| **Permission actions** | `assessment.submit`, `assessment.startAttempt`, `assessment.answerQuiz`, `assessment.submitQuiz`, `assessment.viewAttempts`, `assessment.recordOffline` |
| **Enforcement** | opt-in: a `policy` in the constructor's config (`repos` then also needs `users`, `courses`, `enrollments`, `content`) |

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

// Every question has these, plus the fields of its type (see "Question types" below):
//   id: string; prompt: string;
//   points?: number;    // what a fully right answer earns, default 1
//   penalty?: number;   // negative marking: what a wrong answer costs, default 0
type QuizQuestion =
  | SingleChoiceQuestion     // type?: 'single_choice' (the default); choices; correctChoiceIndex
  | MultipleChoiceQuestion   // type: 'multiple_choice'; choices; correctChoiceIndexes; scoring?
  | TrueFalseQuestion        // type: 'true_false'; correctAnswer: boolean
  | ShortAnswerQuestion      // type: 'short_answer'; acceptedAnswers; caseSensitive?; maxLength?
  | NumericQuestion          // type: 'numeric'; correctValue; tolerance?
  | EssayQuestion;           // type: 'essay'; maxLength?   (scored by a person)

type QuizAnswer = number | number[] | boolean | string;   // which one depends on the question's type

interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[];   // the question ids in this attempt's own order
  startedAt: Date;
  submittedAt?: Date;        // set on submission; an attempt without it is open
  answers?: Record<string, QuizAnswer>;    // question id to what the student saved
  score?: number; maxScore?: number; late?: boolean;   // set on submission
  manualScores?: Record<string, number>;   // points given by hand, by question id
  pendingReview?: boolean;   // true while a question still waits to be scored by hand
  submissionId?: string;     // the Submission stored for it
  gradeEntryId?: string;     // the grade autoGrade recorded
}

interface QuizQuestionView {   // a question as a student sees it: no answer key
  id: string; type: QuizQuestionType; prompt: string;
  choices: string[];           // empty for the types without choices
  points?: number; penalty?: number; maxLength?: number;
  answer?: QuizAnswer;         // what they have saved so far
  selectedChoiceIndex?: number;   // the same, for single choice only (kept for existing callers)
}

interface QuestionResult {
  questionId: string;
  type: QuizQuestionType;
  status: 'correct' | 'partial' | 'incorrect' | 'unanswered' | 'pending' | 'graded';
  answer?: QuizAnswer;                                  // absent if unanswered
  correctAnswer?: number | number[] | boolean | string[];  // the key; absent for an essay
  correct: boolean; points: number;
  earned: number;                                       // negative when a penalty applied
  selectedChoiceIndex?: number; correctChoiceIndex?: number;   // single choice only, as before
}

interface QuizResult {
  attemptId: string; quizId: string; userId: string;
  score: number; maxScore: number; submittedAt: Date; late: boolean;
  pendingReview: boolean;         // a question still waits to be scored by hand
  submissionId?: string; gradeEntryId?: string;
  questions?: QuestionResult[];   // the breakdown with the answer key: only when it may be shown
}

type PlagiarismCheckResult = { flagged: boolean; score?: number; details?: string };
type PlagiarismCheckHook = (submission: Submission) => Promise<PlagiarismCheckResult>;
```

## Rubrics and Rubric Scoring

`RubricService` manages rubrics associated with content and handles rubric evaluations:

```ts
const rubrics = new RubricService({ repos, policy });
await rubrics.saveRubric('assign-1', [
  { id: 'crit-thesis', description: 'Thesis clarity', maxPoints: 10 },
  { id: 'crit-evidence', description: 'Supporting evidence', maxPoints: 20 },
], 'Essay Rubric', { actorId: teacher.id });

const rubric = await rubrics.getRubric('assign-1', { actorId: student.id });
```

- **`scoreRubric(rubric, scores)`**: Pure calculation function that verifies criterion scores are non-negative, finite numbers within each criterion's `maxPoints`, computing `totalScore` and `maxScore`. Unscored criteria default to 0. Throws `InvalidRubricScoreError` on invalid or unknown criterion scores.
- **`saveRubric(contentId, criteria, title?, actor?)`**: Saves or updates a rubric. Requires `assessment.manageRubric` (admins and instructors). Throws `InvalidRubricError` if criteria are empty or have duplicate ids or negative `maxPoints`.
- **`getRubric(contentId, actor?)`**: Retrieves the rubric. Students can view published content; staff can view drafts (`content.view`).
- **`deleteRubric(contentId, actor?)`**: Removes the rubric (`assessment.manageRubric`).
- **`evaluateSubmission({ contentId, submissionId, scores, feedback?, criterionFeedback? }, actor?)`**: Evaluates a submission against the saved rubric. Requires `grading.record` (staff). Throws `RubricNotFoundError` if no rubric exists for the content.

## Peer Review

`PeerReviewService` manages peer review assignments and evaluations:

```ts
const peerReviews = new PeerReviewService({ repos, policy });
// Assign reviews (cyclic shift distribution among submitters):
await peerReviews.assignPeerReviews('assign-1', { reviewsPerStudent: 2 }, { actorId: teacher.id });

// Student submits a peer review:
await peerReviews.submitPeerReview({
  assignmentId: 'asg-1',
  comments: 'Detailed feedback',
  rubricScores: { 'crit-1': 8 },
}, { actorId: reviewer.id });
```

- **`assignPeerReviews(contentId, options?, actor?)`**: Evenly distributes peer reviews among students who submitted work, ensuring no student is assigned to review their own submission. Requires `assessment.assignPeerReviews` (admins and instructors). Throws `PeerReviewAssignmentError` if fewer than 2 students submitted work or `reviewsPerStudent` is out of bounds.
- **`getAssignedReviews(reviewerUserId, options?, actor?)`**: Retrieves peer review assignments for a student. Viewable by the reviewer themselves or staff (`content.view`).
- **`submitPeerReview({ assignmentId, comments?, rubricScores? }, actor?)`**: Submits a review and marks the assignment completed. Can optionally evaluate criterion scores against the content's rubric. Requires the caller to be the assigned reviewer (`assessment.submitPeerReview`). Throws `PeerReviewNotFoundError` if assignment does not exist, or `PeerReviewAssignmentError` if already submitted.
- **`listReviewsForSubmission(submissionId, options?, actor?)`**: Lists reviews for a submission. Accessible to staff (unmasked) and the submission's author (`content.view`). When `options.anonymous: true`, the reviewer identity is masked as `'anonymous'` for students.
- **`listEvaluations(submissionId, actor?)`**: Lists evaluations for a submission (`grading.view`). Staff can list all; the student who authored the submission can list their own.

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
  saveAnswer(attemptId: string, questionId: string, answer: QuizAnswer): Promise<QuizAttempt | null>;
  closeAttempt(attemptId: string, close: { submittedAt: Date; score: number; maxScore: number; late: boolean; pendingReview?: boolean }): Promise<QuizAttempt | null>;
  // optional, recommended if staff score questions by hand: set ONE hand score atomically
  saveManualScore?(attemptId: string, questionId: string, points: number): Promise<QuizAttempt | null>;
  updateAttempt(attemptId: string, patch: {
    submissionId?: string; gradeEntryId?: string;
    score?: number; maxScore?: number; pendingReview?: boolean; manualScores?: Record<string, number>;
  }): Promise<QuizAttempt>;
}
```

**Upgrading a `QuizRepository` written before question types.** Make three changes:

- An answer is now a `QuizAnswer`: a number, a list of numbers, a boolean or a string. Store
  `answers` as JSON, not as integers.
- `closeAttempt` can also be given `pendingReview`.
- `updateAttempt` can be given `score`, `maxScore`, `pendingReview` and `manualScores`. Merge them
  in the same way as the other fields.

`quizRepositoryContract` (see [TESTING.md](./TESTING.md)) checks all of this.

The five quiz-answering methods are required, so a host that implemented the old two-method
`QuizRepository` has to add them (a compile error tells you). What each must do:

- **`findOpenAttempt(quizId, userId)`**: the person's attempt of this quiz with no `submittedAt`,
  newest first if there are several, or `null`.
- **`saveAnswer(attemptId, questionId, answer)`**: set `answers[questionId]` and keep the
  attempt's other answers, **only if the attempt exists and is still open**, and return it; `null`
  otherwise. Do it as one step in the store (a JSON-path update), not read-modify-write, so two answers
  saved at once do not lose each other.
- **`closeAttempt(attemptId, close)`**: set `submittedAt`, `score`, `maxScore` and `late` **only if the
  attempt is still open**, as one atomic step (`UPDATE ... WHERE submittedAt IS NULL`), and return the
  updated attempt or `null`. This is what makes a double submit score once.
- **`updateAttempt`**: merge in the bookkeeping the service attaches: `submissionId` and
  `gradeEntryId`, and, when a question is scored by hand, the new `score`, `maxScore` and
  `pendingReview` (and `manualScores` when there is no `saveManualScore`).
- **`saveManualScore?(attemptId, questionId, points)`** (optional): set `manualScores[questionId]`,
  keeping the other hand scores, **only if the attempt has been submitted**, as one step in the
  store, and return the updated attempt or `null`. Without it, two graders scoring different
  questions of one attempt at the same moment can lose one of the scores.

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
new AssessmentService({
  repos: {
    submissions: SubmissionRepository;
    quizzes: QuizRepository;
    // with a policy also: users, courses, enrollments, content (and groups for group work)
  };
  policy?: PermissionPolicy;
  events?: EventBus;
  plagiarismHook?: PlagiarismCheckHook;
  extensions?: ExtensionSource;                          // see "Extra time"
  autoGrade?: { grading: QuizGradeSink; source?: string };   // see "Automatic grading"
})
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

Pass `options: { groupId: string }` to record work on behalf of a group (`groupId` stored on `Submission`). With enforcement, verifies the submitter is an active student member of the group. Attempt limits and counts are shared across the group.
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

### `generateAttempt(quizId, userId, randomize = true, actor?, { maxAttempts? }): Promise<QuizAttempt>`

Reads the quiz's questions, takes their ids, shuffles that order when `randomize` is
true (a Fisher-Yates shuffle, per attempt, not stored globally), and stores a new
`QuizAttempt` with `startedAt` now. The attempt holds the *order of question ids*.

**If the student already has an open attempt of this quiz, that attempt is returned instead of a
new one** (`randomize` only matters for a new attempt). Starting over is therefore not a way to
see the questions again; a new attempt can be started once the last one is submitted.

**`maxAttempts`** limits how many attempts the student may submit. Once they have submitted that
many (counted from their quiz submissions), starting another throws `AttemptLimitReachedError`
(message `No attempts remaining`, with `quizId` and `maxAttempts`). An open attempt is still
resumed. The limit is yours to pass on each call, like the time limit, and must be a whole number
from 1 up. With enforcement on, the content must be a `quiz`; anything else throws
`WrongContentKindError` (`expected`, `actual`).

## Taking a quiz

```ts
const attempt = await assessment.generateAttempt(quizId, studentId, true, actor);
const questions = await assessment.getAttemptQuestions(attempt.id, actor);   // no answer key
await assessment.saveAnswer(attempt.id, "q1", 2, actor);              // single choice: a choice index
await assessment.saveAnswer(attempt.id, "q2", [0, 3], actor);         // multiple choice: indexes
await assessment.saveAnswer(attempt.id, "q3", true, actor);           // true/false
await assessment.saveAnswer(attempt.id, "q4", "Paris", actor);        // short answer or essay: text
await assessment.saveAnswer(attempt.id, "q5", 9.81, actor);           // numeric
const result = await assessment.submitAttempt(attempt.id, actor, { timeLimitSeconds: 1800 });
// result: { score, maxScore, late, submissionId, gradeEntryId?, ... }
```

### `getAttemptQuestions(attemptId, actor?): Promise<QuizQuestionView[]>`

The attempt's questions in the attempt's own order, as `QuizQuestionView`: each with its `type`,
**and no answer key of any kind**, plus `answer` for what the student has saved, so a page can
pick up where it left off. A question removed from the quiz since the attempt began is left
out. **Show a quiz to a student with this, never with `QuizRepository.getQuestions`**, whose
questions carry the answer key. Only the attempt's own student may ask (`assessment.answerQuiz`).

### `saveAnswer(attemptId, questionId, answer, actor?, { timeLimitSeconds? }): Promise<QuizAttempt>`

Saves one answer, replacing an earlier answer to the same question; call it as the student works so
nothing is lost if they stop. The question must be in the attempt and the answer must be the kind its
type takes, or `InvalidAnswerError` with a `reason`:

| `reason` | When |
| --- | --- |
| `question-not-in-attempt` | the question is not part of this attempt |
| `wrong-answer-type` | not a number (single choice, numeric: a finite one), a non-empty list (multiple choice), a boolean (true/false) or text (short answer, essay) |
| `choice-out-of-range` | a choice index that is not one of the question's choices, or the same choice twice |
| `answer-too-long` | text longer than the question's `maxLength` (short answer: 1000 by default; essay: no limit by default) |

A multiple-choice answer is stored sorted. A submitted attempt throws `AttemptClosedError`; after the time limit
`AttemptExpiredError`. `timeLimitSeconds` is passed by you on each call (the SDK stores no quiz
settings) and counts from `startedAt`; it must be a finite number above zero.

### `submitAttempt(attemptId, actor?, { timeLimitSeconds?, revealAnswers? }): Promise<QuizResult>`

1. Scores the saved answers with `scoreQuiz` and closes the attempt atomically (`closeAttempt`). If a
   question waits to be scored by hand (an essay), the attempt is closed with `pendingReview: true`
   and its score counts that question as 0 for now.
2. Stores a `Submission` with payload `{ kind: 'quiz', attemptId }`, numbered with the student's other
   submissions of that quiz, so [grading](./GRADING.md) can attach to it. It does **not** emit
   `assessment.submissionReceived` and starts no plagiarism check.
3. Emits `assessment.quizSubmitted`.
4. With `autoGrade`, records the score as a grade (below), unless the attempt is pending review:
   then the grade waits for `gradeQuizQuestion`.

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

### `gradeQuizQuestion(attemptId, questionId, points, actor?): Promise<QuizResult>`

Scores one question of a **submitted** attempt by hand, replacing any earlier hand score for it.
An essay gets its points this way. It also **overrides the automatic result of any other type**,
for example to accept a spelling the key did not list. `points` must be from 0 to the question's
points; anything else throws `InvalidManualScoreError`, and so does an attempt that is not
submitted yet. A question that is not part of the attempt throws `InvalidAnswerError`.

The attempt's score is then worked out again with every hand score. When no question is left
pending and `autoGrade` is on, the score is recorded as a grade:

- If the attempt already had an automatic grade, the new one **supersedes** it, so the earlier
  grade stays as history and exactly one is current.
- An essay attempt is graded once its last essay is scored, never before.

It emits `assessment.quizQuestionGraded` and returns the result with its breakdown. With
enforcement on it needs `assessment.gradeQuiz` in the quiz's section, which by default means admins,
instructors and TAs. A student cannot score anything, not even their own attempt.

## Question types

A question with no `type` is a single-choice question, so quizzes stored before the other types
existed keep working, and their results keep `selectedChoiceIndex` and `correctChoiceIndex`.

| `type` | Extra fields | The answer | Right when |
| --- | --- | --- | --- |
| `single_choice` (default) | `choices`, `correctChoiceIndex` | a choice index | it is `correctChoiceIndex` |
| `multiple_choice` | `choices`, `correctChoiceIndexes`, `scoring?` | a list of choice indexes | `all_or_nothing` (default): exactly the right set, in any order. `partial`: each right pick earns `points / right choices`, each wrong pick takes that much away, down to 0 for the question |
| `true_false` | `correctAnswer: boolean` | a boolean | it equals `correctAnswer` |
| `short_answer` | `acceptedAnswers`, `caseSensitive?`, `maxLength?` | text | it matches an accepted answer, ignoring leading, trailing and repeated spaces, and ignoring case unless `caseSensitive` |
| `numeric` | `correctValue`, `tolerance?` | a number | it is within `tolerance` (default 0) of `correctValue` |
| `essay` | `maxLength?` | text | a person decides: it is `pending` until `gradeQuizQuestion` scores it |

**Negative marking.** A question's `penalty` is what a **wrong** answer costs. A blank answer is
never penalised, so leaving a question blank is the safe choice. A partial multiple-choice answer
is not penalised either (it earned something), and neither is an essay. However many penalties
there are, **the quiz total never goes below 0**.

### Scoring: `scoreQuiz(questions, answers, order?, manualScores?): QuizScore`

A pure function you can also call yourself, for example to preview a score. It works like this:

- Each question earns up to its `points` (default 1), according to its type (above). A wrong
  answer earns minus its `penalty`, and a blank earns 0.
- `manualScores` (question id to points) replace the automatic result for those questions.
- `score` is the total, never below 0. `pendingReview` counts the questions still waiting for a
  person.
- Only the questions in `order` (the attempt's own list) are scored, in that order, and a question
  removed from the quiz is skipped. So `maxScore` is what this attempt could have earned.
- Every scored question is checked with `validateQuizQuestion`, which throws
  `InvalidQuizQuestionError`. Call it yourself when a quiz is authored, so a broken question
  (a key outside its choices, no accepted answers, negative points, an unknown type) is refused
  before any student meets it.

`questionTypeOf(question)` gives a question's type, with the `single_choice` default filled in.

### Extra time: the `extensions` option

```ts
const assessment = new AssessmentService({
  repos,
  policy,
  extensions: accommodationExtensions,   // anything with findActive(userId, contentId): { extraSeconds } | null
});
```

With it, a student's active extension on the quiz (see `AccommodationService` in [GRADING.md](./GRADING.md); its
`extensions` repository fits as it is) is **added to the `timeLimitSeconds` you pass**, in `saveAnswer` and
`submitAttempt`: the limit that decides when answers are refused and when a submission is `late`. It looks up the
attempt's own student and quiz, and is not used at all when you pass no limit (the quiz is untimed). An amount that is
not a finite number above zero is ignored.

### Automatic grading: the `autoGrade` option

```ts
const grading = new GradingService({ repos: { grades }, systemGraders: ['system:quiz'] });
const assessment = new AssessmentService({
  repos,
  policy,
  autoGrade: { grading, source: 'system:quiz' },   // source is optional, default 'system:quiz'
});
```

On submission the score is recorded as a grade for the quiz's `Submission` through
`GradingService.recordSystemGrade` (see [GRADING.md](./GRADING.md)), once per attempt; the entry id is kept
as `gradeEntryId`. A quiz worth 0 points has no grade (grades need a maximum above zero). An attempt
pending review gets its grade when its last hand-scored question is scored. A later hand score
replaces the grade with a new one, passing the old entry as `previousEntryId`, so the old grade is
superseded rather than overwritten. Without
`autoGrade`, the grade is yours to post, from `assessment.quizSubmitted` or the result.

## The plagiarism hook (read this)

```ts
const assessment = new AssessmentService({ repos, plagiarismHook: async (submission) => {
  try {
    await checker.check(submission);
  } catch (error) {
    logger.error(error);          // never let it throw
  }
  return { flagged: false };
} });
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

Turn enforcement on with a `policy`:

```ts
const assessment = new AssessmentService({
  repos,        // submissions, quizzes, and users, courses, enrollments, content (optionally guardianLinks, delegations)
  policy: createRolePolicy(),
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
| `gradeQuizQuestion` | `assessment.gradeQuiz` | staff of the section: admins, instructors and TAs |
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
`late`, and `pendingReview: true` when a question waits for a person) once per quiz attempt, when its
submission is stored. A quiz attempt does not also emit `assessment.submissionReceived`.

`assessment.quizQuestionGraded` (`attemptId`, `quizId`, `questionId`, `userId`, `points`, `score`,
`maxScore`, `pendingReview`, `graderId?`) each time staff score a question by hand. When
`pendingReview` is false the attempt is fully scored, which makes it a good moment to tell the
student. See [EVENTS.md](./EVENTS.md).

## Known limitations

- **Without `createAttempt`, the attempt limit and the attempt numbers are not atomic.**
  `countAttempts` and `create` are separate calls, so two simultaneous submissions can both pass
  the limit and can share an attempt number. Provide `createAttempt` if the limit is strict (see
  below).
- **A failing plagiarism hook is swallowed without a trace** (see above), and its
  result is discarded. The SDK has no error channel for it yet.
- **Six question types, no more.** There are no matching, ordering, fill-in-several-blanks or file-upload
  questions. Short answers match text exactly (after spacing and case are normalized): there is no
  fuzzy matching, no regular expressions and no list of misspellings beyond `acceptedAnswers`. A
  person can accept one with `gradeQuizQuestion`.
- **The quiz attempt limit is not atomic.** `generateAttempt` counts submitted attempts and then
  creates one, so two simultaneous starts at the limit can both succeed.
- **Rescoring by hand is not atomic either.** Two graders scoring questions of the same attempt at the
  same moment each work the total out again and write it. The total written last wins, and it can
  miss the other grader's score until the next rescore. Each hand score itself is kept (with
  `saveManualScore`).
- **Rescoring uses the quiz as it is now.** If questions were edited after the attempt was submitted,
  a hand score works the total out from the edited questions.
- **Two simultaneous `generateAttempt` calls can each start an attempt**; the next call resumes the
  newest. A uniqueness rule on one open attempt per person and quiz in your store prevents it.
- **A half-finished submission is only finished by the student calling `submitAttempt` again.** If the
  server dies between closing an attempt and storing its submission, the attempt is scored but has no
  submission or grade until then, and a retry that lands in the same instant as the original can store
  two submissions.
- **A failing `autoGrade` is loud, not silent.** `submitAttempt` throws (the quiz is submitted; retry to
  grade it), which is the opposite of the plagiarism hook's swallowed errors.
- **The answer key is the host's to protect.** `QuizRepository.getQuestions` and `getResult`'s
  breakdown carry the key (`correctAnswer`, `acceptedAnswers`, ...); only `getAttemptQuestions` is safe
  to show a student.
- **The time limit is yours to pass on every call**, and uses the server's clock from `startedAt`.
- **Dates are enforced, prerequisites are not.** With enforcement on, a student cannot submit, start a
  quiz or save a quiz answer before the content's `availableFrom` or after its `availableUntil`
  (`ContentNotAvailableError`); a started attempt can still be submitted after closing. A submission
  after `dueAt` is accepted and not flagged. Prerequisites are not checked: use
  `ContentService.checkAccess` ([CONTENT.md](./CONTENT.md)) before showing the work.
- **The content kind is checked only for quiz attempts, and only with enforcement on.**
  `generateAttempt` refuses content that is not a `quiz`. Nothing stops `submit` being called on a
  page, and without enforcement the service cannot see the content at all.
- **The shuffle cannot be seeded**, so an attempt's order is not reproducible. It uses the Web Crypto
  API (`globalThis.crypto`), which Node 20+, Bun, Deno, browsers and edge runtimes provide.
- `grading.view` covers a guardian's view of grades; there is no guardian access to
  attempts.

## Tests

| File | Covers |
| --- | --- |
| `test/atomic-repositories.test.ts` | attempt-limit and attempt-number races with and without `createAttempt`, including a staff-recorded offline submission racing a student's own |
| `test/assessment-permissions.test.ts` | all four methods with enforcement on, including `recordOffline` (who may, delegation, active-student target, numbering, no hook or event): own-only rules, staff, enrollment states, drafts, unknown content, guardians, the tenant wall, check ordering, no lookups before the actor is known, and behaviour with enforcement off |
| `test/assessment-events.test.ts` | `assessment.submissionReceived`, attempt numbers, no event when `maxAttempts` rejects, a throwing listener, working with no bus |
| `test/assessment-plagiarism.test.ts` | the hook receives the stored submission, is not awaited, and a rejecting or synchronously throwing hook neither fails the submission, leaks an unhandled rejection, nor stops the event |
| `test/assessment-rubrics.test.ts` | `scoreRubric` validation and calculation, `RubricService` CRUD, draft gating, staff evaluations, and owner visibility |
| `test/assessment-peer-review.test.ts` | `PeerReviewService` distribution fairness, no self-assignments, rubric tie-in, anonymous masking, and permission gating |
| `test/assessment-groups.test.ts` | Group submissions: member validation, group attempt consumption, and attempt limits |
| `test/assessment-question-types.test.ts` | every question type in `scoreQuiz` (multiple choice all-or-nothing and partial, true/false, short-answer normalization and case, numeric tolerance, essays pending and graded, hand scores overriding), negative marking (wrong answers only, the 0 floor), `validateQuizQuestion`; and through `createInMemoryLms`: the key-free view of each type, answer validation per type, the whole essay review (pending, no grade, who may score, the grade recorded once), a rescore superseding the earlier grade, `maxAttempts`, and the content-kind check |
| `test/assessment-quiz.test.ts` | extra quiz time from extensions; `scoreQuiz`; resuming an open attempt; the answer-key-free view; saving answers (validation, closed, expired, races); submitting (scoring, the quiz submission and its numbering, idempotence, double submit, late flag, half-done recovery); `autoGrade`; `getResult` and who sees the breakdown; the two new student-only actions |
| `test/core-permissions.test.ts` | the three assessment rules ("assessment rules") |
