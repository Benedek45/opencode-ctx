// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Compress execute: orchestrate the compress pipeline step.
// This module handles the pure transform logic; tool registration is the adapter's job.

import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { CoreConfig } from "../../types/config.js";
import { applyCompress } from "./apply.js";
import { compressionRequestAges, isRecent } from "./transaction.js";

/** Input for a compress execution. */
export interface CompressExecuteInput {
  /** All current messages. */
  messages: NeutralMessage[];
  /** IDs of messages to compress (the range). */
  sourceMessageIds: string[];
  /** The summary text produced by the model. */
  summaryText: string;
  /** Optional topic label. */
  topic?: string;
  state: CoreState;
  config: CoreConfig;
  nowMs: number;
}

/** Output of a compress execution. */
export interface CompressExecuteOutput {
  messages: NeutralMessage[];
  blockId: string;
  anchorMessageId: string;
}

/**
 * Execute a compress operation: apply the summary to the message list.
 *
 * This is the pure transform — it does not call the model.
 * The adapter is responsible for:
 *   1. Calling the model with buildCompressPrompt() to get summaryText.
 *   2. Calling this function with the result.
 *   3. Persisting the updated state.
 */
export function executeCompress(input: CompressExecuteInput): CompressExecuteOutput {
  const { messages, sourceMessageIds, summaryText, state, config, nowMs } = input;

  // Validate that source messages exist
  const sourceSet = new Set(sourceMessageIds);
  const existing = messages.filter(m => sourceSet.has(m.id));
  if (existing.length === 0) {
    throw new Error(`executeCompress: none of the source message IDs exist in the message list`);
  }

  const result = applyCompress(messages, summaryText, sourceMessageIds, state, config, nowMs);

  return {
    messages: result.messages,
    blockId: result.blockId,
    anchorMessageId: result.anchorMessageId,
  };
}

/**
 * Determine the stable/volatile boundary for append-only compress.
 *
 * The "stable" prefix contains messages at least compressionRecencyRequests real
 * model requests old. Synthetic summaries do not advance this request clock.
 *
 * Returns the index of the first volatile message (everything before is stable).
 */
export function findStableVolatileBoundary(
  messages: NeutralMessage[],
  compressionRecencyRequests: number
): number {
  const ages = compressionRequestAges(messages);
  // The first protected message ends the stable prefix, including plain text.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.isIgnored && !msg.isSummary) continue;
    if (isRecent([msg], compressionRecencyRequests, ages)) return i;
  }
  // All messages are stable
  return messages.length;
}

/**
 * Select the source message IDs for a compress run.
 * In append-only mode, selects messages from the last summary block (or start)
 * up to the stable/volatile boundary.
 */
export function selectCompressRange(
  messages: NeutralMessage[],
  state: CoreState,
  compressionRecencyRequests: number
): string[] {
  const boundary = findStableVolatileBoundary(messages, compressionRecencyRequests);

  // Find the start: after the last summary block
  let startIdx = 0;
  for (let i = 0; i < boundary; i++) {
    if (messages[i].isSummary) {
      startIdx = i + 1;
    }
  }

  // Collect non-ignored messages in [startIdx, boundary)
  const range: string[] = [];
  for (let i = startIdx; i < boundary; i++) {
    const msg = messages[i];
    if (!msg.isIgnored) {
      range.push(msg.id);
    }
  }

  return range;
}
