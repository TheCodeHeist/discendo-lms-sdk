/**
 * Repository interfaces. The host app implements these against whatever
 * database/ORM it already uses (Prisma, Drizzle, raw SQL, in-memory for tests).
 * The SDK never imports a concrete DB client — this is what keeps it DB-agnostic.
 */
import type {
  Id,
  Identity,
  Course,
  CourseSection,
  Enrollment,
  ContentNode,
  AcademicTerm,
  Organization,
  GuardianLink,
  Department,
  TaGrant,
} from './types.js';

export interface UserRepository {
  findById(id: Id): Promise<Identity | null>;
  /**
   * `orgId` is passed when the caller is working inside one organization
   * (e.g. a roster import into an org-scoped course). Two organizations may
   * reuse the same external reference, so implementations should then return
   * only an identity belonging to that organization. When it is omitted, no
   * organization is implied. Implementations that don't support multiple
   * organizations can ignore it.
   */
  findByExternalRef(ref: string, orgId?: Id): Promise<Identity | null>;
}

export interface CourseRepository {
  findCourse(id: Id): Promise<Course | null>;
  findSection(id: Id): Promise<CourseSection | null>;
  listSections(courseId: Id): Promise<CourseSection[]>;
}

export interface EnrollmentRepository {
  create(enrollment: Omit<Enrollment, 'id'>): Promise<Enrollment>;
  findById(id: Id): Promise<Enrollment | null>;
  update(id: Id, patch: Partial<Enrollment>): Promise<Enrollment>;
  /**
   * A person can have several records for one section (for example a dropped
   * one and a later active one). Return the MOST RECENT: permission checks and
   * delegated grants depend on it being the current enrollment.
   */
  findByUserAndSection(userId: Id, sectionId: Id): Promise<Enrollment | null>;
  listBySection(sectionId: Id, status?: Enrollment['status']): Promise<Enrollment[]>;
  countActive(sectionId: Id): Promise<number>;
  /**
   * OPTIONAL, and strongly recommended whenever a section has a capacity: create the enrollment
   * (the `active` one it is given) **only if** the section has fewer than `capacity` active
   * enrollments, as ONE atomic step (a transaction, a conditional insert, a row lock), and return
   * `null` if it is full. Count the same enrollments `countActive` counts. Without it the service
   * checks `countActive` and then calls `create`, so two simultaneous enrollments into the last
   * seat can both succeed. With it, the service waitlists the person (or throws) on `null`.
   */
  createIfSeatFree?(enrollment: Omit<Enrollment, 'id'>, capacity: number): Promise<Enrollment | null>;
}

export interface ContentRepository {
  findById(id: Id): Promise<ContentNode | null>;
  listBySection(sectionId: Id): Promise<ContentNode[]>;
  create(node: Omit<ContentNode, 'id' | 'version'>): Promise<ContentNode>;
  update(id: Id, patch: Partial<ContentNode>): Promise<ContentNode>;
  reorder(sectionId: Id, orderedIds: Id[]): Promise<void>;
}

export interface TermRepository {
  findById(id: Id): Promise<AcademicTerm | null>;
}

export interface OrganizationRepository {
  findById(id: Id): Promise<Organization | null>;
}

export interface DepartmentRepository {
  findById(id: Id): Promise<Department | null>;
  /** The departments of one organization (`undefined` = those that belong to no organization). */
  listByOrg(orgId: Id | undefined): Promise<Department[]>;
}

export interface DelegationRepository {
  create(grant: Omit<TaGrant, 'id'>): Promise<TaGrant>;
  findById(id: Id): Promise<TaGrant | null>;
  /** The grants of this enrollment that have not been revoked. */
  listActiveForEnrollment(enrollmentId: Id): Promise<TaGrant[]>;
  revoke(id: Id, at: Date): Promise<TaGrant>;
}

export interface GuardianLinkRepository {
  /**
   * The active link from this guardian to this ward, or null. Enforcement
   * re-checks what comes back (ids, status, organization), so a repository
   * that returns the wrong link still can't widen anyone's access.
   */
  findActive(guardianId: Id, wardId: Id): Promise<GuardianLink | null>;
}

/**
 * What `GuardianService` needs to manage links. A host that only reads links (enforcement)
 * implements `GuardianLinkRepository` alone; this adds the writes and the listings.
 */
export interface GuardianLinkManagementRepository extends GuardianLinkRepository {
  create(link: Omit<GuardianLink, 'id'>): Promise<GuardianLink>;
  findById(id: Id): Promise<GuardianLink | null>;
  update(id: Id, patch: Partial<Pick<GuardianLink, 'scopes' | 'status' | 'revokedAt'>>): Promise<GuardianLink>;
  /** Every link to this ward, active or revoked. */
  listByWard(wardId: Id): Promise<GuardianLink[]>;
  /** Every link from this guardian, active or revoked. */
  listByGuardian(guardianId: Id): Promise<GuardianLink[]>;
}

/**
 * Bundle of repositories the SDK's service classes are constructed with.
 * Host app wires up real implementations once at startup.
 */
export interface RepositoryContext {
  users: UserRepository;
  courses: CourseRepository;
  enrollments: EnrollmentRepository;
  content: ContentRepository;
  terms: TermRepository;
  /** Only needed by hosts that use organizations. Nothing in the SDK requires it yet. */
  organizations?: OrganizationRepository;
  /** Only needed by hosts that group courses into departments. Nothing in the SDK requires it. */
  departments?: DepartmentRepository;
  /** Only needed by hosts whose instructors delegate actions to TAs. Without it a TA only has the TA defaults. */
  delegations?: DelegationRepository;
  /** Only needed by hosts with guardians. Without it a guardian can read nothing. */
  guardianLinks?: GuardianLinkRepository;
}
