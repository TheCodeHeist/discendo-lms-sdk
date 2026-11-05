/**
 * In-memory implementations of every repository interface in `core/repositories.ts`. They are
 * complete (the optional atomic methods included), keep their data in this process only, and are
 * meant for tests, demos, prototypes and local development. They are also a readable reference
 * for what each method is expected to do when you write the real thing against your database;
 * the matching contract suites (`contracts.ts`) check that your implementation agrees.
 *
 * The interfaces that only read (users, courses, terms, organizations, departments) have no
 * create method in the SDK, because creating those records is the host's business. Their
 * in-memory versions add `seed*` methods for that.
 */
import type {
  AcademicTerm,
  ContentNode,
  Course,
  CoursePrerequisite,
  CourseSection,
  Department,
  Enrollment,
  EnrollmentRequest,
  EnrollmentRequestStatus,
  GroupMember,
  GuardianLink,
  Id,
  Identity,
  Organization,
  SectionGroup,
  TaGrant,
} from '../types.js';
import type {
  ContentRepository,
  CoursePrerequisiteRepository,
  CourseRepository,
  DelegationRepository,
  DepartmentRepository,
  EnrollmentRepository,
  EnrollmentRequestRepository,
  GroupRepository,
  GuardianLinkManagementRepository,
  OrganizationRepository,
  TermRepository,
  UserRepository,
} from '../repositories.js';
import { InMemoryTable } from './table.js';

export class InMemoryUserRepository implements UserRepository {
  private readonly users = new InMemoryTable<Identity>('user');

  seed(...identities: Identity[]): this {
    for (const identity of identities) this.users.put(identity);
    return this;
  }

  async findById(id: Id): Promise<Identity | null> {
    return this.users.get(id);
  }

  async findByExternalRef(ref: string, orgId?: Id): Promise<Identity | null> {
    return this.users.last((u) => u.externalRef === ref && (orgId === undefined || u.orgId === orgId));
  }
}

export class InMemoryCourseRepository implements CourseRepository {
  private readonly courses = new InMemoryTable<Course>('course');
  private readonly sections = new InMemoryTable<CourseSection>('section');

  seedCourse(...courses: Course[]): this {
    for (const course of courses) this.courses.put(course);
    return this;
  }

  seedSection(...sections: CourseSection[]): this {
    for (const section of sections) this.sections.put(section);
    return this;
  }

  async findCourse(id: Id): Promise<Course | null> {
    return this.courses.get(id);
  }

  async findSection(id: Id): Promise<CourseSection | null> {
    return this.sections.get(id);
  }

  async listSections(courseId: Id): Promise<CourseSection[]> {
    return this.sections.where((s) => s.courseId === courseId);
  }
}

export class InMemoryTermRepository implements TermRepository {
  private readonly terms = new InMemoryTable<AcademicTerm>('term');

  seed(...terms: AcademicTerm[]): this {
    for (const term of terms) this.terms.put(term);
    return this;
  }

  async findById(id: Id): Promise<AcademicTerm | null> {
    return this.terms.get(id);
  }
}

export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly organizations = new InMemoryTable<Organization>('org');

  seed(...organizations: Organization[]): this {
    for (const organization of organizations) this.organizations.put(organization);
    return this;
  }

  async findById(id: Id): Promise<Organization | null> {
    return this.organizations.get(id);
  }
}

export class InMemoryDepartmentRepository implements DepartmentRepository {
  private readonly departments = new InMemoryTable<Department>('dept');

  seed(...departments: Department[]): this {
    for (const department of departments) this.departments.put(department);
    return this;
  }

  async findById(id: Id): Promise<Department | null> {
    return this.departments.get(id);
  }

  async listByOrg(orgId: Id | undefined): Promise<Department[]> {
    return this.departments.where((d) => d.orgId === orgId);
  }
}

/**
 * Seats are counted for every role (`countActive` counts all `active` enrollments), which is
 * what the SDK documents as the default. Includes both optional atomic methods.
 */
export class InMemoryEnrollmentRepository implements EnrollmentRepository {
  private readonly enrollments = new InMemoryTable<Enrollment>('enr', 'Enrollment');

  seed(...enrollments: Enrollment[]): this {
    for (const enrollment of enrollments) this.enrollments.put(enrollment);
    return this;
  }

  async create(enrollment: Omit<Enrollment, 'id'>): Promise<Enrollment> {
    return this.enrollments.insert(enrollment);
  }

  async findById(id: Id): Promise<Enrollment | null> {
    return this.enrollments.get(id);
  }

  async update(id: Id, patch: Partial<Enrollment>): Promise<Enrollment> {
    return this.enrollments.update(id, patch);
  }

  async findByUserAndSection(userId: Id, sectionId: Id): Promise<Enrollment | null> {
    return this.enrollments.last((e) => e.userId === userId && e.sectionId === sectionId);
  }

  async listBySection(sectionId: Id, status?: Enrollment['status']): Promise<Enrollment[]> {
    return this.enrollments.where((e) => e.sectionId === sectionId && (status === undefined || e.status === status));
  }

  async countActive(sectionId: Id): Promise<number> {
    return this.activeIn(sectionId);
  }

  async createIfSeatFree(enrollment: Omit<Enrollment, 'id'>, capacity: number): Promise<Enrollment | null> {
    if (this.activeIn(enrollment.sectionId) >= capacity) return null;
    return this.enrollments.insert(enrollment);
  }

  async promoteIfSeatFree(enrollmentId: Id, capacity: number): Promise<Enrollment | null> {
    const enrollment = this.enrollments.get(enrollmentId);
    if (!enrollment || enrollment.status !== 'waitlisted') return null;
    if (this.activeIn(enrollment.sectionId) >= capacity) return null;
    return this.enrollments.update(enrollmentId, { status: 'active' });
  }

  private activeIn(sectionId: Id): number {
    return this.enrollments.count((e) => e.sectionId === sectionId && e.status === 'active');
  }
}

/** New nodes start at version 1. `reorder` sets `orderIndex` to each id's position in the list. */
export class InMemoryContentRepository implements ContentRepository {
  private readonly nodes = new InMemoryTable<ContentNode>('content', 'Content');

  seed(...nodes: ContentNode[]): this {
    for (const node of nodes) this.nodes.put(node);
    return this;
  }

  async findById(id: Id): Promise<ContentNode | null> {
    return this.nodes.get(id);
  }

  async listBySection(sectionId: Id): Promise<ContentNode[]> {
    return this.nodes.where((n) => n.sectionId === sectionId).sort((a, b) => a.orderIndex - b.orderIndex);
  }

  async create(node: Omit<ContentNode, 'id' | 'version'>): Promise<ContentNode> {
    return this.nodes.insert({ ...node, version: 1 });
  }

  async update(id: Id, patch: Partial<ContentNode>): Promise<ContentNode> {
    return this.nodes.update(id, patch);
  }

  async reorder(sectionId: Id, orderedIds: Id[]): Promise<void> {
    orderedIds.forEach((id, orderIndex) => {
      const node = this.nodes.get(id);
      if (node && node.sectionId === sectionId) this.nodes.update(id, { orderIndex });
    });
  }
}

/** Includes the optional atomic `decideIfPending`. */
export class InMemoryEnrollmentRequestRepository implements EnrollmentRequestRepository {
  private readonly requests = new InMemoryTable<EnrollmentRequest>('req', 'Enrollment request');

  async create(request: Omit<EnrollmentRequest, 'id'>): Promise<EnrollmentRequest> {
    return this.requests.insert(request);
  }

  async findById(id: Id): Promise<EnrollmentRequest | null> {
    return this.requests.get(id);
  }

  async update(id: Id, patch: Partial<Omit<EnrollmentRequest, 'id'>>): Promise<EnrollmentRequest> {
    return this.requests.update(id, patch);
  }

  async findPending(userId: Id, sectionId: Id): Promise<EnrollmentRequest | null> {
    return this.requests.last((r) => r.userId === userId && r.sectionId === sectionId && r.status === 'pending');
  }

  async listBySection(sectionId: Id, status?: EnrollmentRequestStatus): Promise<EnrollmentRequest[]> {
    return this.requests.where((r) => r.sectionId === sectionId && (status === undefined || r.status === status));
  }

  async listByUser(userId: Id): Promise<EnrollmentRequest[]> {
    return this.requests.where((r) => r.userId === userId);
  }

  async decideIfPending(id: Id, patch: Partial<Omit<EnrollmentRequest, 'id'>>): Promise<EnrollmentRequest | null> {
    const request = this.requests.get(id);
    if (!request || request.status !== 'pending') return null;
    return this.requests.update(id, patch);
  }
}

export class InMemoryDelegationRepository implements DelegationRepository {
  private readonly grants = new InMemoryTable<TaGrant>('grant', 'Grant');

  async create(grant: Omit<TaGrant, 'id'>): Promise<TaGrant> {
    return this.grants.insert(grant);
  }

  async findById(id: Id): Promise<TaGrant | null> {
    return this.grants.get(id);
  }

  async listActiveForEnrollment(enrollmentId: Id): Promise<TaGrant[]> {
    return this.grants.where((g) => g.enrollmentId === enrollmentId && g.revokedAt === undefined);
  }

  async revoke(id: Id, at: Date): Promise<TaGrant> {
    return this.grants.update(id, { revokedAt: at });
  }
}

/** Implements the management interface, which includes the read-only `GuardianLinkRepository`. */
export class InMemoryGuardianLinkRepository implements GuardianLinkManagementRepository {
  private readonly links = new InMemoryTable<GuardianLink>('link', 'Guardian link');

  seed(...links: GuardianLink[]): this {
    for (const link of links) this.links.put(link);
    return this;
  }

  async findActive(guardianId: Id, wardId: Id): Promise<GuardianLink | null> {
    return this.links.last((l) => l.guardianId === guardianId && l.wardId === wardId && l.status === 'active');
  }

  async create(link: Omit<GuardianLink, 'id'>): Promise<GuardianLink> {
    return this.links.insert(link);
  }

  async findById(id: Id): Promise<GuardianLink | null> {
    return this.links.get(id);
  }

  async update(id: Id, patch: Partial<Pick<GuardianLink, 'scopes' | 'status' | 'revokedAt'>>): Promise<GuardianLink> {
    return this.links.update(id, patch);
  }

  async listByWard(wardId: Id): Promise<GuardianLink[]> {
    return this.links.where((l) => l.wardId === wardId);
  }

  async listByGuardian(guardianId: Id): Promise<GuardianLink[]> {
    return this.links.where((l) => l.guardianId === guardianId);
  }
}

/** Deleting a group also removes its memberships. */
export class InMemoryGroupRepository implements GroupRepository {
  private readonly groups = new InMemoryTable<SectionGroup>('group', 'Group');
  private readonly members = new InMemoryTable<GroupMember>('member', 'Group member');

  async create(group: Omit<SectionGroup, 'id'>): Promise<SectionGroup> {
    return this.groups.insert(group);
  }

  async findById(id: Id): Promise<SectionGroup | null> {
    return this.groups.get(id);
  }

  async listBySection(sectionId: Id, groupSet?: string): Promise<SectionGroup[]> {
    return this.groups.where((g) => g.sectionId === sectionId && (groupSet === undefined || g.groupSet === groupSet));
  }

  async delete(id: Id): Promise<boolean> {
    if (!this.groups.delete(id)) return false;
    for (const m of this.members.where((m) => m.groupId === id)) this.members.delete(m.id);
    return true;
  }

  async addMember(member: Omit<GroupMember, 'id'>): Promise<GroupMember> {
    return this.members.insert(member);
  }

  async removeMember(groupId: Id, userId: Id): Promise<boolean> {
    const member = this.members.last((m) => m.groupId === groupId && m.userId === userId);
    return member ? this.members.delete(member.id) : false;
  }

  async listMembers(groupId: Id): Promise<GroupMember[]> {
    return this.members.where((m) => m.groupId === groupId);
  }

  async findMember(groupId: Id, userId: Id): Promise<GroupMember | null> {
    return this.members.last((m) => m.groupId === groupId && m.userId === userId);
  }

  async listGroupsForUser(sectionId: Id, userId: Id): Promise<SectionGroup[]> {
    const groupIds = new Set(this.members.where((m) => m.userId === userId).map((m) => m.groupId));
    return this.groups.where((g) => g.sectionId === sectionId && groupIds.has(g.id));
  }
}

export class InMemoryCoursePrerequisiteRepository implements CoursePrerequisiteRepository {
  private readonly prerequisites = new InMemoryTable<CoursePrerequisite>('prereq', 'Prerequisite');

  async add(prereq: Omit<CoursePrerequisite, 'id'>): Promise<CoursePrerequisite> {
    return this.prerequisites.insert(prereq);
  }

  async remove(id: Id): Promise<boolean> {
    return this.prerequisites.delete(id);
  }

  async listByCourse(courseId: Id): Promise<CoursePrerequisite[]> {
    return this.prerequisites.where((p) => p.courseId === courseId);
  }
}
