# Getting Started

A practical walkthrough of wiring the SDK into a host application, using
the patterns that hold across every module (see `README.md`'s "Design
principles" section for the full list). Ends with a worked, runnable-style
example of the `scheduling` module end to end, since it's the most involved
module and the one most likely to need a concrete example to click.

## 1. Install and import

The SDK is ESM (`"type": "module"`) with a subpath export per module:

```ts
import { EnrollmentService } from "discendo-sdk/enrollment";
import { GradingService } from "discendo-sdk/grading";
import { SchedulingService } from "discendo-sdk/scheduling";
```

or, from the root barrel, everything at once:

```ts
import { EnrollmentService, GradingService, SchedulingService } from "discendo-sdk";
```

Prefer subpath imports in real apps to keep bundles small — the root barrel
is a convenience for quick scripts and tests.

## 2. Implement the repository interfaces you need

Every module that touches persistence defines a repository interface; you
implement it against your actual database. There's no ORM assumption, no
base class to extend — just a plain object (or class instance) satisfying
the interface's method signatures.

For example, `grading`'s `GradeRepository`:

```ts
import type { GradeRepository, GradeEntry } from "discendo-sdk/grading";

class PrismaGradeRepository implements GradeRepository {
  constructor(private prisma: PrismaClient) {}

  async create(entry: Omit<GradeEntry, "id">): Promise<GradeEntry> {
    return this.prisma.gradeEntry.create({ data: entry });
  }
  async findById(id: string): Promise<GradeEntry | null> {
    return this.prisma.gradeEntry.findUnique({ where: { id } });
  }
  async markSuperseded(id: string, byId: string): Promise<void> {
    await this.prisma.gradeEntry.update({
      where: { id },
      data: { supersededBy: byId },
    });
  }
  async listForUserInSection(userId: string, sectionId: string) {
    return this.prisma.gradeEntry.findMany({ where: { userId, sectionId } });
  }
}
```

You only need to implement the repositories for the modules you're actually
using. `core`'s `RepositoryContext` bundles the five repositories that
`enrollment` and `content` need; modules like `grading`, `assessment`,
`communication`, `reporting`, and `admin` take their own repositories
directly, not through `RepositoryContext`.

For quick prototyping or tests, an in-memory `Map`-backed implementation is
often faster to write than wiring a real database — see
`src/domains/scheduling/testing/in-memory-repository.ts` for a complete worked
example of that pattern (note: it's not exported from the package, since
it's meant to be copied/adapted, not depended on).

## 3. Construct services once, at startup

Services take their dependencies via the constructor — no framework, no
service locator:

```ts
const repos: RepositoryContext = {
  users: new MyUserRepository(db),
  courses: new MyCourseRepository(db),
  enrollments: new MyEnrollmentRepository(db),
  content: new MyContentRepository(db),
  terms: new MyTermRepository(db),
};

const enrollmentService = new EnrollmentService(repos);
const gradingService = new GradingService(new MyGradeRepository(db));
const schedulingService = new SchedulingService(new MySchedulingRepository(db));
```

Construct these once and reuse them — there's no per-request setup cost
baked into any service's constructor.

## 4. Wire optional seams as needed

Several modules accept optional hooks/sinks for things the SDK deliberately
doesn't implement:

```ts
// AssessmentService's optional plagiarism check
const assessmentService = new AssessmentService(
  submissionRepo,
  quizRepo,
  async (submission) => myPlagiarismApi.check(submission),
);

// CommunicationService's optional notification dispatch
const commsService = new CommunicationService(announcementRepo, threadRepo, {
  dispatch: async (event) => myPushService.send(event),
});
```

Events work the same way: build one `EventBus`, pass it as the optional
last constructor argument to the services that emit, and subscribe with
`bus.on(...)`. To turn grade events into notifications, use
`bridgeEventBusToNotificationSink(bus, sink, { resolveContentId })` from
`discendo-sdk/communication`.

Omit these entirely if you don't need them yet — they're optional
constructor parameters, not required wiring.

## 5. Wrap mutations in `withAudit` where you want history

`admin`'s `withAudit` is a free function, not tied to any specific service,
so it composes with anything:

```ts
import { withAudit } from "discendo-sdk/admin";

await withAudit(auditRepo, "grade.record", submissionId, actorId, () =>
  gradingService.recordGrade(submissionId, userId, score, maxScore, actorId),
);
```

---

## Worked example: scheduling end to end

This walks through the full path from "a course that needs a routine" to
"a conflict-free timetable applied," using every layer of the `scheduling`
module. Uses `InMemorySchedulingRepository` for brevity — swap in a real
implementation the same way as any other repository.

### Step 1 — set up rooms and groups

```ts
import { InMemorySchedulingRepository } from "discendo-sdk/scheduling"; // path shown for illustration;
// in a real app this is your own SchedulingRepository implementation, not the in-memory one
import { SchedulingService } from "discendo-sdk/scheduling";

const repo = new InMemorySchedulingRepository();

repo.seedRoom({ id: "room-101", capacity: 30, features: [] });
repo.seedRoom({ id: "room-lab", capacity: 24, features: ["lab"] });

repo.seedGroup({
  id: "physics-101-sectionA",
  sectionId: "sec-physics-101",
  size: 22,
});
```

### Step 2 — create unscheduled templates

A template can exist with no `roomId`/times yet — that's what the solver
will decide:

```ts
const template = await repo.createTemplate({
  sectionId: "sec-physics-101",
  teacherIds: ["teacher-jane"],
  groupId: "physics-101-sectionA",
  rule: { freq: "WEEKLY", interval: 1, byDay: ["MO", "WE", "FR"] },
  startTime: "10:00", // used only to derive a 50-minute duration for the solver
  endTime: "10:50",
  timezone: "UTC",
  validFrom: new Date("2026-10-05"),
  requiredRoomFeatures: ["lab"], // this section needs the lab
});
```

### Step 3 — (optional) declare availability constraints

Skip this step entirely if you don't need to constrain when a resource can
be used — availability is opt-in (see `SCHEDULING.md`'s `availability.ts`
section).

```ts
await repo.seedAvailability({
  id: "avail-jane",
  resourceId: "teacher-jane",
  resourceType: "teacher",
  rule: { freq: "WEEKLY", interval: 1, byDay: ["MO", "TU", "WE", "TH", "FR"] },
  startTime: "09:00",
  endTime: "15:00",
  timezone: "UTC",
  validFrom: new Date("2026-10-05"),
});
```

### Step 4 — plan an auto-schedule

```ts
const service = new SchedulingService(repo);

const { result, skippedAvailability } = await service.planAutoSchedule(
  [template.id],
  {
    candidateSlotsPerDay: ["09:00", "10:00", "11:00", "13:00", "14:00"],
    days: ["MO", "TU", "WE", "TH", "FR"],
  },
);

console.log(result.status); // 'COMPLETE' | 'PARTIAL' | 'INFEASIBLE'
console.log(result.placements); // [{ sessionId, roomId, days, startTime, endTime }]
console.log(result.unplaced); // [] if everything placed
console.log(skippedAvailability); // resources whose availability rules couldn't be used
// (e.g. fortnightly rules — see SCHEDULING.md)
```

Nothing has been written yet — `planAutoSchedule` only returns a plan. This
is your chance to show it to a human, log it, or reject it before committing.

### Step 5 — apply the plan

```ts
if (result.status !== "INFEASIBLE") {
  const updatedTemplates = await service.applyAutoSchedulePlan(result);
  // updatedTemplates[0].roomId === 'room-lab'
  // updatedTemplates[0].rule.byDay === ['MO', 'WE', 'FR']
}
```

Templates the solver couldn't place are left completely untouched — handle
`result.unplaced` separately (e.g. surface it for manual scheduling).

### Step 6 — materialize actual dated occurrences

Once a template has a room/time, generate the concrete calendar entries for
a rolling window:

```ts
const occurrences = await service.materializeOccurrences(
  template.id,
  new Date("2026-10-05"),
  new Date("2027-01-05"), // e.g. one term
);
```

Safe to call repeatedly — it only creates occurrences for dates not already
materialized.

### Step 7 — handle real-world exceptions on a single occurrence

```ts
// Teacher calls in sick for one specific class
await service.cancelOccurrence(occurrences[0].id, "Teacher sick");

// A different class gets moved to a different room, one time only
await service.rescheduleOccurrence(occurrences[1].id, { roomId: "room-102" });
```

Neither of these touches the template's rule — the recurring pattern is
untouched, only that one date's occurrence changes.

### Step 8 — check a manual booking before committing it

If you're building a manual scheduling UI (rather than relying solely on
the solver), validate a candidate slot before saving it:

```ts
const check = await service.checkAll(
  candidateOccurrence,
  {
    teacherIds: ["teacher-jane"],
    roomId: "room-lab",
    groupId: "physics-101-sectionA",
    startTime: "10:00",
    endTime: "10:50",
  },
  { minCapacity: 22, requiredFeatures: ["lab"] },
);

if (!check.ok) {
  console.log(check.conflicts); // double-bookings, if any
  console.log(check.availabilityViolations); // outside declared hours, if any
  console.log(check.roomViolation); // capacity/feature mismatch, if any
}
```

---

## Where to go from here

- Read `SCHEDULING.md` in full before relying on the solver in production —
  in particular the "Known limitations" section (no soft-constraint
  optimization, the `interval > 1` availability limitation, and the
  one-room-per-week-per-template assumption).
- Read `OTHER_MODULES.md` for the complete type/method reference of every
  other module.
- Run `bun test` after extracting this project to confirm the existing test
  suite passes in your environment — see `SCHEDULING.md`'s "A note on how
  this was verified" for context on how these tests were last exercised.
