// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Persisted user overrides applied to the final context projection.

import type { NeutralMessage } from "../types/neutral.js";
import type { CoreState } from "../types/state.js";

/**
 * Apply dashboard-authored overrides after automatic pruning and the hard cap.
 * The source history remains untouched; only the outbound projection changes.
 */
export function applyManualOverrides(
  messages: NeutralMessage[],
  state: CoreState,
  originalMessages: NeutralMessage[] = messages
): NeutralMessage[] {
  if (state.manualOverrides.size === 0) return messages;

  const originals = new Map(originalMessages.map(message => [message.id, message]));
  const result: NeutralMessage[] = [];
  for (const message of messages) {
    const override = state.manualOverrides.get(message.id);
    if (!override) {
      result.push(message);
      continue;
    }

    if (override.mode === "exclude") {
      result.push({ ...message, isIgnored: true });
      continue;
    }

    if (override.mode === "keep") {
      const original = originals.get(message.id) ?? message;
      result.push({
        ...original,
        parts: original.parts.map(part => ({ ...part })),
        isIgnored: false,
      });
      continue;
    }

    const text = override.text ?? "";
    result.push({ ...message, isIgnored: true });
    result.push({
      id: `__manual_${message.id}`,
      role: message.role,
      sessionId: message.sessionId,
      createdAt: message.createdAt,
      isManualReplacement: true,
      parts: [{ type: "text", text }],
    });
  }
  return result;
}
