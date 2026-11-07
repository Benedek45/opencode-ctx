// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Dedup strategy: remove repeated completed tool calls with identical inputs.

import type { NeutralMessage, ToolPart } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
import { PLACEHOLDER_DEDUP } from "../placeholders.js";
import { isAlwaysProtected } from "./guards.js";
import { isWithinTieredRetention } from "./guards.js";

/** Result of the dedup pass. */
export interface DedupResult {
  messages: NeutralMessage[];
  dedupCount: number;
  /** Decisions first created by this pass, excluding byte-stable reapplication. */
  newDecisionCount: number;
  tokensSaved: number;
}

/**
 * Stable key for a tool call: tool name + serialized input.
 * Used to detect repeated identical calls.
 */
function toolCallKey(toolPart: ToolPart): string {
  const inputStr = typeof toolPart.input === "string"
    ? toolPart.input
    : JSON.stringify(toolPart.input);
  return `${toolPart.tool}::${inputStr}`;
}

/**
 * Run the dedup strategy on a list of messages.
 *
 * For each completed tool call, if an identical call (same tool + input)
 * has already been seen earlier in the conversation, replace the output
 * of the earlier occurrence with the dedup placeholder.
 *
 * The MOST RECENT occurrence is kept; earlier duplicates are deduplicated.
 * Always-protected tools and tools within their retention window are skipped.
 *
 * Writes NEW decisions to `state.dedupDecisions`. Only counts savings for
 * newly decided callIds (not ones already in the decision set).
 */
export function runDedup(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  emit?: (event: TelemetryEvent) => void
): DedupResult {
  // First pass: find the last occurrence of each tool call key
  const lastOccurrence = new Map<string, { msgIdx: number; partIdx: number }>();

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.isIgnored) continue;
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (part.type !== "tool") continue;
      if (part.status !== "completed") continue;
      if (isAlwaysProtected(part.tool)) continue;
      const key = toolCallKey(part);
      lastOccurrence.set(key, { msgIdx: mi, partIdx: pi });
    }
  }

  // Second pass: dedup earlier occurrences
  let dedupCount = 0;
  let newDecisionCount = 0;
  let tokensSaved = 0;

  const result = messages.map((msg, mi) => {
    if (msg.isIgnored) return msg;
    let modified = false;
    const newParts = msg.parts.map((part, pi) => {
      if (part.type !== "tool") return part;
      if (part.status !== "completed") return part;
      if (isAlwaysProtected(part.tool)) return part;
      if (isWithinTieredRetention(part, currentTurn, config)) return part;
      // Already deduplicated (output is the placeholder)
      if (part.output === PLACEHOLDER_DEDUP) return part;

      const key = toolCallKey(part);
      const last = lastOccurrence.get(key);
      if (!last) return part;
      // If this is NOT the last occurrence, dedup it
      if (last.msgIdx !== mi || last.partIdx !== pi) {
        // Only count savings for NEW decisions (not already in the decision set)
        const isNew = !state.dedupDecisions.has(part.callId);
        if (isNew) {
          newDecisionCount++;
          const savedTokens = (part.output?.length ?? 0) / 4;
          tokensSaved += savedTokens;
          state.dedupDecisions.add(part.callId);
          emit?.({ type: "dedup", callId: part.callId, tool: part.tool, tokens: savedTokens });
        }
        dedupCount++;
        modified = true;
        return { ...part, output: PLACEHOLDER_DEDUP } satisfies ToolPart;
      }
      return part;
    });

    if (!modified) return msg;
    return { ...msg, parts: newParts };
  });

  return { messages: result, dedupCount, newDecisionCount, tokensSaved };
}
