// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Adapter boundary types: what adapters must provide to the core.

import type { NeutralMessage } from "./neutral.js";
import type { CoreConfig } from "./config.js";
import type { CoreState } from "./state.js";
import type { TelemetryEvent } from "./telemetry.js";

/** A single proactive compress request emitted by the pipeline. */
export interface CompressRequest {
  /** The message IDs the adapter should summarise. */
  messageIds: string[];
  /** Optional topic hint for the summarizer. */
  topic?: string;
  startRef?: string;
  endRef?: string;
  sourceTokens?: number;
}

/** Result of running the pipeline on a set of messages. */
export interface PipelineResult {
  /** The transformed messages to send to the model. */
  messages: NeutralMessage[];
  /** Updated state after the pipeline run. */
  state: CoreState;
  /** Urgency nudge delivered through the adapter's safe messages channel. */
  nudgeText?: string;
  /** Whether a compress tool call should be injected. */
  shouldInjectCompress: boolean;
  /** Estimated token count of the output messages. */
  estimatedTokens: number;
  /** Compact per-request context accounting shown to the model. */
  contextStatusText: string;
  /** Structured form of the same accounting for adapters and tests. */
  contextMetrics: {
    modelKey?: string;
    currentTokens: number;
    previousTokens?: number;
    addedTokens?: number;
    targetTokens: number;
    tokensToRemove: number;
  };
  /** Tokens saved by the mechanical cascade on THIS run (dedup + stale-error + mask/offload). */
  savedThisRun: number;
  /** Cumulative tokens saved across the whole session (state.stats.totalTokensSaved). */
  cumulativeSaved: number;
  /**
   * Proactive compress requests: message ID ranges that need summarization.
   * Emitted when sustained nudge non-compliance triggers the escalation path.
   * The adapter should call Summarizer.summarize() for each and feed the
   * result back next turn via executeCompress + applyCompress. Adapters
   * without model access (opencode v1) store these as pending and use
   * mechanical masking as the fallback in the meantime.
   */
  compressRequests: CompressRequest[];
  /** Validator-compatible, advisory candidates for nudges/tools/worker scheduling. */
  compressionCandidates?: import("../core/compress/eligibility.js").CompressionCandidateReport;
  /**
   * Set when this projection carries dashboard edits that have not yet been
   * acknowledged. The adapter must call `markProjectionRewriteApplied` and
   * `recordCacheBust` ONLY after the host has actually received these messages,
   * so an aborted turn re-delivers the edit instead of losing it.
   */
  projectionEdit?: { editedMessages: number; rewrittenTokens: number };
  /** Telemetry events emitted during this pipeline run. */
  telemetryEvents: TelemetryEvent[];
}

/** Input to the pipeline. */
export interface PipelineInput {
  messages: NeutralMessage[];
  state: CoreState;
  config: CoreConfig;
  /** Current wall-clock time in ms (from Clock service). */
  nowMs: number;
  /** OpenCode-only safe message-channel delivery; other adapters inject themselves. */
  injectContextStatus?: boolean;
}
