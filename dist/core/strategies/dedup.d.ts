import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
/** Result of the dedup pass. */
export interface DedupResult {
    messages: NeutralMessage[];
    dedupCount: number;
    /** Decisions first created by this pass, excluding byte-stable reapplication. */
    newDecisionCount: number;
    tokensSaved: number;
}
/**
 * Run the dedup strategy on a list of messages.
 *
 * For each completed tool call, if an identical call (same tool + input)
 * has already been seen earlier in the conversation, replace the output
 * of the earlier occurrence with the dedup placeholder.
 *
 * The MOST RECENT occurrence is kept; earlier duplicates are deduplicated.
 * Always-protected tools and tools within their retention window are skipped.
 *
 * Writes NEW decisions to `state.dedupDecisions`. Only counts savings for
 * newly decided callIds (not ones already in the decision set).
 */
export declare function runDedup(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, emit?: (event: TelemetryEvent) => void): DedupResult;
//# sourceMappingURL=dedup.d.ts.map