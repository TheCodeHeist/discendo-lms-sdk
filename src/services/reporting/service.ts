import type { Id } from "../../core/types.js";
import type { ActorContext, PermissionPolicy } from "../../core/permissions.js";
import { PermissionDeniedError, activeSectionRole } from "../../core/permissions.js";
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
}

/** One student's attendance in a section: the marks, oldest first, and a count per status. */
export interface StudentAttendanceReport {
  records: AttendanceRecord[];
  summary: { present: number; absent: number; excused: number; late: number; total: number };
}

const STATUSES: readonly AttendanceStatus[] = ["present", "absent", "excused", "late"];

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

export function toCsv(exportable: Exportable, options: CsvOptions = {}): string {
  const rows = exportable.toRows();
  if (rows.length === 0) return "";
  const sanitize = options.sanitizeFormulas !== false;
  const cell = (value: string | number | undefined): string =>
    escapeCsvCell(typeof value === "string" && sanitize ? neutralizeFormula(value) : String(value ?? ""));
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
  constructor(
    private readonly attendance: AttendanceRepository,
    private readonly options: ReportingServiceOptions = {},
  ) {
    if (options.enforcement && !options.sessions) {
      throw new Error("ReportingService enforcement needs a SessionLocator (options.sessions)");
    }
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
  async recordAttendance(record: AttendanceRecord, actor?: ActorContext): Promise<void> {
    const enforcement = this.options.enforcement;
    if (!enforcement) return this.attendance.record(record);

    const sectionId = actor ? await this.options.sessions!.sectionOf(record.sessionId) : null;
    await authorizeInSection(enforcement.policy, enforcement.repos, "reporting.recordAttendance", actor, {
      sectionId: sectionId ?? undefined,
    });
    const membership = await enforcement.repos.enrollments.findByUserAndSection(record.userId, sectionId!);
    if (activeSectionRole(membership) !== "student") throw new PermissionDeniedError("reporting.recordAttendance");
    if (!STATUSES.includes(record.status)) throw new Error(`Unknown attendance status: ${String(record.status)}`);

    return this.attendance.record({
      sessionId: record.sessionId,
      userId: record.userId,
      status: record.status,
      recordedAt: new Date(),
      recordedBy: actor!.actorId,
    });
  }

  /**
   * Every mark of one session. **Staff only** with enforcement (`reporting.view` in the session's
   * section, and the actor must be staff there even if a custom policy says otherwise): a student
   * or guardian reads a student's own marks with `attendanceForStudent` instead. Without enforcement
   * it returns what the repository has.
   */
  async listAttendanceForSession(sessionId: Id, actor?: ActorContext): Promise<AttendanceRecord[]> {
    const enforcement = this.options.enforcement;
    if (enforcement) {
      const sectionId = actor ? await this.options.sessions!.sectionOf(sessionId) : null;
      const auth = await authorizeInSection(enforcement.policy, enforcement.repos, "reporting.view", actor, {
        sectionId: sectionId ?? undefined,
      });
      if (!isStaff(auth.ctx)) throw new PermissionDeniedError("reporting.view");
    }
    return this.attendance.listForSession(sessionId);
  }

  /**
   * One student's attendance across a section's sessions, oldest first, with a count per status.
   * With enforcement (`actor` required) the owner is the student named: they may read their own,
   * staff of the section may read anyone's, and a guardian whose verified link has the `attendance`
   * scope may read their ward's, while the ward is an **active student** there. Dropped, waitlisted
   * and completed students are refused (completed access covers grades and content only). It asks
   * the repository for one session at a time, once each, so a section with many sessions costs that
   * many calls. Needs `options.sessions`.
   */
  async attendanceForStudent(sectionId: Id, userId: Id, actor?: ActorContext): Promise<StudentAttendanceReport> {
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

  /**
   * Progress is derived from content completion events, not stored as mutable state. The result is
   * a whole percent from 0 to 100: more completed than total (or a negative count) cannot push it
   * outside that, and anything that is not a finite number, or a total of zero or less, gives 0.
   */
  computeCompletionPercent(totalItems: number, completedItems: number): number {
    if (!Number.isFinite(totalItems) || !Number.isFinite(completedItems) || totalItems <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((completedItems / totalItems) * 100)));
  }
}
