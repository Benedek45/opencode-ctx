// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Token estimation utilities for NeutralMessage/NeutralPart.
/** Estimate tokens for a single part. */
export function estimatePartTokens(part, tokenizer) {
    switch (part.type) {
        case "text":
            return tokenizer.countTokens(part.text);
        case "reasoning":
            return tokenizer.countTokens(part.text);
        case "step-start":
            return tokenizer.countTokens(part.label ?? "");
        case "tool": {
            const inputStr = typeof part.input === "string"
                ? part.input
                : JSON.stringify(part.input);
            const outputStr = part.output ?? "";
            return tokenizer.countTokens(inputStr) + tokenizer.countTokens(outputStr);
        }
        case "summary-block":
            return tokenizer.countTokens(part.text);
        default:
            return 0;
    }
}
/**
 * Estimate total tokens for a message's serialized content.
 *
 * Do NOT use `msg.tokens` here. Host token metadata is provider usage for a
 * model turn: on assistant messages, `tokens.input` is the full prompt/context
 * sent for that turn, not the size of this single message. Summing those values
 * across history makes nudge/hard-cap estimates grow cumulatively with every
 * previous turn instead of reflecting the current projected context window.
 */
export function estimateMessageTokens(msg, tokenizer) {
    return msg.parts.reduce((sum, p) => sum + estimatePartTokens(p, tokenizer), 0);
}
/** Estimate total tokens for a list of messages. */
export function estimateContextTokens(messages, tokenizer) {
    return messages
        .filter(m => !m.isIgnored)
        .reduce((sum, m) => sum + estimateMessageTokens(m, tokenizer), 0);
}
/**
 * Resolve a threshold value to an absolute token count.
 *
 * A number is treated as an absolute token count. A string of the form "X%" is
 * resolved as that fraction of the model context limit (so thresholds scale with
 * the model window instead of being hard-coded for a single ~1M-token model).
 * An unparseable value yields +Infinity so it never accidentally triggers.
 */
export function resolveThreshold(value, modelContextLimit) {
    if (typeof value === "number")
        return value;
    const match = value.match(/^(\d+(?:\.\d+)?)%$/);
    if (match)
        return Math.floor((modelContextLimit * parseFloat(match[1])) / 100);
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}
/**
 * Parse a safetyCap string like "80%" into a fraction (0.8).
 * Returns 0.8 if parsing fails.
 */
export function parseSafetyCapFraction(safetyCap) {
    const match = safetyCap.match(/^(\d+(?:\.\d+)?)%$/);
    if (!match)
        return 0.8;
    return parseFloat(match[1]) / 100;
}
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
export function resolveSafetyCap(value, modelContextLimit) {
    if (typeof value === "number")
        return value;
    const margin = value.match(/^(\d+(?:\.\d+)?)%\s*[:\-]\s*(\d+)$/);
    if (margin) {
        const percent = Math.floor((modelContextLimit * parseFloat(margin[1])) / 100);
        const headroom = modelContextLimit - parseInt(margin[2], 10);
        return Math.min(percent, headroom);
    }
    const percentMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
    if (percentMatch)
        return Math.floor((modelContextLimit * parseFloat(percentMatch[1])) / 100);
    const n = Number(value);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}
/**
 * Compute the effective token budget given a model context limit and safety cap.
 * Clamps to at least 1000 tokens.
 */
export function computeEffectiveBudget(modelContextLimit, safetyCap, systemPromptTokens) {
    const cap = resolveSafetyCap(safetyCap, modelContextLimit);
    return Math.max(1000, cap - systemPromptTokens);
}
//# sourceMappingURL=tokens.js.map