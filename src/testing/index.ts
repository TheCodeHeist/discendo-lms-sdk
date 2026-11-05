/**
 * `discendo-sdk/testing`: in-memory repositories for every module, runner-agnostic contract
 * suites to check your own repository implementations against, and `createInMemoryLms()`, which
 * wires all of it into working services in one call.
 *
 * Nothing here is needed in production, and nothing in the rest of the SDK imports it.
 */
export * from '../core/testing/index.js';
export * from '../domains/content/testing/index.js';
export * from '../domains/assessment/testing/index.js';
export * from '../domains/grading/testing/index.js';
export * from '../domains/scheduling/testing/index.js';
export * from '../services/communication/testing/index.js';
export * from '../services/reporting/testing/index.js';
export * from '../services/admin/testing/index.js';
export * from './in-memory-lms.js';
