import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
/** Result of the near-dupe pass. */
export interface NearDupeResult {
    messages: NeutralMessage[];
    nearDupeCount: number;
    /** Decisions first created by this pass, excluding byte-stable reapplication. */
    newDecisionCount: number;
    tokensSaved: number;
}
/** Compute a 64-bit Charikar SimHash fingerprint for a text. */
export declare function simhash64(text: string): bigint;
/** Hamming distance between two 64-bit fingerprints. */
export declare function hammingDistance64(a: bigint, b: bigint): number;
/**
 * Estimate near-dupe savings without mutating state (for the Cost-ROI P2
 * candidate-savings check in cascade.ts — see estimateDedupStaleSavings).
 * Only counts callIds not already decided (new savings this pass).
 */
export declare function estimateNearDupeSavings(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, hammingThreshold?: number): number;
/**
 * Run the near-duplicate dedup strategy.
 *
 * Writes NEW decisions to `state.nearDupeDecisions`. Only counts savings for
 * newly decided callIds (not ones already in the decision set) — mirrors
 * runDedup's decide/apply split semantics exactly.
 */
export declare function runNearDupe(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, hammingThreshold?: number, emit?: (event: TelemetryEvent) => void): NearDupeResult;
//# sourceMappingURL=nearDupe.d.ts.map