import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { HostMessageEntry } from "./host-types.js";
/** Clone host entries so host re-feeds and projected mutations never alias. */
export declare function cloneHostEntries(entries: HostMessageEntry[]): HostMessageEntry[];
/** Return completed tool outputs from an immutable raw host snapshot. */
export declare function completedToolOutputs(entries: HostMessageEntry[]): Array<{
    callId: string;
    tool: string;
    output: string;
    title: string;
    messageId: string;
}>;
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
export declare function toNeutral(entries: HostMessageEntry[], state?: Pick<CoreState, "currentTurn" | "turnBasis" | "importedContext">): NeutralMessage[];
/** Advance only from raw host history; projection/hydration must never tick the clock. */
export declare function advanceTurnBasis(entries: HostMessageEntry[], state: CoreState): void;
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
export declare function applyNeutral(originalEntries: HostMessageEntry[], neutralMessages: NeutralMessage[]): HostMessageEntry[];
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
export declare function stripForeignProviderMetadata(entries: HostMessageEntry[], currentProviderId: string): HostMessageEntry[];
//# sourceMappingURL=map.d.ts.map