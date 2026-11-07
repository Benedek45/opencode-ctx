// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Cache accounting for dashboard-authored projection edits.
//
// A dashboard edit (keep/exclude/replace, or block activation) rewrites message
// positions the provider has already cached. The next request therefore pays a
// cache WRITE from the earliest edited position onward, whatever else the
// pipeline decides to do.
//
// A settings change does NOT arm this by itself. It only alters future pruning
// decisions, and whichever pass acts on them accounts for its own invalidation;
// charging a rewrite for a save that changes nothing would be a fabricated cost.
//
// That single fact drives two behaviours:
//   1. While an edit is pending, cache-deferred mechanical pruning (dedup,
//      stale-error, near-dupe, observation masking) is allowed to run in the
//      same turn. Those passes also rewrite older positions, so folding them
//      into the edit's unavoidable invalidation costs one cache write instead
//      of two.
//   2. The turn that delivers the edit records exactly one cache-bust event for
//      the adaptive E_turns estimate — not one per edited message, and not one
//      per turn for as long as the override stays in place (once applied, the
//      projection is byte-stable again and the cache refills normally).
/** Whether a dashboard edit still has to be delivered to the model. */
export function hasPendingProjectionRewrite(state) {
    return (state.projectionEditRevision ?? 0) > (state.projectionEditAppliedRevision ?? 0);
}
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
export function recordProjectionEdit(state, messageIds = [], cutIds = []) {
    state.projectionEditRevision = (state.projectionEditRevision ?? 0) + 1;
    const pending = new Set(state.projectionEditPendingIds ?? []);
    for (const messageId of messageIds)
        pending.add(messageId);
    state.projectionEditPendingIds = [...pending];
    const cuts = new Set(state.projectionEditCutIds ?? []);
    for (const messageId of cutIds)
        cuts.add(messageId);
    state.projectionEditCutIds = [...cuts];
}
/**
 * Mark the pending edit as delivered; the projection is byte-stable again.
 *
 * Called at the delivery boundary — after the host actually received the edited
 * message list — so a failure between projection and delivery leaves the edit
 * pending for the next attempt rather than silently dropping it.
 */
export function markProjectionRewriteApplied(state) {
    state.projectionEditAppliedRevision = state.projectionEditRevision ?? 0;
    state.projectionEditPendingIds = [];
    state.projectionEditCutIds = [];
}
//# sourceMappingURL=projectionEdits.js.map