import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { CoreConfig } from "../../types/config.js";
/** Input for a compress execution. */
export interface CompressExecuteInput {
    /** All current messages. */
    messages: NeutralMessage[];
    /** IDs of messages to compress (the range). */
    sourceMessageIds: string[];
    /** The summary text produced by the model. */
    summaryText: string;
    /** Optional topic label. */
    topic?: string;
    state: CoreState;
    config: CoreConfig;
    nowMs: number;
}
/** Output of a compress execution. */
export interface CompressExecuteOutput {
    messages: NeutralMessage[];
    blockId: string;
    anchorMessageId: string;
}
/**
 * Execute a compress operation: apply the summary to the message list.
 *
 * This is the pure transform — it does not call the model.
 * The adapter is responsible for:
 *   1. Calling the model with buildCompressPrompt() to get summaryText.
 *   2. Calling this function with the result.
 *   3. Persisting the updated state.
 */
export declare function executeCompress(input: CompressExecuteInput): CompressExecuteOutput;
/**
 * Determine the stable/volatile boundary for append-only compress.
 *
 * The "stable" prefix contains messages at least compressionRecencyRequests real
 * model requests old. Synthetic summaries do not advance this request clock.
 *
 * Returns the index of the first volatile message (everything before is stable).
 */
export declare function findStableVolatileBoundary(messages: NeutralMessage[], compressionRecencyRequests: number): number;
/**
 * Select the source message IDs for a compress run.
 * In append-only mode, selects messages from the last summary block (or start)
 * up to the stable/volatile boundary.
 */
export declare function selectCompressRange(messages: NeutralMessage[], state: CoreState, compressionRecencyRequests: number): string[];
//# sourceMappingURL=execute.d.ts.map