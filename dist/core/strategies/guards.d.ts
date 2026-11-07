import type { NeutralMessage, ToolPart } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
/**
 * Determine whether a tool call is within the recency guard window.
 * Tool calls within `recencyGuardTurns` of the current turn are exempt.
 * Zero retention still preserves the current user turn (including tool loops).
 */
export declare function isWithinRecencyGuard(toolPart: ToolPart, currentTurn: number, config: CoreConfig): boolean;
/**
 * Determine whether a tool is always protected from automatic strategies.
 */
export declare function isAlwaysProtected(toolName: string): boolean;
/**
 * Get the retention turns for a tool name from config.
 * Falls back to recencyGuardTurns if not found.
 */
export declare function getRetentionTurns(toolName: string, config: CoreConfig): number;
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
export declare function buildTightenedRecencyConfig(config: CoreConfig, maxTurns: number): CoreConfig;
/**
 * Determine whether a tool call is within its tiered retention window.
 * Uses per-tool retentionTurns from config, with a one-user-turn safety floor.
 */
export declare function isWithinTieredRetention(toolPart: ToolPart, currentTurn: number, config: CoreConfig): boolean;
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
export declare function isOrphanSafe(toolPart: ToolPart): boolean;
/**
 * Collect all tool parts from a list of messages that are eligible for masking.
 * Eligibility: completed, not always-protected, not within tiered retention.
 */
export declare function collectEligibleToolParts(messages: NeutralMessage[], currentTurn: number, config: CoreConfig): Array<{
    messageId: string;
    partIndex: number;
    toolPart: ToolPart;
}>;
//# sourceMappingURL=guards.d.ts.map