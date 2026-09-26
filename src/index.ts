/**
 * Root export — convenience for consumers who want everything from one
 * import. Prefer subpath imports (e.g. `lms-sdk/grading`) in real apps
 * to keep bundles small.
 */
export * from './core/index.js';
export * from './enrollment/index.js';
export * from './content/index.js';
export * from './assessment/index.js';
export * from './grading/index.js';
export * from './communication/index.js';
export * from './calendar/index.js';
export * from './scheduling/index.js';
export * from './reporting/index.js';
export * from './admin/index.js';
export * from './interop/index.js';
