// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Claude Code adapter — TYPED STUB (v1).
//
// This adapter is not live-bound in v1. It documents the mapping from the
// Anthropic Messages API content-block format to the NeutralMessage model,
// and provides typed skeletons for future implementation.
//
// See README.md for the full mapping documentation including cache breakpoints.

import type { NeutralMessage, NeutralPart, TokenUsage, ToolStatus } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import { buildDefaultConfig } from "../../core/defaults.js";
import { CACHE_MODEL_ANTHROPIC } from "../../core/defaults.js";

// ── Anthropic Messages API types (minimal, for stub typing) ──────────────────
// These mirror the Anthropic Messages API content block shapes.
// In a live implementation, import from @anthropic-ai/sdk instead.

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
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
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

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

// ── Mapping: Anthropic Messages → NeutralMessage ─────────────────────────────
//
// Key mapping decisions:
//
// 1. Message ID: Anthropic messages don't have stable IDs in the request array.
//    The adapter must assign synthetic IDs (e.g. "msg-0", "msg-1") based on position,
//    or use a stable hash of the content. The core's tagging stage will assign refs.
//
// 2. Role mapping:
//    - "user" -> "user"
//    - "assistant" -> "assistant"
//    Tool result blocks appear in "user" messages (Anthropic's tool_result format).
//
// 3. Content block -> NeutralPart:
//    - text block -> TextPart
//    - thinking block -> ReasoningPart
//    - tool_use block -> ToolPart (status: "completed" if paired with tool_result)
//    - tool_result block -> merged into the corresponding ToolPart's output field
//
// 4. step-start synthesis: Anthropic has no step-start concept. The adapter
//    synthesizes a StepStartPart at the beginning of each assistant message.
//
// 5. Token usage: read from the API response's usage field on the last assistant message.
//    Maps: input_tokens -> input, output_tokens -> output,
//    cache_read_input_tokens -> cacheRead, cache_creation_input_tokens -> cacheWrite.
//
// 6. Pairing tool_use / tool_result: Anthropic sends tool_use in assistant messages
//    and tool_result in the following user message. The adapter must pair them by
//    tool_use_id to build a single ToolPart with both input and output.

/**
 * TODO(stub): Translate Anthropic Messages API messages to NeutralMessage[].
 *
 * @param messages - The messages array from the Anthropic API request.
 * @param sessionId - The session identifier.
 * @param nowMs - Current time in milliseconds.
 */
export function toNeutral(
  _messages: AnthropicMessage[],
  _sessionId: string,
  _nowMs: number
): NeutralMessage[] {
  // TODO(stub): implement full translation
  // Key steps:
  // 1. Pair tool_use blocks (in assistant messages) with tool_result blocks (in user messages)
  // 2. Synthesize step-start parts at the beginning of each assistant message
  // 3. Map content blocks to NeutralPart[]
  // 4. Assign synthetic IDs based on position
  // 5. Extract token usage from the last assistant message's usage field
  throw new Error("claude-code adapter: toNeutral not implemented (stub)");
}

/**
 * TODO(stub): Apply NeutralMessage mutations back to the Anthropic messages array.
 *
 * @param originalMessages - The original Anthropic messages array.
 * @param neutralMessages - The mutated neutral messages from the core pipeline.
 */
export function applyNeutral(
  _originalMessages: AnthropicMessage[],
  _neutralMessages: NeutralMessage[]
): AnthropicMessage[] {
  // TODO(stub): implement mutation application
  // Key steps:
  // 1. For each neutral message, find the corresponding original message by synthetic ID
  // 2. Apply tool output replacements (mask/offload) to tool_result blocks
  // 3. Apply input replacements (stale-error) to tool_use blocks
  // 4. Inject nudge text into the last user message's text block
  // 5. Inject summary-block messages as synthetic user messages
  // 6. Place cache_control breakpoints (see README.md §Cache Breakpoints)
  throw new Error("claude-code adapter: applyNeutral not implemented (stub)");
}

/**
 * TODO(stub): Build a CoreConfig for a Claude Code session.
 *
 * @param sessionId - The session identifier.
 * @param modelContextLimit - The model's context limit (e.g. 200_000 for claude-3-5-sonnet).
 */
export function loadConfig(
  sessionId: string,
  modelContextLimit = 200_000
): CoreConfig {
  // TODO(stub): read from Claude Code harness config
  const config = buildDefaultConfig(sessionId);
  return {
    ...config,
    modelContextLimit,
    cacheModel: CACHE_MODEL_ANTHROPIC,
  };
}

// ── Cache breakpoint placement (Anthropic explicit-paid) ─────────────────────
//
// See README.md for full documentation. Summary:
//
// For Anthropic providers (controlModel = "explicit-paid"), the adapter MUST
// place cache_control: { type: "ephemeral" } at exactly two stable positions:
//
// 1. End of the system-prompt / tool-schema block (most stable content).
// 2. End of the latest compressed summary block (stable/volatile boundary).
//
// Respect breakpointLimit = 4 (Anthropic's maximum).
// Order: tools -> system -> messages (Anthropic's required ordering).
//
// The opencode v1 adapter targets DeepSeek (automatic-free) and does NOT place
// breakpoints. This logic is for the future Claude Code adapter.

/**
 * TODO(stub): Place cache_control breakpoints on the outgoing messages array.
 *
 * @param messages - The Anthropic messages array (after applyNeutral).
 * @param systemBlocks - The system prompt content blocks.
 * @param toolSchemaBlocks - The tool schema content blocks.
 * @param latestSummaryBlockId - The ID of the latest compressed summary block, if any.
 * @param breakpointLimit - Maximum number of breakpoints (Anthropic: 4).
 */
export function placeCacheBreakpoints(
  _messages: AnthropicMessage[],
  _systemBlocks: AnthropicContentBlock[],
  _toolSchemaBlocks: AnthropicContentBlock[],
  _latestSummaryBlockId: string | undefined,
  _breakpointLimit: number
): void {
  // TODO(stub): implement breakpoint placement
  // Key steps:
  // 1. Place cache_control on the last block of the tool-schema section
  // 2. Place cache_control on the last block of the system-prompt section
  // 3. If a summary block exists, place cache_control on its last content block
  // 4. Respect breakpointLimit (max 4 for Anthropic)
  // 5. Follow tools -> system -> messages ordering
  throw new Error("claude-code adapter: placeCacheBreakpoints not implemented (stub)");
}

// ── Helper: extract tool status from Anthropic pairing ───────────────────────

function _toolStatusFromPairing(
  toolUseId: string,
  userMessages: AnthropicMessage[]
): { status: ToolStatus; output?: string } {
  // Find the tool_result block in subsequent user messages
  for (const msg of userMessages) {
    for (const block of msg.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
        const output = typeof block.content === "string"
          ? block.content
          : block.content.map(b => b.text).join("\n");
        return {
          status: block.is_error ? "error" : "completed",
          output,
        };
      }
    }
  }
  // No result found — tool is still pending
  return { status: "pending" };
}

// ── Helper: extract token usage from Anthropic response ──────────────────────

function _extractTokenUsage(message: AnthropicMessage): TokenUsage | undefined {
  if (!message.usage) return undefined;
  return {
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
    reasoning: 0, // Anthropic doesn't separate reasoning tokens in the usage field
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
    cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
  };
}
