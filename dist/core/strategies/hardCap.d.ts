import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import { type OffloadRequest } from "./observationMask.js";
/** Result of the hard-cap pass. */
export interface HardCapResult {
    messages: NeutralMessage[];
    /** Tokens reclaimed by this pass (Phase 1 mask/offload + Phase 2 drops). */
    tokensSaved: number;
    /** Number of whole messages dropped in Phase 2. */
    droppedCount: number;
    /** Offload write requests (from Phase 1) the adapter must persist. */
    offloadRequests: OffloadRequest[];
    /** Whether the hard cap actually did anything. */
    fired: boolean;
    /** Total projected tokens including the measured system prompt. */
    remainingTokens: number;
    /** False when protected/recent content alone cannot fit below the cap. */
    underCap: boolean;
}
/**
 * Force context under config.hardCap. No-op unless the estimated context exceeds
 * the cap, so on roomy windows (the common case) this never touches anything.
 */
export declare function runHardCap(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, workspaceDir: string, tokenizer?: Tokenizer, nowMs?: number): HardCapResult;
//# sourceMappingURL=hardCap.d.ts.map