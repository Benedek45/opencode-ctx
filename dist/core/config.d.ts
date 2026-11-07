import type { CoreConfig, PluginConfig, ProviderConfig, ModelConfig, RuntimeConfig } from "../types/config.js";
/**
 * Merge configuration with precedence:
 * defaults < plugin < global < per-provider < per-model < runtime
 *
 * Later layers override earlier ones. Nested objects (cacheModel, nudges, etc.)
 * are merged shallowly (each key overrides independently).
 */
export declare function resolveConfig(sessionId: string, plugin?: PluginConfig, global?: PluginConfig, provider?: ProviderConfig, model?: ModelConfig, runtime?: RuntimeConfig): CoreConfig;
//# sourceMappingURL=config.d.ts.map