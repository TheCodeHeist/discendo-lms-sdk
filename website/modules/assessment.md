---
description: Learn how discendo-sdk/assessment handles submissions, randomized quizzes, scoring rubrics, peer reviews, and plagiarism checks.
---

# Assessment

`discendo-sdk/assessment` manages student work: collecting file/text submissions, enforcing attempt limits, shuffling and scoring quizzes, managing multi-criteria rubrics, orchestrating peer reviews, and invoking plagiarism scan hooks.

Assessment records _that_ work was turned in and scores objective quizzes. Subjective grading is handled by [Grading](/modules/grading).

---

## At a Glance

|                  |                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import**       | `import { AssessmentService, RubricService, PeerReviewService, scoreQuiz, scoreRubric } from 'discendo-sdk/assessment'`                                                            |
| **Repositories** | `SubmissionRepository`, `QuizRepository`, `RubricRepository`, `PeerReviewRepository`                                                                                               |
| **Seams**        | `PlagiarismCheckHook`, `QuizGradeSink` (`autoGrade`), `ExtensionSource`                                                                                                            |
| **Events**       | `assessment.submissionReceived`, `assessment.quizSubmitted`                                                                                                                        |
| **Permissions**  | `assessment.submit`, `assessment.startAttempt`, `assessment.answerQuiz`, `assessment.submitQuiz`, `assessment.viewAttempts`, `assessment.recordOffline`, `assessment.manageRubric` |
| **Enforcement**  | Opt-in via constructor options `{ policy, repos }`                                                                                                                                 |

---

## Data Models

### Submissions

```ts
type SubmissionPayload =
  | { kind: "text"; content: string }
  | { kind: "file"; ref: string } // Storage key in S3 / local disk
  | { kind: "url"; href: string }
  | { kind: "none" } // In-class presentation or offline work
  | { kind: "quiz"; attemptId: string };

interface Submission {
  id: string;
  contentId: string; // Target assignment ContentNode
  userId: string;
  payload: SubmissionPayload;
  submittedAt: Date;
  attemptNumber: number; // 1 for first attempt
  recordedBy?: string; // Set if staff recorded offline work
}
```

### Quizzes & Attempts

```ts
interface QuizQuestion {
  id: string;
  prompt: string;
  choices: string[];
  correctChoiceIndex: number;
  points?: number; // Default: 1
}

interface QuizAttempt {
  id: string;
  quizId: string;
  userId: string;
  questionOrder: string[]; // Randomized question order unique to this attempt
  startedAt: Date;
  submittedAt?: Date; // Unset while attempt is open
  answers?: Record<string, number>; // questionId -> selectedChoiceIndex
  score?: number;
  maxScore?: number;
}
```

---

## `AssessmentService`

```ts
new AssessmentService(
  submissions: SubmissionRepository,
  quizzes: QuizRepository,
  plagiarismHook?: PlagiarismCheckHook,
  events?: EventBus,
  options?: {
    policy?: PermissionPolicy
    repos?: RepositoryContext
    autoGrade?: QuizGradeSink       // Auto-posts quiz score to GradingService
    extensions?: ExtensionSource    // Extra time accommodations
  }
)
```

### Assignment Submissions

```ts
// Student submits assignment
const sub = await assessment.submit(
  {
    contentId: "assign-1",
    userId: "u-alice",
    payload: { kind: "file", ref: "uploads/alice-essay.pdf" },
  },
  { maxAttempts: 2 },
  { actorId: "u-alice" },
);
```

- **Attempt Limits:** Checks existing submission count; throws if `attemptNumber > maxAttempts`.
- **Plagiarism Hook:** If a `plagiarismHook` is provided, it is invoked asynchronously in the background. Failures in the hook do not block the submission.
- Emits `assessment.submissionReceived`.

### Randomized Quizzes

```ts
// 1. Student starts quiz attempt (questions shuffled)
const attempt = await assessment.startQuizAttempt("quiz-1", "u-alice", {
  actorId: "u-alice",
});

// 2. Student saves answers progressively
await assessment.saveQuizAnswer(
  attempt.id,
  "q-1",
  2, // Selected choice index
  { actorId: "u-alice" },
);

// 3. Student submits completed attempt
const result = await assessment.submitQuiz(attempt.id, { actorId: "u-alice" });

console.log(`Score: ${result.score} / ${result.maxScore}`);
```

- **Auto-Grading:** If configured with `autoGrade: gradingService`, the quiz score is immediately recorded into the student's gradebook under `graderId: 'system:quiz'`.
- **Time Limits:** If the quiz specifies `timeLimitSeconds`, late submissions throw `AttemptExpiredError` unless the student holds an accommodation from `ExtensionSource`.

---

## Rubrics & Multi-Criteria Scoring

`RubricService` manages grading criteria:

```ts
const rubricService = new RubricService(rubricRepo, { policy });

// Define rubric
await rubricService.saveRubric(
  "assign-1",
  [
    { id: "crit-thesis", description: "Thesis Clarity", maxPoints: 10 },
    { id: "crit-analysis", description: "Critical Analysis", maxPoints: 20 },
    { id: "crit-format", description: "Citation Formatting", maxPoints: 10 },
  ],
  "Research Paper Rubric",
  { actorId: "u-instructor" },
);

// Score a submission against the rubric
const evaluation = await rubricService.evaluateSubmission(
  {
    contentId: "assign-1",
    submissionId: sub.id,
    scores: {
      "crit-thesis": 9,
      "crit-analysis": 18,
      "crit-format": 10,
    },
    feedback: "Excellent draft",
  },
  { actorId: "u-instructor" },
);

console.log(`Total Score: ${evaluation.totalScore} / ${evaluation.maxScore}`); // 37 / 40
```

`scoreRubric(rubric, scores)` is a pure validation and calculation function that verifies all criteria fall within bounds.

---

## Peer Review

`PeerReviewService` orchestrates student evaluations of classmate submissions:

```ts
const peerReviews = new PeerReviewService(peerReviewRepo, { policy });

// Assign 2 peer reviews per student using cyclic distribution
await peerReviews.assignPeerReviews(
  "assign-1",
  {
    reviewsPerStudent: 2,
  },
  { actorId: "u-instructor" },
);

// Student submits review of peer's work
await peerReviews.submitPeerReview(
  {
    reviewId: "rev-101",
    scores: { "crit-thesis": 8 },
    comments:
      "Clear thesis statement, needs more empirical evidence in section 2.",
  },
  { actorId: "u-alice" },
);
```

---

## Errors

| Error                 | Cause                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `AttemptClosedError`  | Attempted to modify or submit an attempt that has already been submitted. |
| `AttemptExpiredError` | Quiz submission received after the allocated time limit expired.          |
| `InvalidAnswerError`  | Choice index is out of bounds for the question.                           |
| `InvalidRubricError`  | Rubric criteria contain duplicate IDs or negative point values.           |
| `RubricNotFoundError` | Evaluated submission has no associated rubric.                            |

---

## Known Limitations

- **Objective quiz questions only:** Built-in quiz scoring supports single-choice questions with one correct answer. Free-response and essay questions must be scored manually via `GradingService`.
- **Local attempt state:** Progressive quiz answers are stored in `QuizRepository`; ensure your implementation persists answer updates efficiently.
