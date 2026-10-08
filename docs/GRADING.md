# Grading

`src/domains/grading/` — recording grades without ever losing one, and turning a
student's recorded grades into a final percentage and a letter. Subpath:
`discendo-sdk/grading`.

The module has two halves that are deliberately separate:

- **`GradingService`** records grades and computes a student's final grade. It owns
  persistence (through a repository), permissions and events.
- **Pure functions** (`calculations.ts`) do the arithmetic: late penalties, weighted
  categories with dropped lowest scores, letter grades. They touch no repository and
  have no side effects, so they are trivial to test and to reuse (for example to preview
  a grade before committing it).

## At a glance

| | |
| --- | --- |
| **You import** | `GradingService`, `computeFinalGrade`, `applyLatePolicy`, `toLetterGrade`, and the types in `types.ts` |
| **You implement** | `GradeRepository`; to enforce permissions also a `SubmissionLocator` and the `core` repositories `users`, `courses`, `enrollments` |
| **Emits events** | `grading.gradePosted` |
| **Permission actions** | `grading.record`, `grading.view` |
| **Enforcement** | opt-in: the third constructor argument, `{ policy, repos, submissions }` |

## Types (`types.ts`)

```ts
interface GradeEntry {
  id: string;
  submissionId: string;
  userId: string;
  score: number;
  maxScore: number;
  graderId: string;
  gradedAt: Date;
  supersededBy?: string;     // set when a later entry replaces this one
}

interface GradeCategory {
  name: string;
  weight: number;            // 0 to 1; categories should sum to 1
  dropLowestN?: number;      // drop this many of the lowest scores
}
interface GradingScheme { categories: GradeCategory[] }

type LatePolicy =
  | { kind: 'none' }
  | { kind: 'flatPenalty'; percentPerDay: number; maxPenaltyPercent?: number }
  | { kind: 'cutoff'; afterDays: number };     // zero credit after N days

interface GradeScaleBand { minPercent: number; label: string }   // 'A', 'Pass', ...
type GradeScale = GradeScaleBand[];
```

## The audit trail: grades are never overwritten

A regrade does not change the old entry. `recordGrade` creates a **new** entry and
marks the old one `supersededBy` the new id. Both stay in the repository forever, so
the full history of who graded what, and when, is there for free. Only **current**
entries (those not superseded) count towards a final grade.

```
entry-1  (80/100, graded by ta-1)   supersededBy: entry-2
entry-2  (90/100, graded by teacher-1)             ← current
```

## `GradingService`

```ts
new GradingService(
  grades: GradeRepository,
  events?: EventBus,
  enforcement?: { policy: PermissionPolicy; repos: AuthorizationRepos; submissions: SubmissionLocator },
  options?: { allowExtraCredit?: boolean },
)
```

`allowExtraCredit` (off by default) lets a score exceed the maximum; see `recordGrade` below.

Every method takes a trailing `actor?: { actorId }`, required when `enforcement` is set.

### `recordGrade(submissionId, userId, score, maxScore, graderId, previousEntryId?, actor?)`

Records a grade and returns the new `GradeEntry`.

```ts
await grading.recordGrade('sub-1', 'stu-1', 85, 100, teacher.id, undefined, { actorId: teacher.id });

// A regrade: pass the current entry's id as previousEntryId.
await grading.recordGrade('sub-1', 'stu-1', 90, 100, teacher.id, entry.id, { actorId: teacher.id });
```

1. **(Enforcement on)** the permission checks below.
2. **The numbers must make a grade**, checked **after** the permission check (so a stranger is
   told "not permitted", not what is wrong with the numbers). Otherwise it throws
   `InvalidGradeError`, and nothing is stored, superseded or announced:
   - `maxScore` must be a finite number **above zero**;
   - `score` must be a finite number that is **not negative** (zero is a real score);
   - `score` must **not be above `maxScore`**, unless the service was built with
     `{ allowExtraCredit: true }`. This is off by default so that a typo such as 850 for 85 is
     refused instead of silently inflating a grade. With it on, 120 out of 100 is accepted and
     counts as 120%, so a final grade can then exceed 100. A negative or non-finite number, and a
     maximum of zero or less, are refused either way.
3. **`previousEntryId`, if given, must be the current entry for *this* submission.**
   Otherwise the call throws, and nothing is written:
   - `Previous grade entry <id> not found`
   - `Previous grade entry belongs to a different submission`
   - `Previous grade entry has already been superseded`

   These integrity checks apply with or without enforcement, because superseding the
   wrong entry would silently erase another grade from the gradebook.
4. Creates the entry (`gradedAt` is now), then marks the previous one superseded.
4. Emits `grading.gradePosted`.

### `computeFinalGradeForUser(userId, sectionId, scheme, actor?): Promise<number>`

The weighted final percentage (0 to 100) of the student's current grades in a section.

### `computeLetterGradeForUser(userId, sectionId, scheme, scale, actor?): Promise<string>`

The same percentage turned into a label with `toLetterGrade`.

Both ask `GradeRepository.listForUserInSection`, ignore superseded entries, group the
rest by **category** (which your repository supplies on each entry), and run
`computeFinalGrade`.

## `GradeRepository`

```ts
interface GradeRepository {
  create(entry: Omit<GradeEntry, 'id'>): Promise<GradeEntry>;
  findById(id: string): Promise<GradeEntry | null>;
  markSuperseded(id: string, byId: string): Promise<void>;
  // optional, recommended: supersede ONLY IF still current, as one atomic compare-and-set
  supersedeIfCurrent?(id: string, byId: string): Promise<boolean>;
  listForUserInSection(userId: string, sectionId: string):
    Promise<Array<GradeEntry & { category: string }>>;
}
```

**`supersedeIfCurrent?(id, byId): Promise<boolean>`** is optional and recommended. Implement it as
one atomic compare-and-set (`UPDATE ... SET superseded_by = ? WHERE id = ? AND superseded_by IS
NULL`, returning whether a row changed). When it is provided, `recordGrade` uses it instead of
`markSuperseded`, so **only one of two simultaneous regrades of an entry can win**. The loser's
entry is kept, marked as superseded by the winner's (so exactly one entry stays current and nothing
is deleted), nothing is announced for it, and the caller gets a **`GradeConflictError`** with
`winnerId` (the entry that won), `entryId` (the loser's own entry) and `previousEntryId`. To change
the grade anyway, regrade again with `winnerId` as the `previousEntryId`.

`findById` is required (it backs the `previousEntryId` check). Categories are not
invented by the SDK: **your repository decides which category each entry belongs to**
(typically from the assignment's settings) and returns it as `category`, matching the
names in your `GradingScheme`.

## Permissions

| Method | Action | Who, by default |
| --- | --- | --- |
| `recordGrade` | `grading.record` | admin, instructor, TA, in that submission's section |
| `computeFinalGradeForUser`, `computeLetterGradeForUser` | `grading.view` | staff for anyone; a student for themselves; a guardian whose link has the `grades` scope |

### The submission locator

Grading may not depend on the assessment module (a module may import only `core`),
so it does not know where a submission lives. When enforcement is on, **you** supply
that:

```ts
interface SubmissionLocator {
  locate(submissionId: string): Promise<{ sectionId: string; userId: string } | null>;
}
```

Typically it follows submission → content node → section. **The section must come from
here, never from the caller**, or a grader could claim a section they are allowed in
while grading another. Return `null` for an unknown submission.

### What `recordGrade` enforces

Beyond holding `grading.record` in the submission's section:

- **`graderId` must be the actor.** Nobody records a grade under someone else's name.
- **Nobody grades their own submission**, whatever their role.
- **`userId` must be whoever submitted the work**, or the call throws
  `Submission <id> was not submitted by user <userId>`.
- The order matters: the actor is authorized *before* anything is compared with the
  caller's arguments, so an unauthorized caller learns nothing, not even who submitted
  what, from a mismatch. An unknown submission is refused exactly like a forbidden one.

Viewing is checked against the section and the student, so a student sees only their
own final grade. See [PERMISSIONS.md](./PERMISSIONS.md) and
[GUARDIANS.md](./GUARDIANS.md).

## The pure functions (`calculations.ts`)

### `computeFinalGrade(entriesByCategory, scheme): number`

A weighted average, 0 to 100.

1. For each category in the scheme, take that category's entries, turn each into a
   fraction (`score / maxScore`), and sort ascending.
2. Drop the lowest `dropLowestN` of them.
3. Average what is left and multiply by the category's `weight`.
4. A category with **no entries**, or **nothing left after dropping**, is skipped.
5. The total is divided by the weight actually used, so a course that is only partly
   graded is not dragged towards zero by categories with no grades yet.

```ts
const scheme = { categories: [
  { name: 'homework', weight: 0.4, dropLowestN: 1 },
  { name: 'exam', weight: 0.6 },
] };

// homework 50/100 and 100/100 (lowest dropped -> 100%), exam 80/100:
// (1.0 * 0.4 + 0.8 * 0.6) / (0.4 + 0.6) * 100 = 88
```

Details worth knowing: with nothing graded at all the result is `0`; a category in the
entries but **not in the scheme is ignored**; the weights are not required to sum to 1
(the division by the weight used means only their proportions matter); and scores above
the maximum are **not clamped** (120/100 counts as 120%).

**An entry that cannot be a grade is ignored**, as if it were not there: a maximum of zero or
less, a negative score, or a number that is not finite. One bad row therefore cannot turn a whole
grade into `Infinity` or `NaN`, and a category with only such entries counts as having no grades
yet. `recordGrade` refuses to store these, so this only matters for rows written some other way.
It is silent, so validate imported data.

### `applyLatePolicy(score, maxScore, daysLate, policy): number`

Returns the score after a late penalty.

| Policy | Result |
| --- | --- |
| `daysLate <= 0` | the score unchanged, whatever the policy |
| `{ kind: 'none' }` | the score unchanged |
| `{ kind: 'flatPenalty', percentPerDay, maxPenaltyPercent? }` | `score - maxScore * (percentPerDay * daysLate, capped at maxPenaltyPercent or 100) / 100`, never below 0 |
| `{ kind: 'cutoff', afterDays }` | `0` if `daysLate > afterDays`, otherwise unchanged |

The penalty is a percentage **of the maximum score**, not of the score earned: 3 days
late at 10% a day takes 30 points off an 80/100, giving 50.

`GradingService` does **not** call this. Apply it yourself, before recording, with the
number of days late you computed from your due dates.

### `toLetterGrade(percent, scale): string`

Finds the band with the highest `minPercent` that the percentage reaches. `'N/A'` if
none does (for example a negative percentage, or a scale with no 0 band).

## Events

`grading.gradePosted` (`gradeEntryId`, `submissionId`, `userId`, `score`, `maxScore`,
`graderId`), once per `recordGrade`, including a regrade. It identifies the work by
`submissionId`, not `contentId`; see [EVENTS.md](./EVENTS.md) and the notification
bridge in [COMMUNICATION.md](./COMMUNICATION.md).

## Known limitations

- **Bad rows already in your gradebook are skipped, not reported.** The calculation ignores an
  entry with an impossible maximum or score instead of failing, so a corrupt row quietly stops
  counting.
- **`applyLatePolicy` does not validate its inputs.** A non-finite score or maximum gives a
  non-finite result.
- **Without `supersedeIfCurrent`, regrading is not atomic.** The check of `previousEntryId`,
  the create and the `markSuperseded` are separate calls, so two simultaneous regrades of one
  entry can both succeed and leave two current entries (both would count towards the final grade).
  Provide `supersedeIfCurrent` if that can happen.
- **Two simultaneous *first* grades of one submission are not guarded** even with it: neither
  supersedes anything. A unique constraint on the current grade per submission in your database
  prevents that.
- **No grade release.** A grade is visible to the student, through `grading.view`, as
  soon as it is recorded. There is no "hold until released" state.
- **A completed student can still read their own grades** (final and letter grade), and so
  can their guardians, but nothing else, and never anyone else's. Dropped and waitlisted
  students cannot. See [PERMISSIONS.md](./PERMISSIONS.md).
- **Not built yet:** grading extensions, curve, GPA, and excused-assignment handling.
- **Late penalties are manual** (see above).

## Tests

| File | Covers |
| --- | --- |
| `test/grading.test.ts` | the pure calculations: weighting, dropping the lowest, renormalizing, letter bands, late penalties |
| `test/atomic-repositories.test.ts` | regrading races with and without `supersedeIfCurrent` (one winner, the loser kept as history and told who won, only the winner announced and counted), alongside the capacity and attempt-limit races |
| `test/grading-validation.test.ts` | the number checks in `recordGrade` (each bad case, the boundaries, extra credit on and off, a refused regrade leaving the current grade alone, the permission check coming first) and `computeFinalGrade` skipping entries that cannot be a grade |
| `test/grading-permissions.test.ts` | enforcement (who may record and view, grader identity, own-work rule, the locator, guardians, completed students and their guardians, the tenant wall, check ordering) and the supersede integrity checks on `previousEntryId` |
| `test/grading-events.test.ts` | `grading.gradePosted`, including once per regrade |
