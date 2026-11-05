import type { Id } from "../../core/types.js";
import type { EventBus } from "../../core/events.js";
import type { ActorContext, PermissionPolicy } from "../../core/permissions.js";
import {
  PermissionDeniedError,
  activeSectionRole,
} from "../../core/permissions.js";
import { authorizeInSection, isStaff } from "../../core/authorization.js";
import type { AuthorizationRepos } from "../../core/authorization.js";
import { AUTHORIZATION_REPOS, isServiceConfig, requireRepos, ServiceConfigError } from "../../core/service-config.js";
import type { ServiceConfig } from "../../core/service-config.js";
import type { EnrollmentRepository, UserRepository } from "../../core/repositories.js";
import type { Enrollment } from "../../core/types.js";
import { attendanceSheet, effectiveMarks, rosterRows, type Exportable } from "./export.js";

export type AttendanceStatus = "present" | "absent" | "excused" | "late";

export interface AttendanceRecord {
  sessionId: Id;
  userId: Id;
  status: AttendanceStatus;
  recordedAt: Date;
  /** Who recorded it. Set by `recordAttendance` when permissions are enforced; absent otherwise. */
  recordedBy?: Id;
}

export interface AttendanceRepository {
  record(entry: AttendanceRecord): Promise<void>;
  listForSession(sessionId: Id): Promise<AttendanceRecord[]>;
  /**
   * OPTIONAL, and recommended: the marks of several sessions in one query (`WHERE session_id IN
   * (...)`), only `userId`'s when it is given. Without it `attendanceForStudent` and the attendance
   * export ask `listForSession` once per session.
   */
  listForSessions?(sessionIds: Id[], userId?: Id): Promise<AttendanceRecord[]>;
}

/**
 * How reporting finds out which section a class session belongs to, and which sessions a section
 * has. Reporting cannot ask the scheduling module (modules stay independent), so the host answers:
 * typically from its class occurrences. A session with no section is `null`.
 */
export interface SessionLocator {
  sectionOf(sessionId: Id): Promise<Id | null>;
  sessionsInSection(sectionId: Id): Promise<Id[]>;
}

export interface ReportingServiceOptions {
  /**
   * Needed by `attendanceForStudent` (to find the section's sessions) and, with enforcement, by
   * `recordAttendance` and `listAttendanceForSession` (to find a session's section).
   */
  sessions?: SessionLocator;
  /**
   * Turns on permission enforcement, which requires `sessions`. Once set, every attendance method
   * requires an `{ actorId }` argument and refuses to run without one. Leave it unset and the
   * service behaves as it always has: no actor, no permission checks.
   */
  enforcement?: { policy: PermissionPolicy; repos: AuthorizationRepos };
  /** Optional EventBus to emit reporting events to. */
  events?: EventBus | undefined;
  /**
   * Where the roster comes from, for `exportRoster` and `exportAttendance`. Defaults to the
   * enforcement repos when enforcement is on. `users` adds each person's `externalRef` to the
   * roster.
   */
  roster?: { enrollments: Pick<EnrollmentRepository, "listBySection">; users?: Pick<UserRepository, "findById"> };
}

/**
 * `new ReportingService({ repos: { attendance, ... }, sessions?, policy?, events? })`. With a `policy`,
 * `repos` must also hold `users`, `courses` and `enrollments`, and `sessions` is required. The exports
 * read the roster from `repos.enrollments` (and `repos.users` for external references).
 */
export interface ReportingServiceConfig extends ServiceConfig<{ attendance: AttendanceRepository } & Partial<AuthorizationRepos>> {
  sessions?: SessionLocator;
}

/**
 * One student's attendance in a section. `records` holds the mark that counts for each session,
 * oldest first: when a session was marked more than once (a correction), the latest mark wins.
 * `history` holds every mark, corrections included. `summary` counts `records`.
 */
export interface StudentAttendanceReport {
  records: AttendanceRecord[];
  history: AttendanceRecord[];
  summary: {
    present: number;
    absent: number;
    excused: number;
    late: number;
    total: number;
  };
}

const STATUSES: readonly AttendanceStatus[] = [
  "present",
  "absent",
  "excused",
  "late",
];

export class ReportingService {
  private readonly events?: EventBus | undefined;

  private readonly attendance: AttendanceRepository;
  private readonly options: ReportingServiceOptions;

  constructor(config: ReportingServiceConfig);
  /** @deprecated Pass one config object: `new ReportingService({ repos: { attendance, ... }, sessions, policy, events })`. See docs/MIGRATION.md. */
  constructor(attendance: AttendanceRepository, options?: ReportingServiceOptions, events?: EventBus);
  constructor(...args: unknown[]) {
    let options: ReportingServiceOptions;
    let events: EventBus | undefined;
    if (isServiceConfig(args)) {
      const c = args[0] as ReportingServiceConfig;
      if (c.policy) requireRepos("ReportingService", c.repos, AUTHORIZATION_REPOS);
      this.attendance = c.repos.attendance;
      events = c.events;
      options = {
        ...(c.sessions ? { sessions: c.sessions } : {}),
        ...(c.policy ? { enforcement: { policy: c.policy, repos: c.repos as AuthorizationRepos } } : {}),
        // The exports read the roster from the same repos.
        ...(c.repos.enrollments ? { roster: { enrollments: c.repos.enrollments, ...(c.repos.users ? { users: c.repos.users } : {}) } } : {}),
      };
    } else {
      const [attendance, legacyOptions, legacyEvents] = args as [AttendanceRepository, ReportingServiceOptions | undefined, EventBus | undefined];
      this.attendance = attendance;
      options = legacyOptions ?? {};
      events = legacyEvents;
    }
    this.options = options;
    if (options.enforcement && !options.sessions) {
      throw new Error(
        "ReportingService enforcement needs a SessionLocator (options.sessions)",
      );
    }
    this.events = events ?? options.events;
  }


  /**
   * Records an attendance mark. **Without enforcement** it is a pass-through: it hands the record to
   * the repository exactly as given. **With enforcement** (`actor` required) the actor needs
   * `reporting.recordAttendance` in the session's section (taken from the locator: an unknown
   * session is refused like a forbidden one), the person must be an **active student** of that
   * section, and the status must be one of the four. The stored record is rebuilt from the four
   * known fields: the time is the service's clock (nobody can backdate a mark), `recordedBy` is the
   * actor, and anything else the caller passed is dropped.
   */
  async recordAttendance(
    record: AttendanceRecord,
    actor?: ActorContext,
  ): Promise<void> {
    const enforcement = this.options.enforcement;
    if (!enforcement) {
      await this.attendance.record(record);
      void this.events?.emit({
        type: "reporting.attendanceRecorded",
        sessionId: record.sessionId,
        userId: record.userId,
        status: record.status,
        recordedAt: record.recordedAt,
        ...(record.recordedBy !== undefined
          ? { recordedBy: record.recordedBy }
          : {}),
      });
      return;
    }

    const sectionId = actor
      ? await this.options.sessions!.sectionOf(record.sessionId)
      : null;
    const auth = await authorizeInSection(
      enforcement.policy,
      enforcement.repos,
      "reporting.recordAttendance",
      actor,
      {
        sectionId: sectionId ?? undefined,
      },
    );
    const membership = await enforcement.repos.enrollments.findByUserAndSection(
      record.userId,
      sectionId!,
    );
    if (activeSectionRole(membership) !== "student")
      throw new PermissionDeniedError("reporting.recordAttendance");
    if (!STATUSES.includes(record.status))
      throw new Error(`Unknown attendance status: ${String(record.status)}`);

    const stored: AttendanceRecord = {
      sessionId: record.sessionId,
      userId: record.userId,
      status: record.status,
      recordedAt: new Date(),
      recordedBy: actor!.actorId,
    };
    await this.attendance.record(stored);

    const orgId = auth.ctx.resourceOrgId ?? auth.ctx.actor.orgId;
    void this.events?.emit({
      type: "reporting.attendanceRecorded",
      sessionId: stored.sessionId,
      userId: stored.userId,
      status: stored.status,
      recordedAt: stored.recordedAt,
      ...(stored.recordedBy !== undefined ? { recordedBy: stored.recordedBy } : {}),
      sectionId: sectionId!,
      ...(orgId !== undefined ? { orgId } : {}),
    });
  }

  /**
   * Every mark of one session. **Staff only** with enforcement (`reporting.view` in the session's
   * section, and the actor must be staff there even if a custom policy says otherwise): a student
   * or guardian reads a student's own marks with `attendanceForStudent` instead. Without enforcement
   * it returns what the repository has.
   */
  async listAttendanceForSession(
    sessionId: Id,
    actor?: ActorContext,
  ): Promise<AttendanceRecord[]> {
    const enforcement = this.options.enforcement;
    if (enforcement) {
      const sectionId = actor
        ? await this.options.sessions!.sectionOf(sessionId)
        : null;
      const auth = await authorizeInSection(
        enforcement.policy,
        enforcement.repos,
        "reporting.view",
        actor,
        {
          sectionId: sectionId ?? undefined,
        },
      );
      if (!isStaff(auth.ctx)) throw new PermissionDeniedError("reporting.view");
    }
    return this.attendance.listForSession(sessionId);
  }

  /**
   * One student's marks in a section: ordered oldest first, with a summary count per status. Needs
   * `reporting.view` in that section:
   *  - the student themselves, or staff (instructors, TAs, admins);
   *  - a guardian whose verified link includes the `attendance` scope, while the student is an
   *    active student of that section.
   * A completed student keeps access to their own attendance (and guardians with the scope theirs).
   * Refuses a student who was never enrolled, or whose enrollment was dropped or waitlisted, with
   * `PermissionDeniedError` (same as a forbidden section: no probing).
   *
   * Without enforcement it returns the records for every session of the section without checking
   * who calls or whether the student belongs to the section. Needs `options.sessions`.
   */
  async attendanceForStudent(
    sectionId: Id,
    userId: Id,
    actor?: ActorContext,
  ): Promise<StudentAttendanceReport> {
    const enforcement = this.options.enforcement;
    if (enforcement) {
      await authorizeInSection(enforcement.policy, enforcement.repos, "reporting.view", actor, {
        sectionId,
        ownerId: userId,
      });
    }
    const sessions = this.options.sessions;
    if (!sessions) throw new Error("attendanceForStudent needs a SessionLocator (options.sessions)");

    const history = await this.marksOf(await sessions.sessionsInSection(sectionId), userId);
    const records = effectiveMarks(history);
    const summary = { present: 0, absent: 0, excused: 0, late: 0, total: records.length };
    for (const r of records) if (STATUSES.includes(r.status)) summary[r.status]++;
    return { records, history, summary };
  }

  /**
   * The section's roster as rows for `toCsv`: one per enrollment (`userId`, `externalRef` when a
   * user repository is given, `role`, `status`, `enrolledAt`, `droppedAt`), all statuses unless you
   * pass `status`. With enforcement on, staff of the section only (`reporting.view`).
   */
  async exportRoster(sectionId: Id, actor?: ActorContext, options: { status?: Enrollment["status"] } = {}): Promise<Exportable> {
    await this.authorizeStaffView(sectionId, actor);
    const roster = this.roster();
    const enrollments = await roster.enrollments.listBySection(sectionId, options.status);
    const refs = new Map<string, string>();
    if (roster.users) {
      for (const e of enrollments) {
        const ref = (await roster.users.findById(e.userId))?.externalRef;
        if (ref !== undefined) refs.set(e.userId, ref);
      }
    }
    return rosterRows(enrollments, refs);
  }

  /**
   * The section's attendance as a sheet for `toCsv`: one row per active student, one column per
   * session (in the locator's order) holding the mark that counts, and a total per status. With
   * enforcement on, staff of the section only (`reporting.view`). Needs `options.sessions`.
   */
  async exportAttendance(sectionId: Id, actor?: ActorContext): Promise<Exportable> {
    await this.authorizeStaffView(sectionId, actor);
    const sessions = this.options.sessions;
    if (!sessions) throw new Error("exportAttendance needs a SessionLocator (options.sessions)");
    const sessionIds = await sessions.sessionsInSection(sectionId);
    const students = (await this.roster().enrollments.listBySection(sectionId, "active"))
      .filter((e) => e.role === "student")
      .map((e) => e.userId);
    return attendanceSheet(sessionIds, students, await this.marksOf(sessionIds));
  }

  /** Every mark of these sessions (only `userId`'s when given), in one query when the repository can. */
  private async marksOf(sessionIds: Id[], userId?: Id): Promise<AttendanceRecord[]> {
    if (sessionIds.length === 0) return [];
    if (this.attendance.listForSessions) {
      const all = await this.attendance.listForSessions(sessionIds, userId);
      // Re-filter: the repository's answer is trusted for speed, not for scope.
      const wanted = new Set(sessionIds);
      return all.filter((r) => wanted.has(r.sessionId) && (userId === undefined || r.userId === userId));
    }
    const out: AttendanceRecord[] = [];
    for (const sessionId of sessionIds) {
      for (const r of await this.attendance.listForSession(sessionId)) {
        if (userId === undefined || r.userId === userId) out.push(r);
      }
    }
    return out;
  }

  private roster(): NonNullable<ReportingServiceOptions["roster"]> {
    const roster = this.options.roster ?? (this.options.enforcement ? { enrollments: this.options.enforcement.repos.enrollments, users: this.options.enforcement.repos.users } : undefined);
    if (!roster) throw new Error("Exports need a roster (options.roster) or enforcement");
    return roster;
  }

  /** With enforcement: `reporting.view` in the section, and the actor must be staff there. */
  private async authorizeStaffView(sectionId: Id, actor: ActorContext | undefined): Promise<void> {
    const e = this.options.enforcement;
    if (!e) return;
    const auth = await authorizeInSection(e.policy, e.repos, "reporting.view", actor, { sectionId });
    if (!isStaff(auth.ctx)) throw new PermissionDeniedError("reporting.view");
  }

  computeCompletionPercent(totalItems: number, completedItems: number): number {
    if (!Number.isFinite(totalItems) || !Number.isFinite(completedItems) || totalItems <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((completedItems / totalItems) * 100)));
  }
}
