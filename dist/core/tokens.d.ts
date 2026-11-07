import type { NeutralMessage, NeutralPart } from "../types/neutral.js";
import type { Tokenizer } from "../services/tokenizer.js";
/** Estimate tokens for a single part. */
export declare function estimatePartTokens(part: NeutralPart, tokenizer: Tokenizer): number;
/**
 * Estimate total tokens for a message's serialized content.
 *
 * Do NOT use `msg.tokens` here. Host token metadata is provider usage for a
 * model turn: on assistant messages, `tokens.input` is the full prompt/context
 * sent for that turn, not the size of this single message. Summing those values
 * across history makes nudge/hard-cap estimates grow cumulatively with every
 * previous turn instead of reflecting the current projected context window.
 */
export declare function estimateMessageTokens(msg: NeutralMessage, tokenizer: Tokenizer): number;
/** Estimate total tokens for a list of messages. */
export declare function estimateContextTokens(messages: NeutralMessage[], tokenizer: Tokenizer): number;
/**
 * Resolve a threshold value to an absolute token count.
 *
 * A number is treated as an absolute token count. A string of the form "X%" is
 * resolved as that fraction of the model context limit (so thresholds scale with
 * the model window instead of being hard-coded for a single ~1M-token model).
 * An unparseable value yields +Infinity so it never accidentally triggers.
 */
export declare function resolveThreshold(value: number | string, modelContextLimit: number): number;
/**
 * Parse a safetyCap string like "80%" into a fraction (0.8).
 * Returns 0.8 if parsing fails.
 */
export declare function parseSafetyCapFraction(safetyCap: string): number;
/**
 * Resolve a safety-cap value to an absolute token count.
 *
 * Accepted forms:
 *   - a number: absolute token count
 *   - "X%": X percent of the model context limit
 *   - "X%:N" or "X%-N": the earlier of X% of the limit and N tokens of
 *     headroom (i.e. min(X% of limit, limit - N)). This keeps a minimum
 *     response budget even on large windows.
 * An unparseable value yields +Infinity so it never accidentally triggers.
 */
export declare function resolveSafetyCap(value: number | string, modelContextLimit: number): number;
/**
 * Compute the effective token budget given a model context limit and safety cap.
 * Clamps to at least 1000 tokens.
 */
export declare function computeEffectiveBudget(modelContextLimit: number, safetyCap: string, systemPromptTokens: number): number;
//# sourceMappingURL=tokens.d.ts.map