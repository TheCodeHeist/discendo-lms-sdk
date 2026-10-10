import type { Id } from "../../core/types.js";
import type { EventBus } from "../../core/events.js";
import type { ActorContext, PermissionPolicy } from "../../core/permissions.js";
import {
  PermissionDeniedError,
  activeSectionRole,
} from "../../core/permissions.js";
import { authorizeInSection, isStaff } from "../../core/authorization.js";
import type { AuthorizationRepos } from "../../core/authorization.js";

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
}

/** One student's attendance in a section: the marks, oldest first, and a count per status. */
export interface StudentAttendanceReport {
  records: AttendanceRecord[];
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

/** Anything exportable as flat rows can reuse this — gradebook, roster, attendance, etc. */
export interface Exportable {
  toRows(): Record<string, string | number>[];
}

export interface CsvOptions {
  /**
   * Text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return can be run as a
   * formula when the file is opened in a spreadsheet. By default they are neutralized with a
   * leading `'`. Set this to `false` only for data you wrote yourself. Numbers are never touched.
   */
  sanitizeFormulas?: boolean;
}

export function toCsv(
  exportable: Exportable,
  options: CsvOptions = {},
): string {
  const rows = exportable.toRows();
  if (rows.length === 0) return "";
  const sanitize = options.sanitizeFormulas !== false;
  const cell = (value: string | number | undefined): string =>
    escapeCsvCell(
      typeof value === "string" && sanitize
        ? neutralizeFormula(value)
        : String(value ?? ""),
    );
  const headers = Object.keys(rows[0]!);
  const lines = [headers.map((h) => cell(h)).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => cell(row[h])).join(","));
  }
  return lines.join("\n");
}

function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export class ReportingService {
  private readonly events?: EventBus | undefined;

  constructor(
    private readonly attendance: AttendanceRepository,
    private readonly options: ReportingServiceOptions = {},
    events?: EventBus,
  ) {
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

    const records: AttendanceRecord[] = [];
    for (const sessionId of await sessions.sessionsInSection(sectionId)) {
      for (const r of await this.attendance.listForSession(sessionId)) {
        if (r.userId === userId) records.push(r);
      }
    }
    records.sort(
      (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.sessionId.localeCompare(b.sessionId),
    );
    const summary = { present: 0, absent: 0, excused: 0, late: 0, total: records.length };
    for (const r of records) if (STATUSES.includes(r.status)) summary[r.status]++;
    return { records, summary };
  }

  computeCompletionPercent(totalItems: number, completedItems: number): number {
    if (!Number.isFinite(totalItems) || !Number.isFinite(completedItems) || totalItems <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((completedItems / totalItems) * 100)));
  }
}
