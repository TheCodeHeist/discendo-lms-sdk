/**
 * Root export — convenience for consumers who want everything from one
 * import. Prefer subpath imports (e.g. `discendo-sdk/grading`) in real apps
 * to keep bundles small.
 *
 * Modules are organized into three layers — see each layer's README for
 * the rule of thumb on where a new module belongs:
 *   core/      — shared primitives + EventBus. Everything else depends on
 *                this; this depends on nothing else in the SDK.
 *   domains/   — modules that own a primary entity a host app persists
 *                (enrollment, content, assessment, grading, scheduling).
 *   services/  — cross-cutting modules that consume/aggregate what domains
 *                produce, rather than owning a primary entity of their own
 *                (communication, reporting, admin).
 *   interop/   — pluggable protocol seams only (LTI, SSO, SCORM/xAPI) —
 *                no implementation, by design.
 */
export * from './core/index.js';
export * from './domains/enrollment/index.js';
export * from './domains/content/index.js';
export * from './domains/assessment/index.js';
export * from './domains/grading/index.js';
export * from './domains/scheduling/index.js';
export * from './services/communication/index.js';
export * from './services/reporting/index.js';
export * from './services/admin/index.js';
export * from './interop/index.js';
