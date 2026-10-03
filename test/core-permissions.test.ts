import { describe, it, expect } from 'bun:test';
import {
  createRolePolicy,
  authorize,
  activeSectionRole,
  effectiveRoles,
  PermissionDeniedError,
  ActorRequiredError,
  DEFAULT_RULES,
} from '../src/core/index.js';
import type { GuardianScope, Identity, PermissionContext, PermissionPolicy, Role } from '../src/core/index.js';

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
  resourceOrgId: undefined, // these tests use no-organization actors unless they say otherwise
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

  it('gives nothing to a leftover "guardian" role string from older data (guardians use GuardianLink now)', () => {
    const legacy = 'guardian' as Role;
    const parent = person('parent-1', [legacy]);
    for (const action of Object.keys(DEFAULT_RULES)) {
      expect(policy.can(action, inSection(parent, legacy, { resourceOwnerId: 'parent-1' })), action).toBe(false);
    }
    expect(Object.keys(DEFAULT_RULES)).not.toContain('enrollment.grantRole.guardian');
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
    expect(policy.can('admin.viewAuditLog', { actor: admin, resourceOrgId: undefined })).toBe(true);
    expect(policy.can('admin.viewAuditLog', { actor: teacher, resourceOrgId: undefined })).toBe(false);
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

  describe('a resource with no organization', () => {
    // "No organization" is a value like any other: it matches only an actor with no organization.
    it('refuses an actor who belongs to an organization, even an admin', () => {
      expect(policy.can('scheduling.manage', inSection(orgAAdmin, undefined, { resourceOrgId: undefined }))).toBe(false);
    });

    it('refuses when the caller leaves resourceOrgId out entirely (untyped callers fail closed)', () => {
      const omitted = { actor: orgAAdmin, section: {} } as PermissionContext;
      expect(policy.can('scheduling.manage', omitted)).toBe(false);
    });

    it('allows an actor with no organization (single-institution deployments)', () => {
      expect(policy.can('scheduling.manage', inSection(admin, undefined, { resourceOrgId: undefined }))).toBe(true);
    });

    it('also refuses the own-resource path (a student viewing their own grade)', () => {
      const s = person('s-a', ['student'], 'org-a');
      const ctx = inSection(s, 'student', { resourceOrgId: undefined, resourceOwnerId: 's-a' });
      expect(policy.can('grading.view', ctx)).toBe(false);
      expect(policy.can('grading.view', { ...ctx, resourceOrgId: 'org-a' })).toBe(true);
    });

    it('also refuses actions with no section in the context', () => {
      expect(policy.can('admin.viewAuditLog', { actor: orgAAdmin, resourceOrgId: undefined })).toBe(false);
      expect(policy.can('admin.viewAuditLog', { actor: admin, resourceOrgId: undefined })).toBe(true);
    });

    it('still refuses a no-org actor on an org resource (the other direction)', () => {
      expect(policy.can('admin.viewAuditLog', { actor: admin, resourceOrgId: 'org-a' })).toBe(false);
    });
  });
});

describe('role policy: deny by default', () => {
  it('refuses an unknown action', () => {
    expect(policy.can('nope.nothing', { actor: admin, resourceOrgId: undefined })).toBe(false);
  });

  it('treats action names that match object prototype members as unknown actions', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(policy.can(name, { actor: admin, resourceOrgId: undefined })).toBe(false);
    }
  });

  it('defines a rule for every built-in action that grants someone something', () => {
    for (const [action, rule] of Object.entries(DEFAULT_RULES) as Array<[string, { roles?: readonly Role[]; ownRoles?: readonly Role[] }]>) {
      expect((rule.roles?.length ?? 0) + (rule.ownRoles?.length ?? 0)).toBeGreaterThan(0);
      expect(action).toMatch(/^[a-z]+(\.[A-Za-z]+)+$/);
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
    expect(locked.can('scheduling.manage', { actor: admin, resourceOrgId: undefined })).toBe(false);
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
    await expect(authorize(policy, 'admin.viewAuditLog', { actor: admin, resourceOrgId: undefined })).resolves.toBeUndefined();
  });

  it('rejects with PermissionDeniedError carrying the action', async () => {
    const err = (await authorize(policy, 'admin.viewAuditLog', { actor: stu, resourceOrgId: undefined }).catch((e: unknown) => e)) as PermissionDeniedError;
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
    await expect(authorize(onlyDuringOfficeHours, 'anything', { actor: person('allowed-user', []), resourceOrgId: undefined })).resolves.toBeUndefined();
    await expect(authorize(onlyDuringOfficeHours, 'anything', { actor: stu, resourceOrgId: undefined })).rejects.toBeInstanceOf(PermissionDeniedError);
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
    expect(effectiveRoles({ actor: person('x', ['instructor', 'ta']), resourceOrgId: undefined })).toEqual(['instructor', 'ta']);
  });

  it('returns the section role plus admin, and drops other account roles, for a section', () => {
    expect(effectiveRoles(inSection(person('x', ['instructor', 'admin']), 'student'))).toEqual(['student', 'admin']);
  });

  it('does not duplicate admin', () => {
    expect(effectiveRoles(inSection(admin, 'admin'))).toEqual(['admin']);
  });
});

describe('authorize is strict about what counts as "allowed"', () => {
  it.each([[undefined], [null], ['true'], [1], [{}], [[]]])('denies a policy answer of %p', async (answer) => {
    const sloppy = { can: () => answer } as unknown as PermissionPolicy;
    await expect(authorize(sloppy, 'anything', { actor: admin, resourceOrgId: undefined })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('allows only an exact true, including from an async policy', async () => {
    await expect(authorize({ can: () => true }, 'anything', { actor: stu, resourceOrgId: undefined })).resolves.toBeUndefined();
    await expect(authorize({ can: async () => true }, 'anything', { actor: stu, resourceOrgId: undefined })).resolves.toBeUndefined();
  });

  it('lets an error thrown by the policy propagate instead of allowing or swallowing it', async () => {
    const broken: PermissionPolicy = {
      can: () => {
        throw new Error('backend down');
      },
    };
    await expect(authorize(broken, 'anything', { actor: admin, resourceOrgId: undefined })).rejects.toThrow('backend down');
  });
});

describe('ActorRequiredError', () => {
  it('is its own error, distinct from a permission denial', () => {
    const err = new ActorRequiredError('enrollment.enroll');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermissionDeniedError);
    expect(err.name).toBe('ActorRequiredError');
    expect(err.action).toBe('enrollment.enroll');
  });
});

describe('default role-grant rules', () => {
  const grant = (actor: Identity, role: Role, sectionRole: Role | undefined) =>
    policy.can(`enrollment.grantRole.${role}`, inSection(actor, sectionRole));

  it('lets only an admin grant admin and instructor', () => {
    expect(grant(admin, 'admin', undefined)).toBe(true);
    expect(grant(admin, 'instructor', undefined)).toBe(true);
    expect(grant(teacher, 'admin', 'instructor')).toBe(false);
    expect(grant(teacher, 'instructor', 'instructor')).toBe(false);
  });

  it('lets an instructor grant ta and student', () => {
    for (const role of ['ta', 'student'] as const) {
      expect(grant(teacher, role, 'instructor')).toBe(true);
    }
  });

  it('lets no TA or student grant any role', () => {
    for (const role of ['admin', 'instructor', 'ta', 'student'] as const) {
      expect(grant(person('ta-1', ['ta']), role, 'ta')).toBe(false);
      expect(grant(stu, role, 'student')).toBe(false);
    }
  });

  it('has a grant rule for every role, so no role can be handed out unchecked', () => {
    // Record<Role, true> makes tsc fail here if a role is ever added to `Role`
    // without being listed, so this test can't silently go stale.
    const allRoles: Record<Role, true> = { admin: true, instructor: true, ta: true, student: true };
    for (const role of Object.keys(allRoles) as Role[]) {
      expect(Object.keys(DEFAULT_RULES)).toContain(`enrollment.grantRole.${role}`);
    }
  });
});


describe('guardian access (a verified link to a ward)', () => {
  const policy = createRolePolicy();
  const parent = person('parent-1', ['student'], 'org-a'); // a guardian has no role of their own: the link is the proof
  const link = (scopes: GuardianScope[], wardId = 'kid') => ({ wardId, scopes });
  const ctxFor = (guardian: PermissionContext['guardian'], extra: Partial<PermissionContext> = {}): PermissionContext => ({
    actor: parent,
    section: {},
    resourceOrgId: 'org-a',
    resourceOwnerId: 'kid',
    guardian,
    ...extra,
  });

  it('lets a guardian view the ward\'s grades with the grades scope, and nothing else', () => {
    const g = link(['grades']);
    expect(policy.can('grading.view', ctxFor(g))).toBe(true);
    for (const action of ['grading.record', 'content.view', 'content.manage', 'enrollment.drop', 'enrollment.viewRoster', 'assessment.submit', 'reporting.view', 'scheduling.view', 'admin.viewAuditLog']) {
      expect(policy.can(action, ctxFor(g)), action).toBe(false);
    }
  });

  it('maps each scope to its own action', () => {
    expect(policy.can('reporting.view', ctxFor(link(['attendance'])))).toBe(true);
    expect(policy.can('grading.view', ctxFor(link(['attendance'])))).toBe(false);
    expect(policy.can('scheduling.view', ctxFor(link(['schedule'])))).toBe(true);
    expect(policy.can('reporting.view', ctxFor(link(['schedule'])))).toBe(false);
  });

  it('refuses a link with no scopes', () => {
    expect(policy.can('grading.view', ctxFor(link([])))).toBe(false);
  });

  it('refuses when the resource belongs to someone other than the linked ward', () => {
    expect(policy.can('grading.view', ctxFor(link(['grades']), { resourceOwnerId: 'other-kid' }))).toBe(false);
    expect(policy.can('grading.view', ctxFor(link(['grades']), { resourceOwnerId: undefined }))).toBe(false);
  });

  it('gives nothing for a link from someone to themselves', () => {
    const self = { wardId: 'parent-1', scopes: ['grades', 'attendance', 'schedule'] as GuardianScope[] };
    expect(policy.can('grading.view', ctxFor(self, { resourceOwnerId: 'parent-1' }))).toBe(false);
  });

  it('refuses when there is no verified link in the context', () => {
    expect(policy.can('grading.view', ctxFor(undefined))).toBe(false);
  });

  it('is still behind the tenant check', () => {
    expect(policy.can('grading.view', ctxFor(link(['grades']), { resourceOrgId: 'org-b' }))).toBe(false);
    expect(policy.can('grading.view', ctxFor(link(['grades']), { resourceOrgId: undefined }))).toBe(false);
  });

  it('only applies to rules that opt in, so an override that drops the scope removes guardian access', () => {
    const custom = createRolePolicy({ overrides: { 'grading.view': { roles: ['admin', 'instructor'] } } });
    expect(custom.can('grading.view', ctxFor(link(['grades'])))).toBe(false);
  });

  it('never gives a guardian a write action, whatever scopes the link has', () => {
    const all = link(['grades', 'attendance', 'schedule']);
    for (const [action, rule] of Object.entries(DEFAULT_RULES)) {
      const allowed = policy.can(action, ctxFor(all));
      expect(allowed, action).toBe('guardianScope' in rule);
    }
    expect(Object.keys(DEFAULT_RULES).filter((a) => 'guardianScope' in DEFAULT_RULES[a as keyof typeof DEFAULT_RULES]).sort()).toEqual([
      'grading.view',
      'reporting.view',
      'scheduling.view',
    ]);
  });
});
