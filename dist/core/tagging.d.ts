import type { NeutralMessage } from "../types/neutral.js";
import type { CoreState } from "../types/state.js";
/**
 * Strip ctx-message-id tags from a text string.
 *
 * Used in two places:
 *  - inbound message text (remove the prior turn's injected refs + any the model
 *    may have hallucinated) before the finalize stage re-injects fresh ones;
 *  - model output text (`experimental.text.complete`) to remove hallucinated tags.
 */
export declare function stripHallucinatedTags(text: string): string;
/**
 * Format a message ref from a sequential number.
 * e.g. 1 -> "m0001", 42 -> "m0042"
 */
export declare function formatRef(n: number): string;
/**
 * Assign stable refs to messages that don't have one yet.
 * Idempotent: messages that already have a ref are not re-assigned.
 * Also strips ctx-message-id tags from text parts (so the prior turn's injected
 * refs are removed before finalize re-injects them).
 *
 * Mutates state.messageIds in place.
 * Returns the updated messages (new array, messages may be new objects if modified).
 */
export declare function runTagging(messages: NeutralMessage[], state: CoreState): NeutralMessage[];
//# sourceMappingURL=tagging.d.ts.map