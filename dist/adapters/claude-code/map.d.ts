import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
export interface AnthropicTextBlock {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    };
}
export interface AnthropicThinkingBlock {
    type: "thinking";
    thinking: string;
    signature?: string;
}
export interface AnthropicToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
    cache_control?: {
        type: "ephemeral";
    };
}
export interface AnthropicToolResultBlock {
    type: "tool_result";
    tool_use_id: string;
    content: string | Array<{
        type: "text";
        text: string;
    }>;
    is_error?: boolean;
}
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;
export interface AnthropicMessage {
    id?: string;
    role: "user" | "assistant";
    content: AnthropicContentBlock[];
    /** Usage info (present on assistant messages from the API response). */
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}
/**
 * TODO(stub): Translate Anthropic Messages API messages to NeutralMessage[].
 *
 * @param messages - The messages array from the Anthropic API request.
 * @param sessionId - The session identifier.
 * @param nowMs - Current time in milliseconds.
 */
export declare function toNeutral(_messages: AnthropicMessage[], _sessionId: string, _nowMs: number): NeutralMessage[];
/**
 * TODO(stub): Apply NeutralMessage mutations back to the Anthropic messages array.
 *
 * @param originalMessages - The original Anthropic messages array.
 * @param neutralMessages - The mutated neutral messages from the core pipeline.
 */
export declare function applyNeutral(_originalMessages: AnthropicMessage[], _neutralMessages: NeutralMessage[]): AnthropicMessage[];
/**
 * TODO(stub): Build a CoreConfig for a Claude Code session.
 *
 * @param sessionId - The session identifier.
 * @param modelContextLimit - The model's context limit (e.g. 200_000 for claude-3-5-sonnet).
 */
export declare function loadConfig(sessionId: string, modelContextLimit?: number): CoreConfig;
/**
 * TODO(stub): Place cache_control breakpoints on the outgoing messages array.
 *
 * @param messages - The Anthropic messages array (after applyNeutral).
 * @param systemBlocks - The system prompt content blocks.
 * @param toolSchemaBlocks - The tool schema content blocks.
 * @param latestSummaryBlockId - The ID of the latest compressed summary block, if any.
 * @param breakpointLimit - Maximum number of breakpoints (Anthropic: 4).
 */
export declare function placeCacheBreakpoints(_messages: AnthropicMessage[], _systemBlocks: AnthropicContentBlock[], _toolSchemaBlocks: AnthropicContentBlock[], _latestSummaryBlockId: string | undefined, _breakpointLimit: number): void;
//# sourceMappingURL=map.d.ts.map