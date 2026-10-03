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
  findByUserAndSection(userId: Id, sectionId: Id): Promise<Enrollment | null>;
  listBySection(sectionId: Id, status?: Enrollment['status']): Promise<Enrollment[]>;
  countActive(sectionId: Id): Promise<number>;
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
}
