import type { Id } from '../../../core/types.js';
import type { ActorContext } from '../../../core/permissions.js';
import { sameOrg } from '../../../core/tenancy.js';
import { InvalidSchedulingPlanError } from '../types.js';
import type { ClassSessionTemplate, TeacherQualification, Weekday } from '../types.js';
import { teacherTimePreference } from '../solver/soft-constraints.js';
import { flattenAvailabilityForSolver, placementsToTemplatePatches, roomToSolverRoom, type SolvedTemplatePatch } from '../solver-adapter.js';
import { solveSchedule } from '../solver/backtracking.js';
import type { ResourceAvailabilityWindow, SchedulingProblem, SolveResult, SolverOptions, UnscheduledSession } from '../solver/types.js';
import type { SchedulingAccess } from './access.js';
import type { SchedulingDeps } from './context.js';
import { HHMM, WEEKDAYS, minutesBetween, toMinutes } from './validation.js';

/** Builds a solver problem from stored templates, runs it, and writes an accepted plan back. */
export class SchedulingAutoScheduler {
  constructor(
    private readonly deps: SchedulingDeps,
    private readonly access: SchedulingAccess,
  ) {}

  async planAutoSchedule(
    templateIds: Id[],
    grid: { candidateSlotsPerDay: string[]; days: Weekday[] },
    durationOverrides: Record<Id, number> = {},
    solverOptions?: SolverOptions,
    actor?: ActorContext,
  ): Promise<{ result: SolveResult; skippedAvailability: string[] }> {
    const { scheduling } = this.deps;
    // With enforcement the plan stays inside one organization: the actor needs scheduling.manage in
    // every template's section, and only that organization's rooms are ever offered to the solver.
    let orgId: string | undefined;
    const enforced = !!this.access.enforcement;
    if (enforced) {
      if (templateIds.length === 0) {
        orgId = (await this.access.authorizeOrg('scheduling.manage', actor)).ctx.actor.orgId;
      }
      for (const id of templateIds) {
        const { auth, template } = await this.access.authorizeTemplate('scheduling.manage', actor, id);
        orgId = auth.ctx.resourceOrgId;
        await this.access.assertTemplateResourcesInOrg(template, orgId);
      }
    }
    const templates: ClassSessionTemplate[] = [];
    for (const id of templateIds) {
      const t = await scheduling.findTemplate(id);
      if (!t) throw new Error(`planAutoSchedule: template ${id} not found`);
      templates.push(t);
    }

    const skippedAvailability: string[] = [];
    const availabilityWindows: ResourceAvailabilityWindow[] = [];
    const addAvailability = async (resourceType: 'teacher' | 'room' | 'group', resourceId: Id): Promise<void> => {
      const rules = await scheduling.listAvailability(resourceType, resourceId);
      const { windows, skipped } = flattenAvailabilityForSolver(rules, resourceType, resourceId);
      availabilityWindows.push(...windows);
      if (skipped.length > 0) skippedAvailability.push(`${resourceType}:${resourceId}`);
    };

    const teacherIds = new Set(templates.flatMap((t) => t.teacherIds));
    const groupIds = new Set(templates.map((t) => t.groupId));
    for (const teacherId of teacherIds) await addAvailability('teacher', teacherId);
    for (const groupId of groupIds) await addAvailability('group', groupId);

    const allRooms = await scheduling.listRooms();
    const rooms = enforced ? allRooms.filter((r) => sameOrg(r.orgId, orgId)) : allRooms;
    for (const room of rooms) await addAvailability('room', room.id);

    const teacherQualifications: TeacherQualification[] = [];
    for (const teacherId of teacherIds) {
      const qualification = await scheduling.findTeacherQualification(teacherId);
      if (qualification) teacherQualifications.push(qualification);
    }

    const sessions: UnscheduledSession[] = [];
    for (const t of templates) {
      const group = await scheduling.findGroup(t.groupId);
      if (!group) throw new Error(`planAutoSchedule: group ${t.groupId} not found for template ${t.id}`);

      const duration = durationOverrides[t.id] ?? minutesBetween(t.startTime, t.endTime) ?? undefined;
      if (duration === undefined) {
        throw new Error(`planAutoSchedule: template ${t.id} has no derivable duration — pass it via durationOverrides.`);
      }

      sessions.push({
        id: t.id,
        sectionId: t.sectionId,
        teacherIds: t.teacherIds,
        groupId: t.groupId,
        ...(t.courseId ? { courseId: t.courseId } : {}),
        groupSize: group.size,
        ...(t.requiredRoomFeatures ? { requiredRoomFeatures: t.requiredRoomFeatures } : {}),
        candidateDays: t.rule.byDay,
        durationMinutes: duration,
      });
    }

    const problem: SchedulingProblem = {
      sessions,
      rooms: rooms.map(roomToSolverRoom),
      availability: availabilityWindows,
      ...(teacherQualifications.length > 0 ? { teacherQualifications } : {}),
      candidateSlotsPerDay: grid.candidateSlotsPerDay,
      days: grid.days,
    };

    const result = solveSchedule(problem, await this.withSavedPreferences([...teacherIds], solverOptions));
    return { result, skippedAvailability };
  }

  async applyAutoSchedulePlan(result: SolveResult, actor?: ActorContext): Promise<ClassSessionTemplate[]> {
    const patches: SolvedTemplatePatch[] = placementsToTemplatePatches(result.placements);
    // A plan is data the caller hands over, so with enforcement every placement is checked first
    // (permission in its template's section, the room's organization, well-formed times and days)
    // and nothing is written unless all of them pass.
    if (this.access.enforcement) await this.verifyPlan(patches, actor);
    const updated: ClassSessionTemplate[] = [];
    for (const patch of patches) {
      const template = await this.deps.scheduling.findTemplate(patch.templateId);
      if (!template) continue;
      const next = await this.deps.scheduling.updateTemplate(patch.templateId, {
        roomId: patch.roomId,
        startTime: patch.startTime,
        endTime: patch.endTime,
        rule: { ...template.rule, byDay: patch.days },
      });
      updated.push(next);
    }
    return updated;
  }

  /** The soft constraints for the teachers' saved preferences, added to the caller's own. */
  private async withSavedPreferences(teacherIds: Id[], options: SolverOptions | undefined): Promise<SolverOptions | undefined> {
    const settings = this.deps.options.settings;
    if (!settings) return options;
    const saved = [];
    for (const teacherId of teacherIds) {
      const window = (await settings.findTeacherPreferences(teacherId))?.preferredStartWindow;
      if (window) saved.push(teacherTimePreference(teacherId, window.earliest, window.latest, 1));
    }
    if (saved.length === 0) return options;
    return { ...options, softConstraints: [...(options?.softConstraints ?? []), ...saved] };
  }

  /** Checks a whole plan, and throws on the first problem, before anything is written. */
  private async verifyPlan(patches: SolvedTemplatePatch[], actor: ActorContext | undefined): Promise<void> {
    if (patches.length === 0) {
      await this.access.authorizeOrg('scheduling.manage', actor);
      return;
    }
    for (const patch of patches) {
      const { auth } = await this.access.authorizeTemplate('scheduling.manage', actor, patch.templateId);
      await this.access.assertRoomInOrg(patch.roomId, auth.ctx.resourceOrgId);
      if (
        !HHMM.test(patch.startTime) ||
        !HHMM.test(patch.endTime) ||
        toMinutes(patch.startTime) >= toMinutes(patch.endTime) ||
        !Array.isArray(patch.days) ||
        patch.days.length === 0 ||
        patch.days.some((d) => !WEEKDAYS.includes(d))
      ) {
        throw new InvalidSchedulingPlanError(`The placement for ${patch.templateId} has invalid times or days`);
      }
    }
  }
}
