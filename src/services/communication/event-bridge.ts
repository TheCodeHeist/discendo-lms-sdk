import type { EventBus } from '../../core/events.js';
import type { NotificationSink } from './types.js';

export interface EventBridgeOptions {
  /**
   * `grading.gradePosted` identifies the graded work by `submissionId`, but
   * `NotificationEvent.gradePosted` needs the `contentId` it belongs to, and
   * grading doesn't know that. The host app does (it owns the submission
   * store), so it supplies the lookup. Return `undefined` if the submission
   * can't be resolved and that grade is skipped rather than dispatched with a
   * made-up contentId.
   *
   * If this option is omitted, grade events are not forwarded at all.
   */
  resolveContentId?: (submissionId: string) => string | undefined | Promise<string | undefined>;

  /**
   * Called when dispatching to the sink fails or `resolveContentId` throws.
   * The bridge never lets these propagate: a broken notification channel must
   * not surface as a failure in whatever emitted the event. Default: discarded.
   */
  onError?: (error: unknown) => void;
}

/**
 * Subscribes to the shared EventBus and forwards the events that have a
 * `NotificationEvent` equivalent to a `NotificationSink`. Today that is
 * `grading.gradePosted` -> `gradePosted`. Other bus events (enrollment,
 * scheduling, ...) have no notification shape yet and are ignored; adding one
 * later means adding a `NotificationEvent` variant and a case here.
 *
 * Returns an unsubscribe function that detaches the bridge from the bus.
 */
export function bridgeEventBusToNotificationSink(
  bus: EventBus,
  sink: NotificationSink,
  options: EventBridgeOptions = {},
): () => void {
  const { resolveContentId, onError } = options;

  return bus.on('grading.gradePosted', async (event) => {
    if (!resolveContentId) return;
    try {
      const contentId = await resolveContentId(event.submissionId);
      if (contentId === undefined) return;
      await sink.dispatch({
        type: 'gradePosted',
        userId: event.userId,
        contentId,
        score: event.score,
      });
    } catch (error) {
      onError?.(error);
    }
  });
}
