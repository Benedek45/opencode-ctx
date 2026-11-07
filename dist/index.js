// PolyForm Noncommercial License 1.0.0 — see LICENSE
// context-manager-core: public API surface.
// Host-agnostic pure core — no I/O, no host SDK imports.
export { createInitialState, cloneCoreState } from "./types/state.js";
export { CharTokenizer, defaultTokenizer } from "./services/tokenizer.js";
export { WallClock, FakeClock, wallClock } from "./services/clock.js";
export { InMemoryPersistence } from "./services/persistence.js";
export { NoopLogger, ConsoleLogger, CapturingLogger, noopLogger } from "./services/logger.js";
export { InMemoryContentStore, contentHash, utf8ByteLength } from "./services/contentStore.js";
// Core pipeline
export { runPipeline } from "./core/pipeline.js";
export { applyManualOverrides } from "./core/manualOverrides.js";
export { selectActiveRootBlocks, planTierDemotions, applyTierDemotions, planDirectedTierSelection, applyDirectedTierSelection, buildColdCatalog, planTemporaryRetrieval, activateTemporaryRetrieval, expireTemporaryRetrievals } from "./core/contextTiers.js";
export { classifyTool } from "./core/routing.js";
// Config resolution
export { resolveConfig } from "./core/config.js";
export { buildDefaultConfig, CACHE_MODEL_DEEPSEEK, CACHE_MODEL_ANTHROPIC, CACHE_MODEL_OPENAI, DEFAULT_TOOL_CLASSES, ALWAYS_PROTECTED_TOOLS } from "./core/defaults.js";
// Profiles
export { getProfile, PROFILES } from "./core/profiles.js";
// Compress
export { executeCompress, selectCompressRange, findStableVolatileBoundary } from "./core/compress/execute.js";
export { applyCompress } from "./core/compress/apply.js";
export { decompressBlock, recompressBlock, activateCompressionBlock, deactivateCompressionBlock, recompressCompressionBlock } from "./core/compress/reversible.js";
export { planCompressionBatch, applyCompressionBatch, buildCompressionIndex, appendProtectedContent } from "./core/compress/transaction.js";
export { buildCompressPrompt } from "./core/compress/prompt.js";
// Strategies
export { runDedup } from "./core/strategies/dedup.js";
export { runStaleError } from "./core/strategies/staleError.js";
export { runNearDupe, estimateNearDupeSavings, simhash64, hammingDistance64 } from "./core/strategies/nearDupe.js";
export { runObservationMask } from "./core/strategies/observationMask.js";
// Budget / Cost-ROI
export { computeBudgetBreakdown, shouldTriggerMasking } from "./core/budget.js";
export { evaluateCostRoi, isColdCache, buildCostRoiInput, cachePruneAllowed, recordCacheBust, DEFAULT_E_TURNS } from "./core/budget/costRoi.js";
// Utilities
export { estimateContextTokens, estimateMessageTokens, computeEffectiveBudget, parseSafetyCapFraction, resolveSafetyCap } from "./core/tokens.js";
export { buildOffloadPath, extractPreviewLines, extractTailLines, countLines } from "./core/paths.js";
export { matchesGlob, findToolClassKey } from "./core/glob.js";
export { getRetentionTurns, isWithinTieredRetention, buildTightenedRecencyConfig, isAlwaysProtected } from "./core/strategies/guards.js";
export { stripHallucinatedTags, formatRef, runTagging } from "./core/tagging.js";
export { PLACEHOLDER_DEDUP, PLACEHOLDER_STALE_ERROR_INPUT, PLACEHOLDER_NEAR_DUPE, PLACEHOLDER_PLAIN_MASK, buildOffloadPointer, buildStatefulMask } from "./core/placeholders.js";
export { getNudgeLevel, buildNudgeText, shouldInjectCompress, updateNudgeEscalation, shouldForceMechanicalEscalation, ESCALATION_STREAK_THRESHOLD, } from "./core/nudges.js";
// Adapters (opencode fully wired; claude-code + bff typed stubs)
// Note: adapter imports are kept separate to avoid pulling host-SDK types into
// consumers that only need the pure core. Import from "./adapters/index.js" directly
// when you need adapter types.
export { CtxPlugin } from "./adapters/opencode/plugin.js";
export { toNeutral as opencodeToNeutral, applyNeutral as opencodeApplyNeutral } from "./adapters/opencode/map.js";
export { buildCoreConfig, isInternalModel } from "./adapters/opencode/config.js";
export { FilePersistence, AnthropicTokenizer, AdapterLogger, buildServices } from "./adapters/opencode/services.js";
export { FilesystemContentStore } from "./adapters/opencode/content-store.js";
export { startControlServer, RevisionConflictError } from "./adapters/opencode/control-server.js";
export { collectHandoff, importHandoff, loadImportedSeed, composeRecoveryEntries, localHandoffResourceReader, assertNewHandoffSession } from "./adapters/opencode/context-handoff.js";
export { encodeBundle, decodeBundle, PORTABLE_LIMITS } from "./adapters/opencode/portable-context.js";
export { readBundleFile, writeBundleFile, parseHandoffArguments } from "./adapters/opencode/portable-context-io.js";
//# sourceMappingURL=index.js.map