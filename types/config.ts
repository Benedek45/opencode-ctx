// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Configuration types for the context-manager-core.

/** Cache model parameters for a specific provider/model combination. */
export interface CacheModel {
  /** Cache type: "automatic-free" (no explicit breakpoints needed) or "explicit-paid". */
  type: "automatic-free" | "explicit-paid";
  /**
   * Cache reuse ratio R: the expected number of times a cached prefix is reused.
   * Cost-ROI gate: N_saved * E_turns > (R - 1) * N_after
   */
  R: number;
  /** Effective TTL in seconds. Used to detect cold cache (idle > ttl). */
  effectiveTtlSeconds: number;
  /** Minimum tokens to be worth caching (explicit-paid only). */
  minCacheableTokens?: number;
  /** Maximum number of cache breakpoints (explicit-paid only, e.g. Anthropic = 4). */
  breakpointLimit?: number;
}

/** Per-tool class configuration. */
export interface ToolClassConfig {
  /** Whether the tool's output can be re-fetched (stateless) or not (stateful). */
  stateless: boolean;
  /** Number of recent turns to keep the full output before masking. */
  retentionTurns: number;
}

/** Cost-ROI gate configuration. */
export interface CostRoiConfig {
  /** Whether the Cost-ROI gate is enabled. Default: true. */
  enabled: boolean;
}

/** Top-level switches for automatic context mutation and model-driven summaries. */
export interface AutomationConfig {
  /** Run mechanical dedup/stale/near-dupe/masking and hard-cap passes. */
  automaticPruning: boolean;
  /** Allow compression nudges, requests, tools, and the manual compress command. */
  modelCompression: boolean;
}

/** Hot/warm/cold projection and temporary retrieval budgets. */
export interface ContextTierConfig {
  enabled: boolean;
  warmMaxTokens: number | string;
  /** Strictly enforce warmMaxTokens, or expose it as model guidance only. */
  warmBudgetMode: "strict" | "advisory";
  /** Allow cache-aware automatic WARM -> COLD demotion based on block age. */
  ageDemotionEnabled: boolean;
  warmMaxAgeTurns: number;
  catalogMaxTokens: number | string;
  /** Per-call response safety cap for whole-summary archive retrieval. */
  retrievalMaxTokens: number | string;
  /** Compatibility TTL for temporary retrieval leases created by older versions. */
  retrievalTtlTurns: number;
}

/** Cache-conscious dedup/stale-error recomputation triggers. */
export interface CachePruneConfig {
  /** Recompute after a model-driven compress has already rewritten the prefix. */
  afterCompress: boolean;
  /** Recompute after this session has been idle past ttlSeconds. */
  afterTtl: boolean;
  /** Idle window for afterTtl, in seconds. Default: 360 (6 minutes). */
  ttlSeconds: number;
}

/** Summarization configuration. */
export interface SummarizationConfig {
  /**
   * If true (default), new compress writes a delta block at the stable/volatile
   * boundary; earlier blocks remain byte-identical. Consolidation only on full
   * restructure.
   */
  appendOnly: boolean;
  /** Tool-name globs whose complete calls must survive compression verbatim. */
  protectedToolGlobs?: string[];
  /** File-path globs whose associated tool calls must survive verbatim. */
  protectedFilePathGlobs?: string[];
  /** Preserve complete user messages verbatim. */
  preserveUserMessages?: boolean;
  /** Preserve every <protect>...</protect> span verbatim. */
  preserveProtectTags?: boolean;
  /** Reject transactional blocks saving fewer than this many tokens. */
  minNetSavingsTokens?: number;
}

/**
 * Near-duplicate dedup gate configuration (SimHash-based).
 *
 * Runs alongside exact-match dedup (core/strategies/dedup.ts) to catch cases
 * exact-match misses: re-reading overlapping file ranges, re-running a search
 * with a near-identical (but not byte-identical) result set, etc. Scoped to
 * stateless tool classes only (read/grep/glob/webfetch/websearch) — for
 * stateful tools (bash/test/etc.) small output differences are often
 * meaningful signal, not noise, so near-dup collapsing is not applied there.
 */
export interface NearDupeConfig {
  /** Whether near-duplicate detection runs alongside exact-match dedup. Default: true. */
  enabled: boolean;
}

/**
 * Nudge threshold configuration.
 *
 * Each threshold is an absolute token count (number) or a "X%" string resolved
 * against `modelContextLimit` at runtime (see core/tokens.ts:resolveThreshold),
 * so the same config scales across model window sizes.
 */
export interface NudgeThresholds {
  /** Gentle entry nudge threshold. Default: 150_000. */
  lowerThreshold: number | string;
  /** Mid-soft nudge threshold. Default: 250_000. */
  midSoftNudge: number | string;
  /** Strong nudge / quality-trigger threshold. Default: 400_000. */
  upperThreshold: number | string;
  /** Safety cap as a percentage string ("80%") or a margin form ("95%:30000"
   *  = the earlier of 95% of the window and 30k tokens of headroom). Default: "95%:30000". */
  safetyCap: string;
  /** Observation-masking trigger threshold. Default: 150_000. */
  maskTriggerThreshold: number | string;
}

/** Profile name. */
export type ProfileName = "documents" | "code" | "balanced";

/** Core configuration (merged from all precedence levels). */
export interface CoreConfig {
  /** Session identifier. */
  sessionId: string;
  /** Active profile. Default: "documents". */
  profile: ProfileName;
  /** Recency guard: tool calls within this many turns are exempt. Default: 10. */
  recencyGuardTurns: number;
  /** Model-driven compression only: real assistant requests strictly after a message. */
  compressionRecencyRequests: number;
  /** Minimum turns between masking passes. Default: 3. */
  minRepruneInterval: number;
  /** Minimum recoverable tokens to bother with a masking pass. Default: 2000. */
  clearAtLeast: number;
  /** Cache model for the active provider/model. */
  cacheModel: CacheModel;
  /** Cost-ROI gate config. */
  costRoi: CostRoiConfig;
  /** Independent master switches for mechanical pruning and model compression. */
  automation: AutomationConfig;
  /** Lifecycle and token budgets for compressed context tiers. */
  contextTiers: ContextTierConfig;
  /** Cache-conscious dedup/stale-error trigger config. */
  cachePrune: CachePruneConfig;
  /** Summarization config. */
  summarization: SummarizationConfig;
  /** Near-duplicate dedup gate config (SimHash-based, alongside exact-match dedup). */
  nearDupe: NearDupeConfig;
  /** Nudge thresholds. */
  nudges: NudgeThresholds;
  /**
   * Hard cap: when estimated context exceeds this, a mechanical, model-independent
   * compaction is FORCED (force-mask tool outputs, then drop oldest whole messages)
   * so a request stays below the provider's real context limit even if the model
   * ignored every nudge. Skipped when automation.automaticPruning is false.
   * Absolute token count or "X%" of modelContextLimit; should sit above safetyCap.
   * Default: "92%".
   */
  hardCap: number | string;
  /** Per-tool-name overrides (tool name -> class config). */
  toolClasses: Record<string, ToolClassConfig>;
  /** Model context limit in tokens. */
  modelContextLimit: number;
  /** System prompt token count (estimated). */
  systemPromptTokens: number;
}

/** Layered config override: all fields optional, nested objects also partial. */
export interface LayeredConfig {
  sessionId?: string;
  profile?: ProfileName;
  recencyGuardTurns?: number;
  compressionRecencyRequests?: number;
  minRepruneInterval?: number;
  clearAtLeast?: number;
  cacheModel?: Partial<CacheModel>;
  costRoi?: Partial<CostRoiConfig>;
  automation?: Partial<AutomationConfig>;
  contextTiers?: Partial<ContextTierConfig>;
  cachePrune?: Partial<CachePruneConfig>;
  summarization?: Partial<SummarizationConfig>;
  nearDupe?: Partial<NearDupeConfig>;
  nudges?: Partial<NudgeThresholds>;
  hardCap?: number | string;
  toolClasses?: Record<string, ToolClassConfig>;
  modelContextLimit?: number;
  systemPromptTokens?: number;
}

/** Raw plugin-level config (partial, lowest precedence). */
export type PluginConfig = LayeredConfig;

/** Per-provider config override. */
export type ProviderConfig = LayeredConfig;

/** Per-model config override. */
export type ModelConfig = LayeredConfig;

/** Runtime config override (highest precedence). */
export type RuntimeConfig = LayeredConfig;
