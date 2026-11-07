/** Token usage breakdown for a single message or turn. */
export interface TokenUsage {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
}
/** Role of a message in the conversation. */
export type MessageRole = "user" | "assistant" | "system" | "tool";
/** Status of a tool call. */
export type ToolStatus = "pending" | "running" | "completed" | "error";
export interface TextPart {
    type: "text";
    text: string;
}
export interface ReasoningPart {
    type: "reasoning";
    text: string;
}
export interface StepStartPart {
    type: "step-start";
    label?: string;
}
export interface ToolPart {
    type: "tool";
    callId: string;
    tool: string;
    status: ToolStatus;
    input: unknown;
    output?: string;
    /** Absolute path to offloaded output on disk (set by observationMask). */
    sourcePath?: string;
    /** The conversation turn number when this tool call was made. */
    turn?: number;
}
export interface SummaryBlockPart {
    type: "summary-block";
    /** Stable block identifier, e.g. "b1", "b2". */
    blockId: string;
    text: string;
}
export type NeutralPart = TextPart | ReasoningPart | StepStartPart | ToolPart | SummaryBlockPart;
/**
 * A single message in the neutral conversation model.
 * The `id` is the stable raw ID (e.g. "m0001"); `ref` is the short ref
 * assigned by the tagging stage (e.g. "m0001" or a block ref "b1").
 */
export interface NeutralMessage {
    /** Stable raw message ID, e.g. "m0001". */
    id: string;
    /** Short ref assigned by tagging (may differ from id for summary blocks). */
    ref?: string;
    role: MessageRole;
    sessionId: string;
    createdAt: number;
    /** True if this message is a compression summary block. */
    isSummary?: boolean;
    /** True if this message has been logically removed from the context window. */
    isIgnored?: boolean;
    /** True for a dashboard-authored replacement that has no raw host message. */
    isManualReplacement?: boolean;
    parts: NeutralPart[];
    tokens?: TokenUsage;
}
//# sourceMappingURL=neutral.d.ts.map