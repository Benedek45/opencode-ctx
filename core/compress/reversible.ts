// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Reversible compress: decompress and recompress by block ID.

import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import { cloneCoreState } from "../../types/state.js";
import { buildCompressionIndex } from "./transaction.js";

/** Result of a decompress operation. */
export interface DecompressResult {
  /** Messages with the summary block removed and source messages restored. */
  messages: NeutralMessage[];
  /** The block ID that was decompressed. */
  blockId: string;
}

/**
 * Decompress a summary block: remove the summary message and restore
 * the source messages (un-ignore them).
 *
 * Note: The original source message content must still be present in the
 * message list (just marked isIgnored=true). If source messages have been
 * evicted from memory, decompress is not possible.
 *
 * Returns null if the block is not found or source messages are unavailable.
 */
export function decompressBlock(
  messages: NeutralMessage[],
  blockId: string,
  state: CoreState
): DecompressResult | null {
  const meta = state.blockRegistry.get(blockId);
  if (!meta) return null;

  const sourceSet = new Set(meta.effectiveMessageIds ?? meta.sourceMessageIds);
  const summaryMsgId = `__summary_${blockId}`;

  // Legacy message-returning API can only hydrate sources present in memory.
  const sourceMessages = messages.filter(m => sourceSet.has(m.id));
  if (sourceMessages.length === 0) return null;

  // Remove the summary message and restore source messages
  const result = messages
    .filter(m => m.id !== summaryMsgId)
    .map(m => {
      if (sourceSet.has(m.id)) {
        return { ...m, isIgnored: false };
      }
      return m;
    });

  // Update state: remove from active tracking
  for (const [anchor, bid] of state.activeByAnchorMessageId.entries()) {
    if (bid === blockId) {
      state.activeByAnchorMessageId.delete(anchor);
      break;
    }
  }
  meta.active = false;
  meta.consumed = false;
  meta.deactivatedByUser = true;
  for (const childId of meta.includedBlockIds ?? []) {
    const child = state.blockRegistry.get(childId);
    if (child && !child.deactivatedByUser) {
      child.active = true;
      child.consumed = false;
      state.activeByAnchorMessageId.set(child.anchorMessageId ?? child.sourceMessageIds[0] ?? "", childId);
    }
  }
  state.compressionIndex = buildCompressionIndex(state);

  return { messages: result, blockId };
}

/**
 * Recompress: decompress a block and return the source messages for re-summarization.
 * The caller is responsible for running the compress pipeline again on the returned messages.
 */
export function recompressBlock(
  messages: NeutralMessage[],
  blockId: string,
  state: CoreState
): { messages: NeutralMessage[]; sourceMessages: NeutralMessage[] } | null {
  const meta = state.blockRegistry.get(blockId);
  if (!meta) return null;

  const result = decompressBlock(messages, blockId, state);
  if (!result) return null;

  const sourceSet = new Set(meta.effectiveMessageIds ?? meta.sourceMessageIds);
  const sourceMessages = result.messages.filter(m => sourceSet.has(m.id));

  return { messages: result.messages, sourceMessages };
}

export interface CompressionGraphResult {
  state: CoreState;
  blockId: string;
}

/** Purely deactivate a block, exposing eligible nested children. */
export function deactivateCompressionBlock(state: CoreState, blockId: string): CompressionGraphResult | null {
  const next = cloneCoreState(state);
  const block = next.blockRegistry.get(blockId);
  if (!block) return null;
  block.active = false;
  block.consumed = false;
  block.deactivatedByUser = true;
  next.temporaryRetrievals.delete(blockId);
  for (const [anchor, activeId] of next.activeByAnchorMessageId) if (activeId === blockId) next.activeByAnchorMessageId.delete(anchor);
  for (const childId of block.includedBlockIds ?? []) {
    const child = next.blockRegistry.get(childId);
    if (child && !child.deactivatedByUser) {
      child.active = true;
      child.consumed = false;
      next.activeByAnchorMessageId.set(child.anchorMessageId ?? child.sourceMessageIds[0] ?? "", childId);
    }
  }
  next.compressionIndex = buildCompressionIndex(next);
  return { state: next, blockId };
}

/** Purely activate a block and deactivate all blocks nested beneath it. */
export function activateCompressionBlock(state: CoreState, blockId: string): CompressionGraphResult | null {
  const source = state.blockRegistry.get(blockId);
  if (!source) return null;
  const pendingParents = [...(source.parentBlockIds ?? [])];
  const visitedParents = new Set<string>();
  while (pendingParents.length > 0) {
    const parentId = pendingParents.pop()!;
    if (visitedParents.has(parentId)) continue;
    visitedParents.add(parentId);
    const parent = state.blockRegistry.get(parentId);
    if (!parent) continue;
    if (parent.active && !parent.consumed) return null;
    pendingParents.push(...(parent.parentBlockIds ?? []));
  }
  const next = cloneCoreState(state);
  const block = next.blockRegistry.get(blockId);
  if (!block) return null;
  block.active = true;
  block.consumed = false;
  block.deactivatedByUser = false;
  next.activeByAnchorMessageId.set(block.anchorMessageId ?? block.sourceMessageIds[0] ?? "", blockId);
  const pending = [...(block.includedBlockIds ?? [])];
  while (pending.length) {
    const childId = pending.pop()!;
    const child = next.blockRegistry.get(childId);
    if (!child) continue;
    child.active = false;
    child.consumed = true;
    next.temporaryRetrievals.delete(childId);
    for (const [anchor, activeId] of next.activeByAnchorMessageId) if (activeId === childId) next.activeByAnchorMessageId.delete(anchor);
    pending.push(...(child.includedBlockIds ?? []));
  }
  next.compressionIndex = buildCompressionIndex(next);
  return { state: next, blockId };
}

/** Pure graph-only recompress preparation; durable source hydration stays adapter-side. */
export function recompressCompressionBlock(
  state: CoreState,
  blockId: string
): (CompressionGraphResult & { effectiveMessageIds: string[]; durableSourceRef?: string }) | null {
  const result = deactivateCompressionBlock(state, blockId);
  if (!result) return null;
  const block = result.state.blockRegistry.get(blockId)!;
  return {
    ...result,
    effectiveMessageIds: [...(block.effectiveMessageIds ?? block.sourceMessageIds)],
    durableSourceRef: block.durableSourceRef,
  };
}
