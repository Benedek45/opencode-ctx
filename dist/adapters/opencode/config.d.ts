import type { AutomationConfig, CachePruneConfig, ContextTierConfig, CoreConfig, LayeredConfig, SummarizationConfig } from "../../types/config.js";
import { type SessionCacheOptions } from "./session-cache.js";
/**
 * Raw plugin options shape as passed via opencode.json plugin config.
 * All fields are optional; unset fields inherit defaults.
 *
 * Example opencode.json entry:
 *   "plugin": [["./adapters/opencode/plugin.ts", { "ctx": { "profile": "documents" } }]]
 */
export interface CtxPluginOptions {
    /** Root-shared resident cache; stricter values win across plugin factories. */
    sessionCache?: Partial<SessionCacheOptions>;
    /** Active profile: "documents" | "code" | "balanced". Default: "documents". */
    profile?: string;
    /** Recency guard turns. Default: 10. */
    recencyGuardTurns?: number;
    /** Model-driven compression request guard. Default: 3; 0 disables. */
    compressionRecencyRequests?: number;
    /** Per-tool retention classes; provider/model/runtime layers may override these. */
    toolClasses?: CoreConfig["toolClasses"];
    /** Minimum turns between masking passes. Default: 3. */
    minRepruneInterval?: number;
    /** Minimum tokens a masking pass must recover. Default: 2000. */
    clearAtLeast?: number;
    /** Nudge thresholds (partial). Each may be an absolute token count or a "X%" string. */
    nudges?: {
        lowerThreshold?: number | string;
        midSoftNudge?: number | string;
        upperThreshold?: number | string;
        safetyCap?: string;
        maskTriggerThreshold?: number | string;
    };
    /** Cost-ROI gate. */
    costRoi?: {
        enabled?: boolean;
    };
    /** Master switches for automatic pruning and model-called compression. */
    automation?: Partial<AutomationConfig>;
    /** Hot/warm/cold tier budgets and lifecycle (partial; strictly validated). */
    contextTiers?: Partial<ContextTierConfig>;
    /** Dedup/stale-error cache-prune triggers. */
    cachePrune?: Partial<CachePruneConfig>;
    /** Summarization config. */
    summarization?: Partial<SummarizationConfig>;
    /** Near-duplicate (SimHash) dedup gate, alongside exact-match dedup. Default: { enabled: true }. */
    nearDupe?: {
        enabled?: boolean;
    };
    /** Hard-cap threshold: absolute token count or "X%" of context. Default "92%". */
    hardCap?: number | string;
    /** Provider-specific overrides keyed by providerID. */
    providers?: Record<string, LayeredConfig>;
    /** Model-specific overrides keyed by modelID. */
    models?: Record<string, LayeredConfig>;
    /** Storage directory for sidecar files. Default: XDG_DATA_HOME/opencode/storage. */
    storagePath?: string;
    /** Pre-execution output-risk routing. Default: off. */
    routing?: {
        mode?: "off" | "advise" | "enforce";
    };
    /** Durable raw/projected history and tool-output archive. Default: enabled. */
    contentStore?: {
        enabled?: boolean;
    };
    /** Authenticated loopback control plane. Default: disabled. */
    controlServer?: {
        enabled?: boolean;
        host?: "127.0.0.1" | "::1" | "localhost";
        port?: number;
        openBrowser?: boolean;
    };
    /** Tokenizer implementation. Char mode is fast and provider-calibrated. */
    tokenizer?: "auto" | "char" | "anthropic";
    /** Opt-in isolated SDK summarizer; never inherits a paid/default model silently. */
    summaryWorker?: {
        enabled?: boolean;
        model?: string;
        timeoutMs?: number;
        cleanupTimeoutMs?: number;
        maxInputTokens?: number;
        maxOutputTokens?: number;
        minIntervalMs?: number;
        sdkVersion?: "v1" | "v2";
    };
}
export declare function validateSummaryWorker(value: unknown): {
    enabled: boolean;
    model: string;
    timeoutMs: number;
    cleanupTimeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    minIntervalMs: number;
    sdkVersion: "v1" | "v2";
};
/** Strict plugin-only cache settings; zero would create a busy eviction loop. */
export declare function validateSessionCache(value: unknown): SessionCacheOptions;
/**
 * Build a CoreConfig for a session from the plugin options and model context limit.
 *
 * @param sessionId - The opencode session ID.
 * @param options - Raw plugin options from the opencode config hook.
 * @param modelContextLimit - Context limit from the provider (e.g. 1_000_000 for DeepSeek).
 * @param providerID - Provider ID (e.g. "opencode-go").
 * @param modelID - Model ID (e.g. "deepseek-v4-flash").
 */
export declare function buildCoreConfig(sessionId: string, options: CtxPluginOptions, modelContextLimit: number, providerID: string, _modelID: string, runtime?: LayeredConfig): CoreConfig;
/** Validate the dashboard's highest-precedence settings layer. */
export declare function validateRuntimeConfig(value: unknown): LayeredConfig;
/**
 * Extract context-manager plugin options from the opencode config hook input.
 * The plugin options are passed as the second element of the plugin tuple:
 *   ["./path/to/plugin.ts", { "ctx": { ... } }]
 */
export declare function extractPluginOptions(pluginEntry: unknown): CtxPluginOptions;
/**
 * Known internal model IDs used by opencode for title generation and summarization.
 * These agents should be skipped by the system transform (no context-manager text injected).
 * Detection is by modelID substring since there is no agent name in the system hook input.
 */
export declare const INTERNAL_MODEL_SUBSTRINGS: string[];
/**
 * Returns true if the model appears to be an internal opencode agent.
 *
 * `modelID` is read defensively: the vendored opencode system-transform hook
 * passes a `Provider.Model` whose id field is `id` (NOT `modelID`), so a naive
 * `model.modelID` read is `undefined`. Calling `.toLowerCase()` on `undefined`
 * threw and aborted the whole turn (empty assistant response). Guard the type
 * before touching string methods.
 */
export declare function isInternalModel(modelID: string | undefined): boolean;
//# sourceMappingURL=config.d.ts.map