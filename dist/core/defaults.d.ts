import type { CoreConfig, CacheModel, ToolClassConfig } from "../types/config.js";
/** Default cache model for opencode-go / DeepSeek (automatic-free, long TTL). */
export declare const CACHE_MODEL_DEEPSEEK: CacheModel;
/** Default cache model for Anthropic (explicit-paid, short TTL, breakpoint limit). */
export declare const CACHE_MODEL_ANTHROPIC: CacheModel;
/** Default cache model for OpenAI (automatic-free, medium TTL). */
export declare const CACHE_MODEL_OPENAI: CacheModel;
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
export declare const DEFAULT_TOOL_CLASSES: Record<string, ToolClassConfig>;
/**
 * Tools that are always protected from any automatic strategy.
 * These are meta-tools whose removal would corrupt the session.
 */
export declare const ALWAYS_PROTECTED_TOOLS: Set<string>;
/** Build the default CoreConfig for a session. */
export declare function buildDefaultConfig(sessionId: string): CoreConfig;
//# sourceMappingURL=defaults.d.ts.map