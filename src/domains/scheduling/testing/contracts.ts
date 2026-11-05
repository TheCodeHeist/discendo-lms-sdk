/**
 * Contract suites for the scheduling repositories. See `core/testing/contract.ts` for how to run
 * them with your test runner. Rooms and groups have no create method in the SDK, so the factory is
 * handed the ones to seed.
 */
import { check, checkEqual, idsOf, suite, type ContractCase, type RepositoryFactory } from '../../../core/testing/contract.js';
import type { SchedulingRepository, SchedulingSettingsRepository } from '../repositories.js';
import type { ClassOccurrence, ClassSessionTemplate, Room, SchedulingGroup, TeacherQualification } from '../types.js';

const at = (iso: string) => new Date(iso);

export interface SchedulingSeed {
  rooms: Room[];
  groups: SchedulingGroup[];
  qualifications: TeacherQualification[];
}

const template = (over: Partial<Omit<ClassSessionTemplate, 'id'>> = {}): Omit<ClassSessionTemplate, 'id'> => ({
  sectionId: 's1',
  teacherIds: ['t1'],
  groupId: 'g1',
  roomId: 'r1',
  rule: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'] },
  startTime: '09:00',
  endTime: '10:00',
  timezone: 'UTC',
  validFrom: at('2026-09-01T00:00:00Z'),
  ...over,
});

const occurrence = (templateId: string, iso: string, over: Partial<Omit<ClassOccurrence, 'id'>> = {}): Omit<ClassOccurrence, 'id'> => ({
  templateId,
  date: at(iso),
  status: 'scheduled',
  ...over,
});

export function schedulingRepositoryContract(
  make: (seed: SchedulingSeed) => SchedulingRepository | Promise<SchedulingRepository>,
): ContractCase[] {
  const seed: SchedulingSeed = {
    rooms: [
      { id: 'r1', name: 'Lab', capacity: 20, features: ['lab'], orgId: 'org-a' },
      { id: 'r2', name: 'Hall', capacity: 200, features: [] },
    ],
    groups: [{ id: 'g1', sectionId: 's1', size: 18 }],
    qualifications: [{ teacherId: 't1', qualifiedCourseIds: ['c1'] }],
  };
  return suite('SchedulingRepository', [
    {
      name: 'templates: create, find, update, and list by section',
      run: async () => {
        const repo = await make(seed);
        const a = await repo.createTemplate(template());
        const b = await repo.createTemplate(template({ startTime: '11:00', endTime: '12:00' }));
        await repo.createTemplate(template({ sectionId: 's2' }));
        checkEqual(await repo.findTemplate(a.id), a, 'findTemplate');
        checkEqual(await repo.findTemplate('nope'), null, 'unknown template');
        checkEqual(idsOf(await repo.listTemplatesForSection('s1')), idsOf([a, b]), 'templates of s1');
        const moved = await repo.updateTemplate(a.id, { roomId: 'r2' });
        checkEqual(moved, { ...a, roomId: 'r2' }, 'updateTemplate merges');
      },
    },
    {
      name: 'occurrences: create several, find, update, and list by template within dates (inclusive)',
      run: async () => {
        const repo = await make(seed);
        const t = await repo.createTemplate(template());
        const created = await repo.createOccurrences([
          occurrence(t.id, '2026-09-07T00:00:00Z'),
          occurrence(t.id, '2026-09-09T00:00:00Z'),
          occurrence(t.id, '2026-09-14T00:00:00Z'),
        ]);
        checkEqual(created.length, 3, 'three created');
        check(new Set(created.map((o) => o.id)).size === 3, 'distinct ids');
        const inRange = await repo.listOccurrences(t.id, at('2026-09-07T00:00:00Z'), at('2026-09-09T00:00:00Z'));
        checkEqual(idsOf(inRange), idsOf(created.slice(0, 2)), 'both bounds are inclusive');
        const cancelled = await repo.updateOccurrence(created[0]!.id, { status: 'cancelled', note: 'sick' });
        checkEqual(await repo.findOccurrence(created[0]!.id), cancelled, 'updateOccurrence stored');
        checkEqual(await repo.findOccurrence('nope'), null, 'unknown occurrence');
      },
    },
    {
      name: "listOccurrencesForResource uses an occurrence's own teachers/room over its template's",
      run: async () => {
        const repo = await make(seed);
        const t = await repo.createTemplate(template());
        const [normal, swapped] = await repo.createOccurrences([
          occurrence(t.id, '2026-09-07T00:00:00Z'),
          occurrence(t.id, '2026-09-09T00:00:00Z', { teacherIds: ['t2'], roomId: 'r2' }),
        ]);
        const from = at('2026-09-01T00:00:00Z');
        const to = at('2026-09-30T00:00:00Z');
        checkEqual(idsOf(await repo.listOccurrencesForResource('teacher', 't1', from, to)), [normal!.id], 't1 teaches only the normal one');
        checkEqual(idsOf(await repo.listOccurrencesForResource('teacher', 't2', from, to)), [swapped!.id], 't2 covers the swapped one');
        checkEqual(idsOf(await repo.listOccurrencesForResource('room', 'r2', from, to)), [swapped!.id], 'r2 hosts the swapped one');
        checkEqual(idsOf(await repo.listOccurrencesForResource('group', 'g1', from, to)), idsOf([normal!, swapped!]), 'the group attends both');
      },
    },
    {
      name: 'rooms, groups and qualifications are found as seeded; an unknown one is null',
      run: async () => {
        const repo = await make(seed);
        checkEqual(await repo.findRoom('r1'), seed.rooms[0], 'findRoom');
        checkEqual(idsOf(await repo.listRooms()), ['r1', 'r2'], 'listRooms');
        checkEqual(await repo.findGroup('g1'), seed.groups[0], 'findGroup');
        checkEqual(await repo.findTeacherQualification('t1'), seed.qualifications[0], 'qualification on file');
        checkEqual(await repo.findTeacherQualification('t9'), null, 'no record (which means unrestricted)');
        checkEqual(await repo.findRoom('nope'), null, 'unknown room');
        checkEqual(await repo.findGroup('nope'), null, 'unknown group');
      },
    },
  ]);
}

/**
 * The settings repository, together with the read side it shares with `SchedulingRepository`
 * (`listAvailability`, `findTeacherQualification`): what is saved through one must be what the
 * other reads, so the factory returns one object implementing both.
 */
export function schedulingSettingsRepositoryContract(
  make: RepositoryFactory<SchedulingSettingsRepository & SchedulingRepository>,
): ContractCase[] {
  const rule = { rule: { freq: 'WEEKLY' as const, interval: 1, byDay: ['MO' as const] }, startTime: '08:00', endTime: '16:00', timezone: 'UTC', validFrom: at('2026-09-01') };
  return suite('SchedulingSettingsRepository', [
    {
      name: 'replaceAvailability replaces ALL rules of that resource, and listAvailability reads them back',
      run: async () => {
        const repo = await make();
        await repo.replaceAvailability('teacher', 't1', [rule, { ...rule, startTime: '17:00', endTime: '19:00' }]);
        const stored = await repo.replaceAvailability('teacher', 't1', [rule]);
        checkEqual(stored.length, 1, 'one rule after replacing');
        checkEqual([stored[0]?.resourceType, stored[0]?.resourceId], ['teacher', 't1'], 'stamped with the resource');
        checkEqual(idsOf(await repo.listAvailability('teacher', 't1')), idsOf(stored), 'read back');
        checkEqual(await repo.listAvailability('room', 't1'), [], 'a room with the same id is a different resource');
        await repo.replaceAvailability('teacher', 't1', []);
        checkEqual(await repo.listAvailability('teacher', 't1'), [], 'an empty list clears them');
      },
    },
    {
      name: 'teacher preferences: save replaces, find returns them or null',
      run: async () => {
        const repo = await make();
        checkEqual(await repo.findTeacherPreferences('t1'), null, 'none yet');
        await repo.saveTeacherPreferences({ teacherId: 't1', preferredStartWindow: { earliest: '08:00', latest: '10:00' } });
        await repo.saveTeacherPreferences({ teacherId: 't1' });
        checkEqual(await repo.findTeacherPreferences('t1'), { teacherId: 't1' }, 'the later save replaced the earlier');
      },
    },
    {
      name: 'saveTeacherQualification replaces, and findTeacherQualification reads it back',
      run: async () => {
        const repo = await make();
        await repo.saveTeacherQualification({ teacherId: 't1', qualifiedCourseIds: ['c1', 'c2'] });
        await repo.saveTeacherQualification({ teacherId: 't1', qualifiedCourseIds: [] });
        checkEqual(await repo.findTeacherQualification('t1'), { teacherId: 't1', qualifiedCourseIds: [] }, 'qualified for nothing now');
      },
    },
  ]);
}
