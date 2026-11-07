import type { PipelineResult, PipelineInput } from "../types/adapter.js";
import type { TelemetryEvent } from "../types/telemetry.js";
import type { Tokenizer } from "../services/tokenizer.js";
import { type OffloadRequest } from "./strategies/observationMask.js";
/** Services required by the pipeline. */
export interface PipelineServices {
    tokenizer: Tokenizer;
    /** Workspace directory for offloaded files. */
    workspaceDir: string;
    /**
     * Optional telemetry sink. When provided, the pipeline emits typed events
     * for every pruning decision (dedup, stale-error, near-dupe, mask, offload)
     * as well as nudge injections and the end-of-turn pipeline-complete summary.
     * Adapters typically route this to their Logger at debug level.
     */
    telemetry?: (event: TelemetryEvent) => void;
}
/**
 * Run the full context management pipeline.
 *
 * This is a pure transform: it does not call the model, write files, or
 * perform any I/O. Offload write requests are returned for the adapter to handle.
 */
export declare function runPipeline(input: PipelineInput, services: PipelineServices): PipelineResult & {
    offloadRequests: OffloadRequest[];
};
//# sourceMappingURL=pipeline.d.ts.map