// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Failure-atomic adapter materialization for core offload requests.
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export async function materializeOffloadRequests(requests, state, logger) {
    const failed = new Set();
    for (const request of requests) {
        const tmp = `${request.path}.${randomUUID()}.tmp`;
        try {
            await mkdir(dirname(request.path), { recursive: true });
            await writeFile(tmp, request.content, "utf8");
            await rename(tmp, request.path);
        }
        catch (err) {
            failed.add(request.callId);
            try {
                await rm(tmp, { force: true });
            }
            catch { /* best effort */ }
            state.maskDecisions.delete(request.callId);
            state.messageIndex.delete(request.callId);
            state.stats.totalTokensOffloaded = Math.max(0, state.stats.totalTokensOffloaded - request.tokens);
            state.stats.totalTokensSaved = Math.max(0, state.stats.totalTokensSaved - request.tokens);
            logger.warn(`ctx: offload write failed for ${request.callId}; restored inline output`, err);
        }
    }
    return failed;
}
export function restoreFailedOffloadOutputs(projected, raw, failed) {
    if (failed.size === 0)
        return projected;
    const original = new Map();
    for (const message of raw) {
        for (const part of message.parts) {
            if (part.type === "tool" && failed.has(part.callId))
                original.set(part.callId, part.output);
        }
    }
    return projected.map(message => ({
        ...message,
        parts: message.parts.map(part => part.type === "tool" && failed.has(part.callId)
            ? { ...part, output: original.get(part.callId) }
            : part),
    }));
}
//# sourceMappingURL=offload-writer.js.map