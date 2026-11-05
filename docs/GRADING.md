# Grading

`src/domains/grading/` — recording grades without ever losing one, and turning a
student's recorded grades into a final percentage and a letter. Subpath:
`discendo-sdk/grading`.

The module has four parts:

- **`GradingService`** records grades and computes a student's final grade. It owns
  persistence (through a repository), permissions and events.
- **Pure functions** (`calculations.ts`) do the arithmetic: late penalties, weighted
  categories with dropped lowest scores, letter grades. They touch no repository and
  have no side effects, so they are trivial to test and to reuse (for example to preview
  a grade before committing it).
- **`AccommodationService`** records per-student exceptions: **extra time** (extensions) and
  **excusals** from a piece of work. It has its own repositories, permissions and events.
- **Curves and GPA**: pure functions (`applyCurve`, `curveEntries`, `computeGpa`) with no repositories,
  permissions or events.

## At a glance

| | |
| --- | --- |
| **You import** | `GradingService`, `AccommodationService`, `SystemGraderNotAllowedError`, `computeFinalGrade`, `explainFinalGrade`, `applyLatePolicy`, `effectiveDueAt`, `daysLate`, `toLetterGrade`, `applyCurve`, `curveEntries`, `computeGpa`, `toGpaPoints`, `STANDARD_GPA_SCALE`, and the types in `types.ts` |
| **You implement** | `GradeRepository`; to hold grades until released, a `GradeReleaseRepository`; to enforce permissions also a `SubmissionLocator` and the `core` repositories `users`, `courses`, `enrollments` |
| **Emits events** | `grading.gradePosted`, `grading.gradesReleased`, `grading.gradesHidden`, `grading.extensionGranted`, `grading.extensionRevoked`, `grading.excused`, `grading.unexcused` |
| **Permission actions** | `grading.record`, `grading.view`, `grading.release`, `grading.grantExtension`, `grading.excuse` (and `recordSystemGrade`, which takes no actor: see below) |
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
  options?: { allowExtraCredit?: boolean; systemGraders?: string[] },
)
```

`allowExtraCredit` (off by default) lets a score exceed the maximum; see `recordGrade` below.
`systemGraders` (empty by default) names the `system:` graders that may use `recordSystemGrade`.

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

### `recordGroupGrade(submissionId, memberUserIds, score, maxScore, graderId, options?, actor?): Promise<GradeEntry[]>`

Records a shared grade for every member of a group submission. Creates a distinct `GradeEntry` for each student in `memberUserIds` with the same score and max score, maintaining the full audit trail and event emission per member. Supports regrading via `options.previousEntryIds: Record<userId, previousEntryId>`. Requires `'grading.record'`.

   Otherwise the call throws, and nothing is written:
   - `Previous grade entry <id> not found`
   - `Previous grade entry belongs to a different submission`
   - `Previous grade entry has already been superseded`

   These integrity checks apply with or without enforcement, because superseding the
   wrong entry would silently erase another grade from the gradebook.
4. Creates the entry (`gradedAt` is now), then marks the previous one superseded.
4. Emits `grading.gradePosted`.

### `recordSystemGrade(submissionId, userId, score, maxScore, source, previousEntryId?): Promise<GradeEntry>`

Records a grade made by the system instead of a person, such as the automatic score of a quiz
(see `autoGrade` in [ASSESSMENT.md](./ASSESSMENT.md)). **It takes no actor and checks no permission**, so
it is for SDK code and your own server code only: never expose it to a client. Two guards keep that
from being a back door:

- `source` (the `graderId` of the entry) must start with `system:` **and** be listed in the
  service's `systemGraders`, or it throws `SystemGraderNotAllowedError` and stores nothing. With no
  `systemGraders`, nothing can use it, so a host that never turns on `autoGrade` is not exposed.
  A `system:` name can never be mistaken for a person's id.
- With enforcement on, the submission must exist and belong to `userId` (the `SubmissionLocator` is
  used), or it throws and stores nothing.

The score is validated like any grade (`InvalidGradeError`, `allowExtraCredit`). It is always a new
entry, and `grading.gradePosted` is emitted with the source as `graderId`. With `previousEntryId`
it is a regrade, exactly as in `recordGrade`: the previous entry must be the current entry of the
same submission, and it is superseded, never overwritten (with `supersedeIfCurrent`, a race gives
`GradeConflictError`). A quiz uses this when a question is scored by hand after the quiz was already
graded.

### `computeFinalGradeForUser(userId, sectionId, scheme, actor?, { releasedOnly? }): Promise<number>`

The weighted final percentage (0 to 100) of the student's current grades in a section.

### `computeLetterGradeForUser(userId, sectionId, scheme, scale, actor?, { releasedOnly? }): Promise<string>`

The same percentage turned into a label with `toLetterGrade`.

### `listGradesForUser(userId, sectionId, actor?, { releasedOnly? }): Promise<GradeView[]>`

The student's **current** grades in the section, oldest first: a "my grades" page. Superseded entries
are history and are not listed. Each `GradeView` has `entryId`, `submissionId`, `contentId?`,
`category`, `score`, `maxScore`, `percent`, `graderId`, `gradedAt`, and two flags:

- `released`: whether the student can see it. It is always true when grades are not held.
- `excused`: the work is listed but left out of the final grade.

### `explainGradeForUser(userId, sectionId, scheme, actor?, { releasedOnly? }): Promise<GradeExplanation>`

The final grade **with its working shown**, for a grade page that explains itself or for checking a
gradebook. Besides `percent` (the same number `computeFinalGradeForUser` gives) and `grades` (as
`listGradesForUser`) it has:

- `categories`: one per category of the scheme, with its `weight`, the `effectiveWeight` it really
  carried after renormalizing, its `percent` (null when nothing in it counts yet), and the entries
  it `counted` and `dropped`.
- `skipped`: entries that **could not be counted**, with the reason (`invalid-max-score` or
  `invalid-score`). `recordGrade` never stores these; they come from data written another way.
- `uncategorized`: entries whose category is not in the scheme, so they count for nothing.

All four ask `GradeRepository.listForUserInSection`, ignore superseded entries, group the
rest by **category** (which your repository supplies on each entry), and run
`explainFinalGrade`. They need `grading.view`: staff for anyone in the section, a student for
themselves, a guardian with the `grades` scope for their ward. They all show the same grades: see
"Holding grades until they are released" below for what a student and a guardian see while grades
are held.

**Excused work.** With the `excusals` option (an `ExcusalRepository`, such as the one behind
`AccommodationService`), an entry whose content is excused for that student is **left out**, as if it did
not exist, not counted as zero. This happens before the drop-lowest rule, so what is dropped is
chosen among the work that still counts. A revoked excusal counts for nothing. It needs to know which
content each entry belongs to, so **`listForUserInSection` must return a `contentId` on each entry**; if the
student has an excusal and an entry has none, the calculation throws instead of guessing. Without the
option, or for a student with no excusals, nothing changes and `contentId` is not needed.

## Holding grades until they are released

By default a grade is visible to the student the moment it is recorded. To hold grades back until the
whole class is marked, give `GradingService` a `GradeReleaseRepository` as the `releases` option:

```ts
const grading = new GradingService(grades, bus, enforcement, { releases: gradeReleaseRepository });

await grading.recordGrade(sub.id, 'sam', 18, 20, 'ms-lee', undefined, as('ms-lee'));  // held
await grading.releaseGrades('bio-a', essayId, as('ms-lee'));   // now Sam sees it, and every later grade for it
await grading.hideGrades('bio-a', essayId, as('ms-lee'));      // hidden again
```

- **Grades are released per piece of content and per section.** Releasing an essay shows every grade
  for it in that section, including grades recorded later. Other work stays held.
- **Staff always see everything.** A student, and a guardian with the `grades` scope, see only
  released work, in every view: `listGradesForUser`, `computeFinalGradeForUser`,
  `computeLetterGradeForUser` and `explainGradeForUser`. A held grade is not listed at all, and does
  not count towards their final grade. Without enforcement there is no viewer, so the views include
  held grades unless you pass `{ releasedOnly: true }`. Do that when you show a student their grades.
- **`listForUserInSection` must return a `contentId`** on each entry. An entry without one is
  never shown to a student while grades are held (it fails closed).
- **Who may release:** `grading.release` in the section, which by default means admins and
  instructors; it can be delegated to a TA.
- **Nothing is deleted.** Hiding sets `hiddenAt` and `hiddenBy` on the release, and releasing again
  creates a new one, so you can tell who showed and hid what, and when. Releasing something already
  released returns the existing release and emits nothing.
- **Notifications follow the release.** While grades are held, `grading.gradePosted` carries
  `released: false`, and the notification bridge does not tell the student. `releaseGrades` emits
  `grading.gradesReleased`, which the bridge turns into a `gradesReleased` notification for the
  section (see [COMMUNICATION.md](./COMMUNICATION.md)).

| Method | Does |
| --- | --- |
| `releaseGrades(sectionId, contentId, actor?)` | shows the content's grades to the section; emits `grading.gradesReleased` |
| `hideGrades(sectionId, contentId, actor?)` | hides them again; returns the hidden release, or null if they were not released; emits `grading.gradesHidden` |
| `listReleases(sectionId, actor?)` | the content whose grades are released in the section. Any member may ask (`content.view`): which work is released is no secret, though the grades are |

```ts
interface GradeRelease {
  id: string; sectionId: string; contentId: string;
  releasedAt: Date; releasedBy: string;
  hiddenAt?: Date; hiddenBy?: string;   // set when hidden again; the record is kept
}

interface GradeReleaseRepository {
  create(release: Omit<GradeRelease, 'id'>): Promise<GradeRelease>;
  findActive(sectionId: string, contentId: string): Promise<GradeRelease | null>;  // not hidden
  listActive(sectionId: string): Promise<GradeRelease[]>;                          // not hidden
  hide(id: string, at: Date, by: string): Promise<GradeRelease>;
}
```

`gradeReleaseRepositoryContract` and `InMemoryGradeReleaseRepository` are in `discendo-sdk/testing`
(see [TESTING.md](./TESTING.md)).

## `AccommodationService`

Per-student exceptions to the normal rules of a piece of work. Staff, and TAs they delegate to, grant and
end them, each under their own name; a student sees their own, and so does a guardian with the `grades`
scope. **Nothing is deleted**: ending one sets `revokedAt` and `revokedBy`, and changing an extension keeps the
old one as history.

```ts
new AccommodationService(
  repos,        // the authorization repositories, `content`, plus `extensions` and `excusals` (below)
  bus?,
  { policy },   // required: every method needs an { actorId }, because each record says who made it
)
```

```ts
interface TimeExtension {
  id; userId; contentId; sectionId;
  extraSeconds: number;       // extra time, in seconds
  reason?; grantedBy; grantedAt; revokedAt?; revokedBy?;
}
interface Excusal {
  id; userId; contentId; sectionId;
  reason?; excusedBy; excusedAt; revokedAt?; revokedBy?;
}
```

### Extensions

An extension is only an **amount of extra time**: the SDK stores no due dates (they are yours), so it cannot
move one. It is used in two places: for assignments, the pure helpers `effectiveDueAt` and `daysLate` below; for
quizzes, the `extensions` option of `AssessmentService`, which adds it to the time limit you pass (see
[ASSESSMENT.md](./ASSESSMENT.md)).

- **`grantExtension(contentId, userId, extraSeconds, actor, { reason? })`** gives the student more time.
  `extraSeconds` must be a finite number above zero. Granting the same amount again changes nothing and emits
  nothing; a different amount **replaces** the old extension, which stays as a revoked record
  (`replacedExtensionId` on the event). Emits `grading.extensionGranted`.
- **`revokeExtension(contentId, userId, actor)`** ends it and returns the record, or `null` if there was none.
- **`getExtension(contentId, userId, actor)`** the current extension or `null`: the student's own, their
  guardian's (`grades` scope), or anyone's for staff.
- **`listExtensions(contentId, actor, { includeRevoked? })`** everyone's, staff only.

### Excusals

An excused item is **left out of the student's final grade** (see `excusals` above), instead of being counted
as zero. Excusing needs no grade to exist yet; the item simply never counts.

- **`excuse(contentId, userId, actor, { reason? })`**: excusing someone already excused changes nothing and emits
  nothing. Emits `grading.excused`.
- **`unexcuse(contentId, userId, actor)`**: the work counts again; returns the record, or `null`.
- **`getExcusal(contentId, userId, actor)`** and **`listExcusals(contentId, actor, { includeRevoked? })`**, readable
  like the extension ones.

### Who can do what

| Method | Action | Who, by default |
| --- | --- | --- |
| `grantExtension`, `revokeExtension`, `listExtensions` | `grading.grantExtension` | admin, instructor, and a TA they delegated it to |
| `excuse`, `unexcuse`, `listExcusals` | `grading.excuse` | admin, instructor, and a TA they delegated it to |
| `getExtension`, `getExcusal` | `grading.view` | staff for anyone; a student for themselves (also after completing the section); a guardian with the `grades` scope |

Each grant and revoke is checked **before anything else**, so a stranger learns nothing, and **unknown
content is refused exactly like forbidden content**. The section always comes from the content node (never
from the caller), and the target must be an **active student** of that section: a dropped student, staff, or
someone in another section is refused. Content that is not published yet is fine for staff. A student can
never grant or excuse themselves.

### The repositories

```ts
interface TimeExtensionRepository {
  create(extension: Omit<TimeExtension, 'id'>): Promise<TimeExtension>;
  findActive(userId: string, contentId: string): Promise<TimeExtension | null>;   // not revoked
  revoke(id: string, at: Date, by: string): Promise<TimeExtension>;               // set revokedAt, revokedBy
  listForContent(contentId: string, options?: { includeRevoked?: boolean }): Promise<TimeExtension[]>;
  listForUser(userId: string, sectionId: string, options?: { includeRevoked?: boolean }): Promise<TimeExtension[]>;
}
// ExcusalRepository has the same five methods for Excusal.
```

`list...` methods leave out revoked records unless asked. Add a uniqueness rule (one active record per student and
content) if your store can enforce it: the service checks with a read, so two simultaneous grants could both
create one.

## `GradeRepository`

```ts
interface GradeRepository {
  create(entry: Omit<GradeEntry, 'id'>): Promise<GradeEntry>;
  findById(id: string): Promise<GradeEntry | null>;
  markSuperseded(id: string, byId: string): Promise<void>;
  // optional, recommended: supersede ONLY IF still current, as one atomic compare-and-set
  supersedeIfCurrent?(id: string, byId: string): Promise<boolean>;
  listForUserInSection(userId: string, sectionId: string):
    Promise<Array<GradeEntry & { category: string; contentId?: string }>>;   // contentId: needed for excusals
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

### `explainFinalGrade(entriesByCategory, scheme): FinalGradeExplanation`

The calculation below, with its working shown: `percent`, one `CategoryBreakdown` per category
(`weight`, `effectiveWeight`, `percent`, `counted`, `dropped`), the entries it `skipped` with the
reason, and the `uncategorized` ones. `computeFinalGrade` returns its `percent`, so the two can
never disagree.

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

### `effectiveDueAt(dueAt, extension?): Date` and `daysLate(submittedAt, dueAt, extension?): number`

`effectiveDueAt` is the deadline a student really has: `dueAt` plus their `extraSeconds`, as a **new** date
(`extraSeconds` must be a finite number from 0 up). `daysLate` is how late a submission is **in whole days, started
days included**: one second late is 1, a day and a second is 2, on time or exactly at the deadline is 0. It measures
against the extended deadline, and its result is what `applyLatePolicy` takes:

```ts
const ext = await accommodations.getExtension(assignmentId, studentId, actor);
const late = daysLate(submission.submittedAt, dueAt, ext);          // the SDK has no due dates: dueAt is yours
const score = applyLatePolicy(rawScore, maxScore, late, policy);
```

### Curves: `applyCurve(percents, curve, options?)` and `curveEntries(entries, curve, options?)`

Pure. A curve works on **percentages** (0 and up, normally 0 to 100) and returns new ones in the same order;
`curveEntries` does the same for anything with a `score` and a `maxScore` and returns copies with a new `score`
(the same `maxScore`). Pass **everyone who counts** for the piece of work, and nobody else: `scaleToTop` and
`targetMean` look at the whole class.

| `curve.kind` | What it does |
| --- | --- |
| `flat` (`points`) | adds `points` percentage points to everyone; `points` is from 0 up |
| `scaleToTop` (`target?`, default 100) | scales so the best score becomes `target`; a class that already reaches it is left alone |
| `sqrt` | `10 * sqrt(percent)`: 36 becomes 60, 100 stays 100 |
| `targetMean` (`mean`) | shifts everyone by the same amount so the class average reaches `mean`; an average already there is left alone |
| `linear` (`fromMin`, `fromMax`, `toMin`, `toMax`) | maps `fromMin..fromMax` onto `toMin..toMax` along a straight line that carries on beyond both ends; each range must rise |

Rules that hold for **every** curve:

- **A curve never lowers a grade.** Whatever the curve would give, a score comes back as at least what it was, and
  one the curve does not raise comes back **exactly** as it was (also for `curveEntries`: its `score` is untouched,
  not recomputed).
- **Capped at 100** (`options.cap`); `cap: null` removes the cap for courses with extra credit, and another number
  caps there. A grade already above the cap keeps its value. A cap can stop `targetMean` short of its target.
- **No rounding** unless `options.decimals` (0 to 10) is set; it rounds the curved value, not a grade the curve left alone.
- **Bad input throws** instead of turning into NaN: a negative or non-finite percentage, an entry without a usable
  `maxScore`, a curve of an unknown kind, or an option that makes no sense.

```ts
const percents = entries.map((e) => (e.score / e.maxScore) * 100);
const curved = applyCurve(percents, { kind: 'targetMean', mean: 75 });
```

**Nothing is stored.** To record curved scores, regrade each entry with `GradingService.recordGrade` and
`previousEntryId`, as an actor: the original stays in the history and the audit trail says who curved it.

```ts
const newEntries = curveEntries(entriesForTheAssignment, { kind: 'scaleToTop' });
for (const [i, e] of newEntries.entries()) {
  if (e.score !== entriesForTheAssignment[i].score) {
    const before = entriesForTheAssignment[i];
    await grading.recordGrade(e.submissionId, e.userId, e.score, e.maxScore, teacher.id, before.id, { actorId: teacher.id });
  }
}
```

### GPA: `computeGpa(courses, scale, options?)`

Pure. The credit-weighted average of grade points.

```ts
computeGpa(
  [{ credits: 4, letter: 'A' }, { credits: 3, percent: 87 }, { credits: 3, letter: 'P' }],
  { ...STANDARD_GPA_SCALE, P: null },
  { letterScale, decimals: 2 },        // letterScale: the bands that turn a percent into a letter
);
```

- **The scale** (`GpaScale`) maps a letter to points. `STANDARD_GPA_SCALE` is the US four-point scale with
  pluses and minuses (A+ and A are 4.0, F is 0); it is frozen, so spread it to extend it, or pass your own.
  A letter mapped to **`null`** (pass, withdrawn, incomplete) is **left out** of the average, credits included.
  A letter that is **not in the scale at all throws**, so a typo like `'a'` is caught instead of skipped.
  `toGpaPoints(letter, scale)` is the same lookup on its own.
- **A course** has `credits` (finite, from 0 up) and exactly one of `letter` or `percent`. A `percent` goes through
  `options.letterScale` with `toLetterGrade`, and throws without it or when the percentage falls outside every band
  (`'N/A'`).
- **`bonus`** gives a weighted course (honors, AP) extra points, **only when it earned more than 0**, so an F stays 0.
- **The result** is `null`, not 0, when nothing counts (no courses, only excluded letters, or zero credits).
  `options.decimals` rounds it; otherwise it is not rounded.
- Every course is checked first, so a bad letter, credit value or bonus throws even for a course that would not count.

The SDK does not know a course's credits, or which attempt of a repeated course should count, so **you** gather
them. For a student's cumulative GPA, take each section's final letter (`computeLetterGradeForUser`) or percentage
(`computeFinalGradeForUser`) with its credits, drop the retaken attempts you do not want to count, and pass the list.

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

`grading.extensionGranted` (`extensionId`, `userId`, `contentId`, `sectionId`, `extraSeconds`, `grantedBy`,
`replacedExtensionId?`) and `grading.excused` (`excusalId`, `userId`, `contentId`, `sectionId`, `excusedBy`),
once per new record, each naming who did it. Ending one emits `grading.extensionRevoked` or `grading.unexcused`.

`grading.gradesReleased` (`sectionId`, `contentId`, `releaseId`, `releasedBy`) and `grading.gradesHidden`
(`sectionId`, `contentId`, `releaseId`, `hiddenBy`) when held grades are shown to a section or hidden again.

`grading.gradePosted` (`gradeEntryId`, `submissionId`, `userId`, `score`, `maxScore`,
`graderId`, `contentId?`, and `released` when grades are held), once per `recordGrade`, including a regrade. It identifies the work by
`submissionId`, not `contentId`; see [EVENTS.md](./EVENTS.md) and the notification
bridge in [COMMUNICATION.md](./COMMUNICATION.md).

## Known limitations

- **Bad rows in your gradebook are skipped by the calculation, and reported only if you ask.** An entry
  with an impossible maximum or score does not count, and the final grade does not fail because of it.
  `explainGradeForUser` (and `explainFinalGrade`) list such entries in `skipped`. Nothing alerts you
  on its own.
- **`applyLatePolicy` does not validate its inputs.** A non-finite score or maximum gives a
  non-finite result.
- **Without `supersedeIfCurrent`, regrading is not atomic.** The check of `previousEntryId`,
  the create and the `markSuperseded` are separate calls, so two simultaneous regrades of one
  entry can both succeed and leave two current entries (both would count towards the final grade).
  Provide `supersedeIfCurrent` if that can happen.
- **Two simultaneous *first* grades of one submission are not guarded** even with it: neither
  supersedes anything. A unique constraint on the current grade per submission in your database
  prevents that.
- **Grades are held per piece of content, not per student.** You cannot release one student's grade
  ahead of the class, or release only some categories.
- **Without enforcement, `grading.gradePosted` always says `released: false` while grades are held**,
  because the service cannot find the grade's content without the `SubmissionLocator`.
- **Releasing is not atomic.** Two staff releasing the same content at the same moment can create two
  releases. Both are active and either one shows the grades. Hiding hides only one of them unless
  your store enforces a single active release per section and content.
- **A completed student can still read their own grades** (final and letter grade), and so
  can their guardians, but nothing else, and never anyone else's. Dropped and waitlisted
  students cannot. See [PERMISSIONS.md](./PERMISSIONS.md).
- **Rubrics and peer review live in assessment**, not here (see [ASSESSMENT.md](./ASSESSMENT.md)). A rubric
  evaluation is not turned into a grade automatically.
- **Curving and GPA are calculations, not records.** Nothing remembers that a curve was applied or what a GPA was; recording a
  curve is a regrade you do, and a GPA you keep is yours to store. There is no per-course credit value, repeat/retake policy,
  or class rank in the SDK.
- **Extensions know nothing about due dates**, which are yours; they are an amount of time you apply with
  `effectiveDueAt` / `daysLate`, or the quiz `extensions` option. Nothing stops an extension on content that has no
  deadline or time limit; it simply does nothing.
- **Excused work is matched by content.** An excusal does nothing for a grade whose entries carry no `contentId`
  (and the calculation throws if it cannot tell), and it is only as current as your repository's data.
- **Two simultaneous grants can both create a record** unless your store enforces one active record per student and content.
- **Late penalties are manual** (see above).

## Tests

| File | Covers |
| --- | --- |
| `test/grading.test.ts` | the pure calculations: weighting, dropping the lowest, renormalizing, letter bands, late penalties |
| `test/grading-curve-gpa.test.ts` | `applyCurve` (each curve kind, the never-lower rule, the cap, rounding, bad input), `curveEntries` (exact scores kept, whole-class curves), `computeGpa` and `toGpaPoints` (weighting, excluded and unknown letters, bonus, percent route, null result, rounding) |
| `test/grading-accommodations.test.ts` | `effectiveDueAt`, `daysLate`; `AccommodationService` (grant, replace, revoke, excuse, un-excuse, reading, delegation, tenancy, probing, idempotence, events); final grades leaving out excused work |
| `test/grading-system.test.ts` | `recordSystemGrade`: the `system:` prefix and allow-list, the numbers, no actor needed, the submission-owner check with enforcement, the event; a regrade through `previousEntryId` is covered in `test/assessment-question-types.test.ts` |
| `test/atomic-repositories.test.ts` | regrading races with and without `supersedeIfCurrent` (one winner, the loser kept as history and told who won, only the winner announced and counted), alongside the capacity and attempt-limit races |
| `test/grading-validation.test.ts` | the number checks in `recordGrade` (each bad case, the boundaries, extra credit on and off, a refused regrade leaving the current grade alone, the permission check coming first) and `computeFinalGrade` skipping entries that cannot be a grade |
| `test/grading-permissions.test.ts` | enforcement (who may record and view, grader identity, own-work rule, the locator, guardians, completed students and their guardians, the tenant wall, check ordering) and the supersede integrity checks on `previousEntryId` |
| `test/grading-events.test.ts` | `grading.gradePosted`, including once per regrade |
| `test/grading-release.test.ts` | `explainFinalGrade` (categories, dropped and counted entries, renormalizing, skipped bad rows and why, uncategorized entries, agreeing with `computeFinalGrade`); holding grades from a student and guardian until released, per content; staff seeing everything; hiding again with the history kept; idempotent release; who may release (delegation included); `released` on `gradePosted`; notifications only on release; the default immediate mode; `listGradesForUser` (current only, excused marked) and `explainGradeForUser` (a bad row found, permissions); `releasedOnly` without enforcement |
