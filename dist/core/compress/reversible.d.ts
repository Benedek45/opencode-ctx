import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
/** Result of a decompress operation. */
export interface DecompressResult {
    /** Messages with the summary block removed and source messages restored. */
    messages: NeutralMessage[];
    /** The block ID that was decompressed. */
    blockId: string;
}
/**
 * Decompress a summary block: remove the summary message and restore
 * the source messages (un-ignore them).
 *
 * Note: The original source message content must still be present in the
 * message list (just marked isIgnored=true). If source messages have been
 * evicted from memory, decompress is not possible.
 *
 * Returns null if the block is not found or source messages are unavailable.
 */
export declare function decompressBlock(messages: NeutralMessage[], blockId: string, state: CoreState): DecompressResult | null;
/**
 * Recompress: decompress a block and return the source messages for re-summarization.
 * The caller is responsible for running the compress pipeline again on the returned messages.
 */
export declare function recompressBlock(messages: NeutralMessage[], blockId: string, state: CoreState): {
    messages: NeutralMessage[];
    sourceMessages: NeutralMessage[];
} | null;
export interface CompressionGraphResult {
    state: CoreState;
    blockId: string;
}
/** Purely deactivate a block, exposing eligible nested children. */
export declare function deactivateCompressionBlock(state: CoreState, blockId: string): CompressionGraphResult | null;
/** Purely activate a block and deactivate all blocks nested beneath it. */
export declare function activateCompressionBlock(state: CoreState, blockId: string): CompressionGraphResult | null;
/** Pure graph-only recompress preparation; durable source hydration stays adapter-side. */
export declare function recompressCompressionBlock(state: CoreState, blockId: string): (CompressionGraphResult & {
    effectiveMessageIds: string[];
    durableSourceRef?: string;
}) | null;
//# sourceMappingURL=reversible.d.ts.map