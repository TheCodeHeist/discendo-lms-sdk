import { describe, it, expect } from 'bun:test';
import {
  createRolePolicy,
  authorize,
  activeSectionRole,
  completedSectionRole,
  effectiveRoles,
  isStaff,
  PermissionDeniedError,
  ActorRequiredError,
  DEFAULT_RULES,
} from '../src/core/index.js';
import type { ActionRule, GuardianScope, Identity, PermissionContext, PermissionPolicy, Role } from '../src/core/index.js';

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
    const all = link(['grades', 'attendance', 'schedule', 'announcements']);
    for (const [action, rule] of Object.entries(DEFAULT_RULES)) {
      const allowed = policy.can(action, ctxFor(all));
      expect(allowed, action).toBe('guardianScope' in rule);
    }
    expect(Object.keys(DEFAULT_RULES).filter((a) => 'guardianScope' in DEFAULT_RULES[a as keyof typeof DEFAULT_RULES]).sort()).toEqual([
      'communication.viewGuardianAnnouncements',
      'grading.view',
      'reporting.view',
      'scheduling.view',
    ]);
  });

  it('the announcements scope opens the guardian channel and nothing else, and no other scope opens it', () => {
    const only = link(['announcements']);
    for (const action of Object.keys(DEFAULT_RULES)) {
      expect(policy.can(action, ctxFor(only)), action).toBe(action === 'communication.viewGuardianAnnouncements');
    }
    expect(policy.can('communication.viewGuardianAnnouncements', ctxFor(link(['grades', 'attendance', 'schedule'])))).toBe(false);
  });

  it('never lets a guardian read the students\' channel or post to either channel', () => {
    const all = link(['grades', 'attendance', 'schedule', 'announcements']);
    for (const action of ['communication.viewAnnouncements', 'communication.postAnnouncement', 'communication.postGuardianAnnouncement']) {
      expect(policy.can(action, ctxFor(all)), action).toBe(false);
    }
  });

  it('keeps the guardian channel apart from the students\' channel and from delegation', () => {
    expect(DEFAULT_RULES['communication.postGuardianAnnouncement']).toEqual({ roles: ['admin', 'instructor'] });
    expect('delegable' in DEFAULT_RULES['communication.postGuardianAnnouncement']).toBe(false);
    // a student reads the students' channel but never the guardians'
    const student: PermissionContext = { actor: { id: 's', roles: ['student'], orgId: 'org-a' }, section: { role: 'student' }, resourceOrgId: 'org-a' };
    expect(policy.can('communication.viewAnnouncements', student)).toBe(true);
    expect(policy.can('communication.viewGuardianAnnouncements', student)).toBe(false);
  });
});

describe('delegated actions (grants an instructor gave a TA)', () => {
  const policy = createRolePolicy();
  const ta = person('ta-1', ['ta'], 'org-a');
  const DELEGABLE = [
    'assessment.recordOffline',
    'communication.postAnnouncement',
    'content.manage',
    'enrollment.enroll',
    'enrollment.grantRole.student',
    'reporting.recordAttendance',
    'scheduling.manageOccurrence',
    'scheduling.recordAttendance',
  ];
  const asTa = (delegated: string[] | undefined, extra: Partial<PermissionContext> = {}): PermissionContext => ({
    actor: ta,
    section: { role: 'ta', delegated },
    resourceOrgId: 'org-a',
    ...extra,
  });

  it('marks exactly eight built-in actions as delegable, and the policy lists them', () => {
    expect(
      Object.entries(DEFAULT_RULES)
        .filter(([, rule]) => 'delegable' in rule)
        .map(([action]) => action)
        .sort(),
    ).toEqual(DELEGABLE);
    expect([...policy.delegableActions].sort()).toEqual(DELEGABLE);
  });

  it('lets a TA do exactly the delegable actions they were given', () => {
    expect(policy.can('content.manage', asTa(['content.manage']))).toBe(true);
    expect(policy.can('communication.postAnnouncement', asTa(['content.manage']))).toBe(false);
    expect(policy.can('content.manage', asTa([]))).toBe(false);
    expect(policy.can('content.manage', asTa(undefined))).toBe(false);
  });

  it('ignores a grant for an action that is not delegable, however it got there', () => {
    const notDelegable = ['enrollment.bulkEnroll', 'enrollment.grantRole.ta', 'enrollment.grantRole.instructor', 'scheduling.manage', 'admin.viewAuditLog', 'delegation.grant', 'delegation.revoke'];
    for (const action of notDelegable) {
      expect(policy.can(action, asTa(notDelegable)), action).toBe(false);
    }
  });

  it('only counts for someone whose role in the section is ta', () => {
    for (const role of ['student', 'instructor', undefined] as const) {
      const ctx: PermissionContext = { actor: ta, section: { role, delegated: DELEGABLE }, resourceOrgId: 'org-a' };
      expect(policy.can('content.manage', ctx), String(role)).toBe(role === 'instructor');
    }
    const noSection: PermissionContext = { actor: person('x', ['ta'], 'org-a'), resourceOrgId: 'org-a' };
    expect(policy.can('content.manage', noSection)).toBe(false);
  });

  it('is still behind the tenant check', () => {
    expect(policy.can('content.manage', asTa(['content.manage'], { resourceOrgId: 'org-b' }))).toBe(false);
    expect(policy.can('content.manage', asTa(['content.manage'], { resourceOrgId: undefined }))).toBe(false);
  });

  it('follows the rule table: an override that drops delegable removes it, one that adds it enables it', () => {
    const dropped = createRolePolicy({ overrides: { 'content.manage': { roles: ['admin', 'instructor'] } } });
    expect(dropped.can('content.manage', asTa(['content.manage']))).toBe(false);
    expect(dropped.delegableActions).not.toContain('content.manage');
    const added = createRolePolicy({ overrides: { 'grading.amend': { roles: ['instructor'], delegable: true } } });
    expect(added.can('grading.amend', asTa(['grading.amend']))).toBe(true);
    expect(added.delegableActions).toContain('grading.amend');
  });

  it('has rules for managing delegation: instructors and admins grant and revoke, a TA only sees their own', () => {
    const inSec = (actor: Identity, role: Role | undefined, extra: Partial<PermissionContext> = {}) =>
      ({ actor, section: { role }, resourceOrgId: undefined, ...extra }) as PermissionContext;
    expect(policy.can('delegation.grant', inSec(teacher, 'instructor'))).toBe(true);
    expect(policy.can('delegation.revoke', inSec(teacher, 'instructor'))).toBe(true);
    expect(policy.can('delegation.grant', inSec(admin, undefined))).toBe(true);
    for (const action of ['delegation.grant', 'delegation.revoke']) {
      expect(policy.can(action, inSec(person('t', ['ta']), 'ta')), action).toBe(false);
      expect(policy.can(action, inSec(stu, 'student')), action).toBe(false);
    }
    const t = person('t', ['ta']);
    expect(policy.can('delegation.view', inSec(t, 'ta', { resourceOwnerId: 't' }))).toBe(true);
    expect(policy.can('delegation.view', inSec(t, 'ta', { resourceOwnerId: 'other-ta' }))).toBe(false);
    expect(policy.can('delegation.view', inSec(stu, 'student', { resourceOwnerId: stu.id }))).toBe(false);
  });
});

describe('assessment rules', () => {
  const policy = createRolePolicy();
  const ctx = (actor: Identity, role: Role | undefined, ownerId?: string): PermissionContext => ({
    actor,
    section: { role },
    resourceOrgId: undefined,
    resourceOwnerId: ownerId,
  });
  const ta = person('ta-1', ['ta']);

  it.each(['assessment.submit', 'assessment.startAttempt'])('%s is for a student acting on their own work only', (action) => {
    expect(policy.can(action, ctx(stu, 'student', stu.id))).toBe(true);
    expect(policy.can(action, ctx(stu, 'student', 'someone-else'))).toBe(false);
    expect(policy.can(action, ctx(stu, 'student', undefined))).toBe(false);
    for (const [who, role] of [[teacher, 'instructor'], [ta, 'ta'], [admin, undefined]] as const) {
      expect(policy.can(action, ctx(who, role, who.id)), `${who.id} as self`).toBe(false);
      expect(policy.can(action, ctx(who, role, stu.id)), `${who.id} for a student`).toBe(false);
    }
  });

  it('assessment.viewAttempts is open to staff for anyone and to a student for themselves', () => {
    for (const [who, role] of [[teacher, 'instructor'], [ta, 'ta'], [admin, undefined]] as const) {
      expect(policy.can('assessment.viewAttempts', ctx(who, role, stu.id)), who.id).toBe(true);
    }
    expect(policy.can('assessment.viewAttempts', ctx(stu, 'student', stu.id))).toBe(true);
    expect(policy.can('assessment.viewAttempts', ctx(stu, 'student', 'someone-else'))).toBe(false);
  });

  it('assessment.recordOffline is for admins and instructors only, never a student, even for their own work', () => {
    for (const [who, role] of [[teacher, 'instructor'], [admin, undefined]] as const) {
      expect(policy.can('assessment.recordOffline', ctx(who, role, stu.id)), who.id).toBe(true);
    }
    expect(policy.can('assessment.recordOffline', ctx(ta, 'ta', stu.id))).toBe(false);
    expect(policy.can('assessment.recordOffline', ctx(stu, 'student', stu.id))).toBe(false);
  });

  it('gives a guardian nothing here, whatever the link allows', () => {
    const parent = person('parent-1', ['student'], 'org-a');
    const guardian = { wardId: 'kid', scopes: ['grades', 'attendance', 'schedule'] as GuardianScope[] };
    for (const action of ['assessment.submit', 'assessment.startAttempt', 'assessment.viewAttempts', 'assessment.recordOffline']) {
      const c: PermissionContext = { actor: parent, section: {}, resourceOrgId: 'org-a', resourceOwnerId: 'kid', guardian };
      expect(policy.can(action, c), action).toBe(false);
    }
  });
});

describe('role hierarchy of the default rules', () => {
  // student <= ta <= instructor <= admin: a higher role can always do what a lower one can.
  // (Own-resource rights are a different thing and are not part of this ordering.)
  const rules = Object.entries(DEFAULT_RULES) as Array<[string, ActionRule]>;
  const grantedTo = (role: Role) => rules.filter(([, rule]) => rule.roles?.includes(role)).map(([action]) => action);
  const missing = (lower: Role, higher: Role) => grantedTo(lower).filter((a) => !grantedTo(higher).includes(a));

  it.each([
    ['student', 'ta'],
    ['ta', 'instructor'],
    ['instructor', 'admin'],
  ] as const)('everything %s may do by role, %s may do too', (lower, higher) => {
    expect(missing(lower, higher)).toEqual([]);
  });

  it('is strict: each step up adds something', () => {
    expect(grantedTo('ta').length).toBeGreaterThan(grantedTo('student').length);
    expect(grantedTo('instructor').length).toBeGreaterThan(grantedTo('ta').length);
    expect(grantedTo('admin').length).toBeGreaterThan(grantedTo('instructor').length);
  });
});

describe('isStaff', () => {
  const person = (roles: Role[]): Identity => ({ id: 'p', roles, orgId: 'org-a' });
  const inSection = (role: Role | undefined, roles: Role[] = ['student']): PermissionContext => ({
    actor: person(roles),
    section: { role },
    resourceOrgId: 'org-a',
  });

  it.each(['admin', 'instructor', 'ta'] as const)('is true for a %s of the section', (role) => {
    expect(isStaff(inSection(role))).toBe(true);
  });

  it('is false for a student, and for someone with no role in the section', () => {
    expect(isStaff(inSection('student'))).toBe(false);
    expect(isStaff(inSection(undefined))).toBe(false);
  });

  it('counts a global admin, but not a global instructor who is not enrolled', () => {
    expect(isStaff(inSection(undefined, ['admin']))).toBe(true);
    expect(isStaff(inSection(undefined, ['instructor']))).toBe(false);
  });
});

describe('completed enrollments: read-only access to your own grades and content', () => {
  const completedStudent = (ownerId?: string): PermissionContext => ({
    actor: { id: 's1', roles: ['student'], orgId: 'org-a' },
    section: { role: undefined, completedRole: 'student' },
    resourceOrgId: 'org-a',
    resourceOwnerId: ownerId,
  });

  it('completedSectionRole is the role of a completed enrollment, and nothing else', () => {
    expect(completedSectionRole({ role: 'student', status: 'completed' })).toBe('student');
    for (const status of ['active', 'waitlisted', 'dropped'] as const) {
      expect(completedSectionRole({ role: 'student', status }), status).toBeUndefined();
    }
    expect(completedSectionRole(null)).toBeUndefined();
    expect(completedSectionRole(undefined)).toBeUndefined();
  });

  it('opens exactly two actions to a completed student: their own grades, and published content', () => {
    const allowed = Object.keys(DEFAULT_RULES).filter((a) => policy.can(a, completedStudent('s1')));
    expect(allowed.sort()).toEqual(['content.view', 'grading.view']);
  });

  it('never lets a completed student see someone else\'s grades', () => {
    expect(policy.can('grading.view', completedStudent('s2'))).toBe(false);
    expect(policy.can('grading.view', completedStudent(undefined))).toBe(false);
  });

  it.each(['instructor', 'ta', 'admin'] as const)('gives a completed %s nothing: only students keep access', (role) => {
    const ctx: PermissionContext = {
      actor: { id: 's1', roles: [role === 'admin' ? 'student' : role], orgId: 'org-a' },
      section: { role: undefined, completedRole: role },
      resourceOrgId: 'org-a',
      resourceOwnerId: 's1',
    };
    for (const action of Object.keys(DEFAULT_RULES)) expect(policy.can(action, ctx), action).toBe(false);
  });

  it('only counts on a rule that opts in with afterCompletion, so an override that drops the flag revokes it', () => {
    const custom = createRolePolicy({ overrides: { 'content.view': { roles: ['admin', 'instructor', 'ta', 'student'] } } });
    expect(custom.can('content.view', completedStudent('s1'))).toBe(false);
    const kept = createRolePolicy({
      overrides: { 'content.view': { roles: ['admin', 'instructor', 'ta', 'student'], afterCompletion: true } },
    });
    expect(kept.can('content.view', completedStudent('s1'))).toBe(true);
  });

  it('is carried by exactly the two view actions: no write action, and none delegable', () => {
    const flagged = Object.entries(DEFAULT_RULES).filter(([, rule]) => 'afterCompletion' in rule);
    expect(flagged.map(([a]) => a).sort()).toEqual(['content.view', 'grading.view']);
    for (const [action, rule] of flagged) {
      expect(action.endsWith('.view'), action).toBe(true);
      expect('delegable' in rule, action).toBe(false);
    }
  });

  describe('guardians follow the ward', () => {
    const guardianOf = (wardCompleted: boolean | undefined, scopes: GuardianScope[]): PermissionContext => ({
      actor: { id: 'g1', roles: ['student'], orgId: 'org-a' },
      section: { role: undefined },
      resourceOrgId: 'org-a',
      resourceOwnerId: 'kid',
      guardian: { wardId: 'kid', scopes, ...(wardCompleted === undefined ? {} : { wardCompleted }) },
    });
    const all: GuardianScope[] = ['grades', 'attendance', 'schedule', 'announcements'];

    it('a guardian of a completed ward gets the grades and nothing else', () => {
      const allowed = Object.keys(DEFAULT_RULES).filter((a) => policy.can(a, guardianOf(true, all)));
      expect(allowed).toEqual(['grading.view']);
    });

    it('a guardian of an active ward still gets every action their scopes open', () => {
      const allowed = Object.keys(DEFAULT_RULES).filter((a) => policy.can(a, guardianOf(false, all)));
      expect(allowed.sort()).toEqual([
        'communication.viewGuardianAnnouncements',
        'grading.view',
        'reporting.view',
        'scheduling.view',
      ]);
    });

    it('still needs the grades scope, and a rule that has dropped the flag refuses a completed ward', () => {
      expect(policy.can('grading.view', guardianOf(true, ['attendance']))).toBe(false);
      const custom = createRolePolicy({
        overrides: { 'grading.view': { roles: ['admin', 'instructor', 'ta'], ownRoles: ['student'], guardianScope: 'grades' } },
      });
      expect(custom.can('grading.view', guardianOf(true, all))).toBe(false);
      expect(custom.can('grading.view', guardianOf(false, all))).toBe(true);
    });
  });
});

describe('guardian link management actions', () => {
  const org = (roles: Role[], extra: Partial<PermissionContext> = {}): PermissionContext => ({
    actor: { id: 'p1', roles, orgId: 'org-a' },
    resourceOrgId: 'org-a',
    ...extra,
  });

  it('guardian.manageLinks is for admins only, whatever else the person is, and never delegable', () => {
    expect(policy.can('guardian.manageLinks', org(['admin']))).toBe(true);
    for (const role of ['instructor', 'ta', 'student'] as const) {
      expect(policy.can('guardian.manageLinks', org([role])), role).toBe(false);
      expect(policy.can('guardian.manageLinks', org([role], { resourceOwnerId: 'p1' })), role).toBe(false);
    }
    expect('delegable' in DEFAULT_RULES['guardian.manageLinks']).toBe(false);
    expect(policy.can('guardian.manageLinks', { ...org(['admin']), resourceOrgId: 'org-b' })).toBe(false);
  });

  it('guardian.viewLinks is for admins, and for anyone about their own links', () => {
    expect(policy.can('guardian.viewLinks', org(['admin']))).toBe(true);
    expect(policy.can('guardian.viewLinks', org(['student'], { resourceOwnerId: 'p1' }))).toBe(true);
    expect(policy.can('guardian.viewLinks', org(['student'], { resourceOwnerId: 'p2' }))).toBe(false);
    expect(policy.can('guardian.viewLinks', org(['instructor']))).toBe(false);
    expect(policy.can('guardian.viewLinks', org(['student']))).toBe(false);
  });

  it('guardian.listRecipients is for the section\'s admins and instructors, not TAs, students or guardians', () => {
    const inSection = (role: Role | undefined, roles: Role[]): PermissionContext => ({
      actor: { id: 'p1', roles, orgId: 'org-a' },
      section: { role },
      resourceOrgId: 'org-a',
    });
    expect(policy.can('guardian.listRecipients', inSection('instructor', ['instructor']))).toBe(true);
    expect(policy.can('guardian.listRecipients', inSection(undefined, ['admin']))).toBe(true);
    for (const role of ['ta', 'student'] as const) expect(policy.can('guardian.listRecipients', inSection(role, [role])), role).toBe(false);
    expect(policy.can('guardian.listRecipients', inSection(undefined, ['instructor']))).toBe(false);
  });

  it('a guardian\'s scopes open none of the three', () => {
    const ctx: PermissionContext = {
      actor: { id: 'g1', roles: ['student'], orgId: 'org-a' },
      section: { role: undefined },
      resourceOrgId: 'org-a',
      resourceOwnerId: 'kid',
      guardian: { wardId: 'kid', scopes: ['grades', 'attendance', 'schedule', 'announcements'] },
    };
    for (const a of ['guardian.manageLinks', 'guardian.viewLinks', 'guardian.listRecipients']) expect(policy.can(a, ctx), a).toBe(false);
  });
});

describe('scheduling actions', () => {
  const org = (id: string, roles: Role[], extra: Partial<PermissionContext> = {}): PermissionContext => ({
    actor: { id, roles, orgId: 'org-a' },
    resourceOrgId: 'org-a',
    ...extra,
  });
  const inSection = (id: string, role: Role | undefined, roles: Role[] = [role ?? 'student'], delegated?: string[]): PermissionContext =>
    org(id, roles, { section: { role, ...(delegated ? { delegated: delegated as never } : {}) } });

  it.each(['scheduling.manageOccurrence', 'scheduling.recordAttendance'])('%s: an instructor or admin, a TA only when delegated, never a student', (action) => {
    expect(policy.can(action, inSection('i', 'instructor'))).toBe(true);
    expect(policy.can(action, inSection('a', undefined, ['admin']))).toBe(true);
    expect(policy.can(action, inSection('t', 'ta'))).toBe(false);
    expect(policy.can(action, inSection('t', 'ta', ['ta'], [action]))).toBe(true);
    expect(policy.can(action, inSection('t', 'ta', ['ta'], ['scheduling.view']))).toBe(false);
    expect(policy.can(action, inSection('s', 'student'))).toBe(false);
    expect(policy.can(action, inSection('s', 'student', ['student'], [action]))).toBe(false);
    expect('delegable' in DEFAULT_RULES[action as keyof typeof DEFAULT_RULES]).toBe(true);
  });

  it('scheduling.manage is still the admin\'s alone, delegable to nobody', () => {
    expect(policy.can('scheduling.manage', inSection('a', undefined, ['admin']))).toBe(true);
    for (const role of ['instructor', 'ta', 'student'] as const) expect(policy.can('scheduling.manage', inSection('x', role)), role).toBe(false);
    expect(policy.can('scheduling.manage', inSection('t', 'ta', ['ta'], ['scheduling.manage']))).toBe(false);
  });

  it('scheduling.manageSettings: an instructor for themselves only, an admin for anyone, no one else', () => {
    expect(policy.can('scheduling.manageSettings', org('i1', ['instructor'], { resourceOwnerId: 'i1' }))).toBe(true);
    expect(policy.can('scheduling.manageSettings', org('i1', ['instructor'], { resourceOwnerId: 'i2' }))).toBe(false);
    expect(policy.can('scheduling.manageSettings', org('i1', ['instructor']))).toBe(false);
    expect(policy.can('scheduling.manageSettings', org('a', ['admin'], { resourceOwnerId: 'i2' }))).toBe(true);
    for (const role of ['ta', 'student'] as const) {
      expect(policy.can('scheduling.manageSettings', org('x', [role], { resourceOwnerId: 'x' })), role).toBe(false);
    }
    expect('delegable' in DEFAULT_RULES['scheduling.manageSettings']).toBe(false);
  });

  it('scheduling.manageQualifications is the admin\'s alone: an instructor cannot qualify themselves', () => {
    expect(policy.can('scheduling.manageQualifications', org('a', ['admin']))).toBe(true);
    expect(policy.can('scheduling.manageQualifications', org('i1', ['instructor'], { resourceOwnerId: 'i1' }))).toBe(false);
    expect(policy.can('scheduling.manageQualifications', { ...org('a', ['admin']), resourceOrgId: 'org-b' })).toBe(false);
    expect('delegable' in DEFAULT_RULES['scheduling.manageQualifications']).toBe(false);
  });

  it('a guardian\'s scopes still open only scheduling.view', () => {
    const ctx: PermissionContext = {
      actor: { id: 'g', roles: ['student'], orgId: 'org-a' },
      section: { role: undefined },
      resourceOrgId: 'org-a',
      resourceOwnerId: 'kid',
      guardian: { wardId: 'kid', scopes: ['grades', 'attendance', 'schedule', 'announcements'] },
    };
    for (const a of Object.keys(DEFAULT_RULES).filter((x) => x.startsWith('scheduling.'))) {
      expect(policy.can(a, ctx), a).toBe(a === 'scheduling.view');
    }
  });
});

describe('reporting actions', () => {
  const inSection = (id: string, role: Role | undefined, roles: Role[] = [role ?? 'student'], extra: Partial<PermissionContext> = {}): PermissionContext => ({
    actor: { id, roles, orgId: 'org-a' },
    section: { role },
    resourceOrgId: 'org-a',
    ...extra,
  });
  const delegated = (action: string): PermissionContext => ({
    ...inSection('t', 'ta', ['ta']),
    section: { role: 'ta', delegated: [action] as never },
  });

  it('reporting.recordAttendance: an instructor or admin; a TA only when the instructor appoints them; never a student', () => {
    expect(policy.can('reporting.recordAttendance', inSection('i', 'instructor'))).toBe(true);
    expect(policy.can('reporting.recordAttendance', inSection('a', undefined, ['admin']))).toBe(true);
    expect(policy.can('reporting.recordAttendance', inSection('t', 'ta'))).toBe(false);
    expect(policy.can('reporting.recordAttendance', delegated('reporting.recordAttendance'))).toBe(true);
    expect(policy.can('reporting.recordAttendance', delegated('scheduling.recordAttendance'))).toBe(false);
    expect(policy.can('reporting.recordAttendance', inSection('s', 'student'))).toBe(false);
    expect('delegable' in DEFAULT_RULES['reporting.recordAttendance']).toBe(true);
  });

  it('reporting.view: staff for anyone, a student for themselves, a guardian through the attendance scope', () => {
    for (const role of ['instructor', 'ta'] as const) expect(policy.can('reporting.view', inSection('x', role)), role).toBe(true);
    expect(policy.can('reporting.view', inSection('s1', 'student', ['student'], { resourceOwnerId: 's1' }))).toBe(true);
    expect(policy.can('reporting.view', inSection('s1', 'student', ['student'], { resourceOwnerId: 's2' }))).toBe(false);
    expect(policy.can('reporting.view', inSection('s1', 'student'))).toBe(false);
    const guardian = (scopes: GuardianScope[]): PermissionContext =>
      inSection('g', undefined, ['student'], { resourceOwnerId: 'kid', guardian: { wardId: 'kid', scopes } });
    expect(policy.can('reporting.view', guardian(['attendance']))).toBe(true);
    expect(policy.can('reporting.view', guardian(['grades', 'schedule', 'announcements']))).toBe(false);
  });
});

describe('admin.viewAuditLog', () => {
  const org = (id: string, roles: Role[], resourceOrgId = 'org-a'): PermissionContext => ({
    actor: { id, roles, orgId: 'org-a' },
    resourceOrgId,
  });

  it('is for admins of the organization only: never an instructor, a TA, a student, or an admin of another organization', () => {
    expect(policy.can('admin.viewAuditLog', org('a', ['admin']))).toBe(true);
    for (const role of ['instructor', 'ta', 'student'] as const) {
      expect(policy.can('admin.viewAuditLog', org('x', [role])), role).toBe(false);
      expect(policy.can('admin.viewAuditLog', { ...org('x', [role]), resourceOwnerId: 'x' }), role).toBe(false);
    }
    expect(policy.can('admin.viewAuditLog', org('a', ['admin'], 'org-b'))).toBe(false);
    expect('delegable' in DEFAULT_RULES['admin.viewAuditLog']).toBe(false);
  });

  it('is not opened by a delegation, an instructor role in a section, or a guardian link', () => {
    const delegated: PermissionContext = { ...org('t', ['ta']), section: { role: 'ta', delegated: ['admin.viewAuditLog'] as never } };
    expect(policy.can('admin.viewAuditLog', delegated)).toBe(false);
    const guardian: PermissionContext = { ...org('g', ['student']), resourceOwnerId: 'kid', guardian: { wardId: 'kid', scopes: ['grades', 'attendance', 'schedule', 'announcements'] } };
    expect(policy.can('admin.viewAuditLog', guardian)).toBe(false);
  });
});
