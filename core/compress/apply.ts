// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Apply compress: integrate a summary block into the message list.
// Append-only by default: new delta block at the stable/volatile boundary.

import type { NeutralMessage, SummaryBlockPart } from "../../types/neutral.js";
import type { CoreState, BlockMetadata } from "../../types/state.js";
import type { CoreConfig } from "../../types/config.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import { defaultTokenizer } from "../../services/tokenizer.js";
import { estimateMessageTokens } from "../tokens.js";
import { appendProtectedContent, buildCompressionIndex } from "./transaction.js";

/** Result of applying a compress block. */
export interface ApplyCompressResult {
  /** The updated message list with the summary block inserted and source messages ignored. */
  messages: NeutralMessage[];
  /** The block ID assigned to this summary. */
  blockId: string;
  /** The anchor message ID (the first message in the compressed range). */
  anchorMessageId: string;
}

/**
 * Apply a compress result to the message list.
 *
 * Append-only mode (default, summarization.appendOnly=true):
 *   - Insert a new summary-block message at the position of the first compressed message.
 *   - Mark all compressed messages as isIgnored=true.
 *   - Earlier summary blocks are NOT modified (byte-stable).
 *
 * Full-restructure mode (appendOnly=false or fullRestructureTriggered):
 *   - Consolidate all existing summary blocks into the new one.
 *   - Mark all source messages as ignored.
 */
export function applyCompress(
  messages: NeutralMessage[],
  summaryText: string,
  sourceMessageIds: string[],
  state: CoreState,
  config: CoreConfig,
  nowMs: number,
  tokenizer: Tokenizer = defaultTokenizer
): ApplyCompressResult {
  const blockId = `b${state.nextBlockId}`;
  state.nextBlockId++;

  const sourceSet = new Set(sourceMessageIds);
  const anchorMessageId = sourceMessageIds[0] ?? "";

  // Find the insertion index (position of the first source message)
  let insertIdx = messages.findIndex(m => sourceSet.has(m.id));
  if (insertIdx < 0) insertIdx = messages.length;

  // Determine if we should consolidate existing summary blocks
  const shouldConsolidate =
    !config.summarization.appendOnly || state.fullRestructureTriggered;

  const selectedMessages = messages.filter(m => sourceSet.has(m.id));
  let finalSummaryText = summaryText;
  const consumedBlockIds: string[] = [];

  if (shouldConsolidate) {
    // Collect all existing summary blocks that are in the source range
    const existingBlocks: string[] = [];
    for (const msgId of sourceMessageIds) {
      const msg = messages.find(m => m.id === msgId);
      if (!msg) continue;
      for (const part of msg.parts) {
        if (part.type === "summary-block") {
          existingBlocks.push(part.text);
          consumedBlockIds.push(part.blockId);
          // Mark the nested block inactive and link it after the parent is known.
          const meta = state.blockRegistry.get(part.blockId);
          if (meta) {
            meta.consumed = true;
            meta.active = false;
          }
        }
      }
    }
    // Prepend existing block content to the new summary
    if (existingBlocks.length > 0) {
      finalSummaryText = existingBlocks.join("\n\n---\n\n") + "\n\n---\n\n" + summaryText;
    }
  }
  finalSummaryText = appendProtectedContent(selectedMessages, finalSummaryText, config);

  // Create the summary block message
  const summaryPart: SummaryBlockPart = {
    type: "summary-block",
    blockId,
    text: finalSummaryText,
  };

  const summaryMessage: NeutralMessage = {
    id: `__summary_${blockId}`,
    ref: blockId,
    role: "assistant",
    sessionId: state.sessionId,
    createdAt: messages[insertIdx]?.createdAt ?? nowMs,
    isSummary: true,
    parts: [summaryPart],
  };

  // Mark source messages as ignored
  const updatedMessages = messages.map(m => {
    if (sourceSet.has(m.id)) {
      return { ...m, isIgnored: true };
    }
    return m;
  });

  // Insert the summary block at the anchor position
  updatedMessages.splice(insertIdx, 0, summaryMessage);

  // Register the block in state (including the summary text for re-apply on re-feed)
  const effectiveMessageIds: string[] = [];
  const effectiveToolCallIds: string[] = [];
  for (const message of selectedMessages) {
    const nested = message.parts.find(part => part.type === "summary-block");
    const child = nested?.type === "summary-block" ? state.blockRegistry.get(nested.blockId) : undefined;
    if (child) {
      effectiveMessageIds.push(...(child.effectiveMessageIds ?? child.sourceMessageIds));
      effectiveToolCallIds.push(...(child.effectiveToolCallIds ?? []));
    } else {
      effectiveMessageIds.push(message.id);
      for (const part of message.parts) if (part.type === "tool") effectiveToolCallIds.push(part.callId);
    }
  }
  const sourceTokens = selectedMessages.reduce((sum, message) => sum + estimateMessageTokens(message, tokenizer), 0);
  const summaryTokens = tokenizer.countTokens(finalSummaryText);
  const blockMeta: BlockMetadata = {
    blockId,
    runId: `r${state.nextRunId++}`,
    mode: sourceMessageIds.length === 1 ? "message" : "range",
    topic: "legacy",
    startRef: selectedMessages[0]?.ref ?? sourceMessageIds[0] ?? "",
    endRef: selectedMessages.at(-1)?.ref ?? sourceMessageIds.at(-1) ?? "",
    anchorMessageId: effectiveMessageIds[0] ?? anchorMessageId,
    active: true,
    deactivatedByUser: false,
    includedBlockIds: consumedBlockIds,
    consumedBlockIds,
    parentBlockIds: [],
    directMessageIds: [...sourceMessageIds],
    effectiveMessageIds: [...new Set(effectiveMessageIds)],
    directToolCallIds: selectedMessages.flatMap(message => message.parts.filter((part): part is import("../../types/neutral.js").ToolPart => part.type === "tool").map(part => part.callId)),
    effectiveToolCallIds: [...new Set(effectiveToolCallIds)],
    sourceMessageIds: [...new Set(effectiveMessageIds)],
    sourceTokens,
    summaryTokens,
    netTokens: sourceTokens - summaryTokens,
    createdAtTurn: state.currentTurn,
    updatedAtTurn: state.currentTurn,
    createdAt: nowMs,
    updatedAt: nowMs,
    tokens: summaryTokens,
    consumed: false,
    summaryText: finalSummaryText,
    projectionTier: "warm",
  };
  state.blockRegistry.set(blockId, blockMeta);
  for (const childId of consumedBlockIds) {
    const child = state.blockRegistry.get(childId);
    if (child) child.parentBlockIds = [...new Set([...(child.parentBlockIds ?? []), blockId])];
  }
  state.latestSummaryBlockId = blockId;

  // Compression has its own message-keyed index; messageIndex remains callId-only.
  state.compressionIndex = buildCompressionIndex(state);

  // Update active block tracking
  state.activeByAnchorMessageId.set(blockMeta.anchorMessageId, blockId);

  // Record savings: source content tokens replaced minus the summary block tokens.
  // Estimated via char/4 (apply has no injected tokenizer); clamped at >= 0.
  const savedByCompress = Math.max(0, blockMeta.netTokens);

  state.stats.totalCompressRuns++;
  state.stats.totalTokensCompressed += savedByCompress;
  state.stats.totalTokensSaved += savedByCompress;

  return { messages: updatedMessages, blockId, anchorMessageId };
}
