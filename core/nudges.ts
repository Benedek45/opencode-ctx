// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Nudges: tail-only injection of context management hints to the model.

import type { CoreConfig } from "../types/config.js";
import type { NeutralMessage, TextPart } from "../types/neutral.js";
import type { NudgeEscalationState } from "../types/state.js";
import { resolveThreshold, resolveSafetyCap } from "./tokens.js";
import type { CompressionCandidateReport } from "./compress/eligibility.js";

/** Nudge level, ordered from least to most urgent. */
export type NudgeLevel = "none" | "low" | "mid-soft" | "upper" | "safety-cap";

export interface ContextTokenMetrics {
  modelKey?: string;
  currentTokens: number;
  previousTokens?: number;
  addedTokens?: number;
  targetTokens: number;
  tokensToRemove: number;
}

/**
 * Low-water mark for repeated model compression. Normally this is the low
 * nudge threshold; small-window models clamp to 75% of the earliest mandatory
 * safety/policy ceiling so reaching the target creates useful headroom.
 */
export function resolveCompressionTarget(config: CoreConfig): number {
  const lower = resolveThreshold(config.nudges.lowerThreshold, config.modelContextLimit);
  const safety = resolveSafetyCap(config.nudges.safetyCap, config.modelContextLimit);
  const hard = resolveThreshold(config.hardCap, config.modelContextLimit);
  const ceiling = Math.max(0, Math.min(safety, hard, config.modelContextLimit));
  return Math.max(0, Math.min(lower, Math.floor(ceiling * 0.75)));
}

/** Compact trusted accounting appended to the latest user message each request. */
export function buildContextStatusText(metrics: ContextTokenMetrics, canCompress: boolean, eligibility?: CompressionCandidateReport): string {
  const delta = metrics.addedTokens === undefined
    ? "change unavailable after model switch/start"
    : `${metrics.addedTokens >= 0 ? "+" : ""}${metrics.addedTokens.toLocaleString()} since prior request`;
  const progress = metrics.tokensToRemove > 0
    ? `~${metrics.tokensToRemove.toLocaleString()} above target`
    : "target reached";
  const guidance = canCompress && metrics.tokensToRemove > 0 && (!eligibility || eligibility.candidates.length > 0)
    ? " This is advisory guidance, not a mandatory rule; compress eligible stable ranges when the quality tradeoff is worthwhile."
    : "";
  const model = metrics.modelKey ? ` for ${metrics.modelKey.replace("\u0000", "/")}` : "";
  return `[Context status${model}, model-specific estimate: ~${metrics.currentTokens.toLocaleString()} tokens; ${delta}; advisory compression target <=${metrics.targetTokens.toLocaleString()}; ${progress}.${guidance}]`;
}

/** Metadata only: no source content, guesses about completion, or guard bypass. */
export function buildCompressionGuidance(report: CompressionCandidateReport): string {
  if (!report.candidates.length) {
    const next = report.requestsUntilEligible === undefined ? "" : ` Earliest recent message becomes compressible after ~${report.requestsUntilEligible} more requests.`;
    return `No eligible compression range is currently available (${report.reason ?? "noeligible"}). Do not retry protected ranges or weaken the guards.${next} Continue the task; deterministic context safeguards remain active.`;
  }
  const candidates = report.candidates.map(c =>
    `${c.startRef}..${c.endRef} (${c.messageIds.length} messages, ~${c.sourceTokens.toLocaleString()} visible source tokens)`);
  return `Age/structure-eligible candidates: ${candidates.join("; ")}. Summarize only a section whose role you understand, preserving constraints, unresolved work and source-attributed facts. Source size is not guaranteed net savings. Use ctx_compression_status to refresh eligibility after changes; do not repeat a rejected range unchanged.`;
}

/**
 * Determine the nudge level for the current token count.
 *
 * Thresholds may be absolute token counts or "X%" of the model context limit
 * (resolved here), so the ladder scales correctly across model window sizes.
 * Order of checks is most-urgent-first.
 */
export function getNudgeLevel(totalTokens: number, config: CoreConfig): NudgeLevel {
  const limit = config.modelContextLimit;
  const { lowerThreshold, midSoftNudge, upperThreshold, safetyCap } = config.nudges;

  const lower = resolveThreshold(lowerThreshold, limit);
  const mid = resolveThreshold(midSoftNudge, limit);
  const upper = resolveThreshold(upperThreshold, limit);
  const cap = resolveSafetyCap(safetyCap, limit);

  if (totalTokens >= cap) return "safety-cap";
  if (totalTokens >= upper) return "upper";
  if (totalTokens >= mid) return "mid-soft";
  if (totalTokens >= lower) return "low";
  return "none";
}

/**
 * Consecutive urgent (upper/safety-cap) turns without an intervening compress
 * run before the wording escalates and the pipeline forces an extra mechanical
 * masking pass (see shouldForceMechanicalEscalation / core/pipeline.ts).
 */
export const ESCALATION_STREAK_THRESHOLD = 3;

/**
 * Build the nudge text to inject. Returns undefined when no nudge is warranted.
 *
 * `ignoredStreak` (from state.nudgeEscalation, see updateNudgeEscalation) is the
 * number of consecutive turns the model has been shown an "upper" or
 * "safety-cap" nudge without calling compress. Past ESCALATION_STREAK_THRESHOLD
 * the wording names the repeat count explicitly — plain repetition of identical
 * text is easy for a model to pattern-match past; naming the streak is a
 * cheap, honest escalation that costs nothing extra to try before falling back
 * to the mechanical masking escalation.
 */
export function buildNudgeText(
  level: NudgeLevel,
  totalTokens: number,
  effectiveBudget: number,
  ignoredStreak = 0,
  eligibility?: CompressionCandidateReport,
): string | undefined {
  const pct = effectiveBudget > 0 ? Math.round((totalTokens / effectiveBudget) * 100) : 0;
  const escalated = ignoredStreak >= ESCALATION_STREAK_THRESHOLD;
  if (level !== "none" && eligibility) {
    const guidance = buildCompressionGuidance(eligibility);
    return `[Context management: ${pct}% of context window used. ${guidance}${escalated && eligibility.candidates.length ? ` ${ignoredStreak} actionable requests remain unfulfilled; use an eligible range if the quality tradeoff is worthwhile.` : ""}]`;
  }

  switch (level) {
    case "none":
      return undefined;
    case "low":
      return `[Context management: ${pct}% of context window used. If you have finished a section of work, consider summarizing it with the compress tool.]`;
    case "mid-soft":
      return `[Context management: ${pct}% of context window used. Consider summarizing completed work with the compress tool if the conversation is getting long.]`;
    case "upper":
      return escalated
        ? `[Context management: ${pct}% of context window used. This is the ${ignoredStreak}th consecutive turn asking — you have not called the compress tool. Call it now, before continuing with anything else.]`
        : `[Context management: ${pct}% of context window used. Context is getting full. Use the compress tool to summarize completed sections before continuing.]`;
    case "safety-cap":
      return escalated
        ? `[Context management: ${pct}% of context window used. CRITICAL, repeated ${ignoredStreak} times: you have not compressed despite repeated requests. The system will now force additional context masking to protect this session, but that masking is lossier than a proper summary — call the compress tool immediately.]`
        : `[Context management: ${pct}% of context window used. CRITICAL: Context window is nearly full. You MUST use the compress tool immediately to summarize and free space before the next response.]`;
    default:
      return undefined;
  }
}

/**
 * Update the nudge-escalation streak for this turn.
 *
 * Resets to 0 whenever the level drops below "upper" (the model is no longer
 * being asked urgently) or when `totalCompressRuns` has increased since the
 * last check (the model complied since we last looked). Otherwise increments —
 * this turn was ANOTHER urgent turn with no compliance in between.
 *
 * Pure: returns a new NudgeEscalationState; does not mutate its input.
 */
export function updateNudgeEscalation(
  level: NudgeLevel,
  totalCompressRuns: number,
  current: NudgeEscalationState,
  canAct = true,
): NudgeEscalationState {
  const isUrgent = level === "upper" || level === "safety-cap";
  const attempted = (current.attempts ?? 0) > (current.attemptsAtLastCheck ?? 0);
  if (!isUrgent || !canAct || attempted || totalCompressRuns > current.compressRunsAtLastCheck) {
    return { ...current, ignoredStreak: 0, compressRunsAtLastCheck: totalCompressRuns,
      ...(current.attempts !== undefined ? { attemptsAtLastCheck: current.attempts } : {}) };
  }
  return {
    ...current, ignoredStreak: current.ignoredStreak + 1,
    compressRunsAtLastCheck: totalCompressRuns,
  };
}

/**
 * Whether sustained non-compliance warrants forcing the mechanical masking
 * escalation (core/pipeline.ts) — a tightened-recency-guard observation-mask
 * pass that runs BEFORE the hard cap, instead of waiting for the token
 * ceiling. There is no host hook that lets the adapter invoke the model
 * directly to force a real narrative compress, so this is the strongest
 * enforceable fallback available for ignored nudges short of hardCap's
 * whole-message drops.
 */
export function shouldForceMechanicalEscalation(escalation: NudgeEscalationState): boolean {
  return escalation.ignoredStreak >= ESCALATION_STREAK_THRESHOLD;
}

/** Determine whether a compress tool injection is warranted. */
export function shouldInjectCompress(level: NudgeLevel): boolean {
  return level === "upper" || level === "safety-cap";
}

/**
 * Append nudge text to the current user tail, or reapply it to an explicitly
 * anchored user message during that turn's tool loop.
 *
 * This is the delivery path adapters use when the host's system-prompt channel is
 * unavailable or unsafe to write to (e.g. the opencode reporting-agent, where
 * injecting into the dynamic system prompt produced empty assistant responses).
 *
 * A tool loop has assistant/tool messages after its user turn. Recomputing text
 * on that earlier message changes the cached prefix and destroys provider cache
 * reuse. Callers therefore persist and reapply the exact same text to the same
 * user message for the whole loop.
 *
 * Pure: returns a new array when a nudge is applied, otherwise the input array.
 * Hosts re-feed original (untransformed) message history each turn, so the nudge
 * does not accumulate across turns.
 */
export function appendNudgeToLastUser(
  messages: NeutralMessage[],
  nudgeText: string | undefined,
  anchoredUserMessageId?: string,
): NeutralMessage[] {
  if (!nudgeText) return messages;

  let lastVisibleIndex = -1;
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.isIgnored) continue;
    if (lastVisibleIndex === -1) lastVisibleIndex = i;
    if (anchoredUserMessageId && message.role === "user" && message.id === anchoredUserMessageId) {
      targetIndex = i;
      break;
    }
  }
  if (lastVisibleIndex === -1) return messages;
  if (!anchoredUserMessageId) targetIndex = lastVisibleIndex;
  if (targetIndex === -1) return messages;

  const message = messages[targetIndex];
  if (message.role !== "user") return messages;
  const idx = message.parts.findIndex(p => p.type === "text");
  if (idx === -1) return messages;
  const part = message.parts[idx] as TextPart;
  const newParts = [...message.parts];
  newParts[idx] = { ...part, text: `${part.text}\n\n${nudgeText}` };
  const newMessages = [...messages];
  newMessages[targetIndex] = { ...message, parts: newParts };
  return newMessages;

}
