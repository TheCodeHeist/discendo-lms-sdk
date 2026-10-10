import { describe, it, expect } from "bun:test";
import { GradingService } from "../src/domains/grading/index.js";
import type {
  GradeRepository,
  SubmissionLocation,
  GradeEntry,
} from "../src/domains/grading/index.js";
import { EventBus, createRolePolicy } from "../src/core/index.js";
import type {
  RepositoryContext,
  Enrollment,
} from "../src/core/index.js";

function makeGradeRepo(): GradeRepository {
  const entries = new Map<string, GradeEntry>();
  let counter = 0;
  return {
    create: async (e) => {
      counter++;
      const entry: GradeEntry = { ...e, id: `grade-${counter}` };
      entries.set(entry.id, entry);
      return entry;
    },
    findById: async (id) => entries.get(id) ?? null,
    markSuperseded: async (id, byId) => {
      const existing = entries.get(id);
      if (existing) entries.set(id, { ...existing, supersededBy: byId });
    },
    listForUserInSection: async (userId) =>
      [...entries.values()]
        .filter((e) => e.userId === userId)
        .map((e) => ({ ...e, category: "default" })),
  };
}

describe("GradingService event emission", () => {
  it("emits grading.gradePosted when a grade is recorded", async () => {
    const repo = makeGradeRepo();
    const bus = new EventBus();
    const received: Array<{ score: number; maxScore: number }> = [];
    bus.on("grading.gradePosted", (e) => {
      received.push(e);
    });

    const service = new GradingService(repo, bus);
    await service.recordGrade("sub-1", "user-1", 85, 100, "grader-1");
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.score).toBe(85);
    expect(received[0]?.maxScore).toBe(100);
  });

  it("carries contentId and orgId when enforcement and submission locator provide them", async () => {
    const repo = makeGradeRepo();
    const bus = new EventBus();
    const received: any[] = [];
    bus.on("grading.gradePosted", (e) => {
      received.push(e);
    });

    const enrollments: Enrollment[] = [
      {
        id: "enr-teacher",
        userId: "teacher-1",
        sectionId: "sec-1",
        role: "instructor",
        status: "active",
        enrolledAt: new Date(),
      },
      {
        id: "enr-student",
        userId: "user-1",
        sectionId: "sec-1",
        role: "student",
        status: "active",
        enrolledAt: new Date(),
      },
    ];
    const repos: RepositoryContext = {
      users: {
        findById: async (id) => ({
          id,
          roles: [id.startsWith("teacher") ? "instructor" : "student"],
          orgId: "org-1",
        }),
        findByExternalRef: async () => null,
      },
      courses: {
        findCourse: async (id) => ({ id, title: "Course", orgId: "org-1" }),
        findSection: async (id) => ({
          id,
          courseId: "c-1",
          status: "published",
        }),
        listSections: async () => [],
      },
      enrollments: {
        create: async (e) => ({ ...e, id: "e1" }),
        update: async (id, patch) => ({
          id,
          userId: "u",
          sectionId: "s",
          role: "student",
          status: "active",
          enrolledAt: new Date(),
          ...patch,
        }),
        findById: async () => null,
        findByUserAndSection: async (userId, sectionId) =>
          enrollments.find(
            (e) => e.userId === userId && e.sectionId === sectionId,
          ) ?? null,
        listBySection: async () => enrollments,
        countActive: async () => 0,
      },
      content: {
        findById: async () => null,
        listBySection: async () => [],
        create: async (x) => ({ ...x, id: "c", version: 1 }),
        update: async (id, patch) => ({
          id,
          sectionId: "s",
          kind: "page",
          title: "",
          orderIndex: 0,
          published: false,
          version: 1,
          ...patch,
        }),
        reorder: async () => {},
      },
      terms: { findById: async () => null },
    };

    const submissions = {
      locate: async (subId: string): Promise<SubmissionLocation | null> => ({
        sectionId: "sec-1",
        userId: "user-1",
        contentId: "content-100",
      }),
    };

    const service = new GradingService(repo, bus, {
      policy: createRolePolicy(),
      repos,
      submissions,
    });

    await service.recordGrade(
      "sub-1",
      "user-1",
      95,
      100,
      "teacher-1",
      undefined,
      { actorId: "teacher-1" },
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      score: 95,
      maxScore: 100,
      contentId: "content-100",
      orgId: "org-1",
    });
  });

  it("emits once per recordGrade call, even when superseding a previous entry", async () => {
    const repo = makeGradeRepo();
    const bus = new EventBus();
    let count = 0;
    bus.on("grading.gradePosted", () => {
      count++;
    });

    const service = new GradingService(repo, bus);
    const first = await service.recordGrade(
      "sub-1",
      "user-1",
      70,
      100,
      "grader-1",
    );
    await service.recordGrade("sub-1", "user-1", 90, 100, "grader-1", first.id);
    await new Promise((r) => setTimeout(r, 0));

    expect(count).toBe(2);
  });

  it("works with no EventBus supplied at all", async () => {
    const repo = makeGradeRepo();
    const service = new GradingService(repo); // no bus
    const entry = await service.recordGrade(
      "sub-1",
      "user-1",
      85,
      100,
      "grader-1",
    );
    expect(entry.score).toBe(85);
  });
});
