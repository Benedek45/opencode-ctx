// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Finalize stage: last-pass cleanup before sending messages to the model.

import type { NeutralMessage, TextPart } from "../types/neutral.js";

/**
 * Finalize the message list:
 * - Remove messages marked isIgnored=true from the output.
 * - Ensure the list is in chronological order (by createdAt).
 * - Inject a visible `<ctx-message-id>REF</ctx-message-id>` tag into each message
 *   so the model can address ranges by ref when calling the `compress` tool.
 *
 * Tag injection is the counterpart to the strip in the tagging stage: tagging
 * removes the prior turn's tags (and any hallucinated ones), finalize re-injects
 * the authoritative ref. This keeps the operation idempotent across turns.
 */
export function runFinalize(messages: NeutralMessage[]): NeutralMessage[] {
  return messages
    .filter(m => !m.isIgnored)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(injectRefTag);
}

/**
 * Prepend the message's ref tag to its first text part.
 *
 * Skips messages with no ref, summary blocks (their block ref `bN` is carried in
 * the summary envelope text), and messages with no text part to attach to.
 */
function injectRefTag(msg: NeutralMessage): NeutralMessage {
  if (!msg.ref || msg.isSummary) return msg;

  // Only tag a text part that ALREADY has content. The in-flight assistant
  // message (the turn the model is about to generate) reaches messages.transform
  // with an EMPTY text part to stream into; writing a ref tag into it makes the
  // trailing assistant turn look already-answered, so the model returns an empty
  // response. Skipping empty parts also correctly tags messages whose first text
  // part is blank but which carry content in a later part.
  const idx = msg.parts.findIndex(
    p => p.type === "text" && (p as TextPart).text.trim() !== ""
  );
  if (idx === -1) return msg;

  const part = msg.parts[idx] as TextPart;
  const tag = `<ctx-message-id>${msg.ref}</ctx-message-id>`;

  // Defensive idempotency: if a leading tag survived (it shouldn't — tagging
  // strips inbound tags), drop it before prepending the authoritative one.
  const existing = part.text.replace(/^<ctx-message-id\b[^>]*>[\s\S]*?<\/ctx-message-id>\n?/i, "");
  const newText = `${tag}\n${existing}`;
  if (newText === part.text) return msg;

  const newParts = [...msg.parts];
  newParts[idx] = { ...part, text: newText };
  return { ...msg, parts: newParts };
}
