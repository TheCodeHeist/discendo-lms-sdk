import type { ActorContext, PermissionPolicy } from '../../core/permissions.js';
import { PermissionDeniedError, ActorRequiredError } from '../../core/permissions.js';
import { authorizeWithinOwnOrg } from '../../core/authorization.js';
import type { AuthorizationRepos } from '../../core/authorization.js';
import { sameOrg } from '../../core/tenancy.js';

export interface AuditEntry {
  id: string;
  actorId: string;
  /**
   * The organization the actor belonged to, filled in from their stored account by
   * `AdminService.audited`. An entry without one (written by plain `withAudit`, or before
   * organizations existed) belongs to "no organization": with enforcement only an admin who
   * also has none can read it.
   */
  orgId?: string;
  action: string;
  targetId: string;
  timestamp: Date;
  /** Present, and always `'denied'`, only on an entry recording a refused attempt (`recordDenials`). */
  outcome?: 'denied';
  diff?: Record<string, { before: unknown; after: unknown }>;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntry, 'id'>): Promise<AuditEntry>;
  listForTarget(targetId: string): Promise<AuditEntry[]>;
}

/**
 * The action an audited call performed, or the refusal it ran into, could not be written to the
 * audit log. What happened is in the fields, so the caller can tell "it worked but is not logged"
 * from "it was refused and that is not logged", and can still use `result`.
 */
export class AuditWriteFailedError extends Error {
  constructor(
    /** Why the write failed. */
    readonly cause: unknown,
    /** True if the audited call completed (see `result`); false if it was refused (see `refusal`). */
    readonly completed: boolean,
    /** What the call returned, when it completed. */
    readonly result?: unknown,
    /** The permission error that was recorded, when the call was refused. */
    readonly refusal?: unknown,
  ) {
    super(
      completed
        ? 'The action was carried out but its audit entry could not be written'
        : 'The attempt was refused and its audit entry could not be written',
    );
    this.name = 'AuditWriteFailedError';
  }
}

/**
 * Wrap this around any mutation in the host app to get audit logging
 * without scattering log calls through every service:
 *
 *   await withAudit(auditRepo, 'grade.update', gradeId, actorId, () =>
 *     gradingService.recordGrade(...)
 *   );
 *
 * It records only successes, and writes no organization: with several organizations use
 * `AdminService.audited`, which takes both from the actor's stored account. If the entry cannot be
 * written you get an `AuditWriteFailedError` that carries the call's result, since the call has
 * already happened.
 */
export async function withAudit<T>(
  audit: AuditRepository,
  action: string,
  targetId: string,
  actorId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await fn();
  try {
    await audit.append({ actorId, action, targetId, timestamp: new Date() });
  } catch (cause) {
    throw new AuditWriteFailedError(cause, true, result);
  }
  return result;
}

export interface AdminServiceOptions {
  /**
   * Turns on permission enforcement and organizations: `history` then needs `admin.viewAuditLog`
   * and only shows the admin's own organization's entries, and `audited` takes the actor and their
   * organization from the stored account. Leave it unset and the service behaves as it always has.
   */
  enforcement?: { policy: PermissionPolicy; repos: Pick<AuthorizationRepos, 'users'> };
}

export interface AuditedOptions {
  /** What changed, e.g. from `diffObjects(before, after)`. Stored as given; it is never computed for you. */
  diff?: Record<string, { before: unknown; after: unknown }>;
  /**
   * Also write an entry when the call is refused with a `PermissionDeniedError` (outcome
   * `'denied'`), then rethrow it unchanged. Off by default: a refused actor who keeps retrying
   * writes an entry each time, so rate-limit anything that exposes this. Other errors are never
   * recorded.
   */
  recordDenials?: boolean;
}

export class AdminService {
  constructor(
    private readonly audit: AuditRepository,
    private readonly options: AdminServiceOptions = {},
  ) {}

  /**
   * The audit entries for one target, as the repository returns them. With enforcement
   * (`actor` required) this needs `admin.viewAuditLog` (admins of an organization, never
   * delegable), and only entries of the admin's own organization come back, with "no organization"
   * matching only "no organization". A target that belongs to another organization, or does not
   * exist, gives an empty list, so it does not say which.
   */
  async history(targetId: string, actor?: ActorContext): Promise<AuditEntry[]> {
    const enforcement = this.options.enforcement;
    if (!enforcement) return this.audit.listForTarget(targetId);

    const auth = await authorizeWithinOwnOrg(enforcement.policy, enforcement.repos, 'admin.viewAuditLog', actor);
    const orgId = auth.ctx.actor.orgId;
    const entries = await this.audit.listForTarget(targetId);
    return entries.filter((e) => e.targetId === targetId && sameOrg(e.orgId, orgId));
  }

  /**
   * Runs `fn` and records it, like `withAudit`, but as the actor's stored account: with enforcement
   * `actorId` and `orgId` come from the repository (an actor who does not exist is refused, and
   * `fn` is not run), never from what the caller says. It needs no particular role: it records what
   * the host's own, already authorized, call just did. Only successes are recorded, plus refusals if
   * `recordDenials` is set. If the entry cannot be written it throws `AuditWriteFailedError`.
   */
  async audited<T>(
    action: string,
    targetId: string,
    actor: ActorContext,
    fn: () => Promise<T>,
    options: AuditedOptions = {},
  ): Promise<T> {
    if (!actor) throw new ActorRequiredError('admin.audited');
    let orgId: string | undefined;
    const enforcement = this.options.enforcement;
    if (enforcement) {
      const user = await enforcement.repos.users.findById(actor.actorId);
      if (!user) throw new PermissionDeniedError('admin.audited');
      orgId = user.orgId;
    }
    const entry = (extra: Partial<Omit<AuditEntry, 'id'>>): Omit<AuditEntry, 'id'> => ({
      actorId: actor.actorId,
      ...(orgId !== undefined ? { orgId } : {}),
      action,
      targetId,
      timestamp: new Date(),
      ...extra,
    });

    let result: T;
    try {
      result = await fn();
    } catch (error) {
      if (options.recordDenials && error instanceof PermissionDeniedError) {
        try {
          await this.audit.append(entry({ outcome: 'denied' }));
        } catch (cause) {
          throw new AuditWriteFailedError(cause, false, undefined, error);
        }
      }
      throw error;
    }
    try {
      await this.audit.append(entry(options.diff !== undefined ? { diff: options.diff } : {}));
    } catch (cause) {
      throw new AuditWriteFailedError(cause, true, result);
    }
    return result;
  }
}

/**
 * What changed between two objects: only the keys whose value is different, each with its old and
 * new value (a key on one side only has `undefined` on the other). Values are compared by content,
 * so equal nested objects, arrays and dates are not reported. Pass the result as `audited`'s `diff`.
 */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!sameValue(before[key], after[key])) diff[key] = { before: before[key], after: after[key] };
  }
  return diff;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
