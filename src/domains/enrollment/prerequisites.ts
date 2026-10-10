import type { RepositoryContext } from '../../core/repositories.js';
import type { CoursePrerequisite, Id } from '../../core/types.js';
import type { ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError } from '../../core/permissions.js';
import { assertSameOrg } from '../../core/tenancy.js';
import { authorizeWithinOwnOrg, assertInActorOrg, isStaff } from '../../core/authorization.js';
import { CircularPrerequisiteError, type UnmetPrerequisite } from './types.js';

export interface PrerequisiteServiceOptions {
  policy?: PermissionPolicy;
  gradeSource?: { getCourseGrade(userId: string, courseId: string): Promise<number | null> };
}

export interface AddPrerequisiteOptions {
  courseId: Id;
  requiredCourseId: Id;
  minGrade?: number;
  isCorequisite?: boolean;
}

export interface CheckPrerequisitesOptions {
  userId: Id;
  courseId: Id;
}

export interface PrerequisiteCheckResult {
  satisfied: boolean;
  unmet: UnmetPrerequisite[];
}

export interface SequenceOptions {
  includeSelf?: boolean;
}

export class PrerequisiteService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly options: PrerequisiteServiceOptions = {},
  ) {}

  private get prereqRepo() {
    if (!this.repos.coursePrerequisites) {
      throw new Error('CoursePrerequisiteRepository is required on RepositoryContext for PrerequisiteService');
    }
    return this.repos.coursePrerequisites;
  }

  async addPrerequisite(
    opts: AddPrerequisiteOptions,
    actor?: ActorContext,
  ): Promise<CoursePrerequisite> {
    const repo = this.prereqRepo;
    const policy = this.options.policy;
    let auth;
    if (policy) {
      auth = await authorizeWithinOwnOrg(policy, this.repos, 'course.managePrerequisites', actor);
    }

    const course = await this.repos.courses.findCourse(opts.courseId);
    if (!course) {
      if (policy) throw new PermissionDeniedError('course.managePrerequisites');
      throw new Error(`Course ${opts.courseId} not found`);
    }

    const requiredCourse = await this.repos.courses.findCourse(opts.requiredCourseId);
    if (!requiredCourse) {
      if (policy) throw new PermissionDeniedError('course.managePrerequisites');
      throw new Error(`Course ${opts.requiredCourseId} not found`);
    }

    if (policy && auth) {
      assertInActorOrg(auth, course.orgId, 'course.managePrerequisites');
      assertInActorOrg(auth, requiredCourse.orgId, 'course.managePrerequisites');
    } else {
      assertSameOrg(course.orgId, requiredCourse.orgId, 'Courses belong to different organizations');
    }

    const pathExists = await this.hasPrerequisitePath(opts.requiredCourseId, opts.courseId);
    if (pathExists) {
      throw new CircularPrerequisiteError(opts.courseId, opts.requiredCourseId);
    }

    return repo.add({
      courseId: opts.courseId,
      requiredCourseId: opts.requiredCourseId,
      ...(opts.minGrade !== undefined ? { minGrade: opts.minGrade } : {}),
      ...(opts.isCorequisite !== undefined ? { isCorequisite: opts.isCorequisite } : {}),
    });
  }

  async removePrerequisite(id: Id, actor?: ActorContext): Promise<boolean> {
    const repo = this.prereqRepo;
    const policy = this.options.policy;
    if (policy) {
      await authorizeWithinOwnOrg(policy, this.repos, 'course.managePrerequisites', actor);
    }
    return repo.remove(id);
  }

  async listPrerequisites(courseId: Id, actor?: ActorContext): Promise<CoursePrerequisite[]> {
    const repo = this.prereqRepo;
    const policy = this.options.policy;
    if (policy) {
      const auth = await authorizeWithinOwnOrg(policy, this.repos, 'content.view', actor);
      const course = await this.repos.courses.findCourse(courseId);
      if (!course) throw new PermissionDeniedError('content.view');
      assertInActorOrg(auth, course.orgId, 'content.view');
    }
    return repo.listByCourse(courseId);
  }

  async getPrerequisiteSequence(courseId: Id, options?: SequenceOptions): Promise<Id[]> {
    const repo = this.prereqRepo;
    const visited = new Set<Id>();
    const visiting = new Set<Id>();
    const sequence: Id[] = [];

    const visit = async (currId: Id) => {
      if (visiting.has(currId)) {
        throw new CircularPrerequisiteError(currId, courseId);
      }
      if (visited.has(currId)) return;

      visiting.add(currId);
      const prereqs = await repo.listByCourse(currId);
      for (const p of prereqs) {
        await visit(p.requiredCourseId);
      }
      visiting.delete(currId);
      visited.add(currId);
      sequence.push(currId);
    };

    const directPrereqs = await repo.listByCourse(courseId);
    for (const p of directPrereqs) {
      await visit(p.requiredCourseId);
    }

    if (options?.includeSelf) {
      sequence.push(courseId);
    }

    return sequence;
  }

  async checkPrerequisites(
    opts: CheckPrerequisitesOptions,
    actor?: ActorContext,
  ): Promise<PrerequisiteCheckResult> {
    const repo = this.prereqRepo;
    const policy = this.options.policy;
    if (policy) {
      const auth = await authorizeWithinOwnOrg(policy, this.repos, 'content.view', actor, {
        ownerId: opts.userId,
      });
      const course = await this.repos.courses.findCourse(opts.courseId);
      if (!course) throw new PermissionDeniedError('content.view');
      assertInActorOrg(auth, course.orgId, 'content.view');
      if (opts.userId !== auth.ctx.actor.id && !isStaff(auth.ctx)) {
        throw new PermissionDeniedError('content.view');
      }
    }

    const prereqs = await repo.listByCourse(opts.courseId);
    if (prereqs.length === 0) {
      return { satisfied: true, unmet: [] };
    }

    const unmet: UnmetPrerequisite[] = [];

    for (const prereq of prereqs) {
      const sections = await this.repos.courses.listSections(prereq.requiredCourseId);
      const enrollments = (
        await Promise.all(
          sections.map((s) => this.repos.enrollments.findByUserAndSection(opts.userId, s.id)),
        )
      ).filter((e): e is NonNullable<typeof e> => e !== null);

      if (prereq.isCorequisite) {
        const hasActive = enrollments.some((e) => e.status === 'active');
        if (hasActive) {
          continue;
        }
        const hasCompleted = enrollments.some((e) => e.status === 'completed');
        if (hasCompleted) {
          if (prereq.minGrade !== undefined) {
            const grade = this.options.gradeSource
              ? await this.options.gradeSource.getCourseGrade(opts.userId, prereq.requiredCourseId)
              : null;
            if (grade === null || grade < prereq.minGrade) {
              unmet.push({
                prerequisite: prereq,
                reason: 'insufficient_grade',
                currentGrade: grade ?? undefined,
              });
              continue;
            }
          }
          continue;
        }
        unmet.push({
          prerequisite: prereq,
          reason: 'not_active_corequisite',
        });
      } else {
        const hasCompleted = enrollments.some((e) => e.status === 'completed');
        if (!hasCompleted) {
          unmet.push({
            prerequisite: prereq,
            reason: 'not_completed',
          });
          continue;
        }

        if (prereq.minGrade !== undefined) {
          const grade = this.options.gradeSource
            ? await this.options.gradeSource.getCourseGrade(opts.userId, prereq.requiredCourseId)
            : null;
          if (grade === null || grade < prereq.minGrade) {
            unmet.push({
              prerequisite: prereq,
              reason: 'insufficient_grade',
              currentGrade: grade ?? undefined,
            });
            continue;
          }
        }
      }
    }

    return {
      satisfied: unmet.length === 0,
      unmet,
    };
  }

  private async hasPrerequisitePath(
    fromCourseId: Id,
    targetCourseId: Id,
    visited = new Set<Id>(),
  ): Promise<boolean> {
    if (fromCourseId === targetCourseId) return true;
    if (visited.has(fromCourseId)) return false;
    visited.add(fromCourseId);

    const prereqs = await this.prereqRepo.listByCourse(fromCourseId);
    for (const p of prereqs) {
      if (await this.hasPrerequisitePath(p.requiredCourseId, targetCourseId, visited)) {
        return true;
      }
    }
    return false;
  }
}
