import type { NeutralMessage } from "../types/neutral.js";
import type { CoreState } from "../types/state.js";
import type { ContextTierConfig } from "../types/config.js";
import type { Tokenizer } from "../services/tokenizer.js";
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
export declare function applyDecisions(messages: NeutralMessage[], state: CoreState, options?: {
    automaticPruning?: boolean;
    contextTiers?: ContextTierConfig;
    tokenizer?: Tokenizer;
    modelContextLimit?: number;
}): NeutralMessage[];
//# sourceMappingURL=applyDecisions.d.ts.map