// PolyForm Noncommercial License 1.0.0 — see LICENSE
// StaleError strategy: purge inputs of errored tool calls after N turns.

import type { NeutralMessage, ToolPart } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
import { PLACEHOLDER_STALE_ERROR_INPUT } from "../placeholders.js";
import { isAlwaysProtected } from "./guards.js";

/** Default number of turns after which an errored tool call's input is purged. */
const DEFAULT_STALE_ERROR_TURNS = 3;

/** Result of the stale-error pass. */
export interface StaleErrorResult {
  messages: NeutralMessage[];
  purgedCount: number;
  /** Decisions first created by this pass, excluding byte-stable reapplication. */
  newDecisionCount: number;
  tokensSaved: number;
}

/**
 * Run the stale-error strategy.
 *
 * For each tool call with status "error", if it is older than
 * DEFAULT_STALE_ERROR_TURNS turns, replace its INPUT with the stale-error
 * placeholder. The error message (output) is KEPT so the model knows what failed.
 *
 * Always-protected tools are skipped.
 *
 * Writes NEW decisions to `state.staleErrorDecisions`. Only counts savings for
 * newly decided callIds (not ones already in the decision set).
 */
export function runStaleError(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  emit?: (event: TelemetryEvent) => void
): StaleErrorResult {
  const staleAfterTurns = DEFAULT_STALE_ERROR_TURNS;
  let purgedCount = 0;
  let newDecisionCount = 0;
  let tokensSaved = 0;

  const result = messages.map(msg => {
    if (msg.isIgnored) return msg;
    let modified = false;
    const newParts = msg.parts.map(part => {
      if (part.type !== "tool") return part;
      if (part.status !== "error") return part;
      if (isAlwaysProtected(part.tool)) return part;
      if (part.turn === undefined) return part;
      if ((currentTurn - part.turn) < staleAfterTurns) return part;
      // Already purged
      if (part.input === PLACEHOLDER_STALE_ERROR_INPUT) return part;

      const inputStr = typeof part.input === "string"
        ? part.input
        : JSON.stringify(part.input);
      // Only count savings for NEW decisions
      const isNew = !state.staleErrorDecisions.has(part.callId);
      if (isNew) {
        newDecisionCount++;
        const savedTokens = inputStr.length / 4;
        tokensSaved += savedTokens;
        state.staleErrorDecisions.add(part.callId);
        emit?.({ type: "stale-error", callId: part.callId, tool: part.tool, tokens: savedTokens });
      }
      purgedCount++;
      modified = true;
      return { ...part, input: PLACEHOLDER_STALE_ERROR_INPUT } satisfies ToolPart;
    });

    if (!modified) return msg;
    return { ...msg, parts: newParts };
  });

  return { messages: result, purgedCount, newDecisionCount, tokensSaved };
}
