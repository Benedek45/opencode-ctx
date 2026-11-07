import type { CoreConfig } from "../../types/config.js";
import type { NeutralMessage } from "../../types/neutral.js";
import type { CompressionMode, CoreState, MessageCompressionEntry } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
export interface CompressionRequest {
    mode: CompressionMode;
    topic: string;
    /** Optional source label retained for tool/UI display. */
    content?: string;
    summary: string;
    batchTopic?: string;
    startRef?: string;
    endRef?: string;
    messageRef?: string;
    durableSourceRef?: string;
    durableSummaryRef?: string;
}
export interface CompressionPlan {
    request: CompressionRequest;
    directMessageIds: string[];
    effectiveMessageIds: string[];
    directToolCallIds: string[];
    effectiveToolCallIds: string[];
    consumedBlockIds: string[];
    anchorMessageId: string;
    startRef: string;
    endRef: string;
    protectedContent: string[];
    finalSummary: string;
    sourceTokens: number;
    summaryTokens: number;
    netTokens: number;
}
export interface CompressionValidationError {
    index: number;
    code: "missing-field" | "empty-field" | "missing-target" | "reversed-range" | "empty-range" | "recent-range" | "overlap" | "invalid-block-reference" | "insufficient-savings";
    message: string;
}
export type CompressionBatchPlanResult = {
    ok: true;
    plans: CompressionPlan[];
} | {
    ok: false;
    errors: CompressionValidationError[];
};
export interface PlanCompressionBatchInput {
    messages: NeutralMessage[];
    requests: CompressionRequest[];
    state: CoreState;
    config: CoreConfig;
    tokenizer: Tokenizer;
}
export interface ApplyCompressionBatchInput extends PlanCompressionBatchInput {
    nowMs: number;
}
export type ApplyCompressionBatchResult = {
    ok: true;
    messages: NeutralMessage[];
    state: CoreState;
    plans: CompressionPlan[];
    blockIds: string[];
} | {
    ok: false;
    errors: CompressionValidationError[];
};
/** Append mechanically protected source content to a model supplied summary. */
export declare function appendProtectedContent(messages: NeutralMessage[], summary: string, config: CoreConfig): string;
export declare function preserveIncludedBlockSummaries(summary: string, blockIds: string[], state: CoreState): {
    summary: string;
    invalidBlockIds: string[];
};
/** Count real model requests strictly after each message over the complete input. */
export declare function compressionRequestAges(messages: readonly NeutralMessage[]): Map<string, number>;
export declare function isRecent(messages: readonly NeutralMessage[], guard: number, ages: ReadonlyMap<string, number>): boolean;
/** Rebuild the dedicated compression index from durable active graph metadata. */
export declare function buildCompressionIndex(state: CoreState): Map<string, MessageCompressionEntry>;
/** Validate and resolve every request before any state mutation. */
export declare function planCompressionBatch(input: PlanCompressionBatchInput): CompressionBatchPlanResult;
/** Apply an already validated batch to a cloned state and cloned message array. */
export declare function applyCompressionBatch(input: ApplyCompressionBatchInput): ApplyCompressionBatchResult;
//# sourceMappingURL=transaction.d.ts.map