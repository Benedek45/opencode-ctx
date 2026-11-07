import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
/** Result of the stale-error pass. */
export interface StaleErrorResult {
    messages: NeutralMessage[];
    purgedCount: number;
    /** Decisions first created by this pass, excluding byte-stable reapplication. */
    newDecisionCount: number;
    tokensSaved: number;
}
/**
 * Run the stale-error strategy.
 *
 * For each tool call with status "error", if it is older than
 * DEFAULT_STALE_ERROR_TURNS turns, replace its INPUT with the stale-error
 * placeholder. The error message (output) is KEPT so the model knows what failed.
 *
 * Always-protected tools are skipped.
 *
 * Writes NEW decisions to `state.staleErrorDecisions`. Only counts savings for
 * newly decided callIds (not ones already in the decision set).
 */
export declare function runStaleError(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, emit?: (event: TelemetryEvent) => void): StaleErrorResult;
//# sourceMappingURL=staleError.d.ts.map