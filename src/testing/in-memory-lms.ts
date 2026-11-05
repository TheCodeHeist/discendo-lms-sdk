/**
 * `createInMemoryLms()`: every repository the SDK defines, in memory, and every service built on
 * them and wired to each other, in one call. For tests, demos, prototypes and trying the SDK out
 * before writing any database code. Swap a repository for your own and everything else keeps
 * working, because each service only sees the interface.
 *
 * This file sits at the package root (like `src/index.ts`), so it may import every module: it is
 * the one place where the modules are wired together on the host's behalf.
 */
import { EventBus } from '../core/events.js';
import { createRolePolicy } from '../core/permissions.js';
import type { PermissionPolicy } from '../core/permissions.js';
import type { AuthorizationRepos } from '../core/authorization.js';
import type { ContentNode, RepositoryContext } from '../core/index.js';
import {
  InMemoryContentRepository,
  InMemoryCoursePrerequisiteRepository,
  InMemoryCourseRepository,
  InMemoryDelegationRepository,
  InMemoryDepartmentRepository,
  InMemoryEnrollmentRepository,
  InMemoryEnrollmentRequestRepository,
  InMemoryGroupRepository,
  InMemoryGuardianLinkRepository,
  InMemoryOrganizationRepository,
  InMemoryTermRepository,
  InMemoryUserRepository,
} from '../core/testing/in-memory.js';
import { EnrollmentRequestService, EnrollmentService, GroupService, PrerequisiteService } from '../domains/enrollment/index.js';
import { ContentService, type PrerequisiteEdge } from '../domains/content/index.js';
import { InMemoryCompletionTracker } from '../domains/content/testing/in-memory.js';
import { AssessmentService, PeerReviewService, RubricService } from '../domains/assessment/index.js';
import {
  InMemoryPeerReviewRepository,
  InMemoryQuizRepository,
  InMemoryRubricEvaluationRepository,
  InMemoryRubricRepository,
  InMemorySubmissionRepository,
} from '../domains/assessment/testing/in-memory.js';
import { AccommodationService, GradingService } from '../domains/grading/index.js';
import {
  InMemoryExcusalRepository,
  InMemoryGradeReleaseRepository,
  InMemoryGradeRepository,
  InMemoryTimeExtensionRepository,
} from '../domains/grading/testing/in-memory.js';
import { DelegationService } from '../domains/delegation/index.js';
import { GuardianService } from '../domains/guardians/index.js';
import { SchedulingService } from '../domains/scheduling/index.js';
import { InMemorySchedulingRepository } from '../domains/scheduling/testing/in-memory-repository.js';
import { CommunicationService } from '../services/communication/index.js';
import {
  InMemoryAnnouncementRepository,
  InMemoryThreadRepository,
  RecordingNotificationSink,
} from '../services/communication/testing/in-memory.js';
import { ReportingService } from '../services/reporting/index.js';
import { InMemoryAttendanceRepository } from '../services/reporting/testing/in-memory.js';
import { AdminService } from '../services/admin/index.js';
import { InMemoryAuditRepository } from '../services/admin/testing/in-memory.js';

/** The grader name quiz auto-grading records under. */
export const IN_MEMORY_QUIZ_GRADER = 'system:quiz';

export interface InMemoryLmsOptions {
  /**
   * Turn permission enforcement on in every service that has it (default `true`, as a real
   * deployment should). Every call then needs an `{ actorId }` naming a seeded user. Services that
   * always enforce (delegation, guardians, enrollment requests, accommodations) do so either way.
   */
  enforce?: boolean;
  /** The policy to enforce. Default: `createRolePolicy()`, the SDK's built-in rules. */
  policy?: PermissionPolicy & { delegableActions?: readonly string[] };
  /** The event bus every service emits to. Default: a new `EventBus`. */
  bus?: EventBus;
  /** Content prerequisites for `ContentService.isUnlocked`. Default: none. */
  contentPrerequisites?: PrerequisiteEdge[];
  /**
   * The grading-scheme category a piece of content's grades count towards. Default: its `kind`
   * (`assignment`, `quiz`, ...), so a `GradingScheme` with those category names works as is.
   */
  categoryOf?: (content: ContentNode) => string;
  /**
   * `'immediate'` (default): a grade is visible to the student as soon as it is recorded.
   * `'manual'`: grades are held until staff release them (`grading.releaseGrades`).
   */
  gradeRelease?: 'immediate' | 'manual';
}

export type InMemoryLms = ReturnType<typeof createInMemoryLms>;

export function createInMemoryLms(options: InMemoryLmsOptions = {}) {
  const enforce = options.enforce ?? true;
  const bus = options.bus ?? new EventBus();
  const policy = options.policy ?? createRolePolicy();
  const categoryOf = options.categoryOf ?? ((content: ContentNode) => content.kind);

  // ---- repositories ----
  const users = new InMemoryUserRepository();
  const courses = new InMemoryCourseRepository();
  const enrollments = new InMemoryEnrollmentRepository();
  const content = new InMemoryContentRepository();
  const terms = new InMemoryTermRepository();
  const organizations = new InMemoryOrganizationRepository();
  const departments = new InMemoryDepartmentRepository();
  const enrollmentRequests = new InMemoryEnrollmentRequestRepository();
  const delegations = new InMemoryDelegationRepository();
  const guardianLinks = new InMemoryGuardianLinkRepository();
  const groups = new InMemoryGroupRepository();
  const coursePrerequisites = new InMemoryCoursePrerequisiteRepository();

  const submissions = new InMemorySubmissionRepository();
  const quizzes = new InMemoryQuizRepository();
  const rubrics = new InMemoryRubricRepository();
  const rubricEvaluations = new InMemoryRubricEvaluationRepository();
  const peerReviews = new InMemoryPeerReviewRepository();

  // A grade only names its submission; its section, category and content come from the
  // submission's content node, as a database join would.
  const placementOf = async (submissionId: string) => {
    const submission = await submissions.findById(submissionId);
    const node = submission ? await content.findById(submission.contentId) : null;
    return submission && node
      ? { submission, node, placement: { sectionId: node.sectionId, category: categoryOf(node), contentId: node.id } }
      : null;
  };
  const grades = new InMemoryGradeRepository({ locate: async (id) => (await placementOf(id))?.placement ?? null });
  const extensions = new InMemoryTimeExtensionRepository();
  const excusals = new InMemoryExcusalRepository();
  const gradeReleases = new InMemoryGradeReleaseRepository();

  const scheduling = new InMemorySchedulingRepository();
  const attendance = new InMemoryAttendanceRepository();
  const announcements = new InMemoryAnnouncementRepository();
  const threads = new InMemoryThreadRepository();
  const audit = new InMemoryAuditRepository();

  const repos = {
    users,
    courses,
    enrollments,
    content,
    terms,
    organizations,
    departments,
    enrollmentRequests,
    delegations,
    guardianLinks,
    groups,
    coursePrerequisites,
  } satisfies Required<RepositoryContext>;
  const authRepos: AuthorizationRepos = repos;

  // ---- host glue the SDK asks for ----
  const completion = new InMemoryCompletionTracker(async (userId, contentId) => (await submissions.countAttempts(contentId, userId)) > 0);
  const notifications = new RecordingNotificationSink();
  const submissionLocator = {
    locate: async (submissionId: string) => {
      const found = await placementOf(submissionId);
      return found ? { sectionId: found.node.sectionId, userId: found.submission.userId, contentId: found.node.id } : null;
    },
  };
  // Class sessions are scheduling occurrences: reporting finds their section through the template.
  const allTime = [new Date(0), new Date(8_640_000_000_000_000)] as const;
  const sessionLocator = {
    sectionOf: async (sessionId: string) => {
      const occurrence = await scheduling.findOccurrence(sessionId);
      const template = occurrence ? await scheduling.findTemplate(occurrence.templateId) : null;
      return template?.sectionId ?? null;
    },
    sessionsInSection: async (sectionId: string) => {
      const ids: string[] = [];
      for (const template of await scheduling.listTemplatesForSection(sectionId)) {
        for (const o of await scheduling.listOccurrences(template.id, ...allTime)) ids.push(o.id);
      }
      return ids;
    },
  };

  // ---- services ----
  const optionalPolicy = enforce ? { policy } : {};
  const enrollment = new EnrollmentService(repos, bus, optionalPolicy);
  const grading = new GradingService(
    grades,
    bus,
    enforce ? { policy, repos: authRepos, submissions: submissionLocator } : undefined,
    {
      systemGraders: [IN_MEMORY_QUIZ_GRADER],
      excusals,
      ...(options.gradeRelease === 'manual' ? { releases: gradeReleases } : {}),
    },
  );
  const services = {
    enrollment,
    enrollmentRequests: new EnrollmentRequestService({ ...authRepos, enrollmentRequests }, enrollment, bus, { policy }),
    groups: new GroupService(repos, optionalPolicy),
    prerequisites: new PrerequisiteService(repos, optionalPolicy),
    content: new ContentService(repos, completion, options.contentPrerequisites ?? [], bus, optionalPolicy),
    assessment: new AssessmentService(
      submissions,
      quizzes,
      undefined,
      bus,
      enforce ? { policy, repos: { ...authRepos, content, groups } } : undefined,
      { extensions, autoGrade: { grading, source: IN_MEMORY_QUIZ_GRADER } },
    ),
    rubrics: new RubricService({ ...authRepos, rubrics, evaluations: rubricEvaluations, content, submissions }, optionalPolicy),
    peerReviews: new PeerReviewService(
      { ...authRepos, peerReviews, submissions, content, rubrics, evaluations: rubricEvaluations },
      optionalPolicy,
    ),
    grading,
    accommodations: new AccommodationService({ ...authRepos, content, extensions, excusals }, bus, { policy }),
    delegation: new DelegationService({ ...authRepos, delegations }, { policy }, bus),
    guardians: new GuardianService({ users, courses, enrollments, guardianLinks }, { policy }, bus),
    scheduling: new SchedulingService(scheduling, attendance, bus, {
      ...(enforce ? { enforcement: { policy, repos: authRepos } } : {}),
      settings: scheduling,
    }),
    communication: new CommunicationService(
      announcements,
      threads,
      notifications,
      enforce ? { enforcement: { policy, repos: authRepos } } : {},
      bus,
    ),
    reporting: new ReportingService(
      attendance,
      { sessions: sessionLocator, ...(enforce ? { enforcement: { policy, repos: authRepos } } : {}) },
      bus,
    ),
    admin: new AdminService(audit, enforce ? { enforcement: { policy, repos: { users } } } : {}),
  };

  return {
    bus,
    policy,
    /** Every repository, by name. Seed users, courses, sections, rooms and the like through these. */
    repos: {
      ...repos,
      submissions,
      quizzes,
      rubrics,
      rubricEvaluations,
      peerReviews,
      grades,
      extensions,
      excusals,
      gradeReleases,
      scheduling,
      attendance,
      announcements,
      threads,
      audit,
    },
    services,
    /** What `CommunicationService` would have delivered: the SDK never sends anything itself. */
    notifications,
    /** Marks content complete for `ContentService.isUnlocked` (a submission also counts). */
    completion,
    /** The lookups the SDK asks a host for, as wired here. */
    locators: { submissions: submissionLocator, sessions: sessionLocator },
  };
}
