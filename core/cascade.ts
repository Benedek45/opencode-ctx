// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Cascade: ordered mechanical strategies applied before model-driven compress.
// Order: a. dedup → b. staleError → c. observationMask.
// Cache-consciousness: dedup + staleError rewrite OLDER positions (warm-cache
// busters), so they are gated on `cachePruneAllowed` (compress just happened /
// configured TTL-cold window / definite cold or missed cache / no cache benefit /
// critically full / gate off / cost-ROI formula positive for candidate savings).
// observationMask has its own cost-ROI gate.

import type { NeutralMessage, ToolPart } from "../types/neutral.js";
import type { CoreConfig } from "../types/config.js";
import type { CoreState } from "../types/state.js";
import type { TelemetryEvent } from "../types/telemetry.js";
import { runDedup } from "./strategies/dedup.js";
import { runStaleError } from "./strategies/staleError.js";
import { runNearDupe, estimateNearDupeSavings } from "./strategies/nearDupe.js";
import { runObservationMask, type OffloadRequest } from "./strategies/observationMask.js";
import { shouldTriggerMasking } from "./budget.js";
import { cachePruneAllowed, recordCacheBust } from "./budget/costRoi.js";
import { estimateContextTokens } from "./tokens.js";
import { isAlwaysProtected, isWithinTieredRetention } from "./strategies/guards.js";
import { PLACEHOLDER_DEDUP } from "./placeholders.js";
import type { Tokenizer } from "../services/tokenizer.js";

/** Result of the cascade pass. */
export interface CascadeResult {
  messages: NeutralMessage[];
  tokensSaved: number;
  dedupCount: number;
  staleErrorCount: number;
  nearDupeCount: number;
  maskedCount: number;
  offloadedCount: number;
  offloadRequests: OffloadRequest[];
}

/**
 * Run the full cascade of mechanical strategies.
 *
 * Strategies run in order:
 *   a. Dedup (repeated completed tool calls)
 *   b. StaleError (purge errored inputs after N turns)
 *   c. ObservationMask (mask/offload old outputs, only if masking threshold exceeded)
 *
 * The observationMask pass is only run if the current token count exceeds
 * config.nudges.maskTriggerThreshold.
 */
export function runCascade(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  tokenizer: Tokenizer,
  workspaceDir: string,
  nowMs = 0,
  emit?: (event: TelemetryEvent) => void
): CascadeResult {
  // Existing decisions are already reflected in the visible projection. They
  // still count toward the live budget, but are not new pruning candidates (or
  // valid "last occurrences" for dedup). Mark only their tool parts ineligible
  // for this recompute; restore the exact projected parts before returning.
  const decided = new Map<string, ToolPart>();
  let current = messages.map(message => {
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== "tool" || !(
        state.dedupDecisions.has(part.callId) || state.staleErrorDecisions.has(part.callId)
        || state.nearDupeDecisions.has(part.callId) || state.maskDecisions.has(part.callId)
      )) return part;
      decided.set(part.callId, part);
      changed = true;
      return { ...part, status: "running" as const };
    });
    return changed ? { ...message, parts } : message;
  });
  let totalSaved = 0;
  let dedupCount = 0;
  let staleErrorCount = 0;
  let nearDupeCount = 0;
  let newPrefixDecisions = 0;

  // a + b + c. Dedup, stale-error, and near-dupe all rewrite OLDER positions,
  // busting a warm prompt cache. Run them after a model-driven compress (already
  // a prefix rewrite), once the configured idle TTL says the next request is
  // expected to be a full cache write, on definite cold/missed-cache signals,
  // when cache economics/quality says the rewrite is unavoidable, OR when the
  // cost-ROI formula is positive for the candidate savings (P2: large duplicates
  // — exact or near — are worth busting even on warm cache).
  const preTokens = estimateContextTokens(current, tokenizer);
  const candidateSavings =
    estimateDedupStaleSavings(current, currentTurn, config, state) +
    (config.nearDupe.enabled ? estimateNearDupeSavings(current, currentTurn, config, state) : 0);
  if (cachePruneAllowed(config, state, nowMs, preTokens, candidateSavings)) {
    const dedupResult = runDedup(current, currentTurn, config, state, emit);
    current = dedupResult.messages;
    totalSaved += dedupResult.tokensSaved;
    dedupCount = dedupResult.dedupCount;
    newPrefixDecisions += dedupResult.newDecisionCount;

    const staleResult = runStaleError(current, currentTurn, config, state, emit);
    current = staleResult.messages;
    totalSaved += staleResult.tokensSaved;
    staleErrorCount = staleResult.purgedCount;
    newPrefixDecisions += staleResult.newDecisionCount;

    if (config.nearDupe.enabled) {
      const nearDupeResult = runNearDupe(current, currentTurn, config, state, undefined, emit);
      current = nearDupeResult.messages;
      totalSaved += nearDupeResult.tokensSaved;
      nearDupeCount = nearDupeResult.nearDupeCount;
      newPrefixDecisions += nearDupeResult.newDecisionCount;
    }

    state.lastPruneCompressRuns = state.stats.totalCompressRuns;
    // Only an actual rewrite busts the cache. Passing the gate and finding
    // nothing to prune leaves the prefix byte-identical.
    if (newPrefixDecisions > 0) {
      recordCacheBust(state, currentTurn);
    }
  }

  // c. ObservationMask (only if threshold exceeded; has its own cost-ROI gate)
  const currentTokens = estimateContextTokens(current, tokenizer);
  let maskedCount = 0;
  let offloadedCount = 0;
  let offloadRequests: OffloadRequest[] = [];

  if (shouldTriggerMasking(currentTokens, config)) {
    const maskResult = runObservationMask(current, currentTurn, config, state, workspaceDir, tokenizer, nowMs, emit);
    current = maskResult.messages;
    totalSaved += maskResult.tokensSaved;
    maskedCount = maskResult.maskedCount;
    offloadedCount = maskResult.offloadedCount;
    offloadRequests = maskResult.offloadRequests;
  }

  return {
    messages: decided.size === 0 ? current : current.map(message => ({
      ...message,
      parts: message.parts.map(part => part.type === "tool" ? decided.get(part.callId) ?? part : part),
    })),
    tokensSaved: totalSaved,
    dedupCount,
    staleErrorCount,
    nearDupeCount,
    maskedCount,
    offloadedCount,
    offloadRequests,
  };
}

/**
 * Estimate the tokens that would be saved by running dedup + stale-error.
 *
 * This is a lightweight scan used by the P2 cost-ROI gate: if the formula
 * says the savings are worth busting the warm cache, we allow the recompute.
 * Does NOT modify state or messages.
 */
function estimateDedupStaleSavings(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState
): number {
  let estimated = 0;

  // Dedup: find the last occurrence of each tool call key, sum output sizes of
  // earlier occurrences that are not already decided.
  const lastOccurrence = new Map<string, { msgIdx: number; partIdx: number }>();
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.isIgnored) continue;
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (part.type !== "tool") continue;
      const tp = part as ToolPart;
      if (tp.status !== "completed") continue;
      if (isAlwaysProtected(tp.tool)) continue;
      const key = `${tp.tool}::${typeof tp.input === "string" ? tp.input : JSON.stringify(tp.input)}`;
      lastOccurrence.set(key, { msgIdx: mi, partIdx: pi });
    }
  }

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.isIgnored) continue;
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (part.type !== "tool") continue;
      const tp = part as ToolPart;
      if (tp.status !== "completed") continue;
      if (isAlwaysProtected(tp.tool)) continue;
      if (isWithinTieredRetention(tp, currentTurn, config)) continue;
      if (tp.output === PLACEHOLDER_DEDUP) continue;
      if (state.dedupDecisions.has(tp.callId)) continue; // already decided

      const key = `${tp.tool}::${typeof tp.input === "string" ? tp.input : JSON.stringify(tp.input)}`;
      const last = lastOccurrence.get(key);
      if (last && (last.msgIdx !== mi || last.partIdx !== pi)) {
        estimated += (tp.output?.length ?? 0) / 4;
      }
    }
  }

  // Stale-error: sum input sizes of stale errored calls not already decided.
  const DEFAULT_STALE_ERROR_TURNS = 3;
  for (const msg of messages) {
    if (msg.isIgnored) continue;
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      const tp = part as ToolPart;
      if (tp.status !== "error") continue;
      if (isAlwaysProtected(tp.tool)) continue;
      if (tp.turn === undefined) continue;
      if ((currentTurn - tp.turn) < DEFAULT_STALE_ERROR_TURNS) continue;
      if (state.staleErrorDecisions.has(tp.callId)) continue; // already decided

      const inputStr = typeof tp.input === "string" ? tp.input : JSON.stringify(tp.input);
      estimated += inputStr.length / 4;
    }
  }

  return estimated;
}
