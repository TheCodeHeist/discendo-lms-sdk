/**
 * Pure conflict detection over already-materialized occurrences. No solver,
 * no recurrence math — just interval overlap on a given date. This is
 * deliberately usable standalone: a host app doing manual scheduling gets
 * conflict checking without ever touching the auto-generation solver.
 */
import type { ClassOccurrence } from '../types.js';

export interface ResourceConflict {
  resourceType: 'teacher' | 'room' | 'group';
  resourceId: string;
  occurrenceA: ClassOccurrence;
  occurrenceB: ClassOccurrence;
}

/** Effective start/end for an occurrence, honoring per-instance overrides. */
function effectiveWindow(
  occ: ClassOccurrence,
  templateStart: string,
  templateEnd: string,
): { start: string; end: string } {
  return {
    start: occ.startTime ?? templateStart,
    end: occ.endTime ?? templateEnd,
  };
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function sameDate(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * Checks whether `candidate` conflicts with any of `existing` for a single
 * resource. Cancelled occurrences never conflict — a cancelled slot frees
 * the resource. Pass template time windows for occurrences that don't carry
 * their own override (the common case).
 */
export function findConflictsForResource(
  resourceType: 'teacher' | 'room' | 'group',
  resourceId: string,
  candidate: ClassOccurrence,
  candidateWindow: { start: string; end: string },
  existing: ClassOccurrence[],
  existingWindows: Map<string, { start: string; end: string }>,
): ResourceConflict[] {
  const conflicts: ResourceConflict[] = [];
  for (const other of existing) {
    if (other.id === candidate.id) continue;
    if (other.status === 'cancelled' || candidate.status === 'cancelled') continue;
    if (!sameDate(other.date, candidate.date)) continue;

    const otherWindow = existingWindows.get(other.id);
    if (!otherWindow) continue;

    if (timesOverlap(candidateWindow.start, candidateWindow.end, otherWindow.start, otherWindow.end)) {
      conflicts.push({
        resourceType,
        resourceId,
        occurrenceA: candidate,
        occurrenceB: other,
      });
    }
  }
  return conflicts;
}

export { effectiveWindow };
