import type { Id } from '../core/types.js';
import type {
  AvailabilityRule,
  ClassOccurrence,
  ClassSessionTemplate,
  Room,
  SchedulingGroup,
} from './types.js';

export interface SchedulingRepository {
  // Templates
  findTemplate(id: Id): Promise<ClassSessionTemplate | null>;
  listTemplatesForSection(sectionId: Id): Promise<ClassSessionTemplate[]>;
  createTemplate(template: Omit<ClassSessionTemplate, 'id'>): Promise<ClassSessionTemplate>;
  updateTemplate(id: Id, patch: Partial<ClassSessionTemplate>): Promise<ClassSessionTemplate>;

  // Occurrences — the materialized, editable calendar
  listOccurrences(templateId: Id, from: Date, to: Date): Promise<ClassOccurrence[]>;
  /**
   * List every occurrence touching a resource (teacher/room/group) in a
   * window, regardless of template — this is what conflict detection reads.
   */
  listOccurrencesForResource(
    resourceType: 'teacher' | 'room' | 'group',
    resourceId: Id,
    from: Date,
    to: Date,
  ): Promise<ClassOccurrence[]>;
  createOccurrences(occurrences: Array<Omit<ClassOccurrence, 'id'>>): Promise<ClassOccurrence[]>;
  updateOccurrence(id: Id, patch: Partial<ClassOccurrence>): Promise<ClassOccurrence>;

  // Availability
  listAvailability(resourceType: 'teacher' | 'room' | 'group', resourceId: Id): Promise<AvailabilityRule[]>;

  // Resources
  findRoom(id: Id): Promise<Room | null>;
  listRooms(): Promise<Room[]>;
  findGroup(id: Id): Promise<SchedulingGroup | null>;
}
