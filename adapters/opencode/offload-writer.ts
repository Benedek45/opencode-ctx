// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Failure-atomic adapter materialization for core offload requests.

import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
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
      const sessionDir = dirname(request.path);
      const rootDir = dirname(sessionDir);
      if (basename(rootDir) === ".ctx-offload") {
        for (const dir of [rootDir, sessionDir]) {
          try {
            const info = await lstat(dir);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("offload directory is not a real directory");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      // Only chmod the known plugin-owned tree, never workspace/temp ancestors.
      if (basename(rootDir) === ".ctx-offload") {
        await chmod(rootDir, 0o700);
        await chmod(sessionDir, 0o700);
      }
      await writeFile(tmp, request.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
