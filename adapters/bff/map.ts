// PolyForm Noncommercial License 1.0.0 — see LICENSE
// BFF (backend-for-frontend proxy) adapter — TYPED STUB (v1).
//
// This adapter is not live-bound in v1. It documents the mapping from the
// message DTOs a BFF relays from the opencode REST API to the NeutralMessage
// model, and provides typed skeletons for future implementation.
//
// See README.md for the full wiring documentation.

import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import { buildDefaultConfig } from "../../core/defaults.js";
import { CACHE_MODEL_DEEPSEEK } from "../../core/defaults.js";

// ── BFF message DTO types (minimal, for stub typing) ─────────────────────────
// These mirror the opencode REST message shapes. In a live implementation,
// import the BFF's own DTO types instead.

export interface BffTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface BffMessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  summary?: boolean;
  tokens?: BffTokenUsage;
}

export interface BffToolState {
  status: "pending" | "running" | "completed" | "error";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface BffPart {
  id: string;
  type: "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "compaction" | string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: BffToolState;
  ignored?: boolean;
}

export interface BffMessageEntry {
  info: BffMessageInfo;
  parts: BffPart[];
}

// ── Mapping: BFF DTOs → NeutralMessage ───────────────────────────────────────
//
// A BFF typically mediates the opencode REST stream: it parses /event SSE frames and assembles message history via GET /session/:id/message.
// Those DTOs are structurally identical to the opencode SDK types (same source).
//
// Key mapping decisions:
//
// 1. The message DTOs are the same shape as the opencode plugin's {info, parts}[].
//    The translation is therefore nearly identical to the opencode adapter's map.ts.
//
// 2. The BFF adapter wires into the BFF's chat-stream route (request assembly, before relaying
//    to opencode prompt_async) rather than the in-process plugin hook.
//
// 3. If the BFF injects per-turn system context, context-manager system text is added there
//    (see README.md).
//
// 4. The BFF parses /event frames. Compress part events are fed to onEvent
//    by filtering message.part.updated events where part.tool === "compress".

/**
 * TODO(stub): Translate BFF message DTOs to NeutralMessage[].
 *
 * @param entries - The BFF message entries from GET /session/:id/message.
 * @param sessionId - The session identifier.
 */
export function toNeutral(
  _entries: BffMessageEntry[],
  _sessionId: string
): NeutralMessage[] {
  // TODO(stub): implement full translation
  // The translation is structurally identical to the opencode adapter's toNeutral.
  // Key steps:
  // 1. Map info.id -> NeutralMessage.id
  // 2. Map info.role -> NeutralMessage.role
  // 3. Map info.time.created -> NeutralMessage.createdAt
  // 4. Map info.summary === true -> NeutralMessage.isSummary
  // 5. Map parts[].type "text"/"reasoning"/"step-start"/"tool" -> NeutralPart[]
  // 6. Map info.tokens.cache.{read,write} -> TokenUsage.cacheRead/cacheWrite
  throw new Error("bff adapter: toNeutral not implemented (stub)");
}

/**
 * TODO(stub): Apply NeutralMessage mutations back to the BFF message DTOs.
 *
 * @param originalEntries - The original BFF message entries.
 * @param neutralMessages - The mutated neutral messages from the core pipeline.
 */
export function applyNeutral(
  _originalEntries: BffMessageEntry[],
  _neutralMessages: NeutralMessage[]
): BffMessageEntry[] {
  // TODO(stub): implement mutation application
  // The application is structurally identical to the opencode adapter's applyNeutral.
  // Key steps:
  // 1. For each neutral message, find the corresponding original entry by id
  // 2. Apply tool output replacements to parts[].state.output
  // 3. Apply input replacements to parts[].state.input
  // 4. Inject nudge text into the last text part
  // 5. Inject summary-block messages as synthetic user entries
  throw new Error("bff adapter: applyNeutral not implemented (stub)");
}

/**
 * TODO(stub): Build a CoreConfig for a BFF session.
 *
 * @param sessionId - The opencode session ID.
 * @param modelContextLimit - The model's context limit (from GET /provider).
 * @param providerID - The provider ID (e.g. "opencode-go").
 * @param modelID - The model ID (e.g. "deepseek-v4-flash").
 */
export function loadConfig(
  sessionId: string,
  modelContextLimit = 1_000_000,
  _providerID = "opencode-go",
  _modelID = "deepseek-v4-flash"
): CoreConfig {
  // TODO(stub): read from BFF config / environment
  const config = buildDefaultConfig(sessionId);
  return {
    ...config,
    modelContextLimit,
    cacheModel: CACHE_MODEL_DEEPSEEK,
  };
}
