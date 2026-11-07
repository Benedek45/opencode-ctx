// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Failure-atomic adapter materialization for core offload requests.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../services/logger.js";
import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { OffloadRequest } from "../../core/strategies/observationMask.js";

export async function materializeOffloadRequests(
  requests: OffloadRequest[],
  state: CoreState,
  logger: Logger
): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const request of requests) {
    const tmp = `${request.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(request.path), { recursive: true });
      await writeFile(tmp, request.content, "utf8");
      await rename(tmp, request.path);
    } catch (err) {
      failed.add(request.callId);
      try { await rm(tmp, { force: true }); } catch { /* best effort */ }
      state.maskDecisions.delete(request.callId);
      state.messageIndex.delete(request.callId);
      state.stats.totalTokensOffloaded = Math.max(0, state.stats.totalTokensOffloaded - request.tokens);
      state.stats.totalTokensSaved = Math.max(0, state.stats.totalTokensSaved - request.tokens);
      logger.warn(`ctx: offload write failed for ${request.callId}; restored inline output`, err);
    }
  }
  return failed;
}

export function restoreFailedOffloadOutputs(
  projected: NeutralMessage[],
  raw: NeutralMessage[],
  failed: Set<string>
): NeutralMessage[] {
  if (failed.size === 0) return projected;
  const original = new Map<string, string | undefined>();
  for (const message of raw) {
    for (const part of message.parts) {
      if (part.type === "tool" && failed.has(part.callId)) original.set(part.callId, part.output);
    }
  }
  return projected.map(message => ({
    ...message,
    parts: message.parts.map(part =>
      part.type === "tool" && failed.has(part.callId)
        ? { ...part, output: original.get(part.callId) }
        : part
    ),
  }));
}
