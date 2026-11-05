import { describe, it } from 'bun:test';
import * as testing from '../src/testing/index.js';
import {
  InMemoryAnnouncementRepository,
  InMemoryAttendanceRepository,
  InMemoryAuditRepository,
  InMemoryContentRepository,
  InMemoryCoursePrerequisiteRepository,
  InMemoryCourseRepository,
  InMemoryDelegationRepository,
  InMemoryDepartmentRepository,
  InMemoryEnrollmentRepository,
  InMemoryEnrollmentRequestRepository,
  InMemoryExcusalRepository,
  InMemoryGradeReleaseRepository,
  InMemoryGradeRepository,
  InMemoryGroupRepository,
  InMemoryGuardianLinkRepository,
  InMemoryOrganizationRepository,
  InMemoryPeerReviewRepository,
  InMemoryQuizRepository,
  InMemoryRubricEvaluationRepository,
  InMemoryRubricRepository,
  InMemorySchedulingRepository,
  InMemorySubmissionRepository,
  InMemoryTermRepository,
  InMemoryThreadRepository,
  InMemoryTimeExtensionRepository,
  InMemoryUserRepository,
  assessmentRepositoryContracts,
  attendanceRepositoryContract,
  auditRepositoryContract,
  communicationRepositoryContracts,
  coreRepositoryContracts,
  gradingRepositoryContracts,
  schedulingRepositoryContract,
  schedulingSettingsRepositoryContract,
  type ContractCase,
} from '../src/testing/index.js';

/** Every in-memory repository the SDK ships, run against its contract suite. */
const all: Array<[string, ContractCase[]]> = [
  [
    'core',
    coreRepositoryContracts({
      users: (seed) => new InMemoryUserRepository().seed(...seed),
      courses: ({ courses, sections }) => new InMemoryCourseRepository().seedCourse(...courses).seedSection(...sections),
      terms: (seed) => new InMemoryTermRepository().seed(...seed),
      organizations: (seed) => new InMemoryOrganizationRepository().seed(...seed),
      departments: (seed) => new InMemoryDepartmentRepository().seed(...seed),
      enrollments: () => new InMemoryEnrollmentRepository(),
      content: () => new InMemoryContentRepository(),
      enrollmentRequests: () => new InMemoryEnrollmentRequestRepository(),
      delegations: () => new InMemoryDelegationRepository(),
      guardianLinks: () => new InMemoryGuardianLinkRepository(),
      groups: () => new InMemoryGroupRepository(),
      coursePrerequisites: () => new InMemoryCoursePrerequisiteRepository(),
    }),
  ],
  [
    'assessment',
    assessmentRepositoryContracts({
      submissions: () => new InMemorySubmissionRepository(),
      quizzes: ({ quizId, questions }) => new InMemoryQuizRepository().seedQuestions(quizId, questions),
      rubrics: () => new InMemoryRubricRepository(),
      rubricEvaluations: () => new InMemoryRubricEvaluationRepository(),
      peerReviews: () => new InMemoryPeerReviewRepository(),
    }),
  ],
  [
    'grading',
    gradingRepositoryContracts({
      grades: (placements) => {
        const repo = new InMemoryGradeRepository();
        for (const [submissionId, placement] of Object.entries(placements)) repo.place(submissionId, placement);
        return repo;
      },
      extensions: () => new InMemoryTimeExtensionRepository(),
      excusals: () => new InMemoryExcusalRepository(),
      releases: () => new InMemoryGradeReleaseRepository(),
    }),
  ],
  [
    'scheduling',
    [
      ...schedulingRepositoryContract(({ rooms, groups, qualifications }) => {
        const repo = new InMemorySchedulingRepository();
        rooms.forEach((r) => repo.seedRoom(r));
        groups.forEach((g) => repo.seedGroup(g));
        qualifications.forEach((q) => repo.seedTeacherQualification(q));
        return repo;
      }),
      ...schedulingSettingsRepositoryContract(() => new InMemorySchedulingRepository()),
    ],
  ],
  [
    'services',
    [
      ...communicationRepositoryContracts({
        announcements: () => new InMemoryAnnouncementRepository(),
        threads: () => new InMemoryThreadRepository(),
      }),
      ...attendanceRepositoryContract(() => new InMemoryAttendanceRepository()),
      ...auditRepositoryContract(() => new InMemoryAuditRepository()),
    ],
  ],
];

for (const [name, cases] of all) {
  describe(`in-memory ${name} repositories pass their contracts`, () => {
    for (const c of cases) it(c.name, c.run);
  });
}

describe('the testing barrel', () => {
  it('exports a contract suite for every repository interface the SDK defines', () => {
    const suites = Object.keys(testing).filter((k) => k.endsWith('RepositoryContract'));
    // one per interface: 12 core + 5 assessment + 4 grading + 2 scheduling + 2 communication + attendance + audit
    if (suites.length !== 27) throw new Error(`expected 27 contract suites, found ${suites.length}: ${suites.join(', ')}`);
  });
});
