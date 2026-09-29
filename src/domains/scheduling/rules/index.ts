/**
 * Pure constraint rules: functions over plain data, with no repository
 * access and no I/O. Each answers one yes/no question about a candidate
 * placement. SchedulingService and the solver compose them; you can also
 * call them directly, e.g. to validate a manual booking in a UI.
 */
export * from './recurrence.js';
export * from './conflict.js';
export * from './availability.js';
export * from './room-matching.js';
export * from './teacher-qualification.js';
