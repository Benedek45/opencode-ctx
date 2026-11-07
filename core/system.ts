// PolyForm Noncommercial License 1.0.0 — see LICENSE
// System prompt utilities: inject nudge text into the system prompt.

/**
 * Append nudge text to a system prompt string.
 * The nudge is appended at the tail (recency anchoring).
 */
export function appendNudgeToSystem(systemPrompt: string, nudgeText: string): string {
  if (!nudgeText) return systemPrompt;
  return `${systemPrompt}\n\n${nudgeText}`;
}
