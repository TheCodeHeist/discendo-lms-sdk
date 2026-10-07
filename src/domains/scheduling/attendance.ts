/**
 * Bridges scheduling's ClassOccurrence with attendance recording, without
 * creating a hard dependency between the `scheduling` and `reporting`
 * modules in either direction — each stays independently adoptable (see
 * the repository-interface pattern used throughout this SDK).
 *
 * This module defines its own minimal, structural versions of the
 * attendance shapes rather than importing them from `reporting`.
 * `reporting.AttendanceRecord`/`AttendanceStatus` are structurally
 * identical to `AttendanceEntry`/`AttendanceMark` below, so a host app
 * using both modules can pass its single `AttendanceRepository`
 * implementation to both `ReportingService` and the methods here — nothing
 * needs to be adapted or converted at the boundary.
 */
import type { Id } from "../../core/types.js";
import type { ClassOccurrence } from "./types.js";

export type AttendanceMark = "present" | "absent" | "excused" | "late";

export interface AttendanceEntry {
  sessionId: Id;
  userId: Id;
  status: AttendanceMark;
  recordedAt: Date;
  /** Who recorded it. Set when scheduling enforces permissions; absent otherwise. */
  recordedBy?: Id;
}

/** Structural subset of reporting.AttendanceRepository — only what's needed here. */
export interface AttendanceRecorder {
  record(entry: AttendanceEntry): Promise<void>;
  listForSession(sessionId: Id): Promise<AttendanceEntry[]>;
}

export interface AttendanceValidationError {
  reason: "occurrence-not-found" | "occurrence-cancelled";
  message: string;
}

/**
 * Checks whether attendance can be recorded for this occurrence at all.
 * Pure — takes the occurrence directly rather than fetching it, so it's
 * usable standalone or from a service method that already has one loaded.
 *
 * Recording attendance for a cancelled class is refused: a cancelled
 * occurrence never happened, so marking students present/absent/late for
 * it would corrupt reporting (e.g. inflating "classes held" counts). A
 * host app that genuinely needs to record something for a cancelled class
 * (e.g. a mandatory makeup note) should model that separately rather than
 * through normal attendance marking.
 */
export function validateAttendanceTarget(
  occurrence: ClassOccurrence | null,
): AttendanceValidationError | undefined {
  if (!occurrence) {
    return {
      reason: "occurrence-not-found",
      message: "No occurrence exists with that ID.",
    };
  }
  if (occurrence.status === "cancelled") {
    return {
      reason: "occurrence-cancelled",
      message:
        "This occurrence was cancelled — attendance cannot be recorded for it.",
    };
  }
  return undefined;
}
