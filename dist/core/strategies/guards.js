// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Recency guard and orphan-pair safety logic.
import { ALWAYS_PROTECTED_TOOLS } from "../defaults.js";
import { findToolClassKey } from "../glob.js";
/**
 * Determine whether a tool call is within the recency guard window.
 * Tool calls within `recencyGuardTurns` of the current turn are exempt.
 * Zero retention still preserves the current user turn (including tool loops).
 */
export function isWithinRecencyGuard(toolPart, currentTurn, config) {
    if (toolPart.turn === undefined)
        return false;
    return (currentTurn - toolPart.turn) < Math.max(1, config.recencyGuardTurns);
}
/**
 * Determine whether a tool is always protected from automatic strategies.
 */
export function isAlwaysProtected(toolName) {
    return ALWAYS_PROTECTED_TOOLS.has(toolName);
}
/**
 * Get the retention turns for a tool name from config.
 * Falls back to recencyGuardTurns if not found.
 */
export function getRetentionTurns(toolName, config) {
    const key = findToolClassKey(toolName, config.toolClasses);
    if (key)
        return config.toolClasses[key].retentionTurns;
    return config.recencyGuardTurns;
}
/**
 * Build a config clone with `recencyGuardTurns` AND every registered tool
 * class's `retentionTurns` clamped to at most `maxTurns`.
 *
 * Per-tool `retentionTurns` (core/defaults.ts) governs eligibility ahead of the
 * `recencyGuardTurns` fallback (see getRetentionTurns above), so tightening
 * `recencyGuardTurns` ALONE has no effect on any tool with a registered class —
 * both must be clamped together for a "keep only the freshest N turns" forced
 * pass to actually reach classified tools (read/bash/edit/etc., which is most
 * tool traffic in practice). Used by mechanical, model-independent escalation
 * passes that need to force freshly-protected tool calls into eligibility:
 * hardCap Phase 1 (core/strategies/hardCap.ts) and the nudge-escalation forced
 * mask (core/pipeline.ts).
 */
export function buildTightenedRecencyConfig(config, maxTurns) {
    const toolClasses = Object.fromEntries(Object.entries(config.toolClasses).map(([name, cls]) => [
        name,
        { ...cls, retentionTurns: Math.min(cls.retentionTurns, maxTurns) },
    ]));
    return {
        ...config,
        recencyGuardTurns: Math.min(config.recencyGuardTurns, maxTurns),
        toolClasses,
    };
}
/**
 * Determine whether a tool call is within its tiered retention window.
 * Uses per-tool retentionTurns from config, with a one-user-turn safety floor.
 */
export function isWithinTieredRetention(toolPart, currentTurn, config) {
    if (toolPart.turn === undefined)
        return false;
    const retention = getRetentionTurns(toolPart.tool, config);
    return (currentTurn - toolPart.turn) < Math.max(1, retention);
}
/**
 * Build a map of callId -> paired callId for tool_use/tool_result pairs.
 * In our neutral model, tool calls are self-contained (input + output in one ToolPart),
 * so orphan-pair safety means: never mask a tool call whose output is still referenced
 * by a subsequent message (e.g. a user message that quotes the result).
 *
 * For the purposes of this implementation, we track pairs within the same message:
 * a ToolPart with status "completed" has both input and output — they are always
 * kept together. A ToolPart with status "pending" or "running" has no output yet
 * and must never be masked.
 */
export function isOrphanSafe(toolPart) {
    // A tool call is safe to mask only if it is completed (has output).
    return toolPart.status === "completed";
}
/**
 * Collect all tool parts from a list of messages that are eligible for masking.
 * Eligibility: completed, not always-protected, not within tiered retention.
 */
export function collectEligibleToolParts(messages, currentTurn, config) {
    const eligible = [];
    for (const msg of messages) {
        if (msg.isIgnored)
            continue;
        for (let i = 0; i < msg.parts.length; i++) {
            const part = msg.parts[i];
            if (part.type !== "tool")
                continue;
            if (!isOrphanSafe(part))
                continue;
            if (isAlwaysProtected(part.tool))
                continue;
            if (isWithinTieredRetention(part, currentTurn, config))
                continue;
            eligible.push({ messageId: msg.id, partIndex: i, toolPart: part });
        }
    }
    return eligible;
}
//# sourceMappingURL=guards.js.map