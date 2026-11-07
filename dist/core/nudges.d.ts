import type { CoreConfig } from "../types/config.js";
import type { NeutralMessage } from "../types/neutral.js";
import type { NudgeEscalationState } from "../types/state.js";
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
export declare function resolveCompressionTarget(config: CoreConfig): number;
/** Compact trusted accounting appended to the latest user message each request. */
export declare function buildContextStatusText(metrics: ContextTokenMetrics, canCompress: boolean, eligibility?: CompressionCandidateReport): string;
/** Metadata only: no source content, guesses about completion, or guard bypass. */
export declare function buildCompressionGuidance(report: CompressionCandidateReport): string;
/**
 * Determine the nudge level for the current token count.
 *
 * Thresholds may be absolute token counts or "X%" of the model context limit
 * (resolved here), so the ladder scales correctly across model window sizes.
 * Order of checks is most-urgent-first.
 */
export declare function getNudgeLevel(totalTokens: number, config: CoreConfig): NudgeLevel;
/**
 * Consecutive urgent (upper/safety-cap) turns without an intervening compress
 * run before the wording escalates and the pipeline forces an extra mechanical
 * masking pass (see shouldForceMechanicalEscalation / core/pipeline.ts).
 */
export declare const ESCALATION_STREAK_THRESHOLD = 3;
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
export declare function buildNudgeText(level: NudgeLevel, totalTokens: number, effectiveBudget: number, ignoredStreak?: number, eligibility?: CompressionCandidateReport): string | undefined;
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
export declare function updateNudgeEscalation(level: NudgeLevel, totalCompressRuns: number, current: NudgeEscalationState, canAct?: boolean): NudgeEscalationState;
/**
 * Whether sustained non-compliance warrants forcing the mechanical masking
 * escalation (core/pipeline.ts) — a tightened-recency-guard observation-mask
 * pass that runs BEFORE the hard cap, instead of waiting for the token
 * ceiling. There is no host hook that lets the adapter invoke the model
 * directly to force a real narrative compress, so this is the strongest
 * enforceable fallback available for ignored nudges short of hardCap's
 * whole-message drops.
 */
export declare function shouldForceMechanicalEscalation(escalation: NudgeEscalationState): boolean;
/** Determine whether a compress tool injection is warranted. */
export declare function shouldInjectCompress(level: NudgeLevel): boolean;
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
export declare function appendNudgeToLastUser(messages: NeutralMessage[], nudgeText: string | undefined, anchoredUserMessageId?: string): NeutralMessage[];
//# sourceMappingURL=nudges.d.ts.map