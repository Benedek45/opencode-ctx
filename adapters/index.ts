// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Adapters barrel: re-exports all adapter public APIs.
//
// v1: opencode adapter is fully wired.
//     claude-code and bff adapters are typed stubs.

// opencode adapter (fully wired)
export * from "./opencode/index.js";

// claude-code adapter (typed stub)
export type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
} from "./claude-code/map.js";

// bff adapter (typed stub)
export type {
  BffMessageEntry,
  BffMessageInfo,
  BffPart,
  BffToolState,
  BffTokenUsage,
} from "./bff/map.js";
