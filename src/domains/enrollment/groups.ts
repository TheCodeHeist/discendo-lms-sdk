import type {
  ActorContext,
  PermissionPolicy,
} from '../../core/permissions.js';
import {
  ActorRequiredError,
  PermissionDeniedError,
  activeSectionRole,
} from '../../core/permissions.js';
import { authorizeInSection, isStaff } from '../../core/authorization.js';
import type { RepositoryContext } from '../../core/repositories.js';
import type {
  GroupMember,
  SectionGroup,
} from '../../core/types.js';

export class GroupNotFoundError extends Error {
  constructor(readonly groupId: string) {
    super(`Group ${groupId} not found`);
    this.name = 'GroupNotFoundError';
  }
}

export class GroupFullError extends Error {
  constructor(readonly groupId: string) {
    super(`Group ${groupId} is full`);
    this.name = 'GroupFullError';
  }
}

export class AlreadyInGroupError extends Error {
  constructor(readonly groupId: string, readonly userId: string) {
    super(`User ${userId} is already a member of group ${groupId}`);
    this.name = 'AlreadyInGroupError';
  }
}

export class SelfSignupNotAllowedError extends Error {
  constructor(readonly groupId: string) {
    super(`Self-signup is not allowed for group ${groupId}`);
    this.name = 'SelfSignupNotAllowedError';
  }
}

export interface GroupServiceOptions {
  policy?: PermissionPolicy;
}

export interface CreateGroupOptions {
  maxMembers?: number;
  allowSelfSignup?: boolean;
  groupSet?: string;
}

export class GroupService {
  constructor(
    private readonly repos: RepositoryContext,
    private readonly options: GroupServiceOptions = {},
  ) {}

  private get groupRepo() {
    if (!this.repos.groups) {
      throw new Error('GroupRepository is required on RepositoryContext for GroupService');
    }
    return this.repos.groups;
  }

  async createGroup(
    sectionId: string,
    name: string,
    options?: CreateGroupOptions,
    actor?: ActorContext,
  ): Promise<SectionGroup> {
    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('enrollment.manageGroups');
      }
      await authorizeInSection(policy, this.repos, 'enrollment.manageGroups', actor, {
        sectionId,
      });
    }

    return this.groupRepo.create({
      sectionId,
      name,
      ...(options?.maxMembers !== undefined ? { maxMembers: options.maxMembers } : {}),
      ...(options?.allowSelfSignup !== undefined ? { allowSelfSignup: options.allowSelfSignup } : {}),
      ...(options?.groupSet !== undefined ? { groupSet: options.groupSet } : {}),
    });
  }

  async findGroup(
    groupId: string,
    actor?: ActorContext,
  ): Promise<SectionGroup | null> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) return null;

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId: group.sectionId,
      });
    }

    return group;
  }

  async listGroups(
    sectionId: string,
    options?: { groupSet?: string },
    actor?: ActorContext,
  ): Promise<SectionGroup[]> {
    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId,
      });
    }

    return this.groupRepo.listBySection(sectionId, options?.groupSet);
  }

  async deleteGroup(
    groupId: string,
    actor?: ActorContext,
  ): Promise<boolean> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) return false;

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('enrollment.manageGroups');
      }
      await authorizeInSection(policy, this.repos, 'enrollment.manageGroups', actor, {
        sectionId: group.sectionId,
      });
    }

    return this.groupRepo.delete(groupId);
  }

  async addMember(
    groupId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<GroupMember> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('enrollment.manageGroups');
      }
      await authorizeInSection(policy, this.repos, 'enrollment.manageGroups', actor, {
        sectionId: group.sectionId,
      });

      const enrollment = await this.repos.enrollments.findByUserAndSection(userId, group.sectionId);
      if (activeSectionRole(enrollment) !== 'student') {
        throw new PermissionDeniedError('enrollment.manageGroups');
      }
    }

    const existing = await this.groupRepo.findMember(groupId, userId);
    if (existing) {
      throw new AlreadyInGroupError(groupId, userId);
    }

    if (group.maxMembers !== undefined) {
      const current = await this.groupRepo.listMembers(groupId);
      if (current.length >= group.maxMembers) {
        throw new GroupFullError(groupId);
      }
    }

    return this.groupRepo.addMember({
      groupId,
      userId,
      joinedAt: new Date(),
    });
  }

  async removeMember(
    groupId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<boolean> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('enrollment.manageGroups');
      }
      await authorizeInSection(policy, this.repos, 'enrollment.manageGroups', actor, {
        sectionId: group.sectionId,
      });
    }

    return this.groupRepo.removeMember(groupId, userId);
  }

  async joinGroup(
    groupId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<GroupMember> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    if (!group.allowSelfSignup) {
      throw new SelfSignupNotAllowedError(groupId);
    }

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      if (actor.actorId !== userId) {
        throw new PermissionDeniedError('content.view');
      }
      await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId: group.sectionId,
        ownerId: userId,
      });

      const enrollment = await this.repos.enrollments.findByUserAndSection(userId, group.sectionId);
      if (activeSectionRole(enrollment) !== 'student') {
        throw new PermissionDeniedError('content.view');
      }
    }

    const existing = await this.groupRepo.findMember(groupId, userId);
    if (existing) {
      throw new AlreadyInGroupError(groupId, userId);
    }

    if (group.maxMembers !== undefined) {
      const current = await this.groupRepo.listMembers(groupId);
      if (current.length >= group.maxMembers) {
        throw new GroupFullError(groupId);
      }
    }

    return this.groupRepo.addMember({
      groupId,
      userId,
      joinedAt: new Date(),
    });
  }

  async leaveGroup(
    groupId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<boolean> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    if (!group.allowSelfSignup) {
      throw new SelfSignupNotAllowedError(groupId);
    }

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      if (actor.actorId !== userId) {
        throw new PermissionDeniedError('content.view');
      }
      await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId: group.sectionId,
        ownerId: userId,
      });
    }

    return this.groupRepo.removeMember(groupId, userId);
  }

  async listMembers(
    groupId: string,
    actor?: ActorContext,
  ): Promise<GroupMember[]> {
    const group = await this.groupRepo.findById(groupId);
    if (!group) {
      throw new GroupNotFoundError(groupId);
    }

    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId: group.sectionId,
      });
    }

    return this.groupRepo.listMembers(groupId);
  }

  async listUserGroups(
    sectionId: string,
    userId: string,
    actor?: ActorContext,
  ): Promise<SectionGroup[]> {
    const policy = this.options.policy;
    if (policy) {
      if (!actor) {
        throw new ActorRequiredError('content.view');
      }
      const auth = await authorizeInSection(policy, this.repos, 'content.view', actor, {
        sectionId,
        ownerId: userId,
      });
      const staff = isStaff(auth.ctx);
      if (!staff && actor.actorId !== userId) {
        throw new PermissionDeniedError('content.view');
      }
    }

    return this.groupRepo.listGroupsForUser(sectionId, userId);
  }
}
