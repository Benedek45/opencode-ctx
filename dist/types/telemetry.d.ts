/** A single telemetry event emitted during a pipeline run. */
export type TelemetryEvent = {
    type: "mask";
    callId: string;
    tool: string;
    tokens: number;
    reason: string;
} | {
    type: "offload";
    callId: string;
    tool: string;
    tokens: number;
    path: string;
} | {
    type: "dedup";
    callId: string;
    tool: string;
    tokens: number;
} | {
    type: "stale-error";
    callId: string;
    tool: string;
    tokens: number;
} | {
    type: "near-dupe";
    callId: string;
    tool: string;
    tokens: number;
} | {
    type: "compress-inject";
    blockId: string;
} | {
    type: "nudge";
    level: "mid-soft" | "upper" | "safety-cap";
    tokens: number;
} | {
    type: "compress-request";
    messageCount: number;
}
/**
 * A dashboard projection edit was delivered to the model on this turn.
 * `rewrittenTokens` is the cached-prefix cost: tokens from the earliest edited
 * position to the end of the outgoing context, all of which are re-sent as a
 * cache write. `editedMessages` counts the overrides that changed this turn.
 */
 | {
    type: "projection-edit";
    editedMessages: number;
    rewrittenTokens: number;
} | {
    type: "pipeline-complete";
    inputTokens: number;
    outputTokens: number;
    savedTokens: number;
};
//# sourceMappingURL=telemetry.d.ts.map