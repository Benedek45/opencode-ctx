import type { CoreState } from "../types/state.js";
/** Whether a dashboard edit still has to be delivered to the model. */
export declare function hasPendingProjectionRewrite(state: CoreState): boolean;
/**
 * Record that a dashboard edit changed the outbound projection.
 * Called by the adapter only when the rebuilt projection actually differs, so
 * a no-op save does not spend a cache bust.
 *
 * `messageIds` are the sources this edit touched. They accumulate until delivery
 * so the measured rewrite starts at the earliest NEWLY edited position, not at
 * the oldest override that is merely still in force.
 *
 * `cutIds` are changed synthetic positions (for example a block summary inserted
 * before its anchor). They affect rewritten-token accounting but are not counted
 * as additional edited source messages.
 */
export declare function recordProjectionEdit(state: CoreState, messageIds?: Iterable<string>, cutIds?: Iterable<string>): void;
/**
 * Mark the pending edit as delivered; the projection is byte-stable again.
 *
 * Called at the delivery boundary — after the host actually received the edited
 * message list — so a failure between projection and delivery leaves the edit
 * pending for the next attempt rather than silently dropping it.
 */
export declare function markProjectionRewriteApplied(state: CoreState): void;
//# sourceMappingURL=projectionEdits.d.ts.map