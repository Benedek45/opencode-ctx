// PolyForm Noncommercial License 1.0.0 — see LICENSE
// opencode host config → CoreConfig translation.
//
// Reads plugin config from the opencode config hook input and maps it to CoreConfig.
// The opencode config is a JSONC file; by the time the config hook fires, it has
// already been parsed into a plain object. We read the "ctx" key from the plugin
// options (if present) and merge it with the defaults.
import { resolveConfig } from "../../core/config.js";
import { CACHE_MODEL_DEEPSEEK } from "../../core/defaults.js";
import { DEFAULT_SESSION_CACHE } from "./session-cache.js";
export function validateSummaryWorker(value) {
    const result = { enabled: false, model: "", timeoutMs: 60_000, cleanupTimeoutMs: 5_000,
        maxInputTokens: 32_000, maxOutputTokens: 4_000, minIntervalMs: 60_000,
        sdkVersion: "v1" };
    if (value === undefined)
        return result;
    const options = record(value, "ctx.summaryWorker");
    rejectUnknown(options, Object.keys(result), "ctx.summaryWorker");
    if (options.enabled !== undefined) {
        if (typeof options.enabled !== "boolean")
            throw new Error("ctx.summaryWorker.enabled must be boolean");
        result.enabled = options.enabled;
    }
    if (options.model !== undefined) {
        if (typeof options.model !== "string" || !/^[^\s/]+\/\S+$/.test(options.model)) {
            throw new Error("ctx.summaryWorker.model must be explicit provider/model");
        }
        result.model = options.model;
    }
    if (result.enabled && !result.model)
        throw new Error("enabled summaryWorker requires explicit provider/model");
    for (const key of ["timeoutMs", "cleanupTimeoutMs", "maxInputTokens", "maxOutputTokens", "minIntervalMs"]) {
        if (options[key] !== undefined) {
            if (typeof options[key] !== "number" || !Number.isSafeInteger(options[key]) || options[key] <= 0) {
                throw new Error(`ctx.summaryWorker.${key} must be a positive safe integer`);
            }
            result[key] = options[key];
        }
    }
    if (options.sdkVersion !== undefined) {
        if (options.sdkVersion !== "v1" && options.sdkVersion !== "v2")
            throw new Error("summaryWorker.sdkVersion must be v1 or v2");
        result.sdkVersion = options.sdkVersion;
    }
    return result;
}
/** Strict plugin-only cache settings; zero would create a busy eviction loop. */
export function validateSessionCache(value) {
    const defaults = DEFAULT_SESSION_CACHE;
    if (value === undefined)
        return defaults;
    const nested = record(value, "ctx.sessionCache");
    rejectUnknown(nested, ["maxBytes", "maxSessions", "idleTtlMs"], "ctx.sessionCache");
    const result = { ...defaults };
    for (const key of ["maxBytes", "maxSessions", "idleTtlMs"]) {
        if (nested[key] !== undefined) {
            if (typeof nested[key] !== "number" || !Number.isSafeInteger(nested[key]) || nested[key] <= 0) {
                throw new Error(`ctx.sessionCache.${key} must be a positive safe integer`);
            }
            result[key] = nested[key];
        }
    }
    return result;
}
/**
 * Build a CoreConfig for a session from the plugin options and model context limit.
 *
 * @param sessionId - The opencode session ID.
 * @param options - Raw plugin options from the opencode config hook.
 * @param modelContextLimit - Context limit from the provider (e.g. 1_000_000 for DeepSeek).
 * @param providerID - Provider ID (e.g. "opencode-go").
 * @param modelID - Model ID (e.g. "deepseek-v4-flash").
 */
export function buildCoreConfig(sessionId, options, modelContextLimit, providerID, _modelID, runtime) {
    // Build a plugin-level LayeredConfig from the raw options
    const pluginLayer = {};
    if (options.profile !== undefined) {
        pluginLayer.profile = options.profile;
    }
    if (options.recencyGuardTurns !== undefined) {
        pluginLayer.recencyGuardTurns = options.recencyGuardTurns;
    }
    if (options.compressionRecencyRequests !== undefined) {
        pluginLayer.compressionRecencyRequests = turnCount(options.compressionRecencyRequests, "ctx.compressionRecencyRequests");
    }
    if (options.toolClasses !== undefined) {
        pluginLayer.toolClasses = validateRuntimeConfig({ toolClasses: options.toolClasses }).toolClasses;
    }
    if (options.minRepruneInterval !== undefined) {
        pluginLayer.minRepruneInterval = options.minRepruneInterval;
    }
    if (options.clearAtLeast !== undefined) {
        pluginLayer.clearAtLeast = options.clearAtLeast;
    }
    if (options.nudges !== undefined) {
        pluginLayer.nudges = options.nudges;
    }
    if (options.costRoi !== undefined) {
        pluginLayer.costRoi = { enabled: options.costRoi.enabled ?? true };
    }
    if (options.automation !== undefined) {
        pluginLayer.automation = validateAutomation(options.automation, "ctx.automation");
    }
    if (options.contextTiers !== undefined) {
        pluginLayer.contextTiers = validateContextTiers(options.contextTiers, "ctx.contextTiers");
    }
    if (options.cachePrune !== undefined) {
        pluginLayer.cachePrune = options.cachePrune;
    }
    if (options.summarization !== undefined) {
        pluginLayer.summarization = options.summarization;
    }
    if (options.nearDupe !== undefined) {
        pluginLayer.nearDupe = { enabled: options.nearDupe.enabled ?? true };
    }
    if (options.hardCap !== undefined) {
        pluginLayer.hardCap = options.hardCap;
    }
    // Set model context limit
    pluginLayer.modelContextLimit = modelContextLimit;
    const providerOverrides = validateLayer(options.providers?.[providerID], `ctx.providers.${providerID}`);
    const providerLayer = {
        cacheModel: selectCacheModel(providerID),
        ...(providerOverrides ?? {}),
    };
    const modelLayer = validateLayer(options.models?.[_modelID], `ctx.models.${_modelID}`);
    const runtimeLayer = validateLayer(runtime, "runtime");
    const config = resolveConfig(sessionId, pluginLayer, undefined, providerLayer, modelLayer, runtimeLayer);
    return config;
}
const RUNTIME_KEYS = new Set([
    "profile",
    "recencyGuardTurns",
    "compressionRecencyRequests",
    "minRepruneInterval",
    "clearAtLeast",
    "cacheModel",
    "costRoi",
    "automation",
    "contextTiers",
    "cachePrune",
    "summarization",
    "nearDupe",
    "nudges",
    "hardCap",
    "toolClasses",
]);
function record(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${name} must be an object`);
    }
    return value;
}
function rejectUnknown(value, allowed, name) {
    const allow = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allow.has(key))
            throw new Error(`${name}.${key} is not a supported setting`);
    }
}
function finiteNonNegative(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return value;
}
function threshold(value, name) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return value;
    if (typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)) {
        const percent = Number.parseFloat(value);
        if (percent >= 0 && percent <= 100)
            return value;
    }
    throw new Error(`${name} must be a non-negative number or percentage string`);
}
function booleanValue(value, name) {
    if (typeof value !== "boolean")
        throw new Error(`${name} must be boolean`);
    return value;
}
function validateAutomation(value, name) {
    const nested = record(value, name);
    rejectUnknown(nested, ["automaticPruning", "modelCompression"], name);
    const result = {};
    if (nested.automaticPruning !== undefined) {
        result.automaticPruning = booleanValue(nested.automaticPruning, `${name}.automaticPruning`);
    }
    if (nested.modelCompression !== undefined) {
        result.modelCompression = booleanValue(nested.modelCompression, `${name}.modelCompression`);
    }
    return result;
}
function turnCount(value, name) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    return value;
}
function validateContextTiers(value, name) {
    const nested = record(value, name);
    rejectUnknown(nested, ["enabled", "warmMaxTokens", "warmBudgetMode", "ageDemotionEnabled", "warmMaxAgeTurns", "catalogMaxTokens", "retrievalMaxTokens", "retrievalTtlTurns"], name);
    const result = {};
    if (nested.enabled !== undefined)
        result.enabled = booleanValue(nested.enabled, `${name}.enabled`);
    if (nested.warmMaxTokens !== undefined)
        result.warmMaxTokens = threshold(nested.warmMaxTokens, `${name}.warmMaxTokens`);
    if (nested.warmBudgetMode !== undefined) {
        if (nested.warmBudgetMode !== "strict" && nested.warmBudgetMode !== "advisory") {
            throw new Error(`${name}.warmBudgetMode must be strict or advisory`);
        }
        result.warmBudgetMode = nested.warmBudgetMode;
    }
    if (nested.ageDemotionEnabled !== undefined)
        result.ageDemotionEnabled = booleanValue(nested.ageDemotionEnabled, `${name}.ageDemotionEnabled`);
    if (nested.warmMaxAgeTurns !== undefined)
        result.warmMaxAgeTurns = turnCount(nested.warmMaxAgeTurns, `${name}.warmMaxAgeTurns`);
    if (nested.catalogMaxTokens !== undefined)
        result.catalogMaxTokens = threshold(nested.catalogMaxTokens, `${name}.catalogMaxTokens`);
    if (nested.retrievalMaxTokens !== undefined)
        result.retrievalMaxTokens = threshold(nested.retrievalMaxTokens, `${name}.retrievalMaxTokens`);
    if (nested.retrievalTtlTurns !== undefined)
        result.retrievalTtlTurns = turnCount(nested.retrievalTtlTurns, `${name}.retrievalTtlTurns`);
    return result;
}
/**
 * Validate compression request counts and nested automation/contextTiers overrides
 * (provider/model/runtime) and preserve every other field unchanged. Malformed
 * values, unknown keys, and truthy strings are rejected rather than ignored.
 */
function validateLayer(layer, name) {
    if (!layer || (layer.automation === undefined && layer.contextTiers === undefined && layer.compressionRecencyRequests === undefined))
        return layer;
    const next = { ...layer };
    if (layer.compressionRecencyRequests !== undefined) {
        next.compressionRecencyRequests = turnCount(layer.compressionRecencyRequests, `${name}.compressionRecencyRequests`);
    }
    if (layer.automation !== undefined) {
        next.automation = validateAutomation(layer.automation, `${name}.automation`);
    }
    if (layer.contextTiers !== undefined) {
        next.contextTiers = validateContextTiers(layer.contextTiers, `${name}.contextTiers`);
    }
    return next;
}
function stringArray(value, name) {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
        throw new Error(`${name} must be an array of strings`);
    }
    return [...value];
}
/** Validate the dashboard's highest-precedence settings layer. */
export function validateRuntimeConfig(value) {
    const input = record(value, "settings");
    for (const key of Object.keys(input)) {
        if (!RUNTIME_KEYS.has(key))
            throw new Error(`settings.${key} is not supported`);
    }
    const result = {};
    if (input.profile !== undefined) {
        if (input.profile !== "documents" && input.profile !== "code" && input.profile !== "balanced") {
            throw new Error("settings.profile must be documents, code, or balanced");
        }
        result.profile = input.profile;
    }
    if (input.recencyGuardTurns !== undefined)
        result.recencyGuardTurns = finiteNonNegative(input.recencyGuardTurns, "settings.recencyGuardTurns");
    if (input.compressionRecencyRequests !== undefined)
        result.compressionRecencyRequests = turnCount(input.compressionRecencyRequests, "settings.compressionRecencyRequests");
    if (input.minRepruneInterval !== undefined)
        result.minRepruneInterval = finiteNonNegative(input.minRepruneInterval, "settings.minRepruneInterval");
    if (input.clearAtLeast !== undefined)
        result.clearAtLeast = finiteNonNegative(input.clearAtLeast, "settings.clearAtLeast");
    if (input.hardCap !== undefined)
        result.hardCap = threshold(input.hardCap, "settings.hardCap");
    if (input.cacheModel !== undefined) {
        const nested = record(input.cacheModel, "settings.cacheModel");
        rejectUnknown(nested, ["type", "R", "effectiveTtlSeconds", "minCacheableTokens", "breakpointLimit"], "settings.cacheModel");
        result.cacheModel = {};
        if (nested.type !== undefined) {
            if (nested.type !== "automatic-free" && nested.type !== "explicit-paid") {
                throw new Error("settings.cacheModel.type must be automatic-free or explicit-paid");
            }
            result.cacheModel.type = nested.type;
        }
        for (const key of ["R", "effectiveTtlSeconds", "minCacheableTokens", "breakpointLimit"]) {
            if (nested[key] !== undefined)
                result.cacheModel[key] = finiteNonNegative(nested[key], `settings.cacheModel.${key}`);
        }
    }
    if (input.costRoi !== undefined) {
        const nested = record(input.costRoi, "settings.costRoi");
        rejectUnknown(nested, ["enabled"], "settings.costRoi");
        result.costRoi = nested.enabled === undefined ? {} : { enabled: booleanValue(nested.enabled, "settings.costRoi.enabled") };
    }
    if (input.automation !== undefined) {
        result.automation = validateAutomation(input.automation, "settings.automation");
    }
    if (input.contextTiers !== undefined) {
        result.contextTiers = validateContextTiers(input.contextTiers, "settings.contextTiers");
    }
    if (input.cachePrune !== undefined) {
        const nested = record(input.cachePrune, "settings.cachePrune");
        rejectUnknown(nested, ["afterCompress", "afterTtl", "ttlSeconds"], "settings.cachePrune");
        result.cachePrune = {};
        if (nested.afterCompress !== undefined)
            result.cachePrune.afterCompress = booleanValue(nested.afterCompress, "settings.cachePrune.afterCompress");
        if (nested.afterTtl !== undefined)
            result.cachePrune.afterTtl = booleanValue(nested.afterTtl, "settings.cachePrune.afterTtl");
        if (nested.ttlSeconds !== undefined)
            result.cachePrune.ttlSeconds = finiteNonNegative(nested.ttlSeconds, "settings.cachePrune.ttlSeconds");
    }
    if (input.summarization !== undefined) {
        const nested = record(input.summarization, "settings.summarization");
        rejectUnknown(nested, ["appendOnly", "protectedToolGlobs", "protectedFilePathGlobs", "preserveUserMessages", "preserveProtectTags", "minNetSavingsTokens"], "settings.summarization");
        const summary = {};
        if (nested.appendOnly !== undefined)
            summary.appendOnly = booleanValue(nested.appendOnly, "settings.summarization.appendOnly");
        if (nested.protectedToolGlobs !== undefined)
            summary.protectedToolGlobs = stringArray(nested.protectedToolGlobs, "settings.summarization.protectedToolGlobs");
        if (nested.protectedFilePathGlobs !== undefined)
            summary.protectedFilePathGlobs = stringArray(nested.protectedFilePathGlobs, "settings.summarization.protectedFilePathGlobs");
        if (nested.preserveUserMessages !== undefined)
            summary.preserveUserMessages = booleanValue(nested.preserveUserMessages, "settings.summarization.preserveUserMessages");
        if (nested.preserveProtectTags !== undefined)
            summary.preserveProtectTags = booleanValue(nested.preserveProtectTags, "settings.summarization.preserveProtectTags");
        if (nested.minNetSavingsTokens !== undefined)
            summary.minNetSavingsTokens = finiteNonNegative(nested.minNetSavingsTokens, "settings.summarization.minNetSavingsTokens");
        result.summarization = summary;
    }
    if (input.nearDupe !== undefined) {
        const nested = record(input.nearDupe, "settings.nearDupe");
        rejectUnknown(nested, ["enabled"], "settings.nearDupe");
        result.nearDupe = nested.enabled === undefined ? {} : { enabled: booleanValue(nested.enabled, "settings.nearDupe.enabled") };
    }
    if (input.nudges !== undefined) {
        const nested = record(input.nudges, "settings.nudges");
        rejectUnknown(nested, ["lowerThreshold", "midSoftNudge", "upperThreshold", "safetyCap", "maskTriggerThreshold"], "settings.nudges");
        result.nudges = {};
        for (const key of ["lowerThreshold", "midSoftNudge", "upperThreshold", "maskTriggerThreshold"]) {
            if (nested[key] !== undefined)
                result.nudges[key] = threshold(nested[key], `settings.nudges.${key}`);
        }
        if (nested.safetyCap !== undefined) {
            const value = nested.safetyCap;
            if (typeof value === "string" && /^\d+(?:\.\d+)?%$/.test(value)) {
                result.nudges.safetyCap = value;
            }
            else if (typeof value === "string" && /^\d+(?:\.\d+)?%[:\-]\d+$/.test(value)) {
                result.nudges.safetyCap = value;
            }
            else {
                throw new Error('settings.nudges.safetyCap must be a percentage string like "95%" or "95%:30000"');
            }
        }
    }
    if (input.toolClasses !== undefined) {
        const nested = record(input.toolClasses, "settings.toolClasses");
        result.toolClasses = {};
        for (const [name, raw] of Object.entries(nested)) {
            const item = record(raw, `settings.toolClasses.${name}`);
            rejectUnknown(item, ["stateless", "retentionTurns"], `settings.toolClasses.${name}`);
            result.toolClasses[name] = {
                stateless: booleanValue(item.stateless, `settings.toolClasses.${name}.stateless`),
                retentionTurns: finiteNonNegative(item.retentionTurns, `settings.toolClasses.${name}.retentionTurns`),
            };
        }
    }
    return result;
}
/**
 * Select the appropriate cache model descriptor for a provider.
 * DeepSeek (via opencode-go) uses automatic-free caching with R=50.
 *
 * `providerID` is read defensively: the vendored opencode hook can pass a model
 * object whose provider id is absent, and `providerID.includes(...)` on a
 * non-string would throw — which must never happen in a read-only hook.
 */
function selectCacheModel(providerID) {
    // opencode-go / DeepSeek: automatic-free, long TTL, high R
    if (typeof providerID === "string" && (providerID === "opencode-go" || providerID.includes("deepseek"))) {
        return CACHE_MODEL_DEEPSEEK;
    }
    // Default: automatic-free with R=1 (conservative)
    return { type: "automatic-free", R: 1, effectiveTtlSeconds: 3600 };
}
/**
 * Extract context-manager plugin options from the opencode config hook input.
 * The plugin options are passed as the second element of the plugin tuple:
 *   ["./path/to/plugin.ts", { "ctx": { ... } }]
 */
export function extractPluginOptions(pluginEntry) {
    if (!Array.isArray(pluginEntry) || pluginEntry.length < 2)
        return {};
    const opts = pluginEntry[1];
    if (typeof opts !== "object" || opts === null)
        return {};
    const managerOptions = opts["ctx"];
    if (typeof managerOptions !== "object" || managerOptions === null)
        return {};
    return managerOptions;
}
/**
 * Known internal model IDs used by opencode for title generation and summarization.
 * These agents should be skipped by the system transform (no context-manager text injected).
 * Detection is by modelID substring since there is no agent name in the system hook input.
 */
export const INTERNAL_MODEL_SUBSTRINGS = [
    "title",
    "summarize",
    "compaction",
    "summary",
];
/**
 * Returns true if the model appears to be an internal opencode agent.
 *
 * `modelID` is read defensively: the vendored opencode system-transform hook
 * passes a `Provider.Model` whose id field is `id` (NOT `modelID`), so a naive
 * `model.modelID` read is `undefined`. Calling `.toLowerCase()` on `undefined`
 * threw and aborted the whole turn (empty assistant response). Guard the type
 * before touching string methods.
 */
export function isInternalModel(modelID) {
    if (typeof modelID !== "string")
        return false;
    const lower = modelID.toLowerCase();
    return INTERNAL_MODEL_SUBSTRINGS.some(s => lower.includes(s));
}
//# sourceMappingURL=config.js.map