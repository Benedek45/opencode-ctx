import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { CoreConfig } from "../../types/config.js";
import type { Tokenizer } from "../../services/tokenizer.js";
/** Result of applying a compress block. */
export interface ApplyCompressResult {
    /** The updated message list with the summary block inserted and source messages ignored. */
    messages: NeutralMessage[];
    /** The block ID assigned to this summary. */
    blockId: string;
    /** The anchor message ID (the first message in the compressed range). */
    anchorMessageId: string;
}
/**
 * Apply a compress result to the message list.
 *
 * Append-only mode (default, summarization.appendOnly=true):
 *   - Insert a new summary-block message at the position of the first compressed message.
 *   - Mark all compressed messages as isIgnored=true.
 *   - Earlier summary blocks are NOT modified (byte-stable).
 *
 * Full-restructure mode (appendOnly=false or fullRestructureTriggered):
 *   - Consolidate all existing summary blocks into the new one.
 *   - Mark all source messages as ignored.
 */
export declare function applyCompress(messages: NeutralMessage[], summaryText: string, sourceMessageIds: string[], state: CoreState, config: CoreConfig, nowMs: number, tokenizer?: Tokenizer): ApplyCompressResult;
//# sourceMappingURL=apply.d.ts.map