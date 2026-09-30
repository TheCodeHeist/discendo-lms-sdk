# Other Modules — Full Reference

Complete reference for every module besides `scheduling` (see
`SCHEDULING.md` for that one). Types and signatures here are transcribed
directly from source — nothing paraphrased or inferred beyond what's in the
code and its comments.

---

## `core` — `discendo-sdk/core`

Shared primitives every other module is built on. Two files:
`types.ts`, `repositories.ts`.

### Types

```ts
type Id = string;
type Timestamp = Date;
type Role = "student" | "instructor" | "ta" | "admin" | "guardian";

interface Identity {
  id: Id;
  externalRef?: string; // reference back to the host app's own user record
  roles: Role[];
  orgId?: Id; // the organization this person belongs to (multi-tenant only)
}

interface Organization {
  // one tenant: an institution, school or company
  id: Id;
  name: string;
}
```

**Course vs. CourseSection** — a deliberate separation the source comments
call out as "the most common regret in LMS data models" when conflated:

```ts
interface Course {
  // a template, e.g. "Intro to Physics"
  id: Id;
  title: string;
  description?: string;
  orgId?: Id; // owning organization; see "Tenancy" below
}

interface CourseSection {
  // a running instance, e.g. "Intro to Physics — Fall 2026, Section B"
  id: Id;
  courseId: Id;
  termId?: Id;
  capacity?: number;
  status: "draft" | "published" | "archived";
}
```

```ts
type EnrollmentStatus = "active" | "waitlisted" | "dropped" | "completed";

interface Enrollment {
  id: Id;
  userId: Id;
  sectionId: Id;
  role: Role;
  status: EnrollmentStatus;
  enrolledAt: Timestamp;
  droppedAt?: Timestamp;
}

type ContentKind = "page" | "assignment" | "quiz" | "file" | "link";

interface ContentNode {
  id: Id;
  sectionId: Id;
  kind: ContentKind;
  title: string;
  parentId?: Id;
  orderIndex: number;
  published: boolean;
  version: number;
}

interface AcademicTerm {
  id: Id;
  name: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  orgId?: Id;
}
```

### Tenancy (organizations)

Everything about organizations is optional. If no `orgId` is set anywhere,
no tenant check ever runs and a single-institution deployment behaves
exactly as before, apart from one extra `findCourse` lookup per enrollment.

- A **course** may carry an `orgId`. Sections, enrollments and content
  inherit their tenant through the course and don't repeat it.
- An org-scoped course can only be joined by an identity with the **same**
  `orgId`. A person with no `orgId` is rejected too (fail closed): "no
  organization" only matches "no organization".
- A course **without** an `orgId` is unscoped: nothing is checked, and the
  user isn't even loaded.
- Mismatches throw `TenantMismatchError`, which carries `expectedOrgId` and
  `actualOrgId` for your own logs. Its message is generic on purpose, so it
  can be shown to callers without revealing which organization owns a course.
- Helpers in `core`: `sameOrg(a, b)`, `assertSameOrg(expected, actual, message)`.

Today only `EnrollmentService.enroll` (and so `bulkEnroll`) enforces this.
Other modules, such as rooms and scheduling groups, don't yet.

Two organizations may reuse the same external reference, so
`UserRepository.findByExternalRef(ref, orgId?)` takes an optional `orgId`.
`bulkEnroll` passes the course's `orgId` (resolved once per batch), and your
implementation should then return only an identity from that organization.
Implementations that ignore the hint are still safe: `enroll` rejects a
cross-tenant match with `TenantMismatchError`. The difference is that the
right person then can't be found, because the wrong one was returned first.
For an unscoped course no `orgId` is passed.

### Repository interfaces

```ts
interface UserRepository {
  findById(id: Id): Promise<Identity | null>;
  findByExternalRef(ref: string, orgId?: Id): Promise<Identity | null>; // orgId: only match within this organization
}

interface CourseRepository {
  findCourse(id: Id): Promise<Course | null>;
  findSection(id: Id): Promise<CourseSection | null>;
  listSections(courseId: Id): Promise<CourseSection[]>;
}

interface EnrollmentRepository {
  create(enrollment: Omit<Enrollment, "id">): Promise<Enrollment>;
  update(id: Id, patch: Partial<Enrollment>): Promise<Enrollment>;
  findByUserAndSection(userId: Id, sectionId: Id): Promise<Enrollment | null>;
  listBySection(
    sectionId: Id,
    status?: Enrollment["status"],
  ): Promise<Enrollment[]>;
  countActive(sectionId: Id): Promise<number>;
}

interface ContentRepository {
  findById(id: Id): Promise<ContentNode | null>;
  listBySection(sectionId: Id): Promise<ContentNode[]>;
  create(node: Omit<ContentNode, "id" | "version">): Promise<ContentNode>;
  update(id: Id, patch: Partial<ContentNode>): Promise<ContentNode>;
  reorder(sectionId: Id, orderedIds: Id[]): Promise<void>;
}

interface TermRepository {
  findById(id: Id): Promise<AcademicTerm | null>;
}

interface OrganizationRepository {
  findById(id: Id): Promise<Organization | null>;
}
```

### `RepositoryContext`

```ts
interface RepositoryContext {
  users: UserRepository;
  courses: CourseRepository;
  enrollments: EnrollmentRepository;
  content: ContentRepository;
  terms: TermRepository;
  organizations?: OrganizationRepository; // optional; nothing in the SDK requires it yet
}
```

The bundle several service classes (`EnrollmentService`, `ContentService`)
are constructed with. The host app wires up real implementations once at
startup and passes the same `RepositoryContext` object to every service
that needs it.

---

## `enrollment` — `discendo-sdk/enrollment`

### Types

```ts
interface EnrollOptions {
  userId: string;
  sectionId: string;
  role: Role;
  waitlistIfFull?: boolean; // if the section is full, waitlist instead of throwing
}

interface BatchEnrollRow {
  userExternalRef: string;
  role: Role;
}

interface BatchReport {
  succeeded: number;
  failed: Array<{ row: BatchEnrollRow; reason: string }>;
}
```

### `EnrollmentService`

Constructed with a `RepositoryContext`.

- **`enroll(opts: EnrollOptions): Promise<Enrollment>`** — Idempotent:
  calling twice for the same user+section returns the existing (non-dropped)
  enrollment rather than duplicating it. If the section has a `capacity` and
  is full, either throws or waitlists depending on `waitlistIfFull`. If the
  section's course has an `orgId`, the user must belong to that
  organization or a `TenantMismatchError` is thrown before anything is
  created (see "Tenancy" above).
- **`drop(enrollmentId: string): Promise<Enrollment>`** — Never hard-deletes;
  sets `status: 'dropped'` and `droppedAt` to preserve history.
- **`listRoster(sectionId, status?): Promise<Enrollment[]>`**
- **`bulkEnroll(sectionId, rows: BatchEnrollRow[]): Promise<BatchReport>`** —
  Resolves each row's `userExternalRef` via `UserRepository`, scoped to the
  section's organization when its course has one (so the host
  app's internal user IDs never need to leak into the import feed), then
  calls `enroll(..., waitlistIfFull: true)` for each. Failures (user not
  found, a tenant mismatch, or any thrown error) are collected per-row in
  the report rather than aborting the whole batch.

---

## `content` — `discendo-sdk/content`

### `ContentService`

```ts
interface PrerequisiteEdge {
  contentId: string;
  requiresContentId: string;
}

interface CompletionChecker {
  isComplete(userId: string, contentId: string): Promise<boolean>;
}
```

Constructed with `(repos: RepositoryContext, completion: CompletionChecker,
prerequisites: PrerequisiteEdge[] = [])`. The host app supplies both the
completion-state lookup and the prerequisite graph — this module doesn't own
progress storage.

- **`createNode(node): Promise<ContentNode>`**
- **`publish(id): Promise<ContentNode>`** — Sets `published: true` and
  increments `version`.
- **`reorder(sectionId, orderedIds): Promise<void>`**
- **`isUnlocked(userId, contentId): Promise<boolean>`** — Walks the direct
  prerequisites for `contentId` (a simple, non-transitive DAG check — no
  general graph library needed) and requires every one to be complete per
  the injected `CompletionChecker`.

---

## `assessment` — `discendo-sdk/assessment`

### Types

```ts
type SubmissionPayload =
  | { kind: "text"; content: string }
  | { kind: "file"; ref: string }
  | { kind: "url"; href: string }
  | { kind: "none" }; // offline/manually graded work

interface Submission {
  id: string;
  contentId: string;
  userId: string;
  payload: SubmissionPayload;
  submittedAt: Date;
  attemptNumber: number;
}

interface Criterion {
  description: string;
  maxPoints: number;
}
interface Rubric {
  contentId: string;
  criteria: Criterion[];
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
  questionOrder: string[]; // supports per-attempt randomization
  startedAt: Date;
  submittedAt?: Date;
}

type PlagiarismCheckResult = {
  flagged: boolean;
  score?: number;
  details?: string;
};
type PlagiarismCheckHook = (
  submission: Submission,
) => Promise<PlagiarismCheckResult>;
```

`PlagiarismCheckHook` is a seam — the SDK doesn't implement detection
itself.

### `AssessmentService`

```ts
interface SubmissionRepository {
  create(sub: Omit<Submission, "id">): Promise<Submission>;
  countAttempts(contentId: string, userId: string): Promise<number>;
}
interface QuizRepository {
  getQuestions(quizId: string): Promise<QuizQuestion[]>;
  createAttempt(attempt: Omit<QuizAttempt, "id">): Promise<QuizAttempt>;
}
```

Constructed with `(submissions, quizzes, plagiarismHook?)`.

- **`submit(contentId, userId, payload, maxAttempts?): Promise<Submission>`**
  — Throws `'No attempts remaining'` if `maxAttempts` is set and already
  reached. If a `plagiarismHook` was supplied, it's invoked **fire-and-forget**
  (`void this.plagiarismHook(...)`) — submission is never blocked waiting on
  a potentially slow external check.
- **`attemptsRemaining(contentId, userId, maxAttempts): Promise<number>`**
- **`generateAttempt(quizId, userId, randomize = true): Promise<QuizAttempt>`**
  — Fetches the quiz's questions, optionally Fisher-Yates shuffles the
  question order (per-attempt, not stored globally), and records the attempt.

---

## `grading` — `discendo-sdk/grading`

### Types

```ts
interface GradeEntry {
  id: string;
  submissionId: string;
  userId: string;
  score: number;
  maxScore: number;
  graderId: string;
  gradedAt: Date;
  supersededBy?: string; // set when a later entry replaces this one
}

interface GradeCategory {
  name: string;
  weight: number; // 0-1; all categories should sum to 1
  dropLowestN?: number;
}
interface GradingScheme {
  categories: GradeCategory[];
}

type LatePolicy =
  | { kind: "none" }
  | { kind: "flatPenalty"; percentPerDay: number; maxPenaltyPercent?: number }
  | { kind: "cutoff"; afterDays: number }; // zero credit after N days

interface GradeScaleBand {
  minPercent: number;
  label: string;
} // 'A', 'A-', 'Pass', etc.
type GradeScale = GradeScaleBand[];
```

### Pure calculation functions (`calculations.ts`)

No repository access, no side effects — safe to call for previewing a grade
before committing it.

- **`applyLatePolicy(score, maxScore, daysLate, policy): number`** —
  `daysLate <= 0` always returns `score` unchanged. `flatPenalty` deducts
  `percentPerDay * daysLate` (capped at `maxPenaltyPercent`, default
  effectively 100) of `maxScore` from `score`, floored at 0. `cutoff`
  returns 0 once `daysLate > afterDays`, otherwise unchanged.
- **`computeFinalGrade(entriesByCategory, scheme): number`** — For each
  category, computes the average of kept percentages (score/maxScore)
  after dropping the lowest `dropLowestN`, then weights and sums across
  categories. **Renormalizes by the weight actually used** if some
  categories have no grades yet, so a partially-graded course doesn't
  unfairly tank toward zero. Returns a 0–100 value.
- **`toLetterGrade(percent, scale): string`** — Sorts the scale descending
  by `minPercent` and returns the first band's label the percent qualifies
  for; `'N/A'` if none match.

### `GradingService`

```ts
interface GradeRepository {
  create(entry: Omit<GradeEntry, "id">): Promise<GradeEntry>;
  markSuperseded(id: string, byId: string): Promise<void>;
  listForUserInSection(
    userId: string,
    sectionId: string,
  ): Promise<Array<GradeEntry & { category: string }>>;
}
```

Constructed with a single `GradeRepository`.

- **`recordGrade(submissionId, userId, score, maxScore, graderId,
previousEntryId?): Promise<GradeEntry>`** — **Never overwrites.** Always
  creates a new entry; if `previousEntryId` is given, marks that old entry
  superseded. This gives a full audit trail with no extra effort from
  callers.
- **`computeFinalGradeForUser(userId, sectionId, scheme): Promise<number>`**
  — Fetches entries, filters out any that are superseded, groups by
  category, and delegates to `computeFinalGrade`.
- **`computeLetterGradeForUser(userId, sectionId, scheme, scale):
Promise<string>`**

---

## `communication` — `discendo-sdk/communication`

### Types

```ts
type NotificationEvent =
  | { type: "gradePosted"; userId: string; contentId: string; score: number }
  | { type: "announcementCreated"; sectionId: string; title: string }
  | {
      type: "dueDateApproaching";
      userId: string;
      contentId: string;
      dueAt: Date;
    };

interface NotificationSink {
  dispatch(event: NotificationEvent): Promise<void>;
}

interface Announcement {
  id: string;
  sectionId: string;
  title: string;
  body: string;
  postedAt: Date;
}
interface ThreadPost {
  id: string;
  authorId: string;
  body: string;
  postedAt: Date;
}
interface Thread {
  id: string;
  contentId?: string;
  sectionId: string;
  title: string;
  posts: ThreadPost[];
}
```

The SDK never sends email/push/SMS itself — `NotificationSink` is the seam
the host app wires to whatever delivery mechanism it already has (SendGrid,
FCM, in-app, etc.).

### `CommunicationService`

```ts
interface AnnouncementRepository {
  create(a: Omit<Announcement, "id">): Promise<Announcement>;
  listBySection(sectionId: string): Promise<Announcement[]>;
}
interface ThreadRepository {
  create(t: Omit<Thread, "id" | "posts">): Promise<Thread>;
  addPost(threadId: string, post: Omit<ThreadPost, "id">): Promise<ThreadPost>;
  findById(id: string): Promise<Thread | null>;
}
```

Constructed with `(announcements, threads, sink?)`.

- **`postAnnouncement(sectionId, title, body)`** — Creates the announcement,
  then dispatches an `announcementCreated` event via the sink if one was
  provided.
- **`reply(threadId, authorId, body)`** — Adds a post to a thread.

---

## `scheduling/calendar` — `discendo-sdk/scheduling/calendar`

Lives inside the `scheduling` domain (see `src/domains/scheduling/README.md`
for why) but documented here because it is unrelated to class routines: this
sub-module is entirely about assignment due-date availability windows and
calendar export, and does not model teachers, rooms, or recurring class
routines at all. Also re-exported from `discendo-sdk/scheduling`.

```ts
type AvailabilityState = "locked" | "open" | "closed";
interface AvailabilityWindow {
  opensAt?: Date; // undefined = no lower bound
  closesAt?: Date; // undefined = never closes
}
```

### `CalendarService`

All timestamps UTC — local-timezone conversion is explicitly called out in
source comments as a presentation-layer concern for the host app, "or you
WILL get off-by-one-timezone bugs."

- **`getAvailability(window, now = new Date()): AvailabilityState`** —
  `'locked'` if `now` is before `opensAt`, `'closed'` if after `closesAt`,
  else `'open'`.
- **`toIcal(events: Array<{ id, title, dueAt }>): string`** — Minimal RFC
  5545 iCal export: one `VEVENT` per event with `UID`, `DTSTAMP`, `DTSTART`,
  `SUMMARY`. `id` and `title` are escaped as iCal TEXT (`\`, `;`, `,` and
  line breaks), so a title such as `Quiz 1, part 2` is valid and a title
  containing a line break cannot inject extra properties or events into the
  feed. `dueAt` is written in UTC (`YYYYMMDDTHHMMSSZ`, no milliseconds) and
  an invalid `Date` throws `RangeError`. Not implemented yet: folding of
  lines longer than 75 octets, and a trailing CRLF after `END:VCALENDAR`.

---

## `reporting` — `discendo-sdk/reporting`

### Types

```ts
type AttendanceStatus = "present" | "absent" | "excused" | "late";
interface AttendanceRecord {
  sessionId: string;
  userId: string;
  status: AttendanceStatus;
  recordedAt: Date;
}
interface AttendanceRepository {
  record(entry: AttendanceRecord): Promise<void>;
  listForSession(sessionId: string): Promise<AttendanceRecord[]>;
}
interface Exportable {
  toRows(): Record<string, string | number>[];
}
```

### Functions & `ReportingService`

- **`toCsv(exportable: Exportable): string`** — A free function, not a
  method: anything exportable as flat rows (gradebook, roster, attendance,
  etc.) implements `Exportable` and reuses this. Handles quoting/escaping
  cells containing commas, quotes, or newlines.
- **`ReportingService`** — constructed with an `AttendanceRepository`.
  - **`recordAttendance(record): Promise<void>`**
  - **`computeCompletionPercent(totalItems, completedItems): number`** —
    Rounds to the nearest integer percent; returns 0 if `totalItems` is 0
    (avoids a division-by-zero `NaN`). Comment notes progress is meant to be
    _derived_ from completion events, not stored as separately-mutable
    state.

`AttendanceRecord`/`AttendanceRepository` here is the SDK's attendance
tracking primitive — distinct from, and independent of, the `scheduling`
module's `ClassOccurrence`. Nothing currently wires the two together (e.g.
there's no built-in "mark attendance for this occurrence" helper); a host
app would connect `sessionId` here to a `ClassOccurrence.id` itself if it
wants that link.

---

## `admin` — `discendo-sdk/admin`

```ts
interface AuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  timestamp: Date;
  diff?: Record<string, { before: unknown; after: unknown }>;
}
interface AuditRepository {
  append(entry: Omit<AuditEntry, "id">): Promise<AuditEntry>;
  listForTarget(targetId: string): Promise<AuditEntry[]>;
}
```

- **`withAudit<T>(audit, action, targetId, actorId, fn: () => Promise<T>):
Promise<T>`** — A generic wrapper function (not a method): runs `fn()`,
  then appends an audit entry, then returns `fn()`'s result. Meant to wrap
  any mutation in any other module without scattering log calls through
  every service, e.g.:
  ```ts
  await withAudit(auditRepo, 'grade.update', gradeId, actorId, () =>
    gradingService.recordGrade(...)
  );
  ```
- **`AdminService`** — constructed with an `AuditRepository`.
  - **`history(targetId): Promise<AuditEntry[]>`**

---

## `interop` — `discendo-sdk/interop`

**Type-only module** — no service class, no implementation, on purpose.
Source comments are explicit: _"Don't hand-roll LTI/SAML/OIDC — expose the
interface here and let the host app plug in a real library (e.g. `ltijs`,
`openid-client`, `node-saml`). The value the SDK adds is defining where
these plug into enrollment/grading, not the protocols."_

```ts
interface LtiLaunchContext {
  issuer: string;
  clientId: string;
  deploymentId: string;
  userExternalRef: string;
  contextExternalRef: string; // maps to a CourseSection
  roles: string[];
}
interface LtiLaunchHandler {
  handleLaunch(
    context: LtiLaunchContext,
  ): Promise<{ sectionId: string; userId: string }>;
}
interface LtiGradePassback {
  sendGrade(
    lineItemId: string,
    userId: string,
    score: number,
    maxScore: number,
  ): Promise<void>;
}
interface AuthProvider {
  verifyToken(
    token: string,
  ): Promise<{ externalRef: string; claims: Record<string, unknown> }>;
}
interface ContentPackageImporter {
  importPackage(
    fileRef: string,
    sectionId: string,
  ): Promise<{ importedNodeIds: string[] }>;
}
```

Every interface here is a seam the host app implements: LTI 1.3 launch
handling and grade passback, generic OIDC/SAML token verification, and
SCORM/xAPI content package import (parsing delegated entirely to whatever
library the host chooses).
