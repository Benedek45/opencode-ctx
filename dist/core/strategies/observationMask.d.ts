import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
/** An offload write request (adapter must persist this). */
export interface OffloadRequest {
    callId: string;
    path: string;
    content: string;
    tokens: number;
}
/** Result of the observation mask pass. */
export interface ObservationMaskResult {
    messages: NeutralMessage[];
    maskedCount: number;
    offloadedCount: number;
    tokensSaved: number;
    /** Offload write requests that the adapter must persist. */
    offloadRequests: OffloadRequest[];
}
/**
 * Run the observation mask strategy.
 *
 * For each eligible tool call (completed, not protected, outside retention):
 * - If stateless + output large enough + profile prefers offload: offload to disk
 *   (explicit offload-file reads instead age into a plain mask, never another file)
 * - If stateless + small output: plain mask
 * - If stateful: stateful mask (condensed tail)
 *
 * Gated by the Cost-ROI check: a warm-cache prune that would invalidate a cheap
 * cached prefix for little savings is skipped (overridden by cold cache, the
 * quality trigger, R<=1, or costRoi.enabled=false).
 *
 * Monotonic: once masked/offloaded (tracked in state.messageIndex), stays that way.
 *
 * Pure: token measurement uses the injected `tokenizer`; the current time is
 * supplied as `nowMs` (no Date.now() in core).
 */
export declare function runObservationMask(messages: NeutralMessage[], currentTurn: number, config: CoreConfig, state: CoreState, workspaceDir: string, tokenizer?: Tokenizer, nowMs?: number, emit?: (event: TelemetryEvent) => void): ObservationMaskResult;
//# sourceMappingURL=observationMask.d.ts.map