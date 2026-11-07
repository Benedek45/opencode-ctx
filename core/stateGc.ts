// PolyForm Noncommercial License 1.0.0 — see LICENSE
// State GC: prune orphaned entries from the decision sets and message index.
//
// The decide/apply split means decisions accumulate in CoreState as Sets/Maps
// keyed by callId or messageId. Under normal operation these grow without bound
// as the session runs: dedup/staleError/nearDupe/mask decisions and hardCap
// dropped-message records are never explicitly removed.
//
// This function prunes entries for callIds / messageIds that are no longer
// present in the current message array at all (i.e. the host stopped sending
// them — opencode drops messages from its store after compaction, branch
// switching, or session pruning). It intentionally KEEPS entries for messages
// that are still in the array but flagged isIgnored=true, since those will
// reappear in the next re-feed and the decisions must be re-applied.
//
// Run at the end of each pipeline turn (after hardCap, before finalize) against
// the full pre-finalize message list so isIgnored messages are still visible.

import type { NeutralMessage, ToolPart } from "../types/neutral.js";
import type { CoreState } from "../types/state.js";

/**
 * Prune orphaned state entries for messages and tool calls no longer in the
 * conversation. Mutates `state` in place — no return value.
 */
export function runStateGc(messages: NeutralMessage[], state: CoreState): void {
  // Collect live IDs from the full (pre-finalize) message list, including
  // isIgnored messages — those still come back in the next re-feed.
  const liveMessageIds = new Set<string>();
  const liveCallIds = new Set<string>();

  for (const m of messages) {
    liveMessageIds.add(m.id);
    for (const p of m.parts) {
      if (p.type === "tool") {
        liveCallIds.add((p as ToolPart).callId);
      }
    }
  }

  // Prune callId-keyed decision sets
  for (const callId of state.dedupDecisions) {
    if (!liveCallIds.has(callId)) state.dedupDecisions.delete(callId);
  }
  for (const callId of state.staleErrorDecisions) {
    if (!liveCallIds.has(callId)) state.staleErrorDecisions.delete(callId);
  }
  for (const callId of state.nearDupeDecisions) {
    if (!liveCallIds.has(callId)) state.nearDupeDecisions.delete(callId);
  }
  for (const callId of state.maskDecisions.keys()) {
    if (!liveCallIds.has(callId)) state.maskDecisions.delete(callId);
  }

  // Prune hardCapDroppedIds for messages truly gone from the array
  // (if the message is still in the array as isIgnored, we keep the decision)
  for (const msgId of state.hardCapDroppedIds) {
    if (!liveMessageIds.has(msgId)) state.hardCapDroppedIds.delete(msgId);
  }

  // Prune only the legacy mask/offload index, which is strictly callId-keyed.
  // IMPORTANT: state.messageIndex is keyed by CALL ID (not message ID), even
  // though the type comment says "messageId -> entry". The key is toolPart.callId,
  // matching maskDecisions. Use liveCallIds here — not liveMessageIds.
  for (const callId of state.messageIndex.keys()) {
    if (!liveCallIds.has(callId)) state.messageIndex.delete(callId);
  }

  // blockRegistry and compressionIndex are durable restore state. Their source
  // messages may be absent after host compaction and must not be collected here.
}
