/**
 * Class-routine / timetable scheduling.
 *
 * Layered on purpose — see the four concepts below. Conflating them (e.g.
 * storing "Tuesdays at 3pm" directly on a Course) is the mistake that makes
 * routine management unmanageable once real-world exceptions show up.
 *
 *   1. RecurrenceRule   — an abstract, timeless repeating pattern (RFC 5545 subset)
 *   2. ClassSessionTemplate — "this course section meets per this rule, this
 *      duration, taught by these teachers" — still abstract, no calendar dates
 *   3. ClassOccurrence  — one concrete meeting on one real date, materialized
 *      from a template. Cancel/move/substitute a single class by editing its
 *      occurrence, never the template.
 *   4. Availability     — separate recurring rules for *when a resource can be
 *      used at all* (teacher work hours, room open hours). Independent from
 *      what's actually booked.
 *
 * All timestamps are UTC, same convention as calendar/service.ts — do local
 * timezone conversion at the host app's edge, never inside this module.
 */
import type { Id, Timestamp } from '../core/types.js';

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/**
 * Deliberately a *subset* of RFC 5545 RRULE — just what timetabling needs.
 * Don't extend this ad hoc; if you need more of the spec, bring in a real
 * RRULE library (e.g. rrule.js) and store its string form in `raw` instead.
 */
export interface RecurrenceRule {
  freq: 'WEEKLY';
  /** Repeat every N weeks. 1 = every week, 2 = fortnightly, etc. */
  interval: number;
  /** Days this pattern fires on. */
  byDay: Weekday[];
  /** Optional escape hatch: a raw RRULE string, if the host app supplies one. */
  raw?: string;
}

/** A recurring window during which a resource (teacher/room/group) is usable at all. */
export interface AvailabilityRule {
  id: Id;
  /** The resource this availability applies to. */
  resourceId: Id;
  resourceType: 'teacher' | 'room' | 'group';
  rule: RecurrenceRule;
  /** Local time-of-day bounds, e.g. "09:00"/"17:00". Interpreted in `timezone`. */
  startTime: string;
  endTime: string;
  timezone: string;
  validFrom: Timestamp;
  validUntil?: Timestamp;
}

/**
 * Which courses a teacher is qualified to teach, keyed by the same loose
 * `courseId` a ClassSessionTemplate optionally carries. Like
 * AvailabilityRule, this is opt-in: a teacher with no
 * TeacherQualification record on file is treated as qualified for
 * everything (see teacher-qualification.ts) — institutions that don't
 * track subject-specific staffing (a single-tutor setup, say) never need
 * to declare these at all. One that does adds a record per teacher.
 */
export interface TeacherQualification {
  teacherId: Id;
  qualifiedCourseIds: Id[];
}

/**
 * Abstract "this class meets on this pattern" — not yet placed on a real
 * calendar. Room/time are decisions (see solver/), so they're optional here:
 * a template can exist unscheduled, then get slotted in by the generator.
 */
export interface ClassSessionTemplate {
  id: Id;
  sectionId: Id;
  /**
   * Loose reference to whatever the host app calls "the course" this
   * section belongs to (e.g. core.Course.id, if the host app uses core).
   * Optional and only consulted for teacher-qualification checks (see
   * TeacherQualification below) — omit it if you don't need that check.
   * scheduling deliberately never resolves this through `core` itself, to
   * keep the module's zero-dependency stance on other modules intact.
   */
  courseId?: Id;
  /** Multiple co-teachers supported; first is not privileged over the rest. */
  teacherIds: Id[];
  groupId: Id;
  roomId?: Id;
  rule: RecurrenceRule;
  /** Local time-of-day, interpreted in `timezone`. */
  startTime: string;
  endTime: string;
  timezone: string;
  validFrom: Timestamp;
  validUntil?: Timestamp;
  /**
   * Feature tags a room must have to host this session (e.g. "lab",
   * "projector"). Empty/omitted means no special requirement — any room
   * with sufficient capacity qualifies.
   */
  requiredRoomFeatures?: string[];
}

export type OccurrenceStatus = 'scheduled' | 'cancelled' | 'moved' | 'completed';

/**
 * One concrete, materialized meeting. Generated from a template for a
 * rolling window (see generator.ts) so that single-instance edits — a sick
 * teacher, a moved room, a cancelled session — never have to fork the rule.
 */
export interface ClassOccurrence {
  id: Id;
  templateId: Id;
  date: Timestamp;
  status: OccurrenceStatus;
  /** Overrides — only set when this occurrence deviates from its template. */
  teacherIds?: Id[];
  roomId?: Id;
  startTime?: string;
  endTime?: string;
  note?: string;
}

export interface Room {
  id: Id;
  name: string;
  capacity: number;
  features: string[];
}

/** A group being scheduled together (a section, batch, or cohort). */
export interface SchedulingGroup {
  id: Id;
  sectionId: Id;
  size: number;
}
