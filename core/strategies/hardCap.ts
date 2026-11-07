// PolyForm Noncommercial License 1.0.0 — see LICENSE
// HardCap strategy: a model-independent context policy floor with explicit
// `underCap=false` reporting when protected/recent content makes it impossible.
//
// Nudges only ASK the model to compress; if it ignores them, context can grow
// until the provider returns a context-length error. This pass is the mechanical
// backstop. It fires only near the top of the budget (config.hardCap, default
// "92%" of modelContextLimit) and FORCES context back under the cap without any
// model cooperation:
//   Phase 1 — force-mask/offload ALL eligible tool outputs (Cost-ROI gate
//             bypassed: at the hard cap, avoiding an API error outranks cache
//             economics).
//   Phase 2 — if still over, drop the oldest whole non-recent, non-protected
//             messages until under the cap (lossy last resort).
//
// Decisions persist in state (maskDecisions via Phase 1; hardCapDroppedIds via
// Phase 2) so applyDecisions re-applies them every turn under the re-fed history.

import type { NeutralMessage, ToolPart } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import { defaultTokenizer } from "../../services/tokenizer.js";
import { resolveThreshold, estimateContextTokens, estimateMessageTokens } from "../tokens.js";
import { isAlwaysProtected, buildTightenedRecencyConfig } from "./guards.js";
import { runObservationMask, type OffloadRequest } from "./observationMask.js";

/** Result of the hard-cap pass. */
export interface HardCapResult {
  messages: NeutralMessage[];
  /** Tokens reclaimed by this pass (Phase 1 mask/offload + Phase 2 drops). */
  tokensSaved: number;
  /** Number of whole messages dropped in Phase 2. */
  droppedCount: number;
  /** Offload write requests (from Phase 1) the adapter must persist. */
  offloadRequests: OffloadRequest[];
  /** Whether the hard cap actually did anything. */
  fired: boolean;
  /** Total projected tokens including the measured system prompt. */
  remainingTokens: number;
  /** False when protected/recent content alone cannot fit below the cap. */
  underCap: boolean;
}

/**
 * Force context under config.hardCap. No-op unless the estimated context exceeds
 * the cap, so on roomy windows (the common case) this never touches anything.
 */
export function runHardCap(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  workspaceDir: string,
  tokenizer: Tokenizer = defaultTokenizer,
  nowMs = 0
): HardCapResult {
  const hardCapTokens = resolveThreshold(config.hardCap, config.modelContextLimit);
  let current = estimateContextTokens(messages, tokenizer) + (config.systemPromptTokens || 0);

  if (!Number.isFinite(hardCapTokens) || current <= hardCapTokens) {
    return {
      messages,
      tokensSaved: 0,
      droppedCount: 0,
      offloadRequests: [],
      fired: false,
      remainingTokens: current,
      underCap: current <= hardCapTokens,
    };
  }

  let working = messages;
  let tokensSaved = 0;
  const offloadRequests: OffloadRequest[] = [];

  // ── Phase 1: force-mask/offload all eligible tool outputs (gate bypassed) ──
  // At the hard cap we no longer care about cache economics — preventing the API
  // error wins. Reuse observationMask with a synthetic config that disables every
  // gate and keeps only the freshest turns. buildTightenedRecencyConfig clamps
  // BOTH recencyGuardTurns and every tool class's retentionTurns to 2 — clamping
  // recencyGuardTurns alone would not reach classified tools (read/bash/edit/
  // etc.), since getRetentionTurns prefers their fixed per-class value.
  const forcedConfig: CoreConfig = {
    ...buildTightenedRecencyConfig(config, 2),
    costRoi: { enabled: false },
    minRepruneInterval: 0,
    clearAtLeast: 0,
  };
  const masked = runObservationMask(
    working,
    currentTurn,
    forcedConfig,
    state,
    workspaceDir,
    tokenizer,
    nowMs
  );
  working = masked.messages;
  tokensSaved += masked.tokensSaved;
  offloadRequests.push(...masked.offloadRequests);
  current = estimateContextTokens(working, tokenizer) + (config.systemPromptTokens || 0);

  // ── Phase 2: drop whole messages, preferring tool-output messages over user intent ──
  //
  // Drop order: (0) tool-only messages first → (1) mixed tool+user-text → (2) pure
  // user-text last.  Within each tier, oldest first. This preserves user intent
  // (questions, instructions) as long as possible while still getting under the cap.
  // Previously the loop dropped strictly oldest-first regardless of role, which
  // could discard user questions before tool responses.
  let droppedCount = 0;
  if (current > hardCapTokens) {
    const keepRecentUserTurns = Math.max(config.recencyGuardTurns, 4);
    let usersSeen = 0;
    let cutoff = 0;
    for (let i = working.length - 1; i >= 0; i--) {
      if (working[i].role !== "user") continue;
      usersSeen++;
      if (usersSeen === keepRecentUserTurns) {
        cutoff = i;
        break;
      }
    }
    // Fewer than N user turns means the entire conversation is recent.
    if (usersSeen < keepRecentUserTurns) {
      cutoff = usersSeen === 0 ? Math.max(0, working.length - keepRecentUserTurns) : 0;
    }

    interface DropCandidate { idx: number; cost: number; priority: number }
    const candidates: DropCandidate[] = [];

    for (let i = 0; i < working.length; i++) {
      if (i >= cutoff) break;
      const m = working[i];
      if (m.isIgnored) continue;
      if (m.isSummary) continue;
      if (state.hardCapDroppedIds.has(m.id)) continue;
      if (m.parts.some(p => p.type === "tool" && isAlwaysProtected((p as ToolPart).tool))) continue;
      // Tool turn metadata remains authoritative even in a partial/tool-only feed.
      if (m.parts.some(p => p.type === "tool" && p.turn !== undefined && p.turn >= currentTurn)) continue;

      const hasTools = m.parts.some(p => p.type === "tool");
      const hasUserText = m.role === "user" && m.parts.some(p => p.type === "text");
      // priority 0 = tool-only (drop first), 1 = mixed, 2 = user-text-only (drop last)
      const priority = hasTools && !hasUserText ? 0 : hasTools && hasUserText ? 1 : 2;
      candidates.push({ idx: i, cost: estimateMessageTokens(m, tokenizer), priority });
    }

    // Sort: priority ASC (cheapest-intent first), then index ASC (oldest first within tier)
    candidates.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority : a.idx - b.idx);

    const next = working.map(m => ({ ...m }));
    for (const { idx, cost } of candidates) {
      if (current <= hardCapTokens) break;
      state.hardCapDroppedIds.add(next[idx].id);
      next[idx].isIgnored = true;
      current -= cost;
      tokensSaved += cost;
      droppedCount++;
    }
    working = next;
  }

  const fired = masked.tokensSaved > 0 || droppedCount > 0;
  if (fired) {
    state.stats.totalHardCapPasses = (state.stats.totalHardCapPasses ?? 0) + 1;
  }

  return {
    messages: working,
    tokensSaved,
    droppedCount,
    offloadRequests,
    fired,
    remainingTokens: current,
    underCap: current <= hardCapTokens,
  };
}
