/**
 * In-memory reference implementation of SchedulingRepository. Not exported
 * from the package root — intended for tests and local dev only, so the
 * SDK stays free of any bundled storage engine. Copy/adapt this as a
 * starting point for a real (SQLite/Postgres/etc.) implementation.
 */
import type { Id } from '../../core/types.js';
import type { SchedulingRepository } from '../repositories.js';
import type {
  AvailabilityRule,
  ClassOccurrence,
  ClassSessionTemplate,
  Room,
  SchedulingGroup,
} from '../types.js';

let counter = 0;
function nextId(prefix: string): Id {
  counter += 1;
  return `${prefix}-${counter}`;
}

export class InMemorySchedulingRepository implements SchedulingRepository {
  private templates = new Map<Id, ClassSessionTemplate>();
  private occurrences = new Map<Id, ClassOccurrence>();
  private availability = new Map<Id, AvailabilityRule[]>();
  private rooms = new Map<Id, Room>();
  private groups = new Map<Id, SchedulingGroup>();

  // --- seeding helpers (test/dev only) ---
  seedTemplate(template: ClassSessionTemplate): void {
    this.templates.set(template.id, template);
  }
  seedRoom(room: Room): void {
    this.rooms.set(room.id, room);
  }
  seedGroup(group: SchedulingGroup): void {
    this.groups.set(group.id, group);
  }
  seedAvailability(rule: AvailabilityRule): void {
    const key = `${rule.resourceType}:${rule.resourceId}`;
    const list = this.availability.get(key) ?? [];
    list.push(rule);
    this.availability.set(key, list);
  }

  // --- SchedulingRepository ---
  async findTemplate(id: Id): Promise<ClassSessionTemplate | null> {
    return this.templates.get(id) ?? null;
  }

  async listTemplatesForSection(sectionId: Id): Promise<ClassSessionTemplate[]> {
    return [...this.templates.values()].filter((t) => t.sectionId === sectionId);
  }

  async createTemplate(template: Omit<ClassSessionTemplate, 'id'>): Promise<ClassSessionTemplate> {
    const created = { ...template, id: nextId('template') };
    this.templates.set(created.id, created);
    return created;
  }

  async updateTemplate(id: Id, patch: Partial<ClassSessionTemplate>): Promise<ClassSessionTemplate> {
    const existing = this.templates.get(id);
    if (!existing) throw new Error(`Template ${id} not found`);
    const updated = { ...existing, ...patch };
    this.templates.set(id, updated);
    return updated;
  }

  async listOccurrences(templateId: Id, from: Date, to: Date): Promise<ClassOccurrence[]> {
    return [...this.occurrences.values()].filter(
      (o) => o.templateId === templateId && o.date >= from && o.date <= to,
    );
  }

  async listOccurrencesForResource(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    from: Date,
    to: Date,
  ): Promise<ClassOccurrence[]> {
    const result: ClassOccurrence[] = [];
    for (const occ of this.occurrences.values()) {
      if (occ.date < from || occ.date > to) continue;
      const template = this.templates.get(occ.templateId);
      if (!template) continue;

      const matches =
        (resourceType === 'teacher' &&
          (occ.teacherIds ?? template.teacherIds).includes(resourceId)) ||
        (resourceType === 'room' && (occ.roomId ?? template.roomId) === resourceId) ||
        (resourceType === 'group' && template.groupId === resourceId);

      if (matches) result.push(occ);
    }
    return result;
  }

  async createOccurrences(
    occurrences: Array<Omit<ClassOccurrence, 'id'>>,
  ): Promise<ClassOccurrence[]> {
    const created: ClassOccurrence[] = [];
    for (const occ of occurrences) {
      const withId = { ...occ, id: nextId('occ') };
      this.occurrences.set(withId.id, withId);
      created.push(withId);
    }
    return created;
  }

  async updateOccurrence(id: Id, patch: Partial<ClassOccurrence>): Promise<ClassOccurrence> {
    const existing = this.occurrences.get(id);
    if (!existing) throw new Error(`Occurrence ${id} not found`);
    const updated = { ...existing, ...patch };
    this.occurrences.set(id, updated);
    return updated;
  }

  async listAvailability(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
  ): Promise<AvailabilityRule[]> {
    return this.availability.get(`${resourceType}:${resourceId}`) ?? [];
  }

  async findRoom(id: Id): Promise<Room | null> {
    return this.rooms.get(id) ?? null;
  }

  async listRooms(): Promise<Room[]> {
    return [...this.rooms.values()];
  }

  async findGroup(id: Id): Promise<SchedulingGroup | null> {
    return this.groups.get(id) ?? null;
  }
}
