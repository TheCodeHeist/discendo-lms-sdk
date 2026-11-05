import type { Id } from '../../../core/types.js';
import type { OccurrenceRescheduledEvent } from '../../../core/events.js';
import type { ActorContext } from '../../../core/permissions.js';
import { PermissionDeniedError, activeSectionRole } from '../../../core/permissions.js';
import { authorizeInSection } from '../../../core/authorization.js';
import type { ClassOccurrence, ClassSessionTemplate } from '../types.js';
import { generateOccurrences } from '../generator.js';
import { validateAttendanceTarget, type AttendanceEntry } from '../attendance.js';
import type { SchedulingAccess } from './access.js';
import type { SchedulingDeps } from './context.js';

/** The concrete timetable: materializing, cancelling, moving and reading occurrences, and their attendance. */
export class SchedulingOccurrences {
  constructor(
    private readonly deps: SchedulingDeps,
    private readonly access: SchedulingAccess,
  ) {}

  async materializeOccurrences(
    templateId: Id,
    rangeStart: Date,
    rangeEnd: Date,
    actor?: ActorContext,
  ): Promise<ClassOccurrence[]> {
    if (this.access.enforcement) await this.access.authorizeTemplate('scheduling.manage', actor, templateId);
    const { scheduling } = this.deps;
    const template = await scheduling.findTemplate(templateId);
    if (!template) throw new Error(`materializeOccurrences: template ${templateId} not found`);

    const already = await scheduling.listOccurrences(templateId, rangeStart, rangeEnd);
    const existingDates = new Set(already.map((o) => o.date.toISOString().slice(0, 10)));

    const candidates = generateOccurrences(template, rangeStart, rangeEnd).filter(
      (o) => !existingDates.has(o.date.toISOString().slice(0, 10)),
    );

    if (candidates.length === 0) return already;

    const created = await scheduling.createOccurrences(candidates);
    return [...already, ...created];
  }

  async cancelOccurrence(id: Id, note?: string, actor?: ActorContext): Promise<ClassOccurrence> {
    const guard = await this.access.authorizeOccurrence('scheduling.manageOccurrence', actor, id);
    const patch: Partial<ClassOccurrence> = { status: 'cancelled' };
    if (note !== undefined) patch.note = note;
    const updated = await this.deps.scheduling.updateOccurrence(id, patch);
    void this.deps.events?.emit({
      type: 'scheduling.occurrenceCancelled',
      occurrenceId: updated.id,
      templateId: updated.templateId,
      ...(updated.note !== undefined && { note: updated.note }),
      // oversight: who cancelled it, and what it was
      ...(guard ? { ...guard.oversight, previousStatus: guard.occurrence.status } : {}),
    });
    return updated;
  }

  async rescheduleOccurrence(
    id: Id,
    patch: { roomId?: Id; startTime?: string; endTime?: string; date?: Date },
    actor?: ActorContext,
  ): Promise<ClassOccurrence> {
    const guard = await this.access.authorizeOccurrence('scheduling.manageOccurrence', actor, id);
    // the room must belong to the organization of the section being rescheduled
    if (guard && patch.roomId !== undefined) await this.access.assertRoomInOrg(patch.roomId, guard.auth.ctx.resourceOrgId);
    const updated = await this.deps.scheduling.updateOccurrence(id, { ...patch, status: 'moved' });
    void this.deps.events?.emit({
      type: 'scheduling.occurrenceRescheduled',
      occurrenceId: updated.id,
      templateId: updated.templateId,
      date: updated.date,
      ...(updated.roomId !== undefined && { roomId: updated.roomId }),
      ...(updated.startTime !== undefined && { startTime: updated.startTime }),
      ...(updated.endTime !== undefined && { endTime: updated.endTime }),
      // oversight: who moved it, and where it was before (the effective values, template defaults included)
      ...(guard ? { ...guard.oversight, from: previousOf(guard.occurrence, guard.template) } : {}),
    });
    return updated;
  }

  async recordAttendanceForOccurrence(
    occurrenceId: Id,
    userId: Id,
    status: AttendanceEntry['status'],
    actor?: ActorContext,
  ): Promise<void> {
    const guard = await this.access.authorizeOccurrence('scheduling.recordAttendance', actor, occurrenceId);
    if (guard) {
      // attendance is only ever about a student who is currently taking the section
      const membership = await this.access.enforcement!.repos.enrollments.findByUserAndSection(
        userId,
        guard.oversight.sectionId,
      );
      if (activeSectionRole(membership) !== 'student') throw new PermissionDeniedError('scheduling.recordAttendance');
    }
    const recorder = this.deps.attendanceRecorder;
    if (!recorder) {
      throw new Error('recordAttendanceForOccurrence: no AttendanceRecorder was provided to SchedulingService.');
    }

    const occurrence = await this.deps.scheduling.findOccurrence(occurrenceId);
    const error = validateAttendanceTarget(occurrence);
    if (error) {
      throw new Error(`recordAttendanceForOccurrence: ${error.message}`);
    }

    await recorder.record({
      sessionId: occurrenceId,
      userId,
      status,
      recordedAt: new Date(),
      ...(guard ? { recordedBy: guard.oversight.actorId } : {}),
    });
  }

  async canRecordAttendance(
    occurrenceId: Id,
    actor?: ActorContext,
  ): Promise<ReturnType<typeof validateAttendanceTarget>> {
    await this.access.authorizeOccurrence('scheduling.recordAttendance', actor, occurrenceId);
    const occurrence = await this.deps.scheduling.findOccurrence(occurrenceId);
    return validateAttendanceTarget(occurrence);
  }

  async listOccurrences(
    sectionId: Id,
    from: Date,
    to: Date,
    actor?: ActorContext,
    options: { wardId?: Id } = {},
  ): Promise<ClassOccurrence[]> {
    const e = this.access.enforcement;
    if (e) {
      await authorizeInSection(e.policy, e.repos, 'scheduling.view', actor, { sectionId, ownerId: options.wardId });
    }
    const found: ClassOccurrence[] = [];
    for (const template of await this.deps.scheduling.listTemplatesForSection(sectionId)) {
      found.push(...(await this.deps.scheduling.listOccurrences(template.id, from, to)));
    }
    return found.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
}

/** What an occurrence was before it moved: its own values, or its template's where it has none. */
function previousOf(
  occurrence: ClassOccurrence,
  template: ClassSessionTemplate,
): NonNullable<OccurrenceRescheduledEvent['from']> {
  const roomId = occurrence.roomId ?? template.roomId;
  const startTime = occurrence.startTime ?? template.startTime;
  const endTime = occurrence.endTime ?? template.endTime;
  return {
    date: occurrence.date,
    status: occurrence.status,
    ...(roomId !== undefined ? { roomId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  };
}
