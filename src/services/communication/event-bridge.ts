import type { EventBus } from "../../core/events.js";
import type { NotificationSink } from "./types.js";

export interface EventBridgeOptions {
  /**
   * `grading.gradePosted` identifies the graded work by `submissionId`, but
   * `NotificationEvent.gradePosted` needs the `contentId` it belongs to.
   * If `grading.gradePosted` does not carry `contentId`, the host app supplies
   * this lookup. Return `undefined` if the submission can't be resolved and that
   * grade is skipped rather than dispatched with a made-up contentId.
   *
   * If this option is omitted and `grading.gradePosted` lacks `contentId`,
   * grade events are not forwarded.
   */
  resolveContentId?: (
    submissionId: string,
  ) => string | undefined | Promise<string | undefined>;

  /**
   * Called when dispatching to the sink fails or `resolveContentId` throws.
   * The bridge never lets these propagate: a broken notification channel must
   * not surface as a failure in whatever emitted the event. Default: discarded.
   */
  onError?: (error: unknown) => void;
}

/**
 * Subscribes to the shared EventBus and forwards the events that have a
 * `NotificationEvent` equivalent to a `NotificationSink`. Today those are
 * `grading.gradePosted` -> `gradePosted` (except a grade that is held from the
 * student, `released: false`), and `grading.gradesReleased` -> `gradesReleased`.
 * Other bus events (enrollment, scheduling, ...) have no notification shape yet
 * and are ignored; adding one later means adding a `NotificationEvent` variant
 * and a case here.
 *
 * Returns an unsubscribe function that detaches the bridge from the bus.
 */
export function bridgeEventBusToNotificationSink(
  bus: EventBus,
  sink: NotificationSink,
  options: EventBridgeOptions = {},
): () => void {
  const { resolveContentId, onError } = options;

  const deliver = async (
    notification: Parameters<NotificationSink["dispatch"]>[0],
    orgId: string | undefined,
  ): Promise<void> => {
    try {
      await sink.dispatch(notification);
    } catch (sinkError) {
      onError?.(sinkError);
      void bus.emit({
        type: "communication.deliveryFailed",
        channel: "bridge",
        error: sinkError instanceof Error ? sinkError.message : String(sinkError),
        ...(orgId !== undefined ? { orgId } : {}),
      });
    }
  };

  const offReleased = bus.on("grading.gradesReleased", (event) =>
    deliver({ type: "gradesReleased", sectionId: event.sectionId, contentId: event.contentId }, event.orgId),
  );

  const offPosted = bus.on("grading.gradePosted", async (event) => {
    // A held grade: the student cannot see it yet, so they are told when it is released instead.
    if (event.released === false) return;
    try {
      const contentId =
        event.contentId ??
        (resolveContentId
          ? await resolveContentId(event.submissionId)
          : undefined);
      if (contentId === undefined) return;
      await deliver({ type: "gradePosted", userId: event.userId, contentId, score: event.score }, event.orgId);
    } catch (error) {
      onError?.(error);
    }
  });

  return () => {
    offPosted();
    offReleased();
  };
}
