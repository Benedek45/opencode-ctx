// PolyForm Noncommercial License 1.0.0 — see LICENSE
// opencode ↔ NeutralMessage translation.
//
// Translates between the opencode plugin's native message/part representation
// and the core's NeutralMessage model. This is the only place that knows about
// opencode types; the core never sees them.

import type { NeutralMessage, NeutralPart, TokenUsage, ToolStatus } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type {
  HostMessageEntry,
  HostMessage,
  HostPart,
  HostToolState,
  HostAssistantMessage,
} from "./host-types.js";

/** Clone host entries so host re-feeds and projected mutations never alias. */
export function cloneHostEntries(entries: HostMessageEntry[]): HostMessageEntry[] {
  return structuredClone(entries);
}

/** Return completed tool outputs from an immutable raw host snapshot. */
export function completedToolOutputs(entries: HostMessageEntry[]): Array<{
  callId: string;
  tool: string;
  output: string;
  title: string;
  messageId: string;
}> {
  const outputs: Array<{
    callId: string;
    tool: string;
    output: string;
    title: string;
    messageId: string;
  }> = [];
  for (const entry of entries) {
    for (const part of entry.parts) {
      if (part.type !== "tool") continue;
      const toolPart = part as import("./host-types.js").HostToolPart;
      if (toolPart.state.status !== "completed") continue;
      outputs.push({
        callId: toolPart.callID,
        tool: toolPart.tool,
        output: toolPart.state.output,
        title: toolPart.state.title,
        messageId: toolPart.messageID,
      });
    }
  }
  return outputs;
}

// ── opencode → NeutralMessage ─────────────────────────────────────────────────

/**
 * Translate an array of opencode {info, parts}[] entries to NeutralMessage[].
 *
 * Key mapping decisions (verified against vendored types):
 *   - info.id -> NeutralMessage.id
 *   - info.sessionID -> NeutralMessage.sessionId
 *   - info.time.created -> NeutralMessage.createdAt
 *   - info.summary === true (AssistantMessage) -> NeutralMessage.isSummary
 *   - parts[].type "text" -> TextPart
 *   - parts[].type "reasoning" -> ReasoningPart
 *   - parts[].type "step-start" -> StepStartPart
 *   - parts[].type "tool" -> ToolPart (callID, tool, state.status, state.input, state.output)
 *   - parts[].type "compaction" -> marks message as isSummary (native compaction marker)
 *   - AssistantMessage.tokens.cache.{read,write} -> TokenUsage.cacheRead/cacheWrite
 *   - parts[].ignored === true -> isIgnored on the message
 *
 * With state, use the raw-feed turn basis even for compressed/projected subsets.
 * Unknown hydrated entries conservatively use the current turn. Legacy state
 * without a basis is right-aligned to its monotonic clock; standalone callers
 * without state retain positional user-turn counting.
 */
export function toNeutral(entries: HostMessageEntry[], state?: Pick<CoreState, "currentTurn" | "turnBasis" | "importedContext">): NeutralMessage[] {
  const turns = state?.turnBasis ? new Map(state.turnBasis.messageTurns) : undefined;
  let userTurnCount = state ? Math.max(0, state.currentTurn - entries.filter(isUserTurn).length) : 0;
  return entries.map(entry => {
    if (isUserTurn(entry)) userTurnCount++;
    const turn = entry.info.id.startsWith("__ctx_import_") && state?.importedContext
      ? state.importedContext.importedAtTurn
      : turns
      ? turns.get(entry.info.id)
        ?? (entry.info.role === "assistant" ? turns.get(entry.info.parentID) : undefined)
        ?? state!.currentTurn
      : userTurnCount;
    return entryToNeutral(entry, turn);
  });
}

function isUserTurn(entry: HostMessageEntry): boolean {
  return entry.info.role === "user" && !isCtxSummaryEntry(entry)
    && !entry.info.id.startsWith("__ctx_import_")
    && !entry.info.id.startsWith("__summary_")
    && !entry.info.id.startsWith("__manual_");
}

/** Advance only from raw host history; projection/hydration must never tick the clock. */
export function advanceTurnBasis(entries: HostMessageEntry[], state: CoreState): void {
  const users = entries.filter(isUserTurn);
  const prior = new Map(state.turnBasis?.messageTurns);
  const previousUserId = state.turnBasis?.latestUserId;
  const latestUserId = users.at(-1)?.info.id;
  let anchor = previousUserId;
  if (latestUserId) {
    if (!previousUserId) {
      // Legacy sidecars have a clock but no anchor. Adopt, never reset, that clock.
      state.currentTurn = Math.max(state.currentTurn, users.length);
      anchor = latestUserId;
    } else if (!prior.has(latestUserId)) {
      let overlap = users.length - 1;
      while (overlap >= 0 && !prior.has(users[overlap].info.id)) overlap--;
      // With no overlap, hidden turn counts are unknowable. Count only the new tail.
      state.currentTurn += overlap >= 0 ? users.length - 1 - overlap : 1;
      anchor = latestUserId;
    }
  }

  const userTurns = new Map<string, number>();
  let turn = state.currentTurn;
  for (let i = users.length - 1; i >= 0; i--) {
    const id = users[i].info.id;
    turn = Math.min(turn, prior.get(id) ?? turn);
    userTurns.set(id, turn);
    turn = Math.max(0, turn - 1);
  }
  const messageTurns = new Map<string, number>();
  // Leading/tool-only entries have no reliable positional age: protect unknowns.
  turn = state.currentTurn;
  for (const entry of entries) {
    if (isUserTurn(entry)) turn = userTurns.get(entry.info.id)!;
    const parentTurn = entry.info.role === "assistant"
      ? userTurns.get(entry.info.parentID) ?? prior.get(entry.info.parentID)
      : undefined;
    messageTurns.set(entry.info.id, prior.get(entry.info.id) ?? parentTurn ?? turn);
  }
  // Bound tracking to this feed, but retain the anchor across tool-only re-feeds.
  if (anchor && !messageTurns.has(anchor)) messageTurns.set(anchor, prior.get(anchor)!);
  state.turnBasis = { latestUserId: anchor, messageTurns: [...messageTurns] };
}

function isCtxSummaryEntry(entry: HostMessageEntry): boolean {
  return entry.info.id.startsWith("__summary_b") ||
    (entry.info.role === "user" && entry.info.agent === "ctx-compress");
}

function entryToNeutral(entry: HostMessageEntry, userTurnCount: number): NeutralMessage {
  const { info, parts } = entry;

  const role = info.role === "user" ? "user" : "assistant";
  const sessionId = info.sessionID;
  const createdAt = info.time.created;

  // Detect native compaction: AssistantMessage.summary === true OR a compaction part
  const hasCompactionPart = parts.some(p => p.type === "compaction");
  const ctxSummary = isCtxSummaryEntry(entry);
  const isSummary =
    ctxSummary ||
    hasCompactionPart ||
    (info.role === "assistant" && (info as HostAssistantMessage).summary === true);

  // Detect ignored: any text part with ignored === true marks the whole message
  const isIgnored = parts.some(
    p => p.type === "text" && (p as { ignored?: boolean }).ignored === true
  );

  // Build token usage from the latest assistant message.
  // plugin-authored replacements carry no provider usage: reporting their zeroed
  // counters would be read as "the previous prefix missed the cache" and as a
  // calibration sample, both of which are false.
  let tokens: TokenUsage | undefined;
  if (info.role === "assistant" && !info.id.startsWith("__manual_")) {
    const asst = info as HostAssistantMessage;
    tokens = {
      input: asst.tokens.input,
      output: asst.tokens.output,
      reasoning: asst.tokens.reasoning,
      cacheRead: asst.tokens.cache.read,
      cacheWrite: asst.tokens.cache.write,
    };
  }

  const blockId = ctxSummary
    ? info.id.replace(/^__summary_/, "")
    : undefined;
  const neutralParts = ctxSummary
    ? [{
        type: "summary-block" as const,
        blockId: blockId ?? "",
        text: parts.find(p => p.type === "text") &&
          typeof (parts.find(p => p.type === "text") as { text?: unknown }).text === "string"
            ? String((parts.find(p => p.type === "text") as { text: string }).text)
            : "",
      }]
    : parts.flatMap(p => partToNeutral(p, userTurnCount));

  return {
    id: info.id,
    ref: blockId,
    role,
    sessionId,
    createdAt,
    isSummary: isSummary || undefined,
    isIgnored: isIgnored || undefined,
    parts: neutralParts,
    tokens,
  };
}

function partToNeutral(part: HostPart, userTurnCount: number): NeutralPart[] {
  switch (part.type) {
    case "text": {
      const tp = part as { type: "text"; text: string };
      return [{ type: "text", text: tp.text }];
    }
    case "reasoning": {
      const rp = part as { type: "reasoning"; text: string };
      return [{ type: "reasoning", text: rp.text }];
    }
    case "step-start": {
      return [{ type: "step-start" }];
    }
    case "tool": {
      const tp = part as {
        type: "tool";
        callID: string;
        tool: string;
        state: HostToolState;
      };
      const status = toolStateToStatus(tp.state);
      const input = tp.state.input ?? {};
      const output = toolStateOutput(tp.state);
      return [
        {
          type: "tool",
          callId: tp.callID,
          tool: tp.tool,
          status,
          input,
          output,
          // Assigned on the same user-turn clock as state.currentTurn.
          turn: userTurnCount,
        },
      ];
    }
    case "step-finish":
    case "compaction":
    case "snapshot":
    case "patch":
    case "agent":
    case "retry":
    case "file":
    case "subtask":
      // These part types are not represented in the neutral model.
      // step-finish carries token info but we read that from AssistantMessage.tokens.
      // compaction is handled at the message level (isSummary).
      return [];
    default:
      return [];
  }
}

function toolStateToStatus(state: HostToolState): ToolStatus {
  switch (state.status) {
    case "pending": return "pending";
    case "running": return "running";
    case "completed": return "completed";
    case "error": return "error";
    default: return "pending";
  }
}

function toolStateOutput(state: HostToolState): string | undefined {
  if (state.status === "completed") return state.output;
  if (state.status === "error") return state.error;
  return undefined;
}

// ── NeutralMessage → opencode (apply mutations back) ─────────────────────────

/**
 * Apply neutral-model mutations back onto the original opencode entries array.
 *
 * The core only mutates:
 *   - parts[].output (mask/offload replacement)
 *   - parts[].input fields (stale-error replacement)
 *   - the set of messages emitted (compress range → anchor)
 *   - appended nudge text / id tags
 *
 * This function produces a new entries array reflecting those mutations.
 * Messages that were removed by compress (not present in neutral output) are omitted.
 * Synthetic summary-block messages are injected as synthetic user messages.
 */
export function applyNeutral(
  originalEntries: HostMessageEntry[],
  neutralMessages: NeutralMessage[]
): HostMessageEntry[] {
  // Build a lookup from message id to original entry
  const originalById = new Map<string, HostMessageEntry>();
  for (const entry of originalEntries) {
    originalById.set(entry.info.id, entry);
  }

  const result: HostMessageEntry[] = [];

  for (const neutral of neutralMessages) {
    // Synthetic summary-block messages (injected by compress apply)
    if (neutral.isSummary && !originalById.has(neutral.id)) {
      result.push(buildSyntheticSummaryEntry(neutral));
      continue;
    }

    if (neutral.isManualReplacement && !originalById.has(neutral.id)) {
      // Keep the replaced message's role and provider metadata: turning an
      // assistant turn into a user turn would change the conversation structure
      // the model reads, not just its text.
      const sourceId = neutral.id.replace(/^__manual_/, "");
      result.push(buildSyntheticTextEntry(neutral, originalById.get(sourceId)));
      continue;
    }

    const original = originalById.get(neutral.id);
    if (!original) {
      // Message was in neutral output but not in original — skip (shouldn't happen)
      continue;
    }

    // Apply mutations: rebuild parts from neutral, preserving non-mutated parts
    const mutatedEntry = applyMutationsToEntry(original, neutral);
    result.push(mutatedEntry);
  }

  return result;
}

/**
 * Build a synthetic opencode entry for a summary-block message.
 * The core injects these as synthetic user-role messages at the anchor position.
 */
function buildSyntheticSummaryEntry(neutral: NeutralMessage): HostMessageEntry {
  const summaryPart = neutral.parts.find(p => p.type === "summary-block");
  const text = summaryPart?.type === "summary-block" ? summaryPart.text : "";

  const syntheticInfo: HostMessage = {
    id: neutral.id,
    sessionID: neutral.sessionId,
    role: "user",
    time: { created: neutral.createdAt },
    agent: "ctx-compress",
    model: { providerID: "ctx", modelID: "compress" },
    system: undefined,
    tools: undefined,
  };

  const syntheticPart: HostPart = {
    id: `${neutral.id}-text`,
    sessionID: neutral.sessionId,
    messageID: neutral.id,
    type: "text",
    text,
  };

  return { info: syntheticInfo, parts: [syntheticPart] };
}

/**
 * Build a synthetic host entry for a dashboard-authored replacement.
 *
 * When the replaced message is still available, its `info` is reused so the role
 * (and, for assistant turns, the provider metadata the host expects) is preserved.
 * Reported usage is zeroed: this entry is plugin-authored text, and letting a copied
 * `tokens` block through would corrupt the calibration and cache-warmth signals
 * derived from the latest assistant usage.
 */
function buildSyntheticTextEntry(
  neutral: NeutralMessage,
  source?: HostMessageEntry
): HostMessageEntry {
  const text = neutral.parts.find(p => p.type === "text");
  const syntheticInfo: HostMessage = source
    ? sourceInfoForReplacement(source.info, neutral)
    : {
        id: neutral.id,
        sessionID: neutral.sessionId,
        role: "user",
        time: { created: neutral.createdAt },
        agent: "ctx-control",
        model: { providerID: "ctx", modelID: "manual" },
        system: undefined,
        tools: undefined,
      };
  const syntheticPart: HostPart = {
    id: `${neutral.id}-text`,
    sessionID: neutral.sessionId,
    messageID: neutral.id,
    type: "text",
    text: text?.type === "text" ? text.text : "",
    synthetic: true,
  };
  return { info: syntheticInfo, parts: [syntheticPart] };
}

/** Clone a replaced message's info onto the synthetic replacement id, without usage. */
function sourceInfoForReplacement(info: HostMessage, neutral: NeutralMessage): HostMessage {
  if (info.role === "assistant") {
    return {
      ...info,
      id: neutral.id,
      time: { created: neutral.createdAt, completed: neutral.createdAt },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
  }
  return { ...info, id: neutral.id, time: { created: neutral.createdAt } };
}

/**
 * Provider namespaces opencode stores inside tool-part `metadata` (e.g. the
 * OpenAI Responses API `itemId`). A namespace that does not belong to the
 * current model's provider is foreign history from a prior model/provider
 * rotation and must not be sent to the new provider.
 */
const PROVIDER_METADATA_NAMESPACES = new Set([
  "openai",
  "anthropic",
  "google",
  "xai",
  "copilot",
  "groq",
  "perplexity",
  "openrouter",
]);

/** Map an opencode provider ID to the metadata namespace it stores. */
function providerMetadataNamespace(providerId: string): string {
  if (providerId === "opencode-go" || providerId.startsWith("openai")) return "openai";
  if (providerId.startsWith("anthropic") || providerId === "claude") return "anthropic";
  if (providerId.startsWith("google") || providerId === "gemini") return "google";
  if (providerId.startsWith("xai") || providerId === "grok") return "xai";
  if (providerId.startsWith("copilot")) return "copilot";
  return providerId;
}

/**
 * Strip foreign-provider `metadata` namespaces from parts.
 *
 * When a session is used with one provider (e.g. OpenAI) and later re-fed to a
 * different provider (e.g. Anthropic), parts still carry the old provider's item
 * references: tool parts keep `metadata.openai.itemId` and reasoning parts keep
 * `metadata.openai.reasoningEncryptedContent`. The Anthropic adapter reads the
 * foreign tool references as provider-executed and emits `tool_use` without a
 * matching `tool_result` (Anthropic rejects "tool_use ids were found without
 * tool_result blocks immediately after"); the encrypted reasoning blob is OpenAI
 * ciphertext that has no meaning for a different provider. Removing the foreign
 * namespace makes the tool part a plain local tool again, so the adapter emits
 * tool_use + tool_result from the co-located state.output.
 */
export function stripForeignProviderMetadata(
  entries: HostMessageEntry[],
  currentProviderId: string
): HostMessageEntry[] {
  if (!currentProviderId) return entries;
  const currentNamespace = providerMetadataNamespace(currentProviderId);
  let changed = false;

  const result = entries.map(entry => {
    let entryChanged = false;
    const parts = entry.parts.map(part => {
      const meta = (part as { metadata?: unknown }).metadata;
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) return part;
      const keys = Object.keys(meta as Record<string, unknown>);
      if (keys.length === 0) return part;
      const kept: Record<string, unknown> = {};
      for (const key of keys) {
        if (PROVIDER_METADATA_NAMESPACES.has(key) && key !== currentNamespace) continue;
        kept[key] = (meta as Record<string, unknown>)[key];
      }
      if (Object.keys(kept).length === keys.length) return part;
      entryChanged = true;
      return { ...part, metadata: Object.keys(kept).length > 0 ? kept : undefined };
    });
    if (!entryChanged) return entry;
    changed = true;
    return { ...entry, parts };
  });

  return changed ? result : entries;
}

/**
 * Apply neutral mutations to an original entry.
 * Rebuilds the parts array, applying output/input replacements from the neutral model.
 */
function applyMutationsToEntry(
  original: HostMessageEntry,
  neutral: NeutralMessage
): HostMessageEntry {
  // Build a map from callID -> neutral tool part for quick lookup
  const neutralToolByCallId = new Map<string, { output?: string; input: unknown }>();
  for (const part of neutral.parts) {
    if (part.type === "tool") {
      neutralToolByCallId.set(part.callId, { output: part.output, input: part.input });
    }
  }

  // Build a map from position -> neutral text part for nudge injection
  // (nudges are appended to text parts)
  const neutralTextParts = neutral.parts.filter(p => p.type === "text");

  let textPartIdx = 0;
  const newParts: HostPart[] = original.parts.map(part => {
    if (part.type === "tool") {
      const tp = part as {
        id: string; sessionID: string; messageID: string;
        type: "tool"; callID: string; tool: string; state: HostToolState;
      };
      const neutralTool = neutralToolByCallId.get(tp.callID);
      if (!neutralTool) return part;

      // Apply output mutation (mask/offload replacement)
      if (tp.state.status === "completed" && neutralTool.output !== undefined) {
        const newState: HostToolState = {
          ...tp.state,
          output: neutralTool.output,
        } as HostToolState;
        return { ...tp, state: newState };
      }

      // Apply input mutation (stale-error replacement)
      if (tp.state.status === "error") {
        // Anthropic (and other providers) require a tool_use block's `input` to
        // be a JSON object. The stale-error strategy stores a string placeholder
        // in the neutral model; wrap it so the re-fed host part stays provider-valid.
        const replaced = neutralTool.input;
        const hostInput: Record<string, unknown> =
          replaced !== null && typeof replaced === "object" && !Array.isArray(replaced)
            ? (replaced as Record<string, unknown>)
            : { note: String(replaced) };
        const newState: HostToolState = {
          ...tp.state,
          input: hostInput,
        } as HostToolState;
        return { ...tp, state: newState };
      }

      return part;
    }

    if (part.type === "text") {
      const neutralText = neutralTextParts[textPartIdx];
      textPartIdx++;
      if (neutralText && neutralText.text !== (part as { text: string }).text) {
        return { ...part, text: neutralText.text } as HostPart;
      }
      return part;
    }

    return part;
  });

  return { info: original.info, parts: newParts };
}
