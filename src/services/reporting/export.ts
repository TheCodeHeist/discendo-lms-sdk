/**
 * CSV export and the built-in exporters. All pure: rows in, rows or text out.
 */
import type { Enrollment, Id } from "../../core/types.js";
import type { AttendanceRecord, AttendanceStatus } from "./service.js";

/** A cell: text and numbers as they are, a date as its ISO time (UTC), a boolean as true/false, nothing as empty. */
export type ExportValue = string | number | boolean | Date | null | undefined;

/** Anything exportable as flat rows can reuse this — gradebook, roster, attendance, etc. */
export interface Exportable {
  toRows(): Record<string, ExportValue>[];
}

export interface CsvOptions {
  /**
   * Text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return can be run as a
   * formula when the file is opened in a spreadsheet. By default they are neutralized with a
   * leading `'`. Set this to `false` only for data you wrote yourself. Numbers are never touched.
   */
  sanitizeFormulas?: boolean;
  /** `'\n'` (default) or `'\r\n'`, which RFC 4180 and some spreadsheet imports expect. */
  lineEnding?: "\n" | "\r\n";
  /** Start with a UTF-8 byte order mark, so Excel reads accented names correctly. Default false. */
  bom?: boolean;
}

/**
 * Turns rows into CSV text. The columns are the keys of the first row, in its order: a key only a
 * later row has is left out, and a row missing a column leaves it empty.
 */
export function toCsv(exportable: Exportable, options: CsvOptions = {}): string {
  const rows = exportable.toRows();
  if (rows.length === 0) return "";
  const sanitize = options.sanitizeFormulas !== false;
  const cell = (value: ExportValue): string => {
    const text = formatValue(value);
    return escapeCsvCell(typeof value === "string" && sanitize ? neutralizeFormula(text) : text);
  };
  const headers = Object.keys(rows[0]!);
  const lines = [headers.map((h) => cell(h)).join(",")];
  for (const row of rows) lines.push(headers.map((h) => cell(row[h])).join(","));
  return (options.bom ? "\uFEFF" : "") + lines.join(options.lineEnding ?? "\n");
}

function formatValue(value: ExportValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return String(value);
}

function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Wraps ready-made rows as an `Exportable`. */
export function exportable(rows: Record<string, ExportValue>[]): Exportable {
  return { toRows: () => rows };
}

/**
 * The mark that counts for each person and session: the latest one (by `recordedAt`; for the same
 * instant, the one recorded last). Oldest first. A second mark for the same session is a
 * correction, not a second attendance.
 */
export function effectiveMarks(marks: AttendanceRecord[]): AttendanceRecord[] {
  const latest = new Map<string, AttendanceRecord>();
  for (const m of marks) {
    const key = `${m.userId}\u0000${m.sessionId}`;
    const current = latest.get(key);
    if (!current || m.recordedAt.getTime() >= current.recordedAt.getTime()) latest.set(key, m);
  }
  return [...latest.values()].sort(
    (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.sessionId.localeCompare(b.sessionId),
  );
}

/** Roster rows: `userId`, `externalRef` (when known), `role`, `status`, `enrolledAt`, `droppedAt`. */
export function rosterRows(enrollments: Enrollment[], externalRefs: Map<Id, string> = new Map()): Exportable {
  return exportable(
    enrollments.map((e) => ({
      userId: e.userId,
      externalRef: externalRefs.get(e.userId),
      role: e.role,
      status: e.status,
      enrolledAt: e.enrolledAt,
      droppedAt: e.droppedAt,
    })),
  );
}

/**
 * An attendance sheet: a row per student (in the order given), a column per session (in the order
 * given) holding the mark that counts there, then a total per status. Marks of people not in
 * `studentIds` or sessions not in `sessionIds` are ignored.
 */
export function attendanceSheet(sessionIds: Id[], studentIds: Id[], marks: AttendanceRecord[]): Exportable {
  const byKey = new Map(effectiveMarks(marks).map((m) => [`${m.userId}\u0000${m.sessionId}`, m.status]));
  const statuses: AttendanceStatus[] = ["present", "late", "excused", "absent"];
  return exportable(
    studentIds.map((userId) => {
      const row: Record<string, ExportValue> = { userId };
      const totals: Record<AttendanceStatus, number> = { present: 0, late: 0, excused: 0, absent: 0 };
      for (const sessionId of sessionIds) {
        const status = byKey.get(`${userId}\u0000${sessionId}`);
        row[sessionId] = status ?? "";
        if (status) totals[status]++;
      }
      for (const s of statuses) row[s] = totals[s];
      return row;
    }),
  );
}
