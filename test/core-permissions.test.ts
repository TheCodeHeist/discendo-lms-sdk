import { describe, it, expect } from 'bun:test';
import {
  createRolePolicy,
  authorize,
  activeSectionRole,
  effectiveRoles,
  PermissionDeniedError,
  DEFAULT_RULES,
} from '../src/core/index.js';
import type { Identity, PermissionContext, PermissionPolicy, Role } from '../src/core/index.js';

const policy = createRolePolicy();

const person = (id: string, roles: Role[], orgId?: string): Identity =>
  orgId === undefined ? { id, roles } : { id, roles, orgId };

const admin = person('admin-1', ['admin']);
const teacher = person('teacher-1', ['instructor']);
const stu = person('stu-1', ['student']);

/** Context for an action inside a section where the actor holds `role` (undefined = not enrolled). */
const inSection = (actor: Identity, role?: Role, extra: Partial<PermissionContext> = {}): PermissionContext => ({
  actor,
  section: { role },
  ...extra,
});

describe('role policy: section-scoped actions', () => {
  it('lets an enrolled instructor manage content but not a TA', () => {
    expect(policy.can('content.manage', inSection(teacher, 'instructor'))).toBe(true);
    expect(policy.can('content.manage', inSection(person('ta-1', ['ta']), 'ta'))).toBe(false);
  });

  it('lets a TA record grades but not manage content', () => {
    const ta = person('ta-1', ['ta']);
    expect(policy.can('grading.record', inSection(ta, 'ta'))).toBe(true);
    expect(policy.can('content.manage', inSection(ta, 'ta'))).toBe(false);
  });

  it('ignores a global instructor role for a section they are not enrolled in', () => {
    expect(policy.can('content.manage', inSection(teacher, undefined))).toBe(false);
    expect(policy.can('grading.record', inSection(teacher, undefined))).toBe(false);
  });

  it('uses the role in THIS section, not the account-wide one', () => {
    // Account says instructor, but in this section they are only a student.
    expect(policy.can('content.manage', inSection(teacher, 'student'))).toBe(false);
    expect(policy.can('content.view', inSection(teacher, 'student'))).toBe(true);
  });

  it('honours a global admin everywhere, enrolled or not', () => {
    expect(policy.can('scheduling.manage', inSection(admin, undefined))).toBe(true);
    expect(policy.can('enrollment.bulkEnroll', inSection(admin, 'student'))).toBe(true); // still admin
  });

  it('gives nothing to a guardian by default', () => {
    const parent = person('parent-1', ['guardian']);
    for (const action of Object.keys(DEFAULT_RULES)) {
      expect(policy.can(action, inSection(parent, 'guardian', { resourceOwnerId: 'parent-1' }))).toBe(false);
    }
  });

  it('keeps students out of teacher-only actions', () => {
    for (const action of ['content.manage', 'grading.record', 'enrollment.viewRoster', 'communication.postAnnouncement']) {
      expect(policy.can(action, inSection(stu, 'student'))).toBe(false);
    }
  });
});

describe('role policy: own-resource rules', () => {
  it("lets a student view their own grade but not a classmate's", () => {
    expect(policy.can('grading.view', inSection(stu, 'student', { resourceOwnerId: 'stu-1' }))).toBe(true);
    expect(policy.can('grading.view', inSection(stu, 'student', { resourceOwnerId: 'stu-2' }))).toBe(false);
  });

  it('fails closed when the owner is not given', () => {
    expect(policy.can('grading.view', inSection(stu, 'student'))).toBe(false);
  });

  it('lets a student submit only as themselves', () => {
    expect(policy.can('assessment.submit', inSection(stu, 'student', { resourceOwnerId: 'stu-1' }))).toBe(true);
    expect(policy.can('assessment.submit', inSection(stu, 'student', { resourceOwnerId: 'stu-2' }))).toBe(false);
  });

  it('does not let an instructor submit assessments (own-only applies to students)', () => {
    expect(policy.can('assessment.submit', inSection(teacher, 'instructor', { resourceOwnerId: 'teacher-1' }))).toBe(false);
  });

  it('lets a student drop themselves but not someone else', () => {
    expect(policy.can('enrollment.drop', inSection(stu, 'student', { resourceOwnerId: 'stu-1' }))).toBe(true);
    expect(policy.can('enrollment.drop', inSection(stu, 'student', { resourceOwnerId: 'stu-2' }))).toBe(false);
  });

  it('lets staff view any grade regardless of owner', () => {
    expect(policy.can('grading.view', inSection(teacher, 'instructor', { resourceOwnerId: 'stu-9' }))).toBe(true);
  });
});

describe('role policy: no section in context', () => {
  it('uses account-wide roles', () => {
    expect(policy.can('admin.viewAuditLog', { actor: admin })).toBe(true);
    expect(policy.can('admin.viewAuditLog', { actor: teacher })).toBe(false);
  });
});

describe('role policy: tenancy', () => {
  const orgAAdmin = person('a-admin', ['admin'], 'org-a');

  it('allows an actor from the resource organization', () => {
    expect(policy.can('scheduling.manage', inSection(orgAAdmin, undefined, { resourceOrgId: 'org-a' }))).toBe(true);
  });

  it('refuses even an admin from another organization', () => {
    expect(policy.can('scheduling.manage', inSection(orgAAdmin, undefined, { resourceOrgId: 'org-b' }))).toBe(false);
  });

  it('fails closed for an actor with no organization on an org-scoped resource', () => {
    expect(policy.can('scheduling.manage', inSection(admin, undefined, { resourceOrgId: 'org-a' }))).toBe(false);
  });

  it('applies no tenant check to an unscoped resource', () => {
    expect(policy.can('scheduling.manage', inSection(orgAAdmin, undefined))).toBe(true);
  });
});

describe('role policy: deny by default', () => {
  it('refuses an unknown action', () => {
    expect(policy.can('nope.nothing', { actor: admin })).toBe(false);
  });

  it('treats action names that match object prototype members as unknown actions', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(policy.can(name, { actor: admin })).toBe(false);
    }
  });

  it('defines a rule for every built-in action that grants someone something', () => {
    for (const [action, rule] of Object.entries(DEFAULT_RULES) as Array<[string, { roles?: readonly Role[]; ownRoles?: readonly Role[] }]>) {
      expect((rule.roles?.length ?? 0) + (rule.ownRoles?.length ?? 0)).toBeGreaterThan(0);
      expect(action).toMatch(/^[a-z]+\.[A-Za-z]+$/);
    }
  });
});

describe('role policy: institution overrides', () => {
  it('replaces the default rule for an action', () => {
    const custom = createRolePolicy({ overrides: { 'content.manage': { roles: ['admin', 'instructor', 'ta'] } } });
    const ta = person('ta-1', ['ta']);
    expect(custom.can('content.manage', inSection(ta, 'ta'))).toBe(true);
    expect(policy.can('content.manage', inSection(ta, 'ta'))).toBe(false); // default policy untouched
  });

  it('replaces rather than merges: dropping a role removes it', () => {
    const strict = createRolePolicy({ overrides: { 'content.manage': { roles: ['admin'] } } });
    expect(strict.can('content.manage', inSection(teacher, 'instructor'))).toBe(false);
  });

  it('treats an empty rule as deny-everyone, admins included', () => {
    const locked = createRolePolicy({ overrides: { 'scheduling.manage': {} } });
    expect(locked.can('scheduling.manage', { actor: admin })).toBe(false);
  });

  it('supports host-defined actions', () => {
    const custom = createRolePolicy({ overrides: { 'library.checkout': { roles: ['student'] } } });
    expect(custom.can('library.checkout', inSection(stu, 'student'))).toBe(true);
    expect(policy.can('library.checkout', inSection(stu, 'student'))).toBe(false);
  });

  it('keeps the tenant check in force for overridden actions', () => {
    const custom = createRolePolicy({ overrides: { 'content.manage': { roles: ['student'] } } });
    const s = person('s', ['student'], 'org-a');
    expect(custom.can('content.manage', inSection(s, 'student', { resourceOrgId: 'org-b' }))).toBe(false);
  });
});

describe('authorize / PermissionDeniedError', () => {
  it('resolves when allowed', async () => {
    await expect(authorize(policy, 'admin.viewAuditLog', { actor: admin })).resolves.toBeUndefined();
  });

  it('rejects with PermissionDeniedError carrying the action', async () => {
    const err = (await authorize(policy, 'admin.viewAuditLog', { actor: stu }).catch((e: unknown) => e)) as PermissionDeniedError;
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PermissionDeniedError');
    expect(err.action).toBe('admin.viewAuditLog');
    expect(err.message).toBe('Not permitted: admin.viewAuditLog');
  });

  it('works with an async custom policy (attribute-based rules)', async () => {
    const onlyDuringOfficeHours: PermissionPolicy = {
      can: async (_action, ctx) => ctx.actor.id === 'allowed-user',
    };
    await expect(authorize(onlyDuringOfficeHours, 'anything', { actor: person('allowed-user', []) })).resolves.toBeUndefined();
    await expect(authorize(onlyDuringOfficeHours, 'anything', { actor: stu })).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('activeSectionRole', () => {
  it('returns the role for an active enrollment', () => {
    expect(activeSectionRole({ role: 'instructor', status: 'active' })).toBe('instructor');
  });

  it.each(['waitlisted', 'dropped', 'completed'] as const)('grants nothing for a %s enrollment', (status) => {
    expect(activeSectionRole({ role: 'instructor', status })).toBeUndefined();
  });

  it('grants nothing when there is no enrollment', () => {
    expect(activeSectionRole(null)).toBeUndefined();
    expect(activeSectionRole(undefined)).toBeUndefined();
  });

  it('feeds straight into a permission check: a dropped instructor loses access', () => {
    const dropped = activeSectionRole({ role: 'instructor', status: 'dropped' });
    expect(policy.can('content.manage', inSection(teacher, dropped))).toBe(false);
  });
});

describe('effectiveRoles', () => {
  it('returns account roles when no section is targeted', () => {
    expect(effectiveRoles({ actor: person('x', ['instructor', 'ta']) })).toEqual(['instructor', 'ta']);
  });

  it('returns the section role plus admin, and drops other account roles, for a section', () => {
    expect(effectiveRoles(inSection(person('x', ['instructor', 'admin']), 'student'))).toEqual(['student', 'admin']);
  });

  it('does not duplicate admin', () => {
    expect(effectiveRoles(inSection(admin, 'admin'))).toEqual(['admin']);
  });
});
