// PolyForm Noncommercial License 1.0.0 — see LICENSE
// ObservationMask strategy: mask or offload old/large completed tool outputs.

import type { NeutralMessage, ToolPart } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
import { defaultTokenizer } from "../../services/tokenizer.js";
import {
  PLACEHOLDER_PLAIN_MASK,
  buildOffloadPointer,
  buildStatefulMask,
} from "../placeholders.js";
import { collectEligibleToolParts } from "./guards.js";
import { extractPreviewLines, extractTailLines, buildOffloadPath, referencesOffloadPath } from "../paths.js";
import { findToolClassKey } from "../glob.js";
import { getProfile } from "../profiles.js";
import { estimateContextTokens } from "../tokens.js";
import { evaluateCostRoi, buildCostRoiInput, recordCacheBust } from "../budget/costRoi.js";
import { hasPendingProjectionRewrite } from "../projectionEdits.js";

/** Number of preview lines for offload pointers. */
const OFFLOAD_PREVIEW_LINES = 10;
/** Number of tail lines for stateful masks. */
const STATEFUL_TAIL_LINES = 20;
/** Minimum output size (chars) to trigger offload instead of plain mask. */
const OFFLOAD_MIN_CHARS = 2000;

/** An offload write request (adapter must persist this). */
export interface OffloadRequest {
  callId: string;
  path: string;
  content: string;
  tokens: number;
}

/** Result of the observation mask pass. */
export interface ObservationMaskResult {
  messages: NeutralMessage[];
  maskedCount: number;
  offloadedCount: number;
  tokensSaved: number;
  /** Offload write requests that the adapter must persist. */
  offloadRequests: OffloadRequest[];
}

/**
 * Determine whether a tool is stateless (re-fetchable) based on config.
 */
function isStateless(toolName: string, config: CoreConfig): boolean {
  const key = findToolClassKey(toolName, config.toolClasses);
  if (key) return config.toolClasses[key].stateless;
  // Default: treat unknown tools as stateless
  return true;
}

/**
 * Extract exit code from a tool output string.
 * Looks for patterns like "exit code: 0", "Exit: 1", "returned 0", etc.
 * Returns "unknown" if not found.
 */
function extractExitCode(output: string): string {
  const match = output.match(/(?:exit\s*code|exit|returned)[:\s]+(\d+)/i);
  return match ? match[1] : "unknown";
}

/**
 * Build a pass/fail summary from a stateful tool output.
 */
function buildPassFailSummary(output: string): string {
  const lower = output.toLowerCase();
  // Look for test result patterns
  const testMatch = output.match(/(\d+)\s+(?:tests?\s+)?passed.*?(\d+)\s+(?:tests?\s+)?failed/i)
    ?? output.match(/(\d+)\s+passed.*?(\d+)\s+failed/i);
  if (testMatch) {
    return `${testMatch[1]} passed, ${testMatch[2]} failed`;
  }
  if (lower.includes("error") || lower.includes("failed") || lower.includes("failure")) {
    return "Errors or failures detected";
  }
  if (lower.includes("success") || lower.includes("passed") || lower.includes("ok")) {
    return "Completed successfully";
  }
  return "See tail for details";
}

/**
 * Run the observation mask strategy.
 *
 * For each eligible tool call (completed, not protected, outside retention):
 * - If stateless + output large enough + profile prefers offload: offload to disk
 *   (explicit offload-file reads instead age into a plain mask, never another file)
 * - If stateless + small output: plain mask
 * - If stateful: stateful mask (condensed tail)
 *
 * Gated by the Cost-ROI check: a warm-cache prune that would invalidate a cheap
 * cached prefix for little savings is skipped (overridden by cold cache, the
 * quality trigger, R<=1, or costRoi.enabled=false).
 *
 * Monotonic: once masked/offloaded (tracked in state.messageIndex), stays that way.
 *
 * Pure: token measurement uses the injected `tokenizer`; the current time is
 * supplied as `nowMs` (no Date.now() in core).
 */
export function runObservationMask(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  workspaceDir: string,
  tokenizer: Tokenizer = defaultTokenizer,
  nowMs = 0,
  emit?: (event: TelemetryEvent) => void
): ObservationMaskResult {
  const empty: ObservationMaskResult = {
    messages,
    maskedCount: 0,
    offloadedCount: 0,
    tokensSaved: 0,
    offloadRequests: [],
  };

  const profile = getProfile(config.profile ?? state.activeProfile ?? "documents");
  const eligible = collectEligibleToolParts(messages, currentTurn, config);

  // Compute total recoverable tokens
  let totalRecoverable = 0;
  for (const { toolPart } of eligible) {
    const entry = state.messageIndex.get(toolPart.callId);
    if (entry?.masked || entry?.offloaded) continue; // already handled
    const output = toolPart.output ?? "";
    if (!output) continue;
    const outputTokens = tokenizer.countTokens(output);
    const stateless = isStateless(toolPart.tool, config);
    let replacement: string;
    if (stateless && profile.preferOffload && output.length >= OFFLOAD_MIN_CHARS && !referencesOffloadPath(toolPart.input, workspaceDir)) {
      const path = buildOffloadPath(workspaceDir, config.sessionId, toolPart.callId);
      replacement = buildOffloadPointer(path, OFFLOAD_PREVIEW_LINES, extractPreviewLines(output, OFFLOAD_PREVIEW_LINES));
    } else if (stateless || profile.usePlainMaskForStateful) {
      replacement = PLACEHOLDER_PLAIN_MASK;
    } else {
      replacement = buildStatefulMask(
        extractExitCode(output),
        buildPassFailSummary(output),
        STATEFUL_TAIL_LINES,
        extractTailLines(output, STATEFUL_TAIL_LINES)
      );
    }
    totalRecoverable += Math.max(0, outputTokens - tokenizer.countTokens(replacement));
  }

  // clearAtLeast guard: skip if not enough to recover
  if (totalRecoverable < config.clearAtLeast) {
    return empty;
  }

  // minRepruneInterval guard
  if (
    state.lastMaskingPassTurn > 0 &&
    (currentTurn - state.lastMaskingPassTurn) < config.minRepruneInterval
  ) {
    return empty;
  }

  // Cost-ROI gate: don't bust a warm cached prefix for marginal savings unless an
  // override condition (cold cache, quality trigger, R<=1, gate disabled) applies.
  const activeTokens = estimateContextTokens(messages, tokenizer);
  const nAfter = Math.max(0, activeTokens - totalRecoverable);
  const roi = evaluateCostRoi(
    buildCostRoiInput(
      totalRecoverable,
      nAfter,
      activeTokens,
      config,
      nowMs,
      state.lastRequestTime,
      state.lastCacheMiss,
      state.eTurnsEstimate,
      hasPendingProjectionRewrite(state)
    )
  );
  if (!roi.shouldPrune) {
    return empty;
  }
  // Build a mutable copy of messages (shallow clone parts arrays)
  const msgMap = new Map<string, NeutralMessage>();
  const result = messages.map(m => {
    const clone = { ...m, parts: [...m.parts] };
    msgMap.set(m.id, clone);
    return clone;
  });

  let maskedCount = 0;
  let offloadedCount = 0;
  let tokensSaved = 0;
  let maskedTokens = 0;
  let offloadedTokens = 0;
  const offloadRequests: OffloadRequest[] = [];

  for (const { messageId, partIndex, toolPart } of eligible) {
    // Monotonic: skip if already masked/offloaded
    const entry = state.messageIndex.get(toolPart.callId);
    if (entry?.masked || entry?.offloaded) continue;

    const output = toolPart.output ?? "";
    if (!output) continue;

    const stateless = isStateless(toolPart.tool, config);
    const outputTokens = tokenizer.countTokens(output);

    const msg = msgMap.get(messageId);
    if (!msg) continue;

    let newPart: ToolPart;
    let savedTokens = 0;

    if (stateless && profile.preferOffload && output.length >= OFFLOAD_MIN_CHARS && !referencesOffloadPath(toolPart.input, workspaceDir)) {
      // Offload to disk
      const path = buildOffloadPath(workspaceDir, config.sessionId, toolPart.callId);
      const preview = extractPreviewLines(output, OFFLOAD_PREVIEW_LINES);
      const pointer = buildOffloadPointer(path, OFFLOAD_PREVIEW_LINES, preview);
      savedTokens = Math.max(0, outputTokens - tokenizer.countTokens(pointer));
      if (savedTokens === 0) continue;
      newPart = { ...toolPart, output: pointer, sourcePath: path };
      offloadRequests.push({ callId: toolPart.callId, path, content: output, tokens: savedTokens });
      offloadedCount++;
      offloadedTokens += savedTokens;

      // Update state index (monotonic)
      state.messageIndex.set(toolPart.callId, {
        ...(entry ?? { messageId, masked: false }),
        offloaded: true,
        offloadPath: path,
      });
      // Store replacement text for re-apply (pointer text, not full content)
      state.maskDecisions.set(toolPart.callId, pointer);
      emit?.({ type: "offload", callId: toolPart.callId, tool: toolPart.tool, tokens: savedTokens, path });
    } else if (stateless || profile.usePlainMaskForStateful) {
      // Plain mask
      newPart = { ...toolPart, output: PLACEHOLDER_PLAIN_MASK };
      savedTokens = Math.max(0, outputTokens - tokenizer.countTokens(PLACEHOLDER_PLAIN_MASK));
      if (savedTokens === 0) continue;
      maskedCount++;
      maskedTokens += savedTokens;

      state.messageIndex.set(toolPart.callId, {
        ...(entry ?? { messageId, offloaded: false }),
        masked: true,
        maskedAt: currentTurn,
      });
      // Store replacement text for re-apply
      state.maskDecisions.set(toolPart.callId, PLACEHOLDER_PLAIN_MASK);
      emit?.({ type: "mask", callId: toolPart.callId, tool: toolPart.tool, tokens: savedTokens, reason: "plain" });
    } else {
      // Stateful mask
      const exitCode = extractExitCode(output);
      const summary = buildPassFailSummary(output);
      const tail = extractTailLines(output, STATEFUL_TAIL_LINES);
      const mask = buildStatefulMask(exitCode, summary, STATEFUL_TAIL_LINES, tail);
      savedTokens = Math.max(0, outputTokens - tokenizer.countTokens(mask));
      if (savedTokens === 0) continue;
      newPart = { ...toolPart, output: mask };
      maskedCount++;
      maskedTokens += savedTokens;

      state.messageIndex.set(toolPart.callId, {
        ...(entry ?? { messageId, offloaded: false }),
        masked: true,
        maskedAt: currentTurn,
      });
      // Store replacement text for re-apply
      state.maskDecisions.set(toolPart.callId, mask);
      emit?.({ type: "mask", callId: toolPart.callId, tool: toolPart.tool, tokens: savedTokens, reason: "stateful" });
    }

    msg.parts[partIndex] = newPart;
    tokensSaved += savedTokens;
  }

  // Update masking pass tracking in state
  if (maskedCount > 0 || offloadedCount > 0) {
    // Forced passes can have zero eligible outputs; only real rewrites bust cache.
    recordCacheBust(state, currentTurn);
    state.lastMaskingPassTurn = currentTurn;
    state.lastMaskingPassTime = nowMs;
    state.stats.totalMaskingPasses++;
    state.stats.totalTokensMasked += maskedTokens;
    state.stats.totalTokensOffloaded += offloadedTokens;
  }

  return { messages: result, maskedCount, offloadedCount, tokensSaved, offloadRequests };
}
