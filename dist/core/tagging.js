// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Tagging stage: assign stable write-once IDs to messages, strip hallucinated tags.
/**
 * Regex to detect and strip ctx-message-id tags from message text.
 *
 * Matches a full `<ctx-message-id ...>...</ctx-message-id>` tag (with optional
 * attributes and any content inside) plus an optional single trailing newline.
 *
 * The trailing-newline capture is important for idempotency: the finalize stage
 * injects each tag as `<ctx-message-id>REF</ctx-message-id>\n` in front of a
 * message's text. Consuming that newline here means re-running tagging on an
 * already-tagged message restores the original text byte-for-byte instead of
 * leaving an accumulating run of blank lines.
 *
 * Any `<prefix-message-id>` tag pair is stripped, not only the current prefix:
 * host history persists model text verbatim, so ref tags written under an
 * earlier prefix would otherwise resurface as stale, misleading refs.
 */
const TAG_STRIP_RE = /<([a-z][a-z0-9]*)-message-id\b[^>]*>[\s\S]*?<\/\1-message-id>\n?/gi;
/**
 * Strip ctx-message-id tags from a text string.
 *
 * Used in two places:
 *  - inbound message text (remove the prior turn's injected refs + any the model
 *    may have hallucinated) before the finalize stage re-injects fresh ones;
 *  - model output text (`experimental.text.complete`) to remove hallucinated tags.
 */
export function stripHallucinatedTags(text) {
    return text.replace(TAG_STRIP_RE, "");
}
/**
 * Format a message ref from a sequential number.
 * e.g. 1 -> "m0001", 42 -> "m0042"
 */
export function formatRef(n) {
    return `m${String(n).padStart(4, "0")}`;
}
/**
 * Assign stable refs to messages that don't have one yet.
 * Idempotent: messages that already have a ref are not re-assigned.
 * Also strips ctx-message-id tags from text parts (so the prior turn's injected
 * refs are removed before finalize re-injects them).
 *
 * Mutates state.messageIds in place.
 * Returns the updated messages (new array, messages may be new objects if modified).
 */
export function runTagging(messages, state) {
    return messages.map(msg => {
        // Check if already tagged
        if (state.messageIds.byRawId.has(msg.id)) {
            // Sync the ref onto the in-memory message and strip stale tags (idempotency)
            const ref = state.messageIds.byRawId.get(msg.id);
            const synced = ref && msg.ref !== ref ? { ...msg, ref } : msg;
            return stripMessageTags(synced);
        }
        // Assign a new ref
        const ref = formatRef(state.messageIds.nextRef);
        state.messageIds.nextRef++;
        state.messageIds.byRawId.set(msg.id, ref);
        state.messageIds.byRef.set(ref, msg.id);
        const tagged = { ...msg, ref };
        return stripMessageTags(tagged);
    });
}
/** Strip ctx-message-id tags from all text/reasoning parts of a message. */
function stripMessageTags(msg) {
    let modified = false;
    const newParts = msg.parts.map(part => {
        if (part.type === "text" || part.type === "reasoning") {
            const stripped = stripHallucinatedTags(part.text);
            if (stripped !== part.text) {
                modified = true;
                return { ...part, text: stripped };
            }
        }
        return part;
    });
    if (!modified)
        return msg;
    return { ...msg, parts: newParts };
}
//# sourceMappingURL=tagging.js.map