import type { NeutralMessage } from "../types/neutral.js";
/**
 * Finalize the message list:
 * - Remove messages marked isIgnored=true from the output.
 * - Ensure the list is in chronological order (by createdAt).
 * - Inject a visible `<ctx-message-id>REF</ctx-message-id>` tag into each message
 *   so the model can address ranges by ref when calling the `compress` tool.
 *
 * Tag injection is the counterpart to the strip in the tagging stage: tagging
 * removes the prior turn's tags (and any hallucinated ones), finalize re-injects
 * the authoritative ref. This keeps the operation idempotent across turns.
 */
export declare function runFinalize(messages: NeutralMessage[]): NeutralMessage[];
//# sourceMappingURL=finalize.d.ts.map