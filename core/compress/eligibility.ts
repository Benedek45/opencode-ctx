// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Advisory, read-only planning over the visible projection; no semantic completion claims.
import type { CoreConfig } from "../../types/config.js";
import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import { estimateMessageTokens } from "../tokens.js";
import {
  appendProtectedContent, compressionRequestAges, isRecent, preserveIncludedBlockSummaries,
} from "./transaction.js";

export interface CompressionCandidate {
  startRef: string;
  endRef: string;
  messageIds: string[];
  /** Visible source estimate, NOT actual retained net savings (protected facts/summaries survive). */
  sourceTokens: number;
}

export interface CompressionCandidateReport {
  candidates: CompressionCandidate[];
  /** Visible eligible tokens across all ranges, including ranges below the savings gate. */
  eligibleTokens: number;
  /** Visible tokens excluded by structural or recency protection. */
  protectedTokens: number;
  reason?: "noeligible" | "protectedcontent" | "insufficient-estimate" | "compression-disabled";
  /** Smallest remaining request wait among structurally eligible recent messages. */
  requestsUntilEligible?: number;
}

/**
 * Supply the complete visible conversation, not a selected suffix: request ages
 * deliberately use exactly the transaction validator's full-input basis.
 * Returns at most three oldest stable contiguous ranges. Source estimates exclude
 * hidden originals; validation still uses its historical block source accounting.
 * A real summary must be preflighted again: its size and retained facts can fail
 * the savings gate even when this minimal-summary estimate passes.
 */
export function planCompressionCandidates(
  messages: readonly NeutralMessage[], state: CoreState, config: CoreConfig, tokenizer: Tokenizer,
): CompressionCandidateReport {
  const report: CompressionCandidateReport = { candidates: [], eligibleTokens: 0, protectedTokens: 0 };
  const ages = compressionRequestAges(messages);
  // Mirror resolveMessage's first-match semantics without a full validator scan per message.
  const aliases = new Map<string, number>();
  const calls = new Map<string, number>();
  const messageOccurrences = new Map<string, number>();
  const coveredSources = new Set<string>();
  const sourceOwners = new Map<string, number>();
  for (const block of state.blockRegistry.values()) {
    if (!(block.active ?? !block.consumed) || block.consumed) continue;
    for (const id of new Set(block.effectiveMessageIds ?? block.sourceMessageIds)) {
      coveredSources.add(id);
      sourceOwners.set(id, (sourceOwners.get(id) ?? 0) + 1);
    }
  }
  for (const [index, message] of messages.entries()) {
    messageOccurrences.set(message.id, (messageOccurrences.get(message.id) ?? 0) + 1);
    for (const alias of [message.id, message.ref, ...message.parts.flatMap(part =>
      part.type === "summary-block" ? [part.blockId] : [])]) {
      if (alias && !aliases.has(alias)) aliases.set(alias, index);
    }
    for (const part of message.parts) if (part.type === "tool") {
      calls.set(part.callId, (calls.get(part.callId) ?? 0) + 1);
    }
  }
  let run: NeutralMessage[] = [];
  let sourceTokens = 0;
  let validationSourceTokens = 0;
  let hadEligible = false;
  const flush = () => {
    if (!run.length) return;
    // Same preservation and block expansion as preflight, using a one-character
    // nonempty summary. This is only an estimate, never a promise of net savings.
    const blockIds = [...new Set(run.flatMap(message => message.parts.flatMap(part =>
      part.type === "summary-block" ? [part.blockId] : [])))];
    const preserved = preserveIncludedBlockSummaries(appendProtectedContent(run, "S", config), blockIds, state);
    if (!preserved.invalidBlockIds.length
      && Math.min(sourceTokens, validationSourceTokens) - tokenizer.countTokens(preserved.summary) >= (config.summarization.minNetSavingsTokens ?? 0)
      && report.candidates.length < 3) {
      report.candidates.push({ startRef: run[0].ref!, endRef: run.at(-1)!.ref!,
        messageIds: run.map(message => message.id), sourceTokens });
    }
    run = [];
    sourceTokens = 0;
    validationSourceTokens = 0;
  };
  for (const [index, message] of messages.entries()) {
    if (message.isIgnored && !message.isSummary) { flush(); continue; }
    const tokens = estimateMessageTokens(message, tokenizer);
    const summaries = message.parts.filter(part => part.type === "summary-block");
    const block = summaries.length === 1 ? state.blockRegistry.get(summaries[0].blockId) : undefined;
    const structural = Boolean(message.ref && aliases.get(message.ref) === index
      && messageOccurrences.get(message.id) === 1
      && message.role !== "system" && !message.isManualReplacement
      && !message.id.startsWith("__manual_")
      && !message.id.startsWith("__ctx_cold_")
      && state.manualOverrides.get(message.id)?.mode !== "replace"
      && (summaries.length ? summaries.length === 1 && message.parts.length === 1
        && block && (block.active ?? !block.consumed) && !block.consumed
        && !block.deactivatedByUser && (block.parentBlockIds ?? []).length === 0
        && (block.effectiveMessageIds ?? block.sourceMessageIds).length > 0
        && (block.effectiveMessageIds ?? block.sourceMessageIds).every(id => sourceOwners.get(id) === 1)
        && block.durableSourceRef && block.durableSummaryRef
        && state.activeByAnchorMessageId.get(block.anchorMessageId) === block.blockId
        : !message.isSummary && !message.id.startsWith("__summary_")
          && !coveredSources.has(message.id)
          && !state.compressionIndex.get(message.id)?.replacedByBlockId)
      && message.parts.every(part => part.type !== "tool" || (
        (part.status === "completed" || part.status === "error")
        && Boolean(part.callId) && calls.get(part.callId) === 1
        && !/(?:^|[._/-])compress(?:_message)?$/.test(part.tool))));
    const recent = isRecent([message], config.compressionRecencyRequests, ages);
    if (!config.automation.modelCompression || !structural || recent) {
      flush();
      report.protectedTokens += tokens;
      if (structural && recent && config.automation.modelCompression) {
        const wait = config.compressionRecencyRequests - (ages.get(message.id) ?? 0);
        report.requestsUntilEligible = Math.min(report.requestsUntilEligible ?? wait, wait);
      }
      continue;
    }
    hadEligible = true;
    report.eligibleTokens += tokens;
    run.push(message);
    sourceTokens += tokens;
    validationSourceTokens += block?.sourceTokens ?? tokens;
  }
  flush();
  if (!report.candidates.length) report.reason = !config.automation.modelCompression ? "compression-disabled"
    : hadEligible ? "insufficient-estimate" : report.protectedTokens > 0 ? "protectedcontent" : "noeligible";
  return report;
}
