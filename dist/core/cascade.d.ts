import type { NeutralMessage } from "../types/neutral.js";
import type { CoreConfig } from "../types/config.js";
import type { CoreState } from "../types/state.js";
import type { TelemetryEvent } from "../types/telemetry.js";
import { type OffloadRequest } from "./strategies/observationMask.js";
import type { Tokenizer } from "../services/tokenizer.js";
/** Result of the cascade pass. */
export interface CascadeResult {
    messages: NeutralMessage[];
    tokensSaved: number;
    dedupCount: number;
    staleErrorCount: number;
    nearDupeCount: number;
    maskedCount: number;
    offloadedCount: number;
    offloadRequests: OffloadRequest[];
}
/**
 * Run the full cascade of mechanical strategies.
 *
 * Strategies run in order:
 *   a. Dedup (repeated completed tool calls)
 *   b. StaleError (purge errored inputs after N turns)
 *   c. ObservationMask (mask/offload old outputs, only if masking threshold exceeded)
 *
 * The observationMask pass is only run if the current token count exceeds
 * config.nudges.maskTriggerThreshold.
 */
export declare function runCascade(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, tokenizer: Tokenizer, workspaceDir: string, nowMs?: number, emit?: (event: TelemetryEvent) => void): CascadeResult;
//# sourceMappingURL=cascade.d.ts.map