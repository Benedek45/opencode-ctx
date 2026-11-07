// PolyForm Noncommercial License 1.0.0 — see LICENSE
// applyDecisions: ungated, deterministic re-application of all stored pruning
// decisions every pipeline turn.
//
// Under the opencode re-feed model, the host sends ORIGINAL (unpruned) messages
// every turn. The cascade strategies DECIDE which callIds to prune (gated) and
// write those decisions into CoreState. This function APPLIES those decisions
// (ungated, every turn) so the outgoing prefix is stable even when the gate
// skips recompute.
//
// Decision sources:
//   state.dedupDecisions    → replace tool output with PLACEHOLDER_DEDUP
//   state.staleErrorDecisions → replace tool input with PLACEHOLDER_STALE_ERROR_INPUT
//   state.maskDecisions     → replace tool output with stored replacement text
//   state.compressionIndex  → effective source messages replaced by active blocks
//   state.blockRegistry     → provides summary block text
//   state.activeByAnchorMessageId → anchor → blockId for summary insertion
import { PLACEHOLDER_DEDUP, PLACEHOLDER_STALE_ERROR_INPUT, PLACEHOLDER_NEAR_DUPE } from "./placeholders.js";
import { buildCompressionIndex } from "./compress/transaction.js";
import { buildColdCatalog, selectActiveRootBlocks } from "./contextTiers.js";
/**
 * Apply all stored pruning decisions to the message list.
 *
 * This is a pure transform: it reads from `state` but does NOT write to it.
 * Stats are NOT updated here (they are updated at DECIDE time only).
 * No offload requests are emitted here (files were written at DECIDE time).
 *
 * Compress re-application:
 *   Messages whose messageIndex entry has `replacedByBlockId` set are marked
 *   isIgnored=true and the corresponding summary block is inserted at the anchor
 *   position (the first message in the compressed range).
 */
export function applyDecisions(messages, state, options = {}) {
    const automaticPruning = options.automaticPruning !== false;
    const tiersEnabled = automaticPruning && options.contextTiers?.enabled === true && options.tokenizer !== undefined;
    const dedupDecisions = automaticPruning ? state.dedupDecisions : new Set();
    const staleErrorDecisions = automaticPruning ? state.staleErrorDecisions : new Set();
    const nearDupeDecisions = automaticPruning ? state.nearDupeDecisions : new Set();
    const maskDecisions = automaticPruning ? state.maskDecisions : new Map();
    const hardCapDroppedIds = automaticPruning ? state.hardCapDroppedIds : new Set();
    const { blockRegistry } = state;
    // The registry is authoritative: a persisted index can lag activation or
    // deactivation (and nested parents cover transitive sources). Never hide a
    // restored source or expose a covered one on the basis of a stale index.
    const compressionIndex = buildCompressionIndex(state);
    // Fast path: nothing to apply
    if (dedupDecisions.size === 0 &&
        staleErrorDecisions.size === 0 &&
        nearDupeDecisions.size === 0 &&
        maskDecisions.size === 0 &&
        hardCapDroppedIds.size === 0 &&
        compressionIndex.size === 0 &&
        blockRegistry.size === 0) {
        return messages;
    }
    // Build the set of message IDs that are compressed (have replacedByBlockId)
    // and the set of block IDs that need to be inserted.
    const compressedMessageIds = new Set();
    const blockIdsToInsert = new Set();
    for (const [msgId, entry] of compressionIndex) {
        if (entry.replacedByBlockId) {
            compressedMessageIds.add(msgId);
            blockIdsToInsert.add(entry.replacedByBlockId);
        }
    }
    // Build a map from anchorMessageId -> blockId for insertion ordering.
    // We only insert blocks that are still active (not consumed).
    const anchorToBlock = new Map();
    const coldBlockIds = new Set();
    for (const meta of blockRegistry.values()) {
        if ((meta.active ?? !meta.consumed) && !meta.consumed) {
            anchorToBlock.set(meta.anchorMessageId ?? meta.sourceMessageIds[0] ?? "", meta.blockId);
            if (tiersEnabled && (meta.projectionTier ?? "warm") === "cold")
                coldBlockIds.add(meta.blockId);
        }
    }
    const catalog = tiersEnabled
        ? buildColdCatalog(selectActiveRootBlocks(state), options.contextTiers, options.tokenizer, options.modelContextLimit ?? state.modelContextLimit)
        : { text: "", blockIds: [], overflow: 0 };
    const earliestColdAnchor = selectActiveRootBlocks(state)
        .find(block => coldBlockIds.has(block.blockId))?.anchorMessageId;
    let catalogInserted = false;
    // Track which blocks have been inserted (to avoid duplicates if the same
    // block appears as anchor for multiple messages).
    const insertedBlocks = new Set();
    const result = [];
    for (const msg of messages) {
        const existingSummaryPart = msg.parts.find(part => part.type === "summary-block");
        if (existingSummaryPart?.type === "summary-block") {
            const blockId = existingSummaryPart.blockId;
            if (blockId === "__ctx_cold_catalog")
                continue;
            const meta = blockRegistry.get(blockId);
            if (meta && (meta.active ?? !meta.consumed) && !meta.consumed) {
                if (coldBlockIds.has(blockId)) {
                    result.push({ ...msg, isIgnored: true });
                    continue;
                }
                if (!insertedBlocks.has(blockId)) {
                    result.push(buildSummaryMessage(blockId, meta.summaryText ?? existingSummaryPart.text, state.sessionId, msg.createdAt));
                    insertedBlocks.add(blockId);
                }
            }
            else {
                result.push({ ...msg, isIgnored: true });
            }
            continue;
        }
        if (!catalogInserted && msg.id === earliestColdAnchor) {
            if (catalog.text)
                result.push(buildSummaryMessage("__ctx_cold_catalog", catalog.text, state.sessionId, msg.createdAt));
            catalogInserted = true;
        }
        // Check if this message is the anchor for a summary block insertion.
        // Insert the summary block BEFORE the anchor message (which will be ignored).
        const blockId = anchorToBlock.get(msg.id);
        if (blockId && !insertedBlocks.has(blockId)) {
            const meta = blockRegistry.get(blockId);
            if (meta && !coldBlockIds.has(blockId)) {
                // Prefer the stored summaryText from the registry (available on re-feed
                // when the synthetic summary message is not in the input). Fall back to
                // searching the message list for the synthetic summary message (for
                // compatibility with callers that pass the already-compressed list).
                const text = meta.summaryText ?? getSummaryText(blockId, messages) ?? "";
                result.push(buildSummaryMessage(blockId, text, state.sessionId, msg.createdAt));
                insertedBlocks.add(blockId);
            }
        }
        // Check if this message is compressed (should be ignored)
        if (compressedMessageIds.has(msg.id)) {
            result.push({ ...msg, isIgnored: true });
            continue;
        }
        // Hard-cap drop: removed by the mechanical floor (last resort).
        if (hardCapDroppedIds.has(msg.id)) {
            result.push({ ...msg, isIgnored: true });
            continue;
        }
        // Apply tool-level decisions (dedup, stale-error, mask)
        const hasToolDecisions = msg.parts.some(p => {
            if (p.type !== "tool")
                return false;
            const tp = p;
            return (dedupDecisions.has(tp.callId) ||
                staleErrorDecisions.has(tp.callId) ||
                nearDupeDecisions.has(tp.callId) ||
                maskDecisions.has(tp.callId));
        });
        if (!hasToolDecisions) {
            result.push(msg);
            continue;
        }
        const newParts = msg.parts.map(p => {
            if (p.type !== "tool")
                return p;
            const tp = p;
            // Dedup: replace output
            if (dedupDecisions.has(tp.callId) && tp.status === "completed") {
                return { ...tp, output: PLACEHOLDER_DEDUP };
            }
            // Stale-error: replace input
            if (staleErrorDecisions.has(tp.callId) && tp.status === "error") {
                return { ...tp, input: PLACEHOLDER_STALE_ERROR_INPUT };
            }
            // Near-duplicate (SimHash): replace output
            if (nearDupeDecisions.has(tp.callId) && tp.status === "completed") {
                return { ...tp, output: PLACEHOLDER_NEAR_DUPE };
            }
            // Mask/offload: replace output with stored replacement text
            const maskText = maskDecisions.get(tp.callId);
            if (maskText !== undefined && tp.status === "completed") {
                return { ...tp, output: maskText };
            }
            return p;
        });
        result.push({ ...msg, parts: newParts });
    }
    // Host compaction may remove the original anchor while durable compression
    // metadata remains. Keep the active summary visible by appending any block
    // that could not be inserted at its original anchor.
    for (const meta of blockRegistry.values()) {
        if (!(meta.active ?? !meta.consumed) || meta.consumed || insertedBlocks.has(meta.blockId))
            continue;
        if (coldBlockIds.has(meta.blockId))
            continue;
        result.push(buildSummaryMessage(meta.blockId, meta.summaryText ?? "", state.sessionId, meta.createdAt ?? 0));
    }
    if (!catalogInserted && catalog.text) {
        result.push(buildSummaryMessage("__ctx_cold_catalog", catalog.text, state.sessionId, selectActiveRootBlocks(state).find(block => coldBlockIds.has(block.blockId))?.createdAt ?? 0));
    }
    return result;
}
function buildSummaryMessage(blockId, text, sessionId, createdAt) {
    const summaryPart = { type: "summary-block", blockId, text };
    return {
        id: `__summary_${blockId}`,
        ref: blockId,
        role: "assistant",
        sessionId,
        createdAt,
        isSummary: true,
        parts: [summaryPart],
    };
}
/**
 * Retrieve the summary text for a block by searching the message list.
 * Used as a fallback when the block registry does not have summaryText stored
 * (e.g. for blocks created before the summaryText field was added).
 */
function getSummaryText(blockId, messages) {
    // The synthetic summary message has id `__summary_${blockId}`
    const syntheticId = `__summary_${blockId}`;
    const summaryMsg = messages.find(m => m.id === syntheticId);
    if (summaryMsg) {
        const part = summaryMsg.parts.find(p => p.type === "summary-block");
        if (part?.type === "summary-block")
            return part.text;
    }
    // Also search by blockId in summary-block parts (in case the message was
    // already in the list from a previous applyCompress call)
    for (const msg of messages) {
        for (const part of msg.parts) {
            if (part.type === "summary-block" && part.blockId === blockId) {
                return part.text;
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=applyDecisions.js.map