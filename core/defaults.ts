// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Default configuration values for the context-manager-core.

import type { CoreConfig, CacheModel, ToolClassConfig } from "../types/config.js";

/** Default cache model for opencode-go / DeepSeek (automatic-free, long TTL). */
export const CACHE_MODEL_DEEPSEEK: CacheModel = {
  type: "automatic-free",
  R: 50,
  effectiveTtlSeconds: 3600,
};

/** Default cache model for Anthropic (explicit-paid, short TTL, breakpoint limit). */
export const CACHE_MODEL_ANTHROPIC: CacheModel = {
  type: "explicit-paid",
  R: 10,
  effectiveTtlSeconds: 300,
  minCacheableTokens: 1024,
  breakpointLimit: 4,
};

/** Default cache model for OpenAI (automatic-free, medium TTL). */
export const CACHE_MODEL_OPENAI: CacheModel = {
  type: "automatic-free",
  R: 5,
  effectiveTtlSeconds: 600,
};

/**
 * Default tool class configurations.
 *
 * Retention windows are calibrated in USER-TURN units (each complete
 * user-message → assistant-response exchange counts as one turn). This makes
 * "keep for N turns" mean "N conversational back-and-forths" regardless of how
 * many tool calls a single turn spawns.  Previously windows were in
 * MESSAGE-ARRAY-INDEX units, which made retention vary widely between tool-heavy
 * and chat-only sessions using the same numeric values.
 *
 * Calibration rationale (user turns):
 *   read/webfetch/websearch : 5 — file contents are typically referenced for a
 *                                  few exchanges before becoming stale; 5 gives
 *                                  comfortable headroom without burning context.
 *   glob/list/grep          : 2 — directory listings / search results go stale
 *                                  fast (files change, focus shifts).
 *   bash/stateful tools     : 5 — command outputs are relevant for the current
 *                                  debugging thread; 5 turns is a good balance
 *                                  between context and token budget.
 */
export const DEFAULT_TOOL_CLASSES: Record<string, ToolClassConfig> = {
  // Stateless, re-fetchable
  read:       { stateless: true,  retentionTurns: 5 },
  webfetch:   { stateless: true,  retentionTurns: 5 },
  websearch:  { stateless: true,  retentionTurns: 5 },
  glob:       { stateless: true,  retentionTurns: 2 },
  list:       { stateless: true,  retentionTurns: 2 },
  grep:       { stateless: true,  retentionTurns: 2 },
  // Stateful, not re-fetchable
  bash:       { stateless: false, retentionTurns: 5 },
  execute:    { stateless: false, retentionTurns: 5 },
  shell:      { stateless: false, retentionTurns: 5 },
  run_tests:  { stateless: false, retentionTurns: 5 },
  test:       { stateless: false, retentionTurns: 5 },
  compile:    { stateless: false, retentionTurns: 5 },
  apply_patch:{ stateless: false, retentionTurns: 5 },
  edit:       { stateless: false, retentionTurns: 5 },
  write:      { stateless: false, retentionTurns: 5 },
};

/**
 * Tools that are always protected from any automatic strategy.
 * These are meta-tools whose removal would corrupt the session.
 */
export const ALWAYS_PROTECTED_TOOLS = new Set([
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "compress_message",
  "ctx_archive_search",
  "ctx_archive_retrieve",
  "ctx_archive_release",
  "ctx_tier_update",
  "ctx_compression_status",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
]);

/** Build the default CoreConfig for a session. */
export function buildDefaultConfig(sessionId: string): CoreConfig {
  return {
    sessionId,
    profile: "documents",
    // Calibrated for user-turn units: 5 back-and-forths is a conservative guard.
    recencyGuardTurns: 5,
    compressionRecencyRequests: 3,
    minRepruneInterval: 3,
    clearAtLeast: 2000,
    cacheModel: CACHE_MODEL_DEEPSEEK,
    costRoi: { enabled: true },
    automation: {
      automaticPruning: true,
      modelCompression: true,
    },
    contextTiers: {
      enabled: true,
      warmMaxTokens: "8%",
      warmBudgetMode: "strict",
      ageDemotionEnabled: true,
      warmMaxAgeTurns: 40,
      catalogMaxTokens: "1%",
      retrievalMaxTokens: "8%",
      retrievalTtlTurns: 2,
    },
    cachePrune: {
      afterCompress: true,
      afterTtl: true,
      ttlSeconds: 360,
    },
    summarization: {
      appendOnly: true,
      protectedToolGlobs: [],
      protectedFilePathGlobs: [],
      preserveUserMessages: false,
      preserveProtectTags: true,
      minNetSavingsTokens: 0,
    },
    nearDupe: { enabled: true },
    nudges: {
      lowerThreshold: 150_000,
      midSoftNudge: 250_000,
      upperThreshold: 400_000,
      safetyCap: "95%:30000",
      maskTriggerThreshold: 150_000,
    },
    // Mechanical floor above the safety-cap nudge. Percentage so it scales to any
    // window; per-provider/model overridable like the nudge thresholds.
    hardCap: "92%",
    toolClasses: { ...DEFAULT_TOOL_CLASSES },
    modelContextLimit: 1_000_000,
    systemPromptTokens: 0,
  };
}
