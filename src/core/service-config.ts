/**
 * The one shape every service is built with:
 *
 * ```ts
 * new GradingService({ repos: { grades, users, courses, enrollments }, policy, events, submissions });
 * ```
 *
 * - `repos`: the repositories the service reads and writes, by name. With a `policy`, it also holds
 *   the ones permission checks need (`users`, `courses`, `enrollments`, and `guardianLinks` /
 *   `delegations` if you use guardians or delegation).
 * - `policy`: turns permission enforcement on. Without it the service checks nothing, as before.
 *   (A few services always enforce; for them it is required.)
 * - `events`: the `EventBus` the service emits to.
 * - anything else is that service's own setting, named as before.
 *
 * The positional constructors of earlier versions still work and are marked deprecated; see
 * `docs/MIGRATION.md`.
 */
import type { EventBus } from './events.js';
import type { PermissionPolicy } from './permissions.js';

export interface ServiceConfig<Repos> {
  repos: Repos;
  policy?: PermissionPolicy;
  events?: EventBus;
}

/**
 * Whether a constructor was called the new way: a single object with `repos`. No deprecated
 * constructor takes an object with a `repos` key as its only argument, so the two cannot be
 * confused.
 */
export function isServiceConfig(args: readonly unknown[]): boolean {
  if (args.length !== 1) return false;
  const only = args[0];
  if (typeof only !== 'object' || only === null || !('repos' in only)) return false;
  const repos = (only as { repos: unknown }).repos;
  return typeof repos === 'object' && repos !== null;
}

/** A service was configured with something missing: a repository enforcement needs, say. */
export class ServiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceConfigError';
  }
}

/**
 * Throws `ServiceConfigError` naming every repository in `keys` that `repos` lacks. Services call it
 * when a `policy` is given, so a missing `users` repository is a clear error when the service is
 * built rather than a refusal on the first call.
 */
export function requireRepos(service: string, repos: object, keys: readonly string[], why = 'to enforce permissions'): void {
  const missing = keys.filter((k) => (repos as Record<string, unknown>)[k] === undefined);
  if (missing.length > 0) {
    throw new ServiceConfigError(`${service} needs ${missing.map((k) => `repos.${k}`).join(', ')} ${why}`);
  }
}

/** The repositories every permission check reads. */
export const AUTHORIZATION_REPOS = ['users', 'courses', 'enrollments'] as const;
