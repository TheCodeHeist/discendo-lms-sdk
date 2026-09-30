import type { Id } from "../../core/types.js";

export type AttendanceStatus = "present" | "absent" | "excused" | "late";

export interface AttendanceRecord {
  sessionId: Id;
  userId: Id;
  status: AttendanceStatus;
  recordedAt: Date;
}

export interface AttendanceRepository {
  record(entry: AttendanceRecord): Promise<void>;
  listForSession(sessionId: Id): Promise<AttendanceRecord[]>;
}

/** Anything exportable as flat rows can reuse this — gradebook, roster, attendance, etc. */
export interface Exportable {
  toRows(): Record<string, string | number>[];
}

export function toCsv(exportable: Exportable): string {
  const rows = exportable.toRows();
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers.map((h) => escapeCsvCell(String(row[h] ?? ""))).join(","),
    );
  }
  return lines.join("\n");
}

function escapeCsvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export class ReportingService {
  constructor(private readonly attendance: AttendanceRepository) {}

  async recordAttendance(record: AttendanceRecord): Promise<void> {
    return this.attendance.record(record);
  }

  /** Progress is derived from content completion events, not stored as mutable state. */
  computeCompletionPercent(totalItems: number, completedItems: number): number {
    if (totalItems === 0) return 0;
    return Math.round((completedItems / totalItems) * 100);
  }
}
