import { describe, it, expect } from "bun:test";
import {
  PrerequisiteService,
  CircularPrerequisiteError,
  PrerequisiteNotMetError,
  EnrollmentService,
} from "../src/domains/enrollment/index.js";
import type {
  CoursePrerequisite,
  CoursePrerequisiteRepository,
  Course,
  CourseSection,
  Enrollment,
  Identity,
  RepositoryContext,
  ActorContext,
} from "../src/core/index.js";
import {
  createRolePolicy,
  PermissionDeniedError,
  ActorRequiredError,
} from "../src/core/index.js";

const as = (actorId: string): ActorContext => ({ actorId });

describe("PrerequisiteService (without enforcement)", () => {
  function buildService(opts?: {
    courses?: Course[];
    sections?: CourseSection[];
    enrollments?: Enrollment[];
    gradeSource?: {
      getCourseGrade(userId: string, courseId: string): Promise<number | null>;
    };
  }) {
    const prereqStore: CoursePrerequisite[] = [];
    const coursesStore: Course[] = opts?.courses ?? [
      { id: "math-101", orgId: "org-1", title: "Calculus I" },
      { id: "math-102", orgId: "org-1", title: "Calculus II" },
      { id: "math-201", orgId: "org-1", title: "Multivariable Calculus" },
      { id: "phys-101", orgId: "org-1", title: "Physics I" },
      { id: "phys-101-lab", orgId: "org-1", title: "Physics I Lab" },
      { id: "art-101", orgId: "org-2", title: "Intro to Art" },
    ];
    const sectionsStore: CourseSection[] = opts?.sections ?? [
      { id: "sec-m101", courseId: "math-101", status: "published" },
      { id: "sec-m102", courseId: "math-102", status: "published" },
      { id: "sec-m201", courseId: "math-201", status: "published" },
      { id: "sec-p101", courseId: "phys-101", status: "published" },
      { id: "sec-plab", courseId: "phys-101-lab", status: "published" },
    ];
    const enrollmentsStore: Enrollment[] = opts?.enrollments
      ? [...opts.enrollments]
      : [];

    const prereqRepo: CoursePrerequisiteRepository = {
      add: async (p) => {
        const created: CoursePrerequisite = {
          ...p,
          id: `pr-${prereqStore.length + 1}`,
        };
        prereqStore.push(created);
        return created;
      },
      remove: async (id) => {
        const idx = prereqStore.findIndex((p) => p.id === id);
        if (idx >= 0) {
          prereqStore.splice(idx, 1);
          return true;
        }
        return false;
      },
      listByCourse: async (courseId) =>
        prereqStore.filter((p) => p.courseId === courseId),
    };

    const repos: RepositoryContext = {
      coursePrerequisites: prereqRepo,
      users: {
        findById: async () => null,
        findByExternalRef: async () => null,
      },
      courses: {
        findCourse: async (id) => coursesStore.find((c) => c.id === id) ?? null,
        findSection: async (id) =>
          sectionsStore.find((s) => s.id === id) ?? null,
        listSections: async (courseId) =>
          sectionsStore.filter((s) => s.courseId === courseId),
      },
      enrollments: {
        create: async (e) => {
          const rec: Enrollment = {
            ...e,
            id: `enr-${enrollmentsStore.length + 1}`,
          };
          enrollmentsStore.push(rec);
          return rec;
        },
        findById: async (id) =>
          enrollmentsStore.find((e) => e.id === id) ?? null,
        update: async (id, patch) => {
          const item = enrollmentsStore.find((e) => e.id === id);
          if (!item) throw new Error("not found");
          Object.assign(item, patch);
          return item;
        },
        findByUserAndSection: async (userId, sectionId) =>
          enrollmentsStore.find(
            (e) => e.userId === userId && e.sectionId === sectionId,
          ) ?? null,
        listBySection: async (secId, status) =>
          enrollmentsStore.filter(
            (e) => e.sectionId === secId && (!status || e.status === status),
          ),
        countActive: async (secId) =>
          enrollmentsStore.filter(
            (e) => e.sectionId === secId && e.status === "active",
          ).length,
      },
      content: {
        findById: async () => null,
        listBySection: async () => [],
        create: async () => ({}) as never,
        update: async () => ({}) as never,
        reorder: async () => {},
      },
      terms: { findById: async () => null },
    };

    const service = new PrerequisiteService(repos, {
      ...(opts?.gradeSource !== undefined
        ? { gradeSource: opts.gradeSource }
        : {}),
    });
    return { service, repos, prereqStore, enrollmentsStore };
  }

  it("throws an error if coursePrerequisites repository is missing", async () => {
    const reposWithoutRepo: RepositoryContext = {
      users: {
        findById: async () => null,
        findByExternalRef: async () => null,
      },
      courses: {
        findCourse: async () => null,
        findSection: async () => null,
        listSections: async () => [],
      },
      enrollments: {
        create: async () => ({}) as never,
        findById: async () => null,
        update: async () => ({}) as never,
        findByUserAndSection: async () => null,
        listBySection: async () => [],
        countActive: async () => 0,
      },
      content: {
        findById: async () => null,
        listBySection: async () => [],
        create: async () => ({}) as never,
        update: async () => ({}) as never,
        reorder: async () => {},
      },
      terms: { findById: async () => null },
    };
    const svc = new PrerequisiteService(reposWithoutRepo);
    await expect(
      svc.addPrerequisite({ courseId: "c1", requiredCourseId: "c2" }),
    ).rejects.toThrow("CoursePrerequisiteRepository is required");
  });

  it("adds a prerequisite successfully and lists it", async () => {
    const { service } = buildService();
    const prereq = await service.addPrerequisite({
      courseId: "math-102",
      requiredCourseId: "math-101",
      minGrade: 70,
    });
    expect(prereq.id).toBeDefined();
    expect(prereq.courseId).toBe("math-102");
    expect(prereq.requiredCourseId).toBe("math-101");
    expect(prereq.minGrade).toBe(70);

    const list = await service.listPrerequisites("math-102");
    expect(list.length).toBe(1);
    expect(list[0]?.id).toBe(prereq.id);
  });

  it("removes an existing prerequisite", async () => {
    const { service } = buildService();
    const prereq = await service.addPrerequisite({
      courseId: "math-102",
      requiredCourseId: "math-101",
    });
    const removed = await service.removePrerequisite(prereq.id);
    expect(removed).toBe(true);

    const list = await service.listPrerequisites("math-102");
    expect(list).toEqual([]);

    const removeAgain = await service.removePrerequisite(prereq.id);
    expect(removeAgain).toBe(false);
  });

  it("fails if the target course does not exist", async () => {
    const { service } = buildService();
    await expect(
      service.addPrerequisite({
        courseId: "nonexistent",
        requiredCourseId: "math-101",
      }),
    ).rejects.toThrow("Course nonexistent not found");
  });

  it("fails if the required course does not exist", async () => {
    const { service } = buildService();
    await expect(
      service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "nonexistent",
      }),
    ).rejects.toThrow("Course nonexistent not found");
  });

  it("fails if courses belong to different organizations", async () => {
    const { service } = buildService();
    await expect(
      service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "art-101",
      }),
    ).rejects.toThrow();
  });

  describe("cycle detection", () => {
    it("detects and rejects a direct self-prerequisite (course requires itself)", async () => {
      const { service } = buildService();
      await expect(
        service.addPrerequisite({
          courseId: "math-101",
          requiredCourseId: "math-101",
        }),
      ).rejects.toBeInstanceOf(CircularPrerequisiteError);
    });

    it("detects and rejects a 2-step cycle (A requires B, then B requires A)", async () => {
      const { service } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });

      await expect(
        service.addPrerequisite({
          courseId: "math-101",
          requiredCourseId: "math-102",
        }),
      ).rejects.toBeInstanceOf(CircularPrerequisiteError);
    });

    it("detects and rejects a multi-step cycle (A -> B -> C, then C requires A)", async () => {
      const { service } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });
      await service.addPrerequisite({
        courseId: "math-201",
        requiredCourseId: "math-102",
      });

      // math-201 depends on math-102 depends on math-101.
      // Attempting to make math-101 require math-201 creates a cycle!
      await expect(
        service.addPrerequisite({
          courseId: "math-101",
          requiredCourseId: "math-201",
        }),
      ).rejects.toBeInstanceOf(CircularPrerequisiteError);
    });

    it("permits a diamond dependency without false positives", async () => {
      const { service } = buildService();
      // math-102 requires math-101
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });
      // phys-101 requires math-101
      await service.addPrerequisite({
        courseId: "phys-101",
        requiredCourseId: "math-101",
      });
      // math-201 requires math-102 and phys-101 (diamond convergence on math-101)
      await service.addPrerequisite({
        courseId: "math-201",
        requiredCourseId: "math-102",
      });
      await expect(
        service.addPrerequisite({
          courseId: "math-201",
          requiredCourseId: "phys-101",
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("getPrerequisiteSequence", () => {
    it("returns empty array when course has no prerequisites", async () => {
      const { service } = buildService();
      const seq = await service.getPrerequisiteSequence("math-101");
      expect(seq).toEqual([]);
    });

    it("returns topological sequence leading up to the target course", async () => {
      const { service } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });
      await service.addPrerequisite({
        courseId: "math-201",
        requiredCourseId: "math-102",
      });

      const seq = await service.getPrerequisiteSequence("math-201");
      expect(seq).toEqual(["math-101", "math-102"]);
    });

    it("includes self when includeSelf: true is passed", async () => {
      const { service } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });
      const seq = await service.getPrerequisiteSequence("math-102", {
        includeSelf: true,
      });
      expect(seq).toEqual(["math-101", "math-102"]);
    });

    it("returns deduplicated topological sequence for diamond graphs", async () => {
      const { service } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });
      await service.addPrerequisite({
        courseId: "phys-101",
        requiredCourseId: "math-101",
      });
      await service.addPrerequisite({
        courseId: "math-201",
        requiredCourseId: "math-102",
      });
      await service.addPrerequisite({
        courseId: "math-201",
        requiredCourseId: "phys-101",
      });

      const seq = await service.getPrerequisiteSequence("math-201");
      // math-101 must precede both math-102 and phys-101, and appear only once
      expect(seq.indexOf("math-101")).toBe(0);
      expect(seq).toContain("math-102");
      expect(seq).toContain("phys-101");
      expect(seq.length).toBe(3);
    });

    it("detects cycles during sequence resolution and throws CircularPrerequisiteError", async () => {
      const { service, prereqStore } = buildService();
      prereqStore.push(
        { id: "p1", courseId: "math-201", requiredCourseId: "math-102" },
        { id: "p2", courseId: "math-102", requiredCourseId: "math-201" },
      );
      await expect(
        service.getPrerequisiteSequence("math-201"),
      ).rejects.toBeInstanceOf(CircularPrerequisiteError);
    });
  });

  describe("checkPrerequisites", () => {
    it("passes when course has no prerequisites", async () => {
      const { service } = buildService();
      const res = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-101",
      });
      expect(res.satisfied).toBe(true);
      expect(res.unmet).toEqual([]);
    });

    it("fails with reason not_completed when student has no enrollment in required course", async () => {
      const { service } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });

      const res = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-102",
      });
      expect(res.satisfied).toBe(false);
      expect(res.unmet.length).toBe(1);
      expect(res.unmet[0]?.reason).toBe("not_completed");
      expect(res.unmet[0]?.prerequisite.requiredCourseId).toBe("math-101");
    });

    it("fails with reason not_completed when student enrollment is only active or dropped, not completed", async () => {
      const { service, enrollmentsStore } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });

      // Student is currently active in math-101 (not completed)
      enrollmentsStore.push({
        id: "e1",
        userId: "stu-1",
        sectionId: "sec-m101",
        role: "student",
        status: "active",
        enrolledAt: new Date(),
      });

      const res = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-102",
      });
      expect(res.satisfied).toBe(false);
      expect(res.unmet[0]?.reason).toBe("not_completed");
    });

    it("passes when student completed the required course and no minGrade is specified", async () => {
      const { service, enrollmentsStore } = buildService();
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
      });

      enrollmentsStore.push({
        id: "e1",
        userId: "stu-1",
        sectionId: "sec-m101",
        role: "student",
        status: "completed",
        enrolledAt: new Date(),
      });

      const res = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-102",
      });
      expect(res.satisfied).toBe(true);
      expect(res.unmet).toEqual([]);
    });

    it("enforces minGrade when gradeSource is provided", async () => {
      const grades = new Map<string, number>();
      const gradeSource = {
        getCourseGrade: async (userId: string, courseId: string) =>
          grades.get(`${userId}:${courseId}`) ?? null,
      };

      const { service, enrollmentsStore } = buildService({ gradeSource });
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
        minGrade: 75,
      });

      enrollmentsStore.push({
        id: "e1",
        userId: "stu-1",
        sectionId: "sec-m101",
        role: "student",
        status: "completed",
        enrolledAt: new Date(),
      });

      // Grade 68 < 75 -> fails
      grades.set("stu-1:math-101", 68);
      const failRes = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-102",
      });
      expect(failRes.satisfied).toBe(false);
      expect(failRes.unmet[0]?.reason).toBe("insufficient_grade");
      expect(failRes.unmet[0]?.currentGrade).toBe(68);

      // Grade 80 >= 75 -> passes
      grades.set("stu-1:math-101", 80);
      const passRes = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-102",
      });
      expect(passRes.satisfied).toBe(true);
      expect(passRes.unmet).toEqual([]);
    });

    it("fails with insufficient_grade when minGrade is required but gradeSource is missing or returns null", async () => {
      const { service, enrollmentsStore } = buildService(); // no gradeSource
      await service.addPrerequisite({
        courseId: "math-102",
        requiredCourseId: "math-101",
        minGrade: 70,
      });

      enrollmentsStore.push({
        id: "e1",
        userId: "stu-1",
        sectionId: "sec-m101",
        role: "student",
        status: "completed",
        enrolledAt: new Date(),
      });

      const res = await service.checkPrerequisites({
        userId: "stu-1",
        courseId: "math-102",
      });
      expect(res.satisfied).toBe(false);
      expect(res.unmet[0]?.reason).toBe("insufficient_grade");
      expect(res.unmet[0]?.currentGrade).toBeUndefined();
    });

    describe("corequisites (isCorequisite: true)", () => {
      it("satisfies a corequisite if the student is currently ACTIVE in any section of required course", async () => {
        const { service, enrollmentsStore } = buildService();
        await service.addPrerequisite({
          courseId: "phys-101",
          requiredCourseId: "phys-101-lab",
          isCorequisite: true,
        });

        // Student is concurrently active in the lab section
        enrollmentsStore.push({
          id: "e-lab",
          userId: "stu-1",
          sectionId: "sec-plab",
          role: "student",
          status: "active",
          enrolledAt: new Date(),
        });

        const res = await service.checkPrerequisites({
          userId: "stu-1",
          courseId: "phys-101",
        });
        expect(res.satisfied).toBe(true);
      });

      it("satisfies a corequisite if the student has already COMPLETED the required course", async () => {
        const { service, enrollmentsStore } = buildService();
        await service.addPrerequisite({
          courseId: "phys-101",
          requiredCourseId: "phys-101-lab",
          isCorequisite: true,
        });

        enrollmentsStore.push({
          id: "e-lab",
          userId: "stu-1",
          sectionId: "sec-plab",
          role: "student",
          status: "completed",
          enrolledAt: new Date(),
        });

        const res = await service.checkPrerequisites({
          userId: "stu-1",
          courseId: "phys-101",
        });
        expect(res.satisfied).toBe(true);
      });

      it("fails with reason not_active_corequisite when neither active nor completed", async () => {
        const { service, enrollmentsStore } = buildService();
        await service.addPrerequisite({
          courseId: "phys-101",
          requiredCourseId: "phys-101-lab",
          isCorequisite: true,
        });

        enrollmentsStore.push({
          id: "e-lab",
          userId: "stu-1",
          sectionId: "sec-plab",
          role: "student",
          status: "dropped",
          enrolledAt: new Date(),
        });

        const res = await service.checkPrerequisites({
          userId: "stu-1",
          courseId: "phys-101",
        });
        expect(res.satisfied).toBe(false);
        expect(res.unmet[0]?.reason).toBe("not_active_corequisite");
      });

      it("enforces minGrade for a completed corequisite", async () => {
        const grades = new Map<string, number>();
        const gradeSource = {
          getCourseGrade: async (userId: string, courseId: string) =>
            grades.get(`${userId}:${courseId}`) ?? null,
        };
        const { service, enrollmentsStore } = buildService({ gradeSource });
        await service.addPrerequisite({
          courseId: "phys-101",
          requiredCourseId: "phys-101-lab",
          isCorequisite: true,
          minGrade: 75,
        });

        enrollmentsStore.push({
          id: "e-lab",
          userId: "stu-1",
          sectionId: "sec-plab",
          role: "student",
          status: "completed",
          enrolledAt: new Date(),
        });

        // Grade 70 < 75 fails
        grades.set("stu-1:phys-101-lab", 70);
        const failRes = await service.checkPrerequisites({
          userId: "stu-1",
          courseId: "phys-101",
        });
        expect(failRes.satisfied).toBe(false);
        expect(failRes.unmet[0]?.reason).toBe("insufficient_grade");

        // Grade 85 >= 75 passes
        grades.set("stu-1:phys-101-lab", 85);
        const passRes = await service.checkPrerequisites({
          userId: "stu-1",
          courseId: "phys-101",
        });
        expect(passRes.satisfied).toBe(true);
      });
    });
  });
});

describe("PrerequisiteService (with permissions and tenancy)", () => {
  function buildEnforcedService() {
    const policy = createRolePolicy();
    const prereqStore: CoursePrerequisite[] = [];

    const users: Identity[] = [
      { id: "admin-1", externalRef: "adm1", roles: ["admin"], orgId: "org-1" },
      {
        id: "inst-1",
        externalRef: "ins1",
        roles: ["instructor"],
        orgId: "org-1",
      },
      { id: "ta-1", externalRef: "ta1", roles: ["ta"], orgId: "org-1" },
      { id: "stu-1", externalRef: "st1", roles: ["student"], orgId: "org-1" },
      { id: "stu-2", externalRef: "st2", roles: ["student"], orgId: "org-1" },
      {
        id: "admin-org2",
        externalRef: "adm2",
        roles: ["admin"],
        orgId: "org-2",
      },
    ];

    const courses: Course[] = [
      { id: "c-101", orgId: "org-1", title: "Course 101" },
      { id: "c-102", orgId: "org-1", title: "Course 102" },
      { id: "c-org2", orgId: "org-2", title: "Course Org 2" },
    ];

    const prereqRepo: CoursePrerequisiteRepository = {
      add: async (p) => {
        const created: CoursePrerequisite = {
          ...p,
          id: `pr-${prereqStore.length + 1}`,
        };
        prereqStore.push(created);
        return created;
      },
      remove: async (id) => {
        const idx = prereqStore.findIndex((p) => p.id === id);
        if (idx >= 0) {
          prereqStore.splice(idx, 1);
          return true;
        }
        return false;
      },
      listByCourse: async (courseId) =>
        prereqStore.filter((p) => p.courseId === courseId),
    };

    const repos: RepositoryContext = {
      coursePrerequisites: prereqRepo,
      users: {
        findById: async (id) => users.find((u) => u.id === id) ?? null,
        findByExternalRef: async (ref) =>
          users.find((u) => u.externalRef === ref) ?? null,
      },
      courses: {
        findCourse: async (id) => courses.find((c) => c.id === id) ?? null,
        findSection: async () => null,
        listSections: async () => [],
      },
      enrollments: {
        create: async () => ({}) as never,
        findById: async () => null,
        update: async () => ({}) as never,
        findByUserAndSection: async () => null,
        listBySection: async () => [],
        countActive: async () => 0,
      },
      content: {
        findById: async () => null,
        listBySection: async () => [],
        create: async () => ({}) as never,
        update: async () => ({}) as never,
        reorder: async () => {},
      },
      terms: { findById: async () => null },
    };

    const service = new PrerequisiteService(repos, { policy });
    return { service, prereqStore };
  }

  it("requires an actor when policy is present", async () => {
    const { service } = buildEnforcedService();
    await expect(
      service.addPrerequisite({ courseId: "c-102", requiredCourseId: "c-101" }),
    ).rejects.toBeInstanceOf(ActorRequiredError);
  });

  it("allows admin and instructor to add prerequisites", async () => {
    const { service } = buildEnforcedService();
    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-101" },
        as("admin-1"),
      ),
    ).resolves.toBeDefined();

    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-101" },
        as("inst-1"),
      ),
    ).resolves.toBeDefined();
  });

  it("denies TA and student from adding prerequisites", async () => {
    const { service } = buildEnforcedService();
    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-101" },
        as("ta-1"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-101" },
        as("stu-1"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("denies cross-tenant admin from adding prerequisites to another organization course", async () => {
    const { service } = buildEnforcedService();
    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-101" },
        as("admin-org2"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-org2" },
        as("admin-org2"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(
      service.addPrerequisite(
        { courseId: "c-102", requiredCourseId: "c-org2" },
        as("admin-1"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("allows staff to remove prerequisites but denies student", async () => {
    const { service } = buildEnforcedService();
    const created = await service.addPrerequisite(
      { courseId: "c-102", requiredCourseId: "c-101" },
      as("admin-1"),
    );

    await expect(
      service.removePrerequisite(created.id, as("stu-1")),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      service.removePrerequisite(created.id, as("admin-1")),
    ).resolves.toBe(true);
  });

  it("allows a student to check their own prerequisites", async () => {
    const { service } = buildEnforcedService();
    const res = await service.checkPrerequisites(
      { userId: "stu-1", courseId: "c-101" },
      as("stu-1"),
    );
    expect(res.satisfied).toBe(true);
  });

  it("denies a student from checking another student prerequisites", async () => {
    const { service } = buildEnforcedService();
    await expect(
      service.checkPrerequisites(
        { userId: "stu-2", courseId: "c-101" },
        as("stu-1"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("allows staff to check any student prerequisites", async () => {
    const { service } = buildEnforcedService();
    const res = await service.checkPrerequisites(
      { userId: "stu-1", courseId: "c-101" },
      as("inst-1"),
    );
    expect(res.satisfied).toBe(true);
  });
});

describe("EnrollmentService prerequisite gating integration", () => {
  function buildEnrollmentSetup(opts?: { enforcePrerequisites?: boolean }) {
    const coursesStore: Course[] = [
      { id: "math-101", orgId: "org-1", title: "Calculus I" },
      { id: "math-102", orgId: "org-1", title: "Calculus II" },
    ];
    const sectionsStore: CourseSection[] = [
      { id: "sec-101", courseId: "math-101", status: "published" },
      { id: "sec-102", courseId: "math-102", status: "published" },
    ];
    const prereqStore: CoursePrerequisite[] = [
      { id: "pr-1", courseId: "math-102", requiredCourseId: "math-101" },
    ];
    const enrollmentsStore: Enrollment[] = [];

    const repos: RepositoryContext = {
      coursePrerequisites: {
        add: async (p) => ({ ...p, id: "pr-new" }),
        remove: async () => true,
        listByCourse: async (courseId) =>
          prereqStore.filter((p) => p.courseId === courseId),
      },
      users: {
        findById: async (id) => ({
          id,
          externalRef: id,
          roles: ["student"],
          orgId: "org-1",
        }),
        findByExternalRef: async () => null,
      },
      courses: {
        findCourse: async (id) => coursesStore.find((c) => c.id === id) ?? null,
        findSection: async (id) =>
          sectionsStore.find((s) => s.id === id) ?? null,
        listSections: async (courseId) =>
          sectionsStore.filter((s) => s.courseId === courseId),
      },
      enrollments: {
        create: async (e) => {
          const rec: Enrollment = {
            ...e,
            id: `enr-${enrollmentsStore.length + 1}`,
          };
          enrollmentsStore.push(rec);
          return rec;
        },
        findById: async (id) =>
          enrollmentsStore.find((e) => e.id === id) ?? null,
        update: async (id, patch) => {
          const item = enrollmentsStore.find((e) => e.id === id);
          if (!item) throw new Error("not found");
          Object.assign(item, patch);
          return item;
        },
        findByUserAndSection: async (userId, sectionId) =>
          enrollmentsStore.find(
            (e) => e.userId === userId && e.sectionId === sectionId,
          ) ?? null,
        listBySection: async (secId, status) =>
          enrollmentsStore.filter(
            (e) => e.sectionId === secId && (!status || e.status === status),
          ),
        countActive: async (secId) =>
          enrollmentsStore.filter(
            (e) => e.sectionId === secId && e.status === "active",
          ).length,
      },
      content: {
        findById: async () => null,
        listBySection: async () => [],
        create: async () => ({}) as never,
        update: async () => ({}) as never,
        reorder: async () => {},
      },
      terms: { findById: async () => null },
    };

    const enrollmentService = new EnrollmentService(repos, undefined, {
      ...(opts?.enforcePrerequisites !== undefined
        ? { enforcePrerequisites: opts.enforcePrerequisites }
        : {}),
    });

    return { enrollmentService, enrollmentsStore };
  }

  it("allows enrollment when enforcePrerequisites is false (default behaviour)", async () => {
    const { enrollmentService } = buildEnrollmentSetup({
      enforcePrerequisites: false,
    });
    // Student has not taken math-101, enrolling in math-102
    const enr = await enrollmentService.enroll({
      userId: "stu-1",
      sectionId: "sec-102",
      role: "student",
    });
    expect(enr.status).toBe("active");
  });

  it("blocks student enrollment with PrerequisiteNotMetError when prerequisites are unmet and gating is enabled", async () => {
    const { enrollmentService } = buildEnrollmentSetup({
      enforcePrerequisites: true,
    });
    // Student has not taken math-101
    const err = await enrollmentService
      .enroll({
        userId: "stu-1",
        sectionId: "sec-102",
        role: "student",
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(PrerequisiteNotMetError);
    expect((err as PrerequisiteNotMetError).courseId).toBe("math-102");
    expect((err as PrerequisiteNotMetError).unmet.length).toBe(1);
    expect((err as PrerequisiteNotMetError).unmet[0]?.reason).toBe(
      "not_completed",
    );
  });

  it("allows student enrollment when prerequisites are satisfied", async () => {
    const { enrollmentService, enrollmentsStore } = buildEnrollmentSetup({
      enforcePrerequisites: true,
    });
    // Student completed math-101
    enrollmentsStore.push({
      id: "e-prev",
      userId: "stu-1",
      sectionId: "sec-101",
      role: "student",
      status: "completed",
      enrolledAt: new Date(),
    });

    const enr = await enrollmentService.enroll({
      userId: "stu-1",
      sectionId: "sec-102",
      role: "student",
    });
    expect(enr.status).toBe("active");
  });

  it("allows student enrollment when overridePrerequisites: true is passed", async () => {
    const { enrollmentService } = buildEnrollmentSetup({
      enforcePrerequisites: true,
    });
    // Prerequisite math-101 is NOT satisfied, but staff provided override
    const enr = await enrollmentService.enroll({
      userId: "stu-1",
      sectionId: "sec-102",
      role: "student",
      overridePrerequisites: true,
    });
    expect(enr.status).toBe("active");
  });

  it("skips prerequisite check for non-student roles (e.g. instructor or TA)", async () => {
    const { enrollmentService } = buildEnrollmentSetup({
      enforcePrerequisites: true,
    });
    const enr = await enrollmentService.enroll({
      userId: "teacher-1",
      sectionId: "sec-102",
      role: "instructor",
    });
    expect(enr.status).toBe("active");
  });
});
