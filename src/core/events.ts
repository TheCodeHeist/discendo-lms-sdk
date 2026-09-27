/**
 * Cross-cutting event/hook system: lets host apps react to things
 * happening across the SDK (an enrollment, a grade posting, a section
 * publishing) without the SDK baking in side effects itself, and without
 * services having to import each other directly.
 *
 * This is deliberately more general than communication.NotificationSink
 * (which only carries a fixed, communication-specific set of event shapes)
 * and admin.withAudit (which wraps a single call rather than broadcasting
 * to arbitrary listeners). Those two remain as-is — this module doesn't
 * replace them, it's the general-purpose backbone a host app can use
 * instead of, or alongside, them. A host app is free to have a
 * NotificationSink implementation subscribe to this bus internally if it
 * wants a single place where all cross-module reactions live.
 *
 * Every module that wants to participate defines its own event variants
 * here (see the per-module sections below) as part of the single
 * `LmsEvent` discriminated union, so one EventBus instance, shared across
 * every service a host app constructs, can dispatch all of them through
 * one `on`/`emit` surface — no per-module bus, no separate wiring per
 * feature.
 */

// --- enrollment events ---
export interface EnrolledEvent {
  type: 'enrollment.enrolled';
  enrollmentId: string;
  userId: string;
  sectionId: string;
  status: 'active' | 'waitlisted';
}
export interface DroppedEvent {
  type: 'enrollment.dropped';
  enrollmentId: string;
  userId: string;
  sectionId: string;
}

// --- grading events ---
export interface GradePostedEvent {
  type: 'grading.gradePosted';
  gradeEntryId: string;
  submissionId: string;
  userId: string;
  score: number;
  maxScore: number;
  graderId: string;
}

// --- content events ---
export interface ContentPublishedEvent {
  type: 'content.published';
  contentId: string;
  sectionId: string;
  version: number;
}

/**
 * Every event any module can emit. Extending this in the future (a new
 * module, a new event on an existing module) is additive — add a variant,
 * add it to this union. Existing handlers registered for other event
 * types are unaffected.
 */
export type LmsEvent = EnrolledEvent | DroppedEvent | GradePostedEvent | ContentPublishedEvent;

/** Narrows LmsEvent to just the variant(s) matching a given `type` literal. */
export type LmsEventOfType<T extends LmsEvent['type']> = Extract<LmsEvent, { type: T }>;

type Handler<T extends LmsEvent['type']> = (event: LmsEventOfType<T>) => void | Promise<void>;

/** Internal storage type — deliberately erased since a single Map can't express
 * "handler type varies per key" natively. The public `on`/`emit` API stays
 * fully typed; this cast is confined to this one file. */
type ErasedHandler = (event: LmsEvent) => void | Promise<void>;

export interface EventBusOptions {
  /**
   * Called when a handler throws or rejects. The bus itself never throws
   * from emit() because of a handler's failure — that would mean a
   * notification listener's bug could break the enrollment/grading/etc.
   * operation that triggered it. Default: the error is silently
   * discarded, since the SDK has no logger of its own to call into.
   * Supply this to actually surface handler failures.
   */
  onHandlerError?: (error: unknown, event: LmsEvent) => void;
}

/**
 * A small, dependency-free typed pub/sub bus. Construct one, pass it to
 * every service that should be able to emit or listen, register handlers
 * with `on`, and call `emit` from wherever a meaningful thing happens.
 *
 * Emission failure isolation: emit() awaits every handler via
 * Promise.allSettled, so one throwing/rejecting handler never stops the
 * others from running, and never rejects emit() itself. Combine this with
 * calling emit() without awaiting it (fire-and-forget) at the call site —
 * matching the pattern already used for AssessmentService's plagiarism
 * hook — if the operation that triggered the event shouldn't be slowed
 * down by however long handlers take to run.
 */
export class EventBus {
  private handlers = new Map<LmsEvent['type'], Set<ErasedHandler>>();

  constructor(private readonly options: EventBusOptions = {}) {}

  on<T extends LmsEvent['type']>(type: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    const erased = handler as unknown as ErasedHandler;
    set.add(erased);
    this.handlers.set(type, set);
    return () => set.delete(erased);
  }

  async emit(event: LmsEvent): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set || set.size === 0) return;

    // Wrap each call so a handler that throws SYNCHRONOUSLY (not just one
    // that returns a rejected promise) still becomes a rejected promise
    // here, rather than throwing immediately while this array is being
    // built — which would happen before Promise.allSettled even runs and
    // would break the failure-isolation guarantee for every other handler.
    const results = await Promise.allSettled(
      [...set].map(async (handler) => handler(event)),
    );
    for (const result of results) {
      if (result.status === 'rejected' && this.options.onHandlerError) {
        this.options.onHandlerError(result.reason, event);
      }
    }
  }
}
