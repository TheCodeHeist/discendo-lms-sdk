/** In-memory attendance storage, kept in this process only. */
import type { Id } from '../../../core/types.js';
import type { AttendanceRecord, AttendanceRepository, SessionLocator } from '../service.js';

/**
 * Every mark is kept, in the order recorded: a repeat mark for the same person and session is a
 * second record, as the SDK documents. This also satisfies scheduling's `AttendanceRecorder`, so one
 * instance can back both `ReportingService` and `SchedulingService`.
 */
export class InMemoryAttendanceRepository implements AttendanceRepository {
  private readonly records: AttendanceRecord[] = [];

  async record(entry: AttendanceRecord): Promise<void> {
    this.records.push(structuredClone(entry));
  }

  async listForSession(sessionId: Id): Promise<AttendanceRecord[]> {
    return structuredClone(this.records.filter((r) => r.sessionId === sessionId));
  }
}

/** A `SessionLocator` over a fixed map of session to section, filled with `place()`. */
export class InMemorySessionLocator implements SessionLocator {
  private readonly sections = new Map<Id, Id>();

  place(sessionId: Id, sectionId: Id): this {
    this.sections.set(sessionId, sectionId);
    return this;
  }

  async sectionOf(sessionId: Id): Promise<Id | null> {
    return this.sections.get(sessionId) ?? null;
  }

  async sessionsInSection(sectionId: Id): Promise<Id[]> {
    return [...this.sections].filter(([, s]) => s === sectionId).map(([session]) => session);
  }
}
