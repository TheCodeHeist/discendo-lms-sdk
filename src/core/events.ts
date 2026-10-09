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
 *
 * Listening: `on(type, handler)` for one event type, `on('*', handler)` to
 * receive every event (useful for logging, audit trails, or bridging the
 * bus into another system — see `services/communication/event-bridge.ts`),
 * and `once(...)` for either form when a handler should fire a single time.
 */

import type { Timestamp } from './types.js';

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
/**
 * A waitlisted person was given a seat. `trigger` says how: `'manual'` (someone called
 * `promoteFromWaitlist`) or `'auto'` (the service's `promoteOnDrop` option, after a seat was freed).
 * `actorId` is present only for a manual promotion made with permissions enforced; an automatic one
 * names nobody, so a student who drops themselves is never tied to who moved up.
 */
export interface PromotedEvent {
  type: 'enrollment.promoted';
  enrollmentId: string;
  userId: string;
  sectionId: string;
  previousStatus: 'waitlisted';
  trigger: 'manual' | 'auto';
  actorId?: string;
}

/** A student asked for a seat. Nothing has been decided: this is the cue to tell the reviewers. */
export interface EnrollmentRequestedEvent {
  type: 'enrollment.requested';
  requestId: string;
  userId: string;
  sectionId: string;
}
/**
 * A request was settled. `sectionId` is the section that was asked for. For `accepted`,
 * `enrollmentId`, `enrollmentStatus` (`waitlisted` means the student has no seat yet) and
 * `grantedSectionId` (different from `sectionId` when the reviewer modified the request) say what
 * the student got. `reviewerId` is set for `accepted` and `rejected`, never for `withdrawn`.
 */
export interface EnrollmentRequestDecidedEvent {
  type: 'enrollment.requestDecided';
  requestId: string;
  userId: string;
  sectionId: string;
  decision: 'accepted' | 'rejected' | 'withdrawn';
  reviewerId?: string;
  enrollmentId?: string;
  enrollmentStatus?: 'active' | 'waitlisted' | 'dropped' | 'completed';
  grantedSectionId?: string;
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

// --- assessment events ---
export interface SubmissionReceivedEvent {
  type: 'assessment.submissionReceived';
  submissionId: string;
  contentId: string;
  userId: string;
  attemptNumber: number;
}

/**
 * A student submitted a quiz attempt and it was scored. A `Submission` (payload kind `quiz`) now
 * exists for grading to attach to; it does NOT also emit `assessment.submissionReceived`. Sent once per
 * attempt, when that submission is stored.
 */
export interface QuizSubmittedEvent {
  type: 'assessment.quizSubmitted';
  attemptId: string;
  quizId: string;
  submissionId: string;
  userId: string;
  score: number;
  maxScore: number;
  late: boolean;
}

// --- scheduling events ---
export interface OccurrenceCancelledEvent {
  type: 'scheduling.occurrenceCancelled';
  occurrenceId: string;
  templateId: string;
  note?: string;
  // Oversight: filled in when `SchedulingService` enforces permissions, so a host can tell admins
  // who cancelled what (an instructor cancelling their own class, say). Absent otherwise.
  sectionId?: string;
  actorId?: string;
  /** 'admin', or the role the actor acted as in the section ('instructor', or 'ta' when delegated). */
  actorRole?: 'admin' | 'instructor' | 'ta';
  /** The occurrence's status before this call. */
  previousStatus?: string;
}
/** Carries the occurrence's values AFTER the move, not the patch that was applied. */
export interface OccurrenceRescheduledEvent {
  type: 'scheduling.occurrenceRescheduled';
  occurrenceId: string;
  templateId: string;
  date: Timestamp;
  roomId?: string;
  startTime?: string;
  endTime?: string;
  // Oversight, as on the cancelled event; `from` is what the occurrence was before the move.
  sectionId?: string;
  actorId?: string;
  actorRole?: 'admin' | 'instructor' | 'ta';
  from?: { date: Timestamp; status: string; roomId?: string; startTime?: string; endTime?: string };
}

/**
 * Every event any module can emit. Extending this in the future (a new
 * module, a new event on an existing module) is additive — add a variant,
 * add it to this union. Existing handlers registered for other event
 * types are unaffected.
 */
export type LmsEvent =
  | EnrolledEvent
  | DroppedEvent
  | PromotedEvent
  | EnrollmentRequestedEvent
  | EnrollmentRequestDecidedEvent
  | QuizSubmittedEvent
  | GradePostedEvent
  | ContentPublishedEvent
  | SubmissionReceivedEvent
  | OccurrenceCancelledEvent
  | OccurrenceRescheduledEvent;

/** Narrows LmsEvent to just the variant(s) matching a given `type` literal. */
export type LmsEventOfType<T extends LmsEvent['type']> = Extract<LmsEvent, { type: T }>;

/**
 * Handlers may return anything: only a returned promise is awaited, any other
 * value is ignored. Typing this as `void | Promise<void>` would reject
 * perfectly reasonable one-liners like `(e) => received.push(e)`.
 */
export type Handler<T extends LmsEvent['type']> = (event: LmsEventOfType<T>) => unknown;

/** Receives every event regardless of type. Register with `on('*', ...)`. */
export type WildcardHandler = (event: LmsEvent) => unknown;

/** Internal storage type — deliberately erased since a single Map can't express
 * "handler type varies per key" natively. The public `on`/`emit` API stays
 * fully typed; this cast is confined to this one file. */
type ErasedHandler = (event: LmsEvent) => unknown;

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
  private handlers = new Map<LmsEvent['type'] | '*', Set<ErasedHandler>>();

  constructor(private readonly options: EventBusOptions = {}) {}

  /**
   * Registers a handler for one event type, or for every event with `'*'`.
   * Returns an unsubscribe function. Registering the same function twice
   * registers it twice.
   */
  on<T extends LmsEvent['type']>(type: T, handler: Handler<T>): () => void;
  on(type: '*', handler: WildcardHandler): () => void;
  on(type: LmsEvent['type'] | '*', handler: ErasedHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<ErasedHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Like `on`, but the handler is removed before it runs, so it fires for at
   * most one event even if it (or something it calls) emits re-entrantly.
   * The returned function cancels it if it hasn't fired yet.
   */
  once<T extends LmsEvent['type']>(type: T, handler: Handler<T>): () => void;
  once(type: '*', handler: WildcardHandler): () => void;
  once(type: LmsEvent['type'] | '*', handler: ErasedHandler): () => void {
    const off = this.on(type as '*', (event) => {
      off();
      return handler(event);
    });
    return off;
  }

  /**
   * Delivers to handlers registered for the event's exact type first, then
   * to wildcard handlers, each group in registration order.
   */
  async emit(event: LmsEvent): Promise<void> {
    const specific = this.handlers.get(event.type);
    const wildcard = this.handlers.get('*');
    if (!specific?.size && !wildcard?.size) return;

    // Snapshot before iterating so a handler that subscribes/unsubscribes
    // (once() does) can't change who receives THIS event.
    const targets = [...(specific ?? []), ...(wildcard ?? [])];

    // Wrap each call so a handler that throws SYNCHRONOUSLY (not just one
    // that returns a rejected promise) still becomes a rejected promise
    // here, rather than throwing immediately while this array is being
    // built — which would happen before Promise.allSettled even runs and
    // would break the failure-isolation guarantee for every other handler.
    const results = await Promise.allSettled(targets.map(async (handler) => handler(event)));
    for (const result of results) {
      if (result.status === 'rejected' && this.options.onHandlerError) {
        this.options.onHandlerError(result.reason, event);
      }
    }
  }
}
