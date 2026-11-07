// PolyForm Noncommercial License 1.0.0 — see LICENSE
// opencode plugin factory: binds the core pipeline to opencode's hook seams.
//
// This is the entry point for the opencode adapter. It exports a factory function
// that matches the opencode Plugin type: (input, options?) => Promise<Hooks>.
//
// Hooks wired:
//   "experimental.chat.messages.transform" -> core pipeline (transformMessages)
//   "experimental.chat.system.transform"   -> system nudge injection + context-limit cache
//   "experimental.text.complete"           -> hallucination tag stripping
//   "event"                                -> compress timing capture
//   "config"                               -> permission/command merge
//   "command.execute.before"               -> /ctx-compress manual trigger
//   "tool"                                 -> compress tool registration
//
// VERIFIED HOOK SHAPES (from vendor/opencode/packages/plugin/src/index.ts):
//   messages.transform: input={}, output={messages: {info, parts}[]}
//   system.transform:   input={sessionID?, model}, output={system: string[]}
//   text.complete:      input={sessionID, messageID, partID}, output={text: string}
//   event:              input={event: {type, properties}}, output=void
//   config:             input=Config (full config object), output=void
//   command.execute.before: input={command, sessionID, arguments}, output={parts}
//   tool:               { [key: string]: ToolDefinition }
//
// MISMATCH vs spec §4.2 assumption:
//   The spec says "skip internal agents via literal-substring check" in system.transform.
//   The actual system.transform input has NO agent name — only {sessionID?, model}.
//   The vendored opencode `Provider.Model` exposes the model id as `id` (NOT
//   `modelID`) and the provider as `providerID`. We resolve the id defensively
//   (id ?? modelID ?? info.id) and detect internal models from it. The whole
//   onSystemTransform body is try/catch-guarded so a missing/renamed field can
//   never throw and empty the turn. See config.ts:isInternalModel().
import { cloneCoreState } from "../../types/state.js";
import { CalibratedTokenizer } from "../../services/tokenizer.js";
import { toNeutral, advanceTurnBasis, applyNeutral, cloneHostEntries, completedToolOutputs, stripForeignProviderMetadata } from "./map.js";
import { AnthropicTokenizer, buildServices, loadOrCreateState } from "./services.js";
import { buildCoreConfig, extractPluginOptions, isInternalModel, validateRuntimeConfig, validateSessionCache, validateSummaryWorker } from "./config.js";
import { createOpenCodeSummarizer, isSummaryWorkerSession } from "./summary-worker.js";
import { ProactiveCompressionScheduler } from "./proactive-compression.js";
import { planCompressionCandidates } from "../../core/compress/eligibility.js";
import { buildCompressMessageTool, buildCompressTool, buildCompressionArchiveReleaseTool, buildCompressionArchiveRetrieveTool, buildCompressionArchiveSearchTool, buildCompressionStatusTool, buildContextTierUpdateTool, commitWorkerCompression, projectedCompressionMessages, } from "./tool.js";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { runPipeline } from "../../core/pipeline.js";
import { stripHallucinatedTags } from "../../core/tagging.js";
import { selectCompressRange } from "../../core/compress/execute.js";
import { activateCompressionBlock, deactivateCompressionBlock, } from "../../core/compress/reversible.js";
import { createInitialState } from "../../types/state.js";
import { classifyTool } from "../../core/routing.js";
import { contentHash } from "../../services/contentStore.js";
import { runTagging } from "../../core/tagging.js";
import { applyDecisions } from "../../core/applyDecisions.js";
import { applyDirectedTierSelection, planDirectedTierSelection } from "../../core/contextTiers.js";
import { applyManualOverrides } from "../../core/manualOverrides.js";
import { hasPendingProjectionRewrite, markProjectionRewriteApplied, recordProjectionEdit, } from "../../core/projectionEdits.js";
import { recordCacheBust } from "../../core/budget/costRoi.js";
import { runFinalize } from "../../core/finalize.js";
import { estimateContextTokens, estimateMessageTokens } from "../../core/tokens.js";
import { safePathSegment } from "../../core/paths.js";
import { RevisionConflictError, } from "./control-server.js";
import { materializeOffloadRequests, restoreFailedOffloadOutputs } from "./offload-writer.js";
import { offloadCleanupScheduler } from "./offload-cleanup.js";
import { sharedSessionCoordinator } from "./session-coordinator.js";
import { SessionCache } from "./session-cache.js";
import { SessionOwners } from "./session-owners.js";
import { sharedControlService } from "./control-service.js";
import { archiveCompressionSummary, loadCompressionSource, loadCompressionSummary, redactInactiveArchiveRetrievals, searchCompressionSummaries, } from "./compression-archive.js";
import { createHandoffHostReader } from "./handoff-host.js";
import { decodeBundle, encodeBundle } from "./portable-context.js";
import { parseHandoffArguments, readBundleFile, writeBundleFile } from "./portable-context-io.js";
import { collectHandoff, composeRecoveryEntries, importHandoff, loadImportedSeed, localHandoffResourceReader, } from "./context-handoff.js";
import { normalizeRemoteContextDirectory, registerRemoteContextBridge, unregisterRemoteContextBridge, } from "./remote-context-bridge.js";
function modelKey(identity) {
    return `${identity.providerId}\u0000${identity.modelId}`;
}
function identityFromModelKey(key) {
    if (!key)
        return undefined;
    const separator = key.indexOf("\u0000");
    if (separator <= 0 || separator === key.length - 1)
        return undefined;
    return { providerId: key.slice(0, separator), modelId: key.slice(separator + 1) };
}
function modelIdentityFromEntries(entries) {
    for (let index = entries.length - 1; index >= 0; index--) {
        const info = entries[index].info;
        if (info.role === "user" && info.model?.providerID && info.model.modelID) {
            return { providerId: info.model.providerID, modelId: info.model.modelID };
        }
        if (info.role === "assistant" && info.providerID && info.modelID) {
            return { providerId: info.providerID, modelId: info.modelID };
        }
    }
    return undefined;
}
const sessionCachesByStorageRoot = new Map();
const sessionOwnersByStorageRoot = new Map();
const systemKnowledgeByStorageRoot = new Map();
// messages.transform may precede system.transform on desktop. Reserve a
// conservative first-request system/tool-framing estimate until the read-only
// system hook replaces it with a model-specific measured value.
const UNKNOWN_SYSTEM_PROMPT_RESERVE = 32_000;
function sharedSystemKnowledge(storageRoot) {
    let knowledge = systemKnowledgeByStorageRoot.get(storageRoot);
    if (!knowledge) {
        knowledge = { prompts: new Map(), contextLimits: new Map(), models: new Map() };
        systemKnowledgeByStorageRoot.set(storageRoot, knowledge);
    }
    return knowledge;
}
// ── Plugin factory ────────────────────────────────────────────────────────────
/**
 * context-manager opencode plugin factory.
 *
 * Usage in opencode.json:
 *   "plugin": [["./clean-impl/adapters/opencode/plugin.ts", { "ctx": { ... } }]]
 *
 * Or as a named export (see index.ts):
 *   import { CtxPlugin } from "./adapters/opencode/index.js"
 */
export async function CtxPlugin(_input, options) {
    const pluginOptions = extractPluginOptions(["plugin", options ?? {}]);
    const summaryWorkerOptions = validateSummaryWorker(pluginOptions.summaryWorker);
    // Build services (tokenizer, clock, persistence, logger)
    const services = await buildServices(pluginOptions.storagePath, pluginOptions.tokenizer ?? "auto");
    const { tokenizer, tokenizerFor, persistence, logger, contentStore } = services;
    const contentStoreEnabled = pluginOptions.contentStore?.enabled !== false;
    const configuredRoutingMode = pluginOptions.routing?.mode;
    const routingMode = configuredRoutingMode === "advise" || configuredRoutingMode === "enforce"
        ? configuredRoutingMode
        : "off";
    // Plugin reloads/parallel instances share both the coordinator and live state
    // for one storage root. Serialization without a shared state view would still
    // allow an older instance to overwrite a newer persisted mutation.
    const sessionCoordinator = sharedSessionCoordinator(services.storageRoot);
    let sessionOwners = sessionOwnersByStorageRoot.get(services.storageRoot);
    if (!sessionOwners) {
        sessionOwners = new SessionOwners();
        sessionOwnersByStorageRoot.set(services.storageRoot, sessionOwners);
    }
    const owners = sessionOwners;
    const { prompts: systemPrompts, contextLimits, models: systemModels } = sharedSystemKnowledge(services.storageRoot);
    let sessionCache = sessionCachesByStorageRoot.get(services.storageRoot);
    if (!sessionCache) {
        let warnedStatus = false;
        const deferForStatus = (reason) => {
            if (!warnedStatus) {
                warnedStatus = true;
                logger.warn(`ctx: session cache eviction deferred: ${reason}`);
            }
            return false;
        };
        sessionCache = new SessionCache(validateSessionCache(pluginOptions.sessionCache), sessionCoordinator, async (sessionId, data) => {
            // Save state before replacing the disposable history checkpoint. A failed
            // save leaves the resident item intact for a later attempt.
            if (!owners.durable(sessionId))
                throw new Error("ctx: session owner has no durable history storage; eviction deferred");
            await persistence.save(sessionId, data.state);
            await contentStore.saveSessionHistory({
                version: 1, sessionId, rawEntries: data.rawEntries,
                projectedEntries: data.projectedEntries, updatedAt: data.updatedAt,
                stateVersion: persistedStateVersion(data.state),
                summary: { revision: data.state.controlRevision,
                    ...(owners.knownWorkspace(sessionId) ? { workspace: owners.knownWorkspace(sessionId) } : {}) },
            });
        }, async (sessionId) => {
            // The host status map is authoritative: absence means idle. Without it,
            // long-running streams cannot safely be distinguished from idle chats.
            try {
                const status = await owners.status(sessionId);
                if (status === "idle") {
                    cache.status(sessionId, "idle");
                    return true;
                }
                if (status === "busy" || status === "retry") {
                    cache.status(sessionId, status);
                    return false;
                }
                return deferForStatus("session owner or host session.status is unavailable");
            }
            catch {
                return deferForStatus("host session.status request failed");
            }
        }, sessionId => {
            systemPrompts.delete(sessionId);
            contextLimits.delete(sessionId);
            systemModels.delete(sessionId);
            owners.delete(sessionId);
            sharedControlService(services.storageRoot).forget(sessionId);
        }, error => logger.warn("ctx: session cache eviction deferred", error));
        sessionCachesByStorageRoot.set(services.storageRoot, sessionCache);
    }
    else
        sessionCache.constrain(validateSessionCache(pluginOptions.sessionCache));
    const cache = sessionCache;
    const sessions = cache.sessions;
    const controlService = sharedControlService(services.storageRoot);
    // Headless/test hosts without a project directory have one explicit
    // storage-root scope; real OpenCode supplies its project directory.
    const exactDirectory = pluginContextDirectory(_input);
    const workspace = pluginContextDirectories(_input)[0] ?? services.storageRoot;
    const hostSession = _input?.client?.session;
    const unregisterOwner = owners.register(workspace, {
        durable: contentStoreEnabled,
        realWorkspace: exactDirectory !== undefined,
        config: (sessionId, limit, providerId, modelId, runtime) => buildCoreConfig(sessionId, pluginOptions, limit, providerId, modelId, runtime),
        tokenizer: tokenizerFor,
        status: async (sessionId, directory) => {
            const workerStatus = _input.workerStatus;
            if (summaryWorkerOptions.enabled && workerStatus)
                return workerStatus(sessionId);
            if (!hostSession?.status)
                return "unknown";
            // SDK methods may depend on `this`; retain the original session client.
            const result = await hostSession.status.call(hostSession, { query: { directory }, throwOnError: true });
            if (result.error || !result.data || typeof result.data !== "object" || Array.isArray(result.data))
                return "unknown";
            const found = result.data[sessionId];
            if (found === undefined)
                return "idle";
            if (found && typeof found === "object" && found.type === "idle")
                return "idle";
            if (found && typeof found === "object" && found.type === "busy")
                return "busy";
            if (found && typeof found === "object" && found.type === "retry")
                return "retry";
            return "unknown";
        },
    });
    for (const sessionId of unregisterOwner.reopened)
        cache.cancelRetirement(sessionId);
    const releaseEmptyRoot = () => {
        if (owners.hasRegistrations() || owners.hasRetired() || cache.stats().sessions > 0 || cache.stats().pinned > 0)
            return;
        if (sessionCachesByStorageRoot.get(services.storageRoot) !== cache)
            return;
        cache.close();
        sessionCachesByStorageRoot.delete(services.storageRoot);
        sessionOwnersByStorageRoot.delete(services.storageRoot);
        systemKnowledgeByStorageRoot.delete(services.storageRoot);
    };
    cache.setOnQuiescent(releaseEmptyRoot);
    let controlServer;
    let controlBootstrapPath;
    let unregisterControl;
    let unregisterBridge;
    let warnedAnthropicFallback = false;
    const defaultContextLimit = 1_000_000;
    function ownerPorts(sessionId) {
        return owners.current(sessionId, workspace);
    }
    function sessionConfig(sessionId, limit, providerId, modelId, runtime) {
        return ownerPorts(sessionId)?.ports.config(sessionId, limit, providerId, modelId, runtime)
            ?? buildCoreConfig(sessionId, pluginOptions, limit, providerId, modelId, runtime);
    }
    function sessionTokenizer(sessionId, providerId, modelId) {
        return ownerPorts(sessionId)?.ports.tokenizer(providerId, modelId) ?? tokenizerFor(providerId, modelId);
    }
    function refreshOwnerGeneration(data) {
        const current = ownerPorts(data.state.sessionId);
        if (!current || data.ownerGeneration === current.token)
            return;
        data.tokenizer = current.ports.tokenizer(data.providerId, data.modelId);
        const prompt = systemPrompts.get(data.state.sessionId);
        if (prompt) {
            data.baseSystemPromptTokens = prompt.reduce((sum, text) => sum + data.tokenizer.countTokens(text), 0);
            data.state.systemPromptTokens = Math.ceil(data.baseSystemPromptTokens * data.state.tokenCalibration.ratio);
        }
        else if (data.state.systemPromptTokens > 0) {
            data.baseSystemPromptTokens = Math.max(0, Math.round(data.state.systemPromptTokens / Math.max(data.state.tokenCalibration.ratio, 0.01)));
        }
        data.config = current.ports.config(data.state.sessionId, data.config.modelContextLimit, data.providerId, data.modelId, data.state.runtimeConfig);
        data.config.systemPromptTokens = data.state.systemPromptTokens;
        data.ownerGeneration = current.token;
    }
    // ── Session helpers ─────────────────────────────────────────────────────────
    async function getOrCreateSession(sessionId, identity, loaded) {
        if (isSummaryWorkerSession(sessionId))
            throw new Error("summary worker sessions cannot create context-manager state");
        const existing = sessions.get(sessionId);
        if (existing) {
            owners.claim(sessionId, unregisterOwner);
            if (owners.isCurrent(unregisterOwner))
                controlService.observe(sessionId, workspace);
            refreshOwnerGeneration(existing);
            if (identity)
                syncSessionModel(existing, identity);
            return existing;
        }
        const state = loaded?.state ?? await loadOrCreateState(sessionId, persistence);
        const initialIdentity = identity
            ?? systemModels.get(sessionId)
            ?? identityFromModelKey(state.contextTokenMetrics.modelKey ?? state.tokenCalibration.modelKey)
            ?? { providerId: "opencode-go", modelId: "deepseek-v4-flash" };
        const initialContextLimit = contextLimits.get(sessionId)
            ?? (state.modelContextLimit > 0 ? state.modelContextLimit : defaultContextLimit);
        const config = sessionConfig(sessionId, initialContextLimit, initialIdentity.providerId, initialIdentity.modelId, state.runtimeConfig);
        const initialKey = modelKey(initialIdentity);
        state.modelContextLimit = config.modelContextLimit;
        if (state.tokenCalibration.modelKey !== initialKey) {
            state.tokenCalibration = { ratio: 1, sampleCount: 0, modelKey: initialKey };
            state.contextTokenMetrics = { modelKey: initialKey };
        }
        const data = {
            state,
            config,
            rawEntries: [],
            recoveryEntries: [],
            projectedEntries: [],
            pendingCompressRequests: [],
            providerId: initialIdentity.providerId,
            modelId: initialIdentity.modelId,
            tokenizer: sessionTokenizer(sessionId, initialIdentity.providerId, initialIdentity.modelId),
            baseSystemPromptTokens: 0,
            updatedAt: Date.now(),
        };
        const knownSystemPrompt = systemPrompts.get(sessionId);
        data.baseSystemPromptTokens = knownSystemPrompt !== undefined
            ? knownSystemPrompt.reduce((sum, text) => sum + data.tokenizer.countTokens(text), 0)
            : state.systemPromptTokens > 0
                ? Math.max(0, Math.round(state.systemPromptTokens / Math.max(state.tokenCalibration.ratio, 0.01)))
                : UNKNOWN_SYSTEM_PROMPT_RESERVE;
        if (knownSystemPrompt !== undefined) {
            state.systemPromptTokens = Math.ceil(data.baseSystemPromptTokens * state.tokenCalibration.ratio);
        }
        else {
            state.systemPromptTokens ||= Math.ceil(data.baseSystemPromptTokens * state.tokenCalibration.ratio);
        }
        config.systemPromptTokens = state.systemPromptTokens;
        let exactProjectionMatchesState = false;
        if (contentStoreEnabled) {
            const history = loaded ? loaded.history : await contentStore.loadSessionHistory(sessionId);
            if (history) {
                data.rawEntries = cloneHostEntries(history.rawEntries);
                data.recoveryEntries = cloneHostEntries(history.rawEntries);
                data.projectedEntries = cloneHostEntries(history.projectedEntries);
                data.updatedAt = history.updatedAt;
                exactProjectionMatchesState = history.stateVersion === persistedStateVersion(state);
            }
        }
        if (state.importedContext) {
            if (!contentStoreEnabled)
                throw new Error("ctx: imported context requires durable content storage");
            data.importedSeed = await loadImportedSeed(state, contentStore, services.storageRoot);
            data.recoveryEntries = composeRecoveryEntries(data.rawEntries, data.importedSeed);
            // A saved projection is only a cache, never the owner of imported history.
            exactProjectionMatchesState = false;
        }
        if (contentStoreEnabled && data.recoveryEntries.length > 0) {
            const hydrated = await hydrateRestoredBlockEntries(data.recoveryEntries, state, contentStore, logger);
            data.recoveryEntries = hydrated.entries;
            if (!exactProjectionMatchesState || hydrated.graphChanged) {
                data.projectedEntries = rebuildProjectedEntries(data.recoveryEntries, state, config, effectiveSessionTokenizer(data));
            }
            if (hydrated.graphChanged) {
                try {
                    await persistence.save(sessionId, state);
                }
                catch (err) {
                    logger.warn("ctx: failed to persist startup hydration fallback", err);
                }
            }
        }
        cache.set(sessionId, data);
        owners.claim(sessionId, unregisterOwner);
        if (owners.isCurrent(unregisterOwner))
            controlService.observe(sessionId, workspace);
        data.ownerGeneration = ownerPorts(sessionId)?.token;
        return data;
    }
    function effectiveSessionTokenizer(data) {
        return data.state.tokenCalibration.sampleCount > 0
            && Math.abs(data.state.tokenCalibration.ratio - 1) > 0.01
            ? new CalibratedTokenizer(data.tokenizer, data.state.tokenCalibration.ratio)
            : data.tokenizer;
    }
    function syncSessionModel(data, identity, contextLimit) {
        refreshOwnerGeneration(data);
        const nextKey = modelKey(identity);
        const changed = data.providerId !== identity.providerId || data.modelId !== identity.modelId;
        if (changed) {
            data.providerId = identity.providerId;
            data.modelId = identity.modelId;
            data.tokenizer = sessionTokenizer(data.state.sessionId, identity.providerId, identity.modelId);
            if (data.tokenizer instanceof AnthropicTokenizer && !data.tokenizer.isAvailable && !warnedAnthropicFallback) {
                warnedAnthropicFallback = true;
                logger.warn("ctx: @anthropic-ai/tokenizer unavailable; Claude token counts use calibrated char estimates");
            }
            data.state.tokenCalibration = { ratio: 1, sampleCount: 0, modelKey: nextKey };
            data.state.contextTokenMetrics = { modelKey: nextKey };
            const knownSystemPrompt = systemPrompts.get(data.state.sessionId);
            data.baseSystemPromptTokens = knownSystemPrompt !== undefined
                ? knownSystemPrompt.reduce((sum, text) => sum + data.tokenizer.countTokens(text), 0)
                : UNKNOWN_SYSTEM_PROMPT_RESERVE;
            data.state.systemPromptTokens = data.baseSystemPromptTokens;
        }
        const nextLimit = contextLimit && contextLimit > 0 ? contextLimit : data.config.modelContextLimit;
        if (changed || data.config.modelContextLimit !== nextLimit) {
            data.config = sessionConfig(data.state.sessionId, nextLimit, identity.providerId, identity.modelId, data.state.runtimeConfig);
            data.state.modelContextLimit = nextLimit;
            data.config.systemPromptTokens = data.state.systemPromptTokens;
        }
    }
    function consumePendingCalibration(data, entries) {
        const pending = data.state.contextTokenMetrics.pendingCalibration;
        if (!pending || pending.modelKey !== modelKey(data))
            return;
        const consumed = new Set(data.state.contextTokenMetrics.consumedCalibrationAssistantIds ?? []);
        const matchingResponses = [...entries].reverse().filter(entry => {
            const info = entry.info;
            return info.role === "assistant"
                && !consumed.has(info.id)
                && info.parentID === pending.requestMessageId
                && modelKey({
                    providerId: info.providerID ?? data.providerId,
                    modelId: info.modelID ?? data.modelId,
                }) === pending.modelKey;
        });
        const completedResponses = matchingResponses.filter(entry => {
            if (entry.info.role !== "assistant")
                return false;
            return entry.info.tokens.input + entry.info.tokens.cache.read + entry.info.tokens.cache.write > 0;
        });
        const response = completedResponses[0];
        if (!response || response.info.role !== "assistant")
            return;
        const actual = response.info.tokens.input
            + response.info.tokens.cache.read
            + response.info.tokens.cache.write;
        if (actual > 100 && pending.baseEstimatedTokens > 0) {
            const sample = Math.max(0.1, Math.min(10, actual / pending.baseEstimatedTokens));
            const prior = data.state.tokenCalibration;
            const alpha = 0.2;
            data.state.tokenCalibration = {
                ratio: prior.sampleCount > 0 ? alpha * sample + (1 - alpha) * prior.ratio : sample,
                sampleCount: prior.sampleCount + 1,
                modelKey: pending.modelKey,
            };
            const systemTokens = Math.ceil(data.baseSystemPromptTokens * data.state.tokenCalibration.ratio);
            data.config.systemPromptTokens = systemTokens;
            data.state.systemPromptTokens = systemTokens;
        }
        // Every nonzero provider report is authoritative for the request baseline,
        // even when it is too small to be a useful calibration sample.
        data.state.contextTokenMetrics.lastRequestTokens = actual;
        data.state.contextTokenMetrics.consumedCalibrationAssistantIds = [...new Set([
                ...(data.state.contextTokenMetrics.consumedCalibrationAssistantIds ?? []),
                ...completedResponses.map(entry => entry.info.id),
            ])].slice(-64);
        delete data.state.contextTokenMetrics.pendingCalibration;
    }
    // ── Compress tool deps ──────────────────────────────────────────────────────
    const compressToolDeps = {
        getState: (sessionId) => sessions.get(sessionId)?.state,
        setState: (sessionId, state) => {
            const data = sessions.get(sessionId);
            if (data) {
                data.state = state;
                cache.refresh(sessionId);
            }
        },
        getConfig: (sessionId) => sessions.get(sessionId)?.config,
        getTokenizer: (sessionId) => sessions.get(sessionId)?.tokenizer,
        getProjectedEntries: (sessionId) => sessions.get(sessionId)?.projectedEntries,
        getRawEntries: (sessionId) => sessions.get(sessionId)?.recoveryEntries,
        setProjectedEntries: (sessionId, entries) => {
            const data = sessions.get(sessionId);
            if (data) {
                data.projectedEntries = cloneHostEntries(entries);
                cache.refresh(sessionId);
            }
        },
        contentStore: contentStoreEnabled ? contentStore : undefined,
        persistence,
        tokenizer,
        logger,
        runExclusive: async (sessionId, task) => {
            if (isSummaryWorkerSession(sessionId))
                throw new Error("ctx tools are unavailable in summary worker sessions");
            return cache.run(sessionId, async () => { await getOrCreateSession(sessionId); return task(); });
        },
    };
    const compressTool = buildCompressTool(compressToolDeps);
    const compressMessageTool = buildCompressMessageTool(compressToolDeps);
    const archiveSearchTool = buildCompressionArchiveSearchTool(compressToolDeps);
    const archiveRetrieveTool = buildCompressionArchiveRetrieveTool(compressToolDeps);
    const archiveReleaseTool = buildCompressionArchiveReleaseTool(compressToolDeps);
    const tierUpdateTool = buildContextTierUpdateTool(compressToolDeps);
    const compressionStatusTool = buildCompressionStatusTool(compressToolDeps);
    const hostDirectory = pluginContextDirectories(_input)[0];
    const generationIds = new WeakMap();
    let nextGeneration = 0;
    const generationId = (token) => {
        if (!token)
            return -1;
        let id = generationIds.get(token);
        if (id === undefined)
            generationIds.set(token, id = ++nextGeneration);
        return id;
    };
    const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const ownsSession = (id) => owners.isCurrent(unregisterOwner) && owners.get(id) === unregisterOwner.workspace;
    function workerData(id) {
        if (isSummaryWorkerSession(id) || !ownsSession(id))
            return;
        const data = sessions.get(id);
        if (!data)
            return;
        refreshOwnerGeneration(data);
        return data.config.automation.modelCompression && contentStoreEnabled ? data : undefined;
    }
    function planWorkerCandidate(id, data, accept) {
        const messages = projectedCompressionMessages(data.projectedEntries, data.state);
        const candidate = planCompressionCandidates(messages, data.state, data.config, effectiveSessionTokenizer(data)).candidates.find(accept);
        if (!candidate)
            return null;
        const ids = new Set(candidate.messageIds);
        const source = messages.filter(message => ids.has(message.id));
        if (source.length !== ids.size)
            return null;
        const requested = data.pendingCompressRequests.find(request => request.startRef === candidate.startRef && request.endRef === candidate.endRef);
        const topic = (requested?.topic ?? data.pendingCompressRequests[0]?.topic) === "escalation"
            ? "Background summary (escalation)" : "Background summary of stable context";
        return { key: digest({ version: 1, sessionId: id, messageIds: candidate.messageIds,
                startRef: candidate.startRef, endRef: candidate.endRef, source: digest(source),
                controlRevision: data.state.controlRevision, model: modelKey(data), config: digest(data.config),
                worker: summaryWorkerOptions.model, owner: generationId(data.ownerGeneration) }),
            source, startRef: candidate.startRef, endRef: candidate.endRef, topic };
    }
    let proactiveScheduler;
    if (summaryWorkerOptions.enabled) {
        const client = _input?.client;
        if (!client?.session || !["create", "prompt", "abort", "delete"].every(name => typeof client.session[name] === "function")) {
            throw new Error("summaryWorker requires verified session create/prompt/abort/delete transport");
        }
        const separator = summaryWorkerOptions.model.indexOf("/");
        const model = { providerID: summaryWorkerOptions.model.slice(0, separator), modelID: summaryWorkerOptions.model.slice(separator + 1) };
        const summarizer = createOpenCodeSummarizer(client, { ...summaryWorkerOptions, model,
            agent: "ctx-summarizer", ...(hostDirectory ? { directory: hostDirectory } : {}) }, tokenizerFor(model.providerID, model.modelID), {
            onDiagnostic: diagnostic => logger.warn(`ctx: summary worker ${diagnostic.code}: ${diagnostic.detail}`),
        });
        proactiveScheduler = new ProactiveCompressionScheduler({
            namespace: services.storageRoot, runExclusive: (id, task) => cache.run(id, task),
            minIntervalMs: summaryWorkerOptions.minIntervalMs,
            maxSourceTokens: Math.max(1, Math.min(16_000, Math.floor(summaryWorkerOptions.maxInputTokens / 2))),
            cleanupTimeoutMs: summaryWorkerOptions.cleanupTimeoutMs * 4,
            onDiagnostic: diagnostic => logger.warn(`ctx: background compression ${diagnostic.code}: ${diagnostic.detail}`),
            async capture(id, limit) {
                const data = workerData(id);
                if (!data || !data.pendingCompressRequests.length || await owners.status(id) !== "idle")
                    return null;
                return planWorkerCandidate(id, data, candidate => candidate.sourceTokens <= limit);
            },
            summarize: (snapshot, signal) => summarizer.summarize(snapshot.source, snapshot.topic, signal),
            async commit(id, snapshot, summary, signal) {
                const current = () => {
                    const data = workerData(id);
                    return data && planWorkerCandidate(id, data, candidate => candidate.startRef === snapshot.startRef && candidate.endRef === snapshot.endRef);
                };
                if (current()?.key !== snapshot.key || await owners.status(id) !== "idle")
                    return false;
                const result = await commitWorkerCompression(compressToolDeps, id, { topic: snapshot.topic,
                    content: [{ startId: snapshot.startRef, endId: snapshot.endRef, summary }] }, hostDirectory ?? workspace, async () => await owners.status(id) === "idle" && !signal.aborted && current()?.key === snapshot.key);
                if (result.committed) {
                    const data = sessions.get(id);
                    if (data)
                        data.pendingCompressRequests = [];
                }
                return result.committed;
            },
        });
    }
    // ── Hook implementations ────────────────────────────────────────────────────
    /**
     * experimental.chat.messages.transform
     * Runs the full core pipeline on the outgoing message array.
     * Mutates output.messages in place.
     */
    async function onMessagesTransform(input, output) {
        const sessionId = sessionIdFromTransform(input, output.messages);
        if (!sessionId)
            return runMessagesTransform(input, output);
        if (isSummaryWorkerSession(sessionId))
            return;
        proactiveScheduler?.cancel(sessionId);
        return cache.run(sessionId, async () => {
            try {
                await runMessagesTransform(input, output);
            }
            finally {
                cache.refresh(sessionId);
            }
        });
    }
    async function runMessagesTransform(input, output) {
        const entries = output.messages;
        if (entries.length === 0)
            return;
        // Other plugins may prepend synthetic entries without host identity fields.
        const sessionId = sessionIdFromTransform(input, entries);
        if (!sessionId || isSummaryWorkerSession(sessionId))
            return;
        const identity = modelIdentityFromEntries(entries);
        const data = await getOrCreateSession(sessionId, identity);
        owners.claim(sessionId, unregisterOwner);
        if (owners.isCurrent(unregisterOwner))
            controlService.observe(sessionId, workspace);
        if (identity)
            syncSessionModel(data, identity);
        consumePendingCalibration(data, entries);
        // Capture the exact host re-feed before context-manager hydrates any durable originals.
        data.rawEntries = cloneHostEntries(entries);
        advanceTurnBasis(data.rawEntries, data.state);
        await archiveHostRefeed(contentStore, contentStoreEnabled, logger, sessionId, data.rawEntries);
        if (contentStoreEnabled) {
            const composed = composeRecoveryEntries(entries, data.importedSeed);
            const hydrated = await hydrateRestoredBlockEntries(composed, data.state, contentStore, logger);
            if (hydrated.entries !== entries) {
                output.messages.splice(0, output.messages.length, ...hydrated.entries);
            }
            if (hydrated.graphChanged) {
                try {
                    await persistence.save(sessionId, data.state);
                }
                catch (err) {
                    logger.warn("ctx: failed to persist hydration fallback", err);
                }
            }
        }
        data.recoveryEntries = cloneHostEntries(output.messages);
        // Summary archives were introduced after durable source archives. Backfill
        // them before core evaluates tier eligibility so legacy active blocks remain
        // warm until their full summary is durably available.
        if (contentStoreEnabled) {
            await ensureSummaryArchives(data, contentStore, persistence, logger);
        }
        if (!data.config.contextTiers.enabled || !data.config.automation.automaticPruning) {
            data.state.temporaryRetrievals.clear();
        }
        // Retrieval tool results are temporary model context. OpenCode re-feeds tool
        // output forever, so redact released, expired, or restart-orphaned retrievals
        // before core sees them. The immutable summary archive remains searchable.
        const retrievalSafeEntries = redactInactiveArchiveRetrievals(output.messages, data.state);
        if (retrievalSafeEntries !== output.messages) {
            output.messages.splice(0, output.messages.length, ...retrievalSafeEntries);
        }
        // Translate to neutral model
        const neutralMessages = toNeutral(output.messages, data.state);
        const telemetry = (event) => {
            logger.debug(`[ctx-telemetry] ${JSON.stringify(event)}`);
        };
        // Run the pipeline
        const pipelineResult = runPipeline({
            messages: neutralMessages,
            state: data.state,
            config: data.config,
            nowMs: Date.now(),
            injectContextStatus: true,
        }, {
            tokenizer: data.tokenizer,
            workspaceDir: resolveWorkspaceDir(sessionId),
            telemetry,
        });
        // Record savings for observability (only when something was actually saved).
        if (pipelineResult.savedThisRun > 0) {
            logger.info(`ctx: saved ${pipelineResult.savedThisRun} tokens this turn ` +
                `(cumulative ${pipelineResult.cumulativeSaved}) for session ${sessionId}`);
        }
        // Materialize offloads before exposing pointers. Failed writes are rolled
        // back to the original tool output so the model never receives a dangling
        // path and state does not persist a broken decision.
        const failedOffloads = await materializeOffloadRequests(pipelineResult.offloadRequests, pipelineResult.state, logger);
        const safePipelineMessages = restoreFailedOffloadOutputs(pipelineResult.messages, neutralMessages, failedOffloads);
        // Coalesced background cleanup: at most one scan per session directory per
        // ten minutes. Tool-loop re-feeds must not overlap repeated filesystem scans.
        const referencedOffloadPaths = new Set([...pipelineResult.state.messageIndex.values()]
            .map(entry => entry.offloadPath)
            .filter((path) => typeof path === "string"));
        const offloadSessionDir = resolveOffloadSessionDir(sessionId);
        offloadCleanupScheduler.request(offloadSessionDir, () => cleanupOldOffloadFiles(offloadSessionDir, 7 * 24 * 3600 * 1000, referencedOffloadPaths))
            .catch(err => logger.warn("ctx: offload cleanup failed", err));
        // Pending requests are fulfilled only by explicit opt-in idle workers;
        // otherwise retain the existing model-driven/mechanical fallback behavior.
        if (pipelineResult.compressRequests.length > 0) {
            data.pendingCompressRequests = pipelineResult.compressRequests;
            logger.info(`ctx: ${pipelineResult.compressRequests.length} compress request(s) queued ` +
                (proactiveScheduler ? `(opt-in idle summary worker)` : `(model-driven only; opencode v1 uses mechanical fallback)`));
        }
        else if (!data.config.automation.modelCompression) {
            data.pendingCompressRequests = [];
        }
        // Deliver the nudge through the messages channel (the system.transform hook
        // is a deliberate no-op here — injecting into the dynamic system prompt caused
        // empty assistant responses in live smoke tests). The nudge is appended to the
        // latest user message; hosts re-feed original history each turn so it does not
        // accumulate.
        const deliveredMessages = safePipelineMessages;
        // Apply mutations back to the output entries.
        // IMPORTANT: mutate the array IN PLACE so that opencode's hook contract is
        // satisfied on all versions. Reassigning `output.messages = newArray` is a
        // silent no-op on many opencode versions because the host keeps using the
        // original array reference. Splicing the original array to contain exactly
        // the mutated entries works on all versions. We also keep the assignment for
        // newer versions that do read the property.
        const mutatedEntries = applyNeutral(output.messages, deliveredMessages);
        // Anthropic rejects tool_use without a matching tool_result. Cross-provider
        // history (e.g. OpenAI tool parts re-fed to Claude) carries foreign item
        // metadata that makes the adapter drop the tool_result, so strip it here.
        const providerSafeEntries = stripForeignProviderMetadata(mutatedEntries, data.providerId);
        output.messages.splice(0, output.messages.length, ...providerSafeEntries);
        // Keep the assignment for newer opencode versions that read the property.
        // (On older versions this is a no-op; the splice above is what matters.)
        // Note: after the splice, output.messages IS the same reference as entries,
        // so this assignment is technically redundant but harmless.
        // Update session state
        data.state = pipelineResult.state;
        data.projectedEntries = cloneHostEntries(providerSafeEntries);
        data.updatedAt = Date.now();
        const request = [...mutatedEntries].reverse().find(entry => entry.info.role === "user");
        if (request) {
            data.state.contextTokenMetrics.pendingCalibration = {
                modelKey: modelKey(data),
                requestMessageId: request.info.id,
                baseEstimatedTokens: estimateContextTokens(toNeutral(mutatedEntries, data.state), data.tokenizer) + data.baseSystemPromptTokens,
            };
        }
        // Persist before releasing the per-session coordinator. This prevents a
        // later dashboard/compression commit from being overwritten by an older turn.
        // A delivery acknowledgement is prepared on a clone and becomes live only
        // after it is durable. If persistence fails, the in-memory state remains
        // pending and safely retries instead of emitting/accounting the same delivery
        // once now and again after a restart from stale durable state.
        try {
            const durableState = pipelineResult.projectionEdit
                ? cloneCoreState(data.state)
                : data.state;
            if (pipelineResult.projectionEdit) {
                markProjectionRewriteApplied(durableState);
                recordCacheBust(durableState, durableState.currentTurn);
            }
            await persistence.save(sessionId, durableState);
            data.state = durableState;
            if (pipelineResult.projectionEdit) {
                telemetry({ type: "projection-edit", ...pipelineResult.projectionEdit });
            }
            await saveLatestSessionHistory(contentStore, contentStoreEnabled, logger, data, owners.knownWorkspace(sessionId));
        }
        catch (err) {
            logger.warn("ctx: failed to persist state after transform", err);
        }
    }
    /**
     * experimental.chat.system.transform
     *
     * OUTPUT-SAFE BY DESIGN: this hook never modifies `output.system`. Injecting a
     * second context-management instruction into this app's dynamic system prompt
     * caused empty assistant responses in live Docker smoke tests (see git history
     * + AGENTS.md). Nudges are delivered through the messages channel instead
     * (see appendNudgeToLastUser in onMessagesTransform).
     *
      * It caches the session's model context limit and measures the system-prompt
      * token count so the budget stage can subtract it (UPGRADES §7). These
      * accounting updates are serialized and persisted, but `output.system` remains
      * byte-identical. Internal agents (title/summarizer) are skipped.
     */
    async function onSystemTransform(input, output) {
        // THROW-SAFE BY DESIGN: this is a read-only optimization hook, so it must
        // NEVER be able to abort (and thereby empty) a user turn. The vendored
        // opencode engine passes a `Provider.Model` whose model id is `id` (not
        // `modelID`); reading `model.modelID` was `undefined`, and the subsequent
        // `.toLowerCase()` threw inside the hook and produced an empty assistant
        // response with no surfaced error. The whole body is wrapped so any future
        // shape change degrades to "no optimization this turn" instead of breaking
        // the turn.
        try {
            const { model } = input;
            // Resolve the model/provider ids defensively across the real field (`id`)
            // and cross-version fallbacks. Never assume a single field is present.
            const modelId = model?.id ?? model?.modelID ?? model?.info?.id;
            // Skip internal models (title/summarizer agents)
            if (isInternalModel(modelId))
                return;
            const contextLimit = model?.limit?.context;
            const sessionId = input.sessionID;
            if (!sessionId || isSummaryWorkerSession(sessionId))
                return;
            // System hooks can race message transforms, compression tools, and dashboard
            // mutations. Participate in the same per-session coordinator and persist the
            // accounting update so a restart cannot restore an obsolete denominator.
            await cache.run(sessionId, async () => {
                systemPrompts.set(sessionId, [...output.system]);
                if (modelId && model?.providerID) {
                    const identity = { providerId: model.providerID, modelId };
                    const previous = systemModels.get(sessionId);
                    if (previous && modelKey(previous) !== modelKey(identity))
                        contextLimits.delete(sessionId);
                    systemModels.set(sessionId, identity);
                }
                if (contextLimit && contextLimit > 0)
                    contextLimits.set(sessionId, contextLimit);
                const data = sessions.get(sessionId);
                if (!data)
                    return; // system-first ordering is handled by the maps above
                refreshOwnerGeneration(data);
                const providerId = typeof model?.providerID === "string"
                    ? model.providerID
                    : data.providerId;
                const nextModelId = modelId ?? data.modelId;
                const nextContextLimit = contextLimit && contextLimit > 0
                    ? contextLimit
                    : data.config.modelContextLimit;
                syncSessionModel(data, { providerId, modelId: nextModelId }, nextContextLimit);
                data.baseSystemPromptTokens = output.system.reduce((sum, text) => sum + data.tokenizer.countTokens(text), 0);
                const systemPromptTokens = output.system.reduce((sum, text) => sum + effectiveSessionTokenizer(data).countTokens(text), 0);
                data.config.systemPromptTokens = systemPromptTokens;
                data.state.systemPromptTokens = systemPromptTokens;
                const pending = data.state.contextTokenMetrics.pendingCalibration;
                if (pending?.modelKey === modelKey(data) && data.projectedEntries.length > 0) {
                    pending.baseEstimatedTokens = estimateContextTokens(toNeutral(data.projectedEntries, data.state), data.tokenizer)
                        + data.baseSystemPromptTokens;
                }
                await persistence.save(sessionId, data.state);
                cache.refresh(sessionId);
            });
        }
        catch (err) {
            // Swallow: protect the turn. Log for observability only.
            logger.warn("ctx: onSystemTransform failed; skipping optimization for this turn", err);
        }
    }
    /**
     * experimental.text.complete
     * Strips hallucinated ctx-message-id tags from model text output.
     */
    async function onTextComplete(_input, output) {
        if (isSummaryWorkerSession(_input?.sessionID))
            return;
        output.text = stripHallucinatedTags(output.text);
    }
    /**
     * event
     * Captures compress timing events for cache-aware batching.
     */
    async function onEvent(input) {
        const { event } = input;
        if (event.type === "server.instance.disposed") {
            const directory = event.properties?.directory;
            if (exactDirectory && typeof directory === "string" && isAbsolute(directory)
                && normalize(resolve(directory)) === exactDirectory)
                await proactiveScheduler?.dispose();
            if (exactDirectory && typeof directory === "string" && isAbsolute(directory)
                && normalize(resolve(directory)) === exactDirectory && owners.isCurrent(unregisterOwner)) {
                // The verified V1 event carries the exact project directory. Token and
                // bridge identity checks keep a stale factory from removing its reload.
                const retired = owners.retire(unregisterOwner);
                unregisterBridge?.();
                unregisterOwner();
                const releaseControl = unregisterControl;
                unregisterControl = undefined;
                controlServer = undefined;
                await cache.retire(retired);
                await releaseControl?.(); // server.close waits for active HTTP requests
                releaseEmptyRoot();
            }
            return;
        }
        if (event.type === "session.status" && event.properties && typeof event.properties === "object") {
            const properties = event.properties;
            const status = properties.status;
            if (typeof properties.sessionID === "string" && !isSummaryWorkerSession(properties.sessionID)
                && (status?.type === "busy" || status?.type === "retry" || status?.type === "idle")) {
                cache.status(properties.sessionID, status.type);
                if (status.type !== "idle")
                    proactiveScheduler?.cancel(properties.sessionID);
                else if (proactiveScheduler && sessions.has(properties.sessionID) && ownsSession(properties.sessionID)) {
                    void proactiveScheduler.start(properties.sessionID).catch(() => false);
                }
            }
            return;
        }
        // Capture compress tool completion events for timing
        if (event.type === "message.part.updated" &&
            typeof event.properties === "object" &&
            event.properties !== null) {
            const part = event.properties["part"];
            if (typeof part === "object" &&
                part !== null &&
                part["type"] === "tool" &&
                part["tool"] === "compress") {
                const sessionID = part["sessionID"];
                if (sessionID && !isSummaryWorkerSession(sessionID)) {
                    const data = sessions.get(sessionID);
                    if (data?.config.automation.modelCompression) {
                        data.state.compressionTiming.lastCompressMs = Date.now();
                    }
                }
            }
        }
    }
    /**
     * config
     * Merges context-manager permission and command config into the opencode config.
     * Currently a no-op (permissions are handled via tool.ask()).
     */
    async function onConfig(input) {
        const existing = input.command && typeof input.command === "object"
            ? input.command
            : {};
        input.command = {
            ...existing,
            "ctx-compress": { description: "Compress the stable conversation range", template: "Trigger context compression" },
            "ctx-decompress": { description: "Restore a compression block", template: "$ARGUMENTS" },
            "ctx-recompress": { description: "Re-apply a restored compression block", template: "$ARGUMENTS" },
            "ctx-stats": { description: "Show context savings", template: "Show context statistics" },
            "ctx-ui": { description: "Open the local context control plane", template: "Show the context control URL" },
            "ctx-export": { description: "Export portable context to .ctx/context.json or a project-relative path", template: "Export portable context" },
            "ctx-import": { description: "Import a portable context file into this new chat", template: "Import portable context" },
        };
        if (proactiveScheduler) {
            const agents = input.agent;
            if (agents === undefined || agents && typeof agents === "object" && !Array.isArray(agents)) {
                if (!Object.hasOwn(agents ?? {}, "ctx-summarizer"))
                    input.agent = { ...(agents ?? {}),
                        "ctx-summarizer": { mode: "subagent", hidden: true, permission: { "*": "deny" } } };
            }
        }
    }
    async function onToolExecuteBefore(input, output) {
        if (routingMode === "off" || isSummaryWorkerSession(input.sessionID) || isCtxTool(input.tool))
            return;
        const result = classifyTool(input.tool, output.args);
        if (result.outcome === "deny" && routingMode === "enforce") {
            throw new Error(`ctx routing denied ${input.tool}: ${boundedGuidance(result.reason)}`);
        }
        if (result.outcome !== "allow") {
            logger.warn(`ctx routing ${routingMode}: ${input.tool}: ${boundedGuidance(result.reason)}`);
        }
    }
    async function loadControlSession(sessionId) {
        if (isSummaryWorkerSession(sessionId))
            return undefined;
        const active = sessions.get(sessionId);
        if (active) {
            refreshOwnerGeneration(active);
            return active;
        }
        const [persisted, history] = await Promise.all([
            persistence.load(sessionId),
            contentStoreEnabled ? contentStore.loadSessionHistory(sessionId) : Promise.resolve(undefined),
        ]);
        if (!persisted && !history)
            return undefined;
        const identity = history ? modelIdentityFromEntries(history.rawEntries) : undefined;
        return getOrCreateSession(sessionId, identity, {
            state: persisted ?? createInitialState(sessionId),
            history,
        });
    }
    async function hydrateBlockSources(data, blockId) {
        const raw = cloneHostEntries(data.recoveryEntries);
        const byId = new Map(raw.map(entry => [entry.info.id, entry]));
        const block = data.state.blockRegistry.get(blockId);
        if (!block)
            throw new Error(`Compression block ${blockId} was not found.`);
        const ref = block.durableSourceRef;
        if (!ref || !contentStoreEnabled) {
            throw new Error(`Compression block ${blockId} has no complete durable source archive and cannot be restored. Its summary remains available.`);
        }
        const entries = await loadCompressionSource(contentStore, ref, data.state.sessionId, blockId, block.effectiveMessageIds ?? block.sourceMessageIds ?? []);
        for (const entry of entries)
            byId.set(entry.info.id, entry);
        return [...byId.values()].sort((left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id));
    }
    /**
     * Reject edits that cannot take effect, before any state is touched.
     *
     * Two cases are structurally impossible rather than merely unusual:
     *   - `__manual_*` ids are generated replacements. An override keyed to one is
     *     never re-applied on a host re-feed, so it would silently do nothing.
     *   - A message covered by an ACTIVE compression block is represented by that
     *     block's summary. Forcing it back (keep/replace) would send the original
     *     and its summary together, i.e. duplicated and possibly contradictory
     *     context. Excluding it is still allowed: it is already not sent.
     */
    function validateProjectionEdit(data, messageId, override) {
        if (messageId.startsWith("__manual_")) {
            throw Object.assign(new Error(`${messageId} is a generated replacement; edit its source message instead`), { code: "INVALID_REQUEST" });
        }
        const known = [data.rawEntries, data.recoveryEntries, data.projectedEntries]
            .some(list => list.some(entry => entry.info.id === messageId));
        if (!known) {
            // Clearing a stale override stays possible after the message left history,
            // but replacing it with another inert override must not consume a revision.
            if (override === null && data.state.manualOverrides.has(messageId))
                return;
            throw Object.assign(new Error(`Raw or projected message not found: ${messageId}`), { code: "NOT_FOUND" });
        }
        if (!override || override.mode === "exclude")
            return;
        for (const block of data.state.blockRegistry.values()) {
            const active = (block.active ?? !block.consumed) && !block.consumed;
            if (!active)
                continue;
            const covered = (block.effectiveMessageIds ?? block.sourceMessageIds ?? []).includes(messageId);
            if (!covered)
                continue;
            throw Object.assign(new Error(`${messageId} is compressed into ${block.blockId}. Restore ${block.blockId} first, then keep or replace it.`), { code: "INVALID_REQUEST" });
        }
    }
    async function commitControlMutation(data, revision, nextState, nextConfig, nextRawEntries = data.recoveryEntries, editedMessageIds = [], cutMessageIds = [], view) {
        checkControlRevision(data, revision, view?.generation);
        if (data.state.controlRevision !== revision) {
            throw new RevisionConflictError("Session changed; reload before applying this edit", revision, data.state.controlRevision);
        }
        nextState.controlRevision = revision + 1;
        const sessionTokenizer = effectiveSessionTokenizer(data);
        // Compare like with like: both projections come from the same nudge-free
        // rebuild, so the only difference is the edit itself. The "before" pass runs
        // against a clone because tagging assigns refs into the state it is given.
        const previousProjected = rebuildProjectedEntries(data.recoveryEntries, cloneCoreState(data.state), data.config, sessionTokenizer);
        const nextProjected = rebuildProjectedEntries(nextRawEntries, nextState, nextConfig, sessionTokenizer);
        // Only a real projection change costs a prompt-cache rewrite, so only a real
        // change arms the coalescing signal the next pipeline run consumes.
        if (projectionFingerprint(previousProjected) !== projectionFingerprint(nextProjected)) {
            recordProjectionEdit(nextState, editedMessageIds, cutMessageIds);
        }
        await persistence.save(data.state.sessionId, nextState);
        data.state = nextState;
        data.config = nextConfig;
        if (!nextConfig.automation.modelCompression)
            data.pendingCompressRequests = [];
        data.recoveryEntries = cloneHostEntries(nextRawEntries);
        data.projectedEntries = cloneHostEntries(nextProjected);
        data.updatedAt = Date.now();
        await saveLatestSessionHistory(contentStore, contentStoreEnabled, logger, data, owners.knownWorkspace(data.state.sessionId));
        cache.refresh(data.state.sessionId);
        return buildControlSnapshot(data, sessionTokenizer, view);
    }
    /** Apply a staged projection batch: validate all, then commit under one revision. */
    async function applyProjectionEditBatch(sessionId, revision, edits, view) {
        return cache.run(sessionId, async () => {
            const data = await loadControlSession(sessionId);
            if (!data)
                throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
            checkControlRevision(data, revision, view?.generation);
            // Validate the whole batch before touching state: a save either lands
            // completely or leaves the projection exactly as it was.
            for (const edit of edits)
                validateProjectionEdit(data, edit.messageId, edit.override);
            const nextState = cloneCoreState(data.state);
            for (const edit of edits) {
                if (edit.override)
                    nextState.manualOverrides.set(edit.messageId, edit.override);
                else
                    nextState.manualOverrides.delete(edit.messageId);
            }
            return commitControlMutation(data, revision, nextState, data.config, data.recoveryEntries, edits.map(edit => edit.messageId), [], view);
        });
    }
    const controlBackend = {
        async listSessions() {
            const persisted = contentStoreEnabled ? await contentStore.listSessionHistories(async (sessionId) => (await persistence.load(sessionId))?.controlRevision ?? createInitialState(sessionId).controlRevision) : [];
            const result = new Map(persisted.flatMap(item => item.revision === undefined
                ? [] : [[item.sessionId, { ...item, revision: item.revision }]]));
            // Listing must never hydrate cold sessions into the shared live store.
            // Existing live sessions take precedence over their last saved summary.
            for (const sessionId of sessions.keys()) {
                const summary = await cache.run(sessionId, async () => {
                    const data = sessions.get(sessionId);
                    if (!data)
                        return undefined;
                    const projected = toNeutral(data.projectedEntries, data.state);
                    return {
                        sessionId,
                        title: sessionTitle(data.rawEntries),
                        ...(owners.get(sessionId) ? { workspace: owners.get(sessionId) } : {}),
                        revision: data.state.controlRevision,
                        messageCount: data.projectedEntries.length,
                        tokenCount: estimateContextTokens(projected, effectiveSessionTokenizer(data)) + data.state.systemPromptTokens,
                        updatedAt: data.updatedAt,
                    };
                });
                if (summary)
                    result.set(sessionId, summary);
            }
            return [...result.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        },
        async getSession(sessionId, view) {
            return cache.run(sessionId, async () => {
                const data = await loadControlSession(sessionId);
                if (!data)
                    return undefined;
                checkControlRevision(data, view?.revision, view?.generation);
                return buildControlSnapshot(data, effectiveSessionTokenizer(data), view);
            });
        },
        async getMessageDetail(sessionId, messageId, revision, generation) {
            return cache.run(sessionId, async () => {
                const data = await loadControlSession(sessionId);
                if (!data)
                    return undefined;
                checkControlRevision(data, revision, generation);
                const entry = data.projectedEntries.find(item => item.info.id === messageId && isHotControlMessage(item))
                    ?? (data.state.manualOverrides.get(messageId)?.mode === "exclude"
                        ? data.rawEntries.find(item => item.info.id === messageId) : undefined);
                if (!entry)
                    return undefined;
                return {
                    sessionId, revision, id: messageId,
                    message: controlMessages([entry], effectiveSessionTokenizer(data), data.state)[0],
                    override: data.state.manualOverrides.get(messageId) ?? null,
                };
            });
        },
        async getBlockDetail(sessionId, blockId, revision, generation) {
            return cache.run(sessionId, async () => {
                const data = await loadControlSession(sessionId);
                if (!data)
                    return undefined;
                checkControlRevision(data, revision, generation);
                const block = data.state.blockRegistry.get(blockId);
                if (!block)
                    return undefined;
                return { sessionId, revision, id: blockId, block: fullControlBlock(block) };
            });
        },
        async updateSettings(sessionId, revision, settings, view) {
            return cache.run(sessionId, async () => {
                const data = await loadControlSession(sessionId);
                if (!data)
                    throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
                checkControlRevision(data, revision, view?.generation);
                let runtime;
                try {
                    runtime = validateRuntimeConfig(settings);
                }
                catch (err) {
                    throw Object.assign(new Error(err instanceof Error ? err.message : "Invalid settings"), { code: "INVALID_REQUEST" });
                }
                const nextState = cloneCoreState(data.state);
                nextState.runtimeConfig = runtime;
                const nextConfig = sessionConfig(sessionId, data.config.modelContextLimit, data.providerId, data.modelId, runtime);
                const releasedMessageIds = (!nextConfig.contextTiers.enabled || !nextConfig.automation.automaticPruning)
                    ? [...new Set([...nextState.temporaryRetrievals.values()].map(lease => lease.messageId).filter((id) => Boolean(id)))]
                    : [];
                if (releasedMessageIds.length > 0)
                    nextState.temporaryRetrievals.clear();
                return commitControlMutation(data, revision, nextState, nextConfig, data.recoveryEntries, releasedMessageIds, [], view);
            });
        },
        // The single-message routes are thin wrappers over the batch path so all
        // three share one validation and commit sequence. They call the local
        // function rather than `this`, which would break under destructuring.
        async putMessageOverride(sessionId, messageId, revision, override, view) {
            return applyProjectionEditBatch(sessionId, revision, [{ messageId, override }], view);
        },
        async deleteMessageOverride(sessionId, messageId, revision, view) {
            return applyProjectionEditBatch(sessionId, revision, [{ messageId, override: null }], view);
        },
        async applyProjectionEdits(sessionId, revision, edits, view) {
            return applyProjectionEditBatch(sessionId, revision, edits, view);
        },
        async performBlockAction(sessionId, blockId, revision, action, view) {
            return cache.run(sessionId, async () => {
                const data = await loadControlSession(sessionId);
                if (!data)
                    throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
                checkControlRevision(data, revision, view?.generation);
                const block = data.state.blockRegistry.get(blockId);
                if (action === "promote" || action === "demote") {
                    if (!block)
                        throw Object.assign(new Error("Compression block not found"), { code: "NOT_FOUND" });
                    if (!data.config.contextTiers.enabled || !data.config.automation.automaticPruning) {
                        throw Object.assign(new Error("Automatic tier projection is disabled"), { code: "INVALID_REQUEST" });
                    }
                    const nextState = cloneCoreState(data.state);
                    const tierTokenizer = effectiveSessionTokenizer(data);
                    const planned = planDirectedTierSelection(nextState, action === "promote" ? { promoteBlockIds: [blockId] } : { demoteBlockIds: [blockId] }, data.config.contextTiers, tierTokenizer, data.config.modelContextLimit);
                    if (!planned.ok)
                        throw Object.assign(new Error(planned.reason), { code: "INVALID_REQUEST" });
                    try {
                        for (const changedBlockId of new Set([...planned.plan.promoteBlockIds, ...planned.plan.demoteBlockIds])) {
                            const changedBlock = nextState.blockRegistry.get(changedBlockId);
                            await loadCompressionSource(contentStore, changedBlock.durableSourceRef, sessionId, changedBlockId, changedBlock.effectiveMessageIds ?? changedBlock.sourceMessageIds ?? []);
                            const archivedSummary = await loadCompressionSummary(contentStore, changedBlock.durableSummaryRef, sessionId, changedBlockId);
                            if (archivedSummary !== changedBlock.summaryText)
                                throw new Error("summary archive mismatch");
                        }
                    }
                    catch {
                        throw Object.assign(new Error("Complete durable block archives are unavailable"), { code: "INVALID_REQUEST" });
                    }
                    const changed = applyDirectedTierSelection(nextState, planned.plan);
                    return commitControlMutation(data, revision, nextState, data.config, data.recoveryEntries, changed.effectiveMessageIds, changed.cutIds, view);
                }
                const graph = action === "deactivate" ? deactivateCompressionBlock(data.state, blockId) : activateCompressionBlock(data.state, blockId);
                if (!graph) {
                    const exists = data.state.blockRegistry.has(blockId);
                    throw Object.assign(new Error(exists ? "Restore the active parent compression before reactivating this nested block" : "Compression block not found"), { code: exists ? "INVALID_REQUEST" : "NOT_FOUND" });
                }
                const raw = action === "deactivate" ? await hydrateBlockSources(data, blockId) : data.recoveryEntries;
                const coveredIds = block?.effectiveMessageIds ?? block?.sourceMessageIds ?? [];
                // Reactivation inserts the synthetic summary immediately before its
                // anchor. Include that position so cache telemetry covers the summary
                // tokens rather than cutting only at the now-ignored source message.
                return commitControlMutation(data, revision, graph.state, data.config, raw, coveredIds, [`__summary_${blockId}`], view);
            });
        },
        async searchArchivedContent(query) {
            if (!contentStoreEnabled)
                return { items: [], totalMatches: 0 };
            if (!query.sessionId)
                return { items: [], totalMatches: 0 };
            const results = await searchCompressionSummaries(contentStore, query.sessionId, query.text, { maxResults: query.limit ?? 20, maxBytes: 64_000, snippetMaxChars: 600 });
            return {
                totalMatches: results.totalMatches,
                truncated: results.truncatedBytes || results.truncatedResults,
                items: jsonSafe(results.items.map(item => ({
                    blockId: item.blockId,
                    score: item.score,
                    title: item.label ?? item.blockId,
                    estimatedTokens: item.estimatedTokens,
                    snippet: item.snippet
                        ? `${item.snippet.before}${item.snippet.match}${item.snippet.after}`
                        : "",
                }))),
            };
        },
    };
    /** Build a single text part for a command response. */
    function commandText(sessionID, _label, text) {
        // Recent hosts validate PartID before accepting command output. Diagnostic
        // labels such as ctx-cmd-import are not host IDs and also collide on replay.
        // The host replaces messageID when attaching this part to its new user row.
        const suffix = randomUUID().replace(/-/g, "");
        return [{ id: `prt_${suffix}`, sessionID, messageID: `msg_${suffix}`, type: "text", text }];
    }
    /**
     * Replace the command template with a response in place. opencode retains the
     * original `parts` array reference after `command.execute.before`, so
     * reassigning `output.parts` would leave the template on the model-facing
     * array. splice() mutates the retained array instead.
     */
    function setCommandParts(output, sessionID, id, text) {
        output.parts.splice(0, output.parts.length, ...commandText(sessionID, id, text));
    }
    /**
     * command.execute.before
     * Handles the context-manager slash commands:
     *   /ctx-compress    — prompt the model to compress the stable range
     *   /ctx-decompress  — restore a compressed block (defaults to the latest)
     *   /ctx-stats       — report cumulative token savings for the session
     */
    async function onCommandExecuteBefore(input, output) {
        const { command, sessionID } = input;
        if (isSummaryWorkerSession(sessionID))
            return;
        if (command !== "ctx-compress" &&
            command !== "ctx-decompress" &&
            command !== "ctx-recompress" &&
            command !== "ctx-stats" &&
            command !== "ctx-ui" &&
            command !== "ctx-export" &&
            command !== "ctx-import") {
            return;
        }
        return cache.run(sessionID, async () => {
            try {
                await runCtxCommand(input, output);
            }
            finally {
                cache.refresh(sessionID);
            }
        });
    }
    async function runCtxCommand(input, output) {
        const { command, sessionID } = input;
        if (command === "ctx-export" || command === "ctx-import") {
            await runHandoffCommand(input, output);
            return;
        }
        // /ctx-ui is a pure local side effect and must work even before any session
        // has been transformed (e.g. the first action after a restart). It does not
        // depend on session state, so handle it before the session lookup.
        if (command === "ctx-ui") {
            try {
                if (!controlServer) {
                    logger.warn("ctx-ui: control server is disabled");
                }
                else {
                    const bootstrapPath = await writeControlBootstrap(services.storageRoot, `${controlServer.origin}/`, controlServer.token, "all-chats").catch(err => {
                        logger.warn("ctx: failed to write the session bootstrap file", err);
                        return controlBootstrapPath;
                    });
                    if (pluginOptions.controlServer?.openBrowser !== false && bootstrapPath !== undefined) {
                        await openLocalBrowser(bootstrapPath);
                    }
                }
            }
            catch (err) {
                logger.error("ctx-ui: failed to open the dashboard", err);
            }
            finally {
                // Never send anything to the model, even when opening fails. opencode
                // retains the original array reference, so clear in place via splice.
                output.parts.splice(0, output.parts.length);
            }
            // Abort the command so opencode does not send an empty request to the
            // model after this local-only side effect. opencode has no "silent
            // command" hook, so throwing is the only way to skip the prompt loop.
            throw new Error("ctx-ui: opened the local dashboard; no model response required");
        }
        const data = await loadControlSession(sessionID);
        if (!data) {
            setCommandParts(output, sessionID, "ctx-cmd-error", `${command}: no active session data found. Start a conversation first.`);
            return;
        }
        if (command === "ctx-stats") {
            setCommandParts(output, sessionID, "ctx-cmd-stats", formatStats(data.state.stats));
            return;
        }
        if (command === "ctx-decompress" || command === "ctx-recompress") {
            // Block id from the command argument, or the latest summary block by default.
            const requested = input.arguments?.trim();
            const blockId = requested && requested.length > 0 ? requested : data.state.latestSummaryBlockId;
            if (!blockId) {
                setCommandParts(output, sessionID, "ctx-cmd-noop", `${command}: no compressed block is available.`);
                return;
            }
            const graph = command === "ctx-decompress"
                ? deactivateCompressionBlock(data.state, blockId)
                : activateCompressionBlock(data.state, blockId);
            if (!graph) {
                setCommandParts(output, sessionID, "ctx-cmd-noop", `${command}: block "${blockId}" was not found.`);
                return;
            }
            const nextRaw = command === "ctx-decompress"
                ? await hydrateBlockSources(data, blockId)
                : data.recoveryEntries;
            graph.state.controlRevision = data.state.controlRevision + 1;
            const nextProjected = rebuildProjectedEntries(nextRaw, graph.state, data.config, effectiveSessionTokenizer(data));
            try {
                await persistence.save(sessionID, graph.state);
                data.state = graph.state;
                data.recoveryEntries = cloneHostEntries(nextRaw);
                data.projectedEntries = cloneHostEntries(nextProjected);
                data.updatedAt = Date.now();
                await saveLatestSessionHistory(contentStore, contentStoreEnabled, logger, data, owners.knownWorkspace(sessionID));
            }
            catch (err) {
                logger.warn(`ctx: failed to persist state after ${command}`, err);
                setCommandParts(output, sessionID, "ctx-cmd-error", `${command}: state persistence failed; nothing was changed.`);
                return;
            }
            setCommandParts(output, sessionID, "ctx-cmd-block", command === "ctx-decompress"
                ? `ctx-decompress: restored block ${blockId} from its durable source archive.`
                : `ctx-recompress: re-applied block ${blockId} without re-summarizing.`);
            return;
        }
        // command === "ctx-compress": inject a user message prompting the model to compress.
        if (!data.config.automation.modelCompression) {
            setCommandParts(output, sessionID, "ctx-cmd-disabled", "ctx-compress: disabled by automation.modelCompression.");
            return;
        }
        const neutralMessages = toNeutral(data.projectedEntries, data.state);
        const range = selectCompressRange(neutralMessages, data.state, data.config.compressionRecencyRequests);
        if (range.length === 0) {
            setCommandParts(output, sessionID, "ctx-cmd-noop", "ctx-compress: nothing to compress (no stable messages outside the compression request-recency window).");
            return;
        }
        const firstMsg = neutralMessages.find(m => m.id === range[0]);
        const lastMsg = neutralMessages.find(m => m.id === range[range.length - 1]);
        const startRef = firstMsg?.ref ?? range[0];
        const endRef = lastMsg?.ref ?? range[range.length - 1];
        setCommandParts(output, sessionID, "ctx-cmd-trigger", `[Manual compress trigger] Please compress the conversation from ${startRef} to ${endRef} using the compress tool. Use the 7-section structured summary format.`);
    }
    async function runHandoffCommand(input, output) {
        const { command, sessionID } = input;
        let committed = false;
        try {
            if (!contentStoreEnabled)
                throw new Error("durable content storage is disabled");
            const args = parseHandoffArguments(input.arguments ?? "", command === "ctx-export");
            const host = createHandoffHostReader(_input);
            await host.assertIdle(sessionID);
            const raw = cloneHostEntries(await (command === "ctx-import" ? host.readAllHistory(sessionID) : host.readHistory(sessionID)));
            const data = await getOrCreateSession(sessionID, modelIdentityFromEntries(raw));
            if (command === "ctx-export") {
                const state = cloneCoreState(data.state);
                const recovery = await hydrateRestoredBlockEntries(composeRecoveryEntries(raw, data.importedSeed), state, contentStore, logger);
                // Full tier rendering produces one slot per root, never catalog duplicates.
                const exportConfig = { ...data.config, contextTiers: { ...data.config.contextTiers, enabled: false } };
                const projectedEntries = rebuildProjectedEntries(recovery.entries, state, exportConfig, effectiveSessionTokenizer(data));
                const orderingState = cloneCoreState(state);
                for (const id of orderingState.manualOverrides.keys()) {
                    if (id.startsWith("__summary_"))
                        orderingState.manualOverrides.delete(id);
                }
                const orderingEntries = rebuildProjectedEntries(recovery.entries, orderingState, exportConfig, effectiveSessionTokenizer(data));
                const bundle = await collectHandoff({ state, projectedEntries, orderingEntries, importedSeed: data.importedSeed }, contentStore, localHandoffResourceReader(host.projectRoot, {
                    offloadRoots: [resolveOffloadSessionDir(sessionID), join(services.storageRoot, "ctx-import-resources"),
                        join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".local", "share"), "opencode", "tool-output"),
                        ...[...state.messageIndex.values()].flatMap(item => item.offloadPath ? [dirname(item.offloadPath)] : []),
                    ],
                }));
                const bytes = encodeBundle(bundle.payload);
                await writeBundleFile(host.projectRoot, args.path, bytes, args.overwrite);
                const unavailable = bundle.payload.roots.filter(root => !root.recoverable).length;
                setCommandParts(output, sessionID, "ctx-cmd-export", `ctx-export: wrote ${args.path} (${bytes.byteLength} bytes; SHA-256 ${bundle.sha256}). ${bundle.payload.sequence.filter(node => node.type === "hot").length} HOT records, ${bundle.payload.roots.length} active roots; ${unavailable} legacy summary-only roots. Flat-root recovery and referenced resources are embedded. Git staging is manual.`);
                return;
            }
            const bundle = decodeBundle(await readBundleFile(host.projectRoot, args.path));
            const cachedModel = systemModels.get(sessionID);
            const cachedLimit = contextLimits.get(sessionID);
            const resolvedModel = cachedModel && cachedLimit
                ? { ...cachedModel, contextLimit: cachedLimit }
                : await host.getModelContext(sessionID);
            if (resolvedModel)
                syncSessionModel(data, resolvedModel, contextLimits.get(sessionID) ?? resolvedModel.contextLimit);
            const limit = contextLimits.get(sessionID) ?? resolvedModel?.contextLimit;
            if (limit === undefined)
                throw new Error("destination model context limit is unavailable; select a model with published context metadata before importing");
            const config = sessionConfig(sessionID, limit, data.providerId, data.modelId, data.state.runtimeConfig);
            config.modelContextLimit = limit;
            config.systemPromptTokens = data.state.systemPromptTokens;
            const receiptReserve = 2_048;
            const result = await importHandoff({ bundle, currentState: data.state, hostEntries: raw,
                invocationText: `/ctx-import${input.arguments?.trim() ? ` ${input.arguments.trim()}` : ""}`,
                store: contentStore, persistence, tokenizer: effectiveSessionTokenizer(data), config, resourceRoot: services.storageRoot,
                project: (entries, state) => rebuildProjectedEntries(entries, state, config, effectiveSessionTokenizer(data)),
                measure: (entries, state) => estimateContextTokens(toNeutral(entries, state), effectiveSessionTokenizer(data)) + config.systemPromptTokens + receiptReserve,
            });
            committed = !result.alreadyImported;
            data.state = result.state;
            data.config = config;
            data.importedSeed = result.seed;
            data.rawEntries = raw;
            data.recoveryEntries = composeRecoveryEntries(raw, result.seed);
            data.projectedEntries = result.projectedEntries;
            data.updatedAt = Date.now();
            await saveLatestSessionHistory(contentStore, contentStoreEnabled, logger, data, owners.knownWorkspace(sessionID));
            setCommandParts(output, sessionID, "ctx-cmd-import", `ctx-import: ${result.alreadyImported ? "already imported; current progress preserved" : "imported durable historical context"} from ${args.path}. SHA-256 ${bundle.sha256}; ${bundle.payload.sequence.filter(node => node.type === "hot").length} HOT records, ${bundle.payload.roots.length} active roots, ${result.unrecoverableRoots.length} legacy summary-only roots. Historical context is supplied in the message projection. Acknowledge the handoff and await the user's next instruction.`);
        }
        catch (error) {
            setCommandParts(output, sessionID, "ctx-cmd-handoff-error", committed
                ? `${command}: import committed, but refreshing its presentation failed; restart to reload the durable seed.`
                : `${command}: ${error instanceof Error ? error.message : "handoff failed"}`);
        }
    }
    async function captureRemoteContext(host, allowedDirectories, request) {
        if (isSummaryWorkerSession(request.sessionId))
            throw new Error("summary worker context is not exportable");
        if (typeof request.sessionId !== "string" || !request.sessionId.trim()) {
            throw new Error("remote context sessionId must be a non-empty string");
        }
        const directory = normalizeRemoteContextDirectory(request.directory);
        if (!allowedDirectories.has(directory)) {
            throw new Error(`remote context directory does not belong to this plugin bridge: ${directory}`);
        }
        const selectionRequest = validateRemoteSelectionRequest(request.context);
        if (selectionRequest.mode === "none") {
            const bytes = encodeBundle({ sequence: [], roots: [], records: {}, blobs: {} });
            const bundle = decodeBundle(bytes);
            return {
                bytes,
                sessionId: request.sessionId,
                directory,
                bundleDigest: bundle.sha256,
                selection: { mode: "none", messageCount: 0, blockCount: 0, recoverableBlockCount: 0, summaryOnlyBlockCount: 0 },
            };
        }
        if (!contentStoreEnabled)
            throw new Error("remote context capture requires durable content storage");
        return cache.run(request.sessionId, async () => {
            // The host read is deliberately allowed while the chat is busy. It is
            // bounded/read-only, then cut immediately before this remote_submit call.
            const fresh = cloneHostEntries(await host.readHistory(request.sessionId));
            const safeFreshHistory = sanitizeRemoteCaptureHistory(fresh, request.messageId, request.callId);
            const live = sessions.get(request.sessionId);
            const persisted = live ? undefined : await persistence.load(request.sessionId);
            const persistedHistory = live ? undefined : await contentStore.loadSessionHistory(request.sessionId);
            const state = cloneCoreState(live?.state ?? persisted ?? createInitialState(request.sessionId));
            if (state.sessionId !== request.sessionId)
                throw new Error("remote context state belongs to another session");
            const stableRefs = new Map(state.messageIds.byRef);
            const safeHistory = request.messageId === undefined && request.callId === undefined
                ? mergeStoredCaptureHistory(live?.rawEntries ?? [], safeFreshHistory)
                : safeFreshHistory;
            const identity = modelIdentityFromEntries(safeHistory)
                ?? (live ? { providerId: live.providerId, modelId: live.modelId } : undefined)
                ?? identityFromModelKey(state.contextTokenMetrics.modelKey ?? state.tokenCalibration.modelKey)
                ?? { providerId: "opencode-go", modelId: "deepseek-v4-flash" };
            const config = live?.config ?? sessionConfig(request.sessionId, state.modelContextLimit > 0 ? state.modelContextLimit : defaultContextLimit, identity.providerId, identity.modelId, state.runtimeConfig);
            const baseTokenizer = live?.tokenizer ?? sessionTokenizer(request.sessionId, identity.providerId, identity.modelId);
            const captureTokenizer = state.tokenCalibration.sampleCount > 0
                && Math.abs(state.tokenCalibration.ratio - 1) > 0.01
                ? new CalibratedTokenizer(baseTokenizer, state.tokenCalibration.ratio)
                : baseTokenizer;
            let importedSeed = live?.importedSeed;
            if (!importedSeed && state.importedContext && selectionRequest.mode === "full") {
                importedSeed = await loadImportedSeed(state, contentStore, services.storageRoot, { readOnly: true });
            }
            const initialHistory = selectionRequest.mode === "selected" && persistedHistory
                ? mergeProjectedCaptureHistory(persistedHistory.projectedEntries, safeHistory)
                : safeHistory;
            let recovery = composeRecoveryEntries(initialHistory, importedSeed);
            const allMessages = selectionRequest.mode === "full";
            if (allMessages) {
                recovery = (await hydrateRestoredBlockEntries(recovery, state, contentStore, logger)).entries;
            }
            const exportConfig = { ...config, contextTiers: { ...config.contextTiers, enabled: false } };
            let projectedEntries = rebuildProjectedEntries(recovery, state, exportConfig, captureTokenizer);
            let orderingState = cloneCoreState(state);
            for (const id of orderingState.manualOverrides.keys()) {
                if (id.startsWith("__summary_"))
                    orderingState.manualOverrides.delete(id);
            }
            let orderingEntries = rebuildProjectedEntries(recovery, orderingState, exportConfig, captureTokenizer);
            let selectedMessageIds;
            let selectedRootIds;
            if (selectionRequest.mode === "selected") {
                const visibleEntries = live?.projectedEntries ?? persistedHistory?.projectedEntries
                    ?? rebuildProjectedEntries(recovery, cloneCoreState(state), config, captureTokenizer);
                const selected = resolveRemoteContextSelection(selectionRequest, state, stableRefs, visibleEntries, projectedEntries, orderingEntries);
                selectedMessageIds = selected.messageIds;
                selectedRootIds = selected.rootIds;
                if (!importedSeed && state.importedContext) {
                    importedSeed = await loadImportedSeed(state, contentStore, services.storageRoot, {
                        readOnly: true,
                        messageIds: selected.rawMessageIds,
                        blockIds: selected.rootIds,
                        includeRecovery: selectionRequest.includeRecovery,
                    });
                }
                const selectedStored = visibleEntries.filter(entry => !entry.info.id.startsWith("__summary_")
                    && selected.rawMessageIds.has(rawProjectionMessageId(entry.info.id)));
                recovery = composeRecoveryEntries(mergeProjectedCaptureHistory(selectedStored, safeHistory), importedSeed);
                // Restored roots are HOT. Read only a restored archive that contributes
                // an explicitly selected message; active selected roots are loaded later
                // by collectHandoff and no unrelated active source is visited.
                const hydrated = await hydrateRestoredBlockEntries(recovery, state, contentStore, logger, new Set([...selected.rawMessageIds]));
                recovery = hydrated.entries;
                projectedEntries = rebuildProjectedEntries(recovery, state, exportConfig, captureTokenizer);
                orderingState = cloneCoreState(state);
                for (const id of orderingState.manualOverrides.keys()) {
                    if (id.startsWith("__summary_"))
                        orderingState.manualOverrides.delete(id);
                }
                orderingEntries = rebuildProjectedEntries(recovery, orderingState, exportConfig, captureTokenizer);
                selectedMessageIds = new Set([...selected.rawMessageIds].map(rawId => projectedEntryForRaw(projectedEntries, rawId)?.info.id
                    ?? (() => { throw new Error(`selected message is no longer projected: ${rawId}`); })()));
            }
            const bundle = await collectHandoff({ state, projectedEntries, orderingEntries, importedSeed }, contentStore, localHandoffResourceReader(host.projectRoot, {
                offloadRoots: [resolveOffloadSessionDir(request.sessionId), join(services.storageRoot, "ctx-import-resources"),
                    join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".local", "share"), "opencode", "tool-output"),
                    ...[...state.messageIndex.values()].flatMap(item => item.offloadPath ? [dirname(item.offloadPath)] : []),
                ],
            }), {
                messageIds: selectedMessageIds,
                rootIds: selectedRootIds,
                includeRecovery: selectionRequest.includeRecovery,
            });
            const bytes = encodeBundle(bundle.payload);
            const recoverableBlockCount = bundle.payload.roots.filter(root => root.recoverable).length;
            return {
                bytes,
                sessionId: request.sessionId,
                directory,
                bundleDigest: bundle.sha256,
                selection: {
                    mode: selectionRequest.mode,
                    messageCount: bundle.payload.sequence.filter(node => node.type === "hot").length,
                    blockCount: bundle.payload.roots.length,
                    recoverableBlockCount,
                    summaryOnlyBlockCount: bundle.payload.roots.length - recoverableBlockCount,
                },
            };
        });
    }
    const remoteBridgeDirectories = pluginContextDirectories(_input);
    if (remoteBridgeDirectories.length > 0) {
        try {
            const host = createHandoffHostReader(_input);
            const allowedDirectories = new Set();
            const bridge = {
                version: 1,
                capture: request => captureRemoteContext(host, allowedDirectories, request),
            };
            for (const directory of registerRemoteContextBridge(remoteBridgeDirectories, bridge, pluginContextOwnerToken(_input))) {
                allowedDirectories.add(directory);
            }
            unregisterBridge = () => unregisterRemoteContextBridge(allowedDirectories, bridge);
        }
        catch (err) {
            logger.warn("ctx: remote context bridge unavailable for this plugin instance", err);
        }
    }
    if (pluginOptions.controlServer?.enabled) {
        try {
            const registered = await controlService.register({
                workspace, backend: controlBackend, durable: contentStoreEnabled,
                persistedOwner: async (sessionId) => {
                    if (!exactDirectory && workspace === services.storageRoot) {
                        return controlService.isSoleWorkspace(workspace) ? workspace : undefined;
                    }
                    const summary = (await contentStore.listSessionHistories()).find(item => item.sessionId === sessionId);
                    return summary?.workspace;
                },
                hostOwner: async (sessionId) => {
                    const client = _input;
                    const session = client?.client?.session;
                    if (session?.get) {
                        try {
                            const result = await session.get.call(session, {
                                path: { id: sessionId }, query: { directory: workspace }, throwOnError: true,
                            });
                            const data = result.data;
                            if (data?.id === sessionId && typeof data.directory === "string" && isAbsolute(data.directory)) {
                                return resolve(data.directory) === workspace ? workspace : undefined;
                            }
                        }
                        catch { /* An unknown or unavailable host identity cannot claim ownership. */ }
                    }
                    return undefined;
                },
            }, {
                host: pluginOptions.controlServer.host ?? "127.0.0.1",
                port: pluginOptions.controlServer.port ?? 0,
            }, async (server) => {
                controlBootstrapPath = await writeControlBootstrap(services.storageRoot, `${server.origin}/`, server.token);
            });
            controlServer = registered.server;
            unregisterControl = registered.unregister;
            controlBootstrapPath ??= join(services.storageRoot, "ctx-control.html");
            for (const [id, owner] of owners.entries())
                if (owner === workspace)
                    controlService.observe(id, workspace);
            logger.info(`ctx control: ${controlServer.origin} (private bootstrap file: ${controlBootstrapPath})`);
        }
        catch (err) {
            logger.warn("ctx: control server failed to start; plugin will continue without it", err);
        }
    }
    // ── Return Hooks object ─────────────────────────────────────────────────────
    return {
        // Reporting-agent safety: the system hook is OUTPUT-SAFE — onSystemTransform
        // never writes to output.system (injecting a second context-management
        // instruction into this app's dynamic system prompt caused empty assistant
        // responses in live Docker smoke tests). It only reads: caches the context
        // limit and measures system-prompt tokens. Nudges are delivered through the
        // messages channel; automatic mechanical pruning runs in messages.transform.
        "experimental.chat.messages.transform": onMessagesTransform,
        "experimental.chat.system.transform": onSystemTransform,
        "experimental.text.complete": onTextComplete,
        "event": onEvent,
        "config": onConfig,
        "command.execute.before": onCommandExecuteBefore,
        "tool.execute.before": onToolExecuteBefore,
        "tool": {
            compress: compressTool,
            compress_message: compressMessageTool,
            ctx_archive_search: archiveSearchTool,
            ctx_archive_retrieve: archiveRetrieveTool,
            ctx_archive_release: archiveReleaseTool,
            ctx_tier_update: tierUpdateTool,
            ctx_compression_status: compressionStatusTool,
        },
    };
}
// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Resolve the workspace root used by core when constructing offload paths.
 *
 * Prefers WORKSPACES_ROOT (the BFF deployment volume) and falls back to the OS
 * temp directory. Core appends `.ctx-offload/<safe-session>/<safe-call>.txt`.
 */
function resolveWorkspaceDir(_sessionId) {
    return process.env.WORKSPACES_ROOT ?? join(tmpdir(), "ctx");
}
function resolveOffloadSessionDir(sessionId) {
    return join(resolveWorkspaceDir(sessionId), ".ctx-offload", safePathSegment(sessionId));
}
async function archiveHostRefeed(store, enabled, logger, sessionId, entries) {
    if (!enabled)
        return;
    const projectId = projectIdFromEntries(entries);
    const requests = [];
    for (const entry of entries) {
        const data = JSON.stringify(entry);
        requests.push({
            what: `raw message ${entry.info.id}`,
            request: {
                data,
                metadata: {
                    sessionId,
                    projectId,
                    source: "opencode",
                    kind: "history-message",
                    label: `${entry.info.role}:${entry.info.id}`,
                },
                id: `message-${contentHash(`${sessionId}\0${entry.info.id}\0${data}`)}`,
            },
        });
    }
    for (const toolOutput of completedToolOutputs(entries)) {
        requests.push({
            what: `tool output ${toolOutput.callId}`,
            request: {
                data: toolOutput.output,
                metadata: {
                    sessionId,
                    projectId,
                    source: toolOutput.tool,
                    kind: "tool-output",
                    callId: toolOutput.callId,
                    label: `${toolOutput.title} (${toolOutput.messageId})`,
                },
                id: `tool-${contentHash(`${sessionId}\0${toolOutput.callId}`)}`,
            },
        });
    }
    // One index publication per re-feed: the shared index spans every session,
    // so per-record publication turned a long first re-feed (e.g. a session
    // migrated to a new host shape) into minutes of index rewrites.
    if (store.writeMany) {
        try {
            await store.writeMany(requests.map(item => item.request));
            return;
        }
        catch (err) {
            logger.warn(`ctx: batched archive of ${requests.length} raw records failed; retrying individually`, err);
        }
    }
    for (const { request, what } of requests) {
        try {
            await store.write(request);
        }
        catch (err) {
            logger.warn(`ctx: failed to archive ${what}`, err);
        }
    }
}
async function hydrateRestoredBlockEntries(entries, state, store, logger, onlyMessageIds) {
    const restored = [...state.blockRegistry.values()].filter(block => block.deactivatedByUser && !block.active && block.durableSourceRef
        && (onlyMessageIds === undefined
            || (block.effectiveMessageIds ?? block.sourceMessageIds ?? []).some(id => onlyMessageIds.has(id))));
    if (restored.length === 0)
        return { entries, graphChanged: false };
    const byId = new Map(entries.map(entry => [entry.info.id, entry]));
    let changed = false;
    let graphChanged = false;
    for (const block of restored) {
        try {
            const archived = await loadCompressionSource(store, block.durableSourceRef, state.sessionId, block.blockId, block.effectiveMessageIds ?? block.sourceMessageIds ?? []);
            for (const entry of archived) {
                if (!byId.has(entry.info.id)) {
                    byId.set(entry.info.id, entry);
                    changed = true;
                }
            }
        }
        catch (err) {
            logger.warn(`ctx: failed to hydrate restored block ${block.blockId}`, err);
            const fallback = activateCompressionBlock(state, block.blockId);
            if (fallback) {
                Object.assign(state, fallback.state);
                graphChanged = true;
            }
        }
    }
    if (!changed)
        return { entries, graphChanged };
    return { entries: [...byId.values()].sort((left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id)), graphChanged };
}
async function ensureSummaryArchives(data, store, persistence, logger) {
    const missing = [...data.state.blockRegistry.values()].filter(block => !block.durableSummaryRef && typeof block.summaryText === "string" && block.summaryText.length > 0);
    if (missing.length === 0)
        return;
    const next = cloneCoreState(data.state);
    let changed = false;
    const createdIds = [];
    for (const block of missing) {
        try {
            const archived = await archiveCompressionSummary(store, data.state.sessionId, block.blockId, block.topic, block.summaryText);
            await loadCompressionSummary(store, archived.record.id, data.state.sessionId, block.blockId);
            if (archived.created)
                createdIds.push(archived.record.id);
            next.blockRegistry.get(block.blockId).durableSummaryRef = archived.record.id;
            changed = true;
        }
        catch (err) {
            logger.warn(`ctx: failed to backfill summary archive for ${block.blockId}; keeping it warm`, err);
        }
    }
    if (!changed)
        return;
    try {
        await persistence.save(data.state.sessionId, next);
        data.state = next;
    }
    catch (err) {
        for (const id of createdIds) {
            try {
                await store.delete(id);
            }
            catch { /* best-effort orphan cleanup */ }
        }
        logger.warn("ctx: failed to persist summary archive references; keeping blocks warm", err);
    }
}
async function saveLatestSessionHistory(store, enabled, logger, data, workspace) {
    if (!enabled)
        return;
    try {
        // Callers await this save under the session coordinator. These histories are
        // already owned snapshots; cloning them again doubles the serialization peak.
        await store.saveSessionHistory({
            version: 1,
            sessionId: data.state.sessionId,
            rawEntries: data.rawEntries,
            projectedEntries: data.projectedEntries,
            updatedAt: data.updatedAt,
            stateVersion: persistedStateVersion(data.state),
            summary: { revision: data.state.controlRevision, ...(workspace ? { workspace } : {}) },
        });
    }
    catch (err) {
        logger.warn("ctx: failed to save latest session history", err);
    }
}
function persistedStateVersion(state) {
    return [
        state.stats.totalTurns,
        state.controlRevision,
        state.nextBlockId,
        state.nextRunId,
        state.projectionEditRevision ?? 0,
    ].join(":");
}
/** Rebuild a nudge-free projection from recovery history and persisted decisions. */
function rebuildProjectedEntries(rawEntries, state, config, tokenizer) {
    const retrievalSafe = redactInactiveArchiveRetrievals(rawEntries, state);
    const tagged = runTagging(toNeutral(retrievalSafe, state), state);
    const automatic = applyDecisions(tagged, state, {
        automaticPruning: config.automation.automaticPruning,
        contextTiers: config.contextTiers,
        tokenizer,
        modelContextLimit: config.modelContextLimit,
    });
    const manual = applyManualOverrides(automatic, state, tagged);
    return applyNeutral(retrievalSafe, runFinalize(manual));
}
const controlProjectionGenerations = new WeakMap();
function controlProjectionGeneration(data) {
    let generation = controlProjectionGenerations.get(data.projectedEntries);
    if (!generation) {
        generation = randomUUID();
        controlProjectionGenerations.set(data.projectedEntries, generation);
    }
    return generation;
}
function checkControlRevision(data, revision, generation) {
    if ((revision !== undefined && revision !== data.state.controlRevision) ||
        (generation !== undefined && generation !== controlProjectionGeneration(data))) {
        throw new RevisionConflictError("Session changed; reload inventory", revision, data.state.controlRevision);
    }
}
function isHotControlMessage(entry) {
    return entry.info.id !== "__ctx_cold_catalog" && !entry.info.id.startsWith("__summary_");
}
function fullControlBlock(block) {
    const active = (block.active ?? !block.consumed) && !block.consumed;
    return jsonSafe({
        ...block,
        effectiveMessageIds: block.effectiveMessageIds ?? block.sourceMessageIds ?? [],
        status: active ? "active" : block.deactivatedByUser ? "restored" : "nested",
    });
}
/** One token pass per immutable projected array/model calibration; no complete history clone. */
const inventoryMetrics = new WeakMap();
function inventoryPreview(entry) {
    for (const part of entry.parts) {
        const record = part;
        if ((part.type === "text" || part.type === "reasoning") && typeof record.text === "string")
            return record.text.slice(0, 512);
        if (part.type === "tool") {
            const state = record.state;
            const output = state?.status === "completed" ? state.output : state?.status === "error" ? state.error : "";
            return (String(record.tool ?? "tool") + ": " + (typeof output === "string" ? output.slice(0, 512) : "")).slice(0, 512);
        }
    }
    return "";
}
function buildControlInventory(data, tokenizer, view) {
    const state = data.state;
    const ratio = state.tokenCalibration.sampleCount > 0 && Math.abs(state.tokenCalibration.ratio - 1) > 0.01
        ? state.tokenCalibration.ratio : 1;
    let metrics = inventoryMetrics.get(data.projectedEntries);
    if (!metrics || metrics.baseTokenizer !== data.tokenizer || metrics.ratio !== ratio) {
        let hotTokens = 0;
        let projectedTokens = 0;
        for (const entry of data.projectedEntries) {
            const message = toNeutral([entry], state)[0];
            if (!message || message.isIgnored)
                continue;
            const count = estimateMessageTokens(message, tokenizer);
            projectedTokens += count;
            if (isHotControlMessage(entry))
                hotTokens += count;
        }
        metrics = { baseTokenizer: data.tokenizer, ratio, hotTokens, projectedTokens };
        inventoryMetrics.set(data.projectedEntries, metrics);
    }
    const hot = data.projectedEntries.filter(isHotControlMessage);
    const coveredBy = new Map();
    for (const block of state.blockRegistry.values()) {
        if (!(block.active ?? !block.consumed) || block.consumed)
            continue;
        for (const id of block.effectiveMessageIds ?? block.sourceMessageIds ?? [])
            coveredBy.set(id, block.blockId);
    }
    const messages = hot.slice(view.messageOffset, view.messageOffset + view.limit).map(entry => {
        const id = entry.info.id;
        const sourceId = id.startsWith("__manual_") ? id.slice("__manual_".length) : id;
        const neutral = toNeutral([entry], state)[0];
        const saved = state.manualOverrides.get(sourceId);
        const message = {
            id, sourceId, role: entry.info.role, createdAt: entry.info.time.created,
            tokenCount: neutral ? estimateMessageTokens(neutral, tokenizer) : 0,
            preview: inventoryPreview(entry),
        };
        if (coveredBy.has(sourceId))
            message.blockId = coveredBy.get(sourceId);
        if (saved)
            message.override = { mode: saved.mode };
        return message;
    });
    const hotIds = new Set(hot.map(entry => entry.info.id));
    const excludedIds = [...state.manualOverrides].filter(([id, override]) => override.mode === "exclude" && !hotIds.has(id) && !hotIds.has(`__manual_${id}`));
    const excludedOverrides = excludedIds
        .slice(view.overrideOffset, view.overrideOffset + view.limit).map(([id, override]) => {
        const entry = data.rawEntries.find(item => item.info.id === id);
        const neutral = entry ? toNeutral([entry], state)[0] : undefined;
        return {
            id, sourceId: id, role: entry?.info.role ?? "unavailable",
            createdAt: entry?.info.time.created ?? 0,
            tokenCount: neutral ? estimateMessageTokens(neutral, tokenizer) : 0,
            preview: entry ? inventoryPreview(entry) : "Source no longer in host history; reset is still available.",
            override: { mode: override.mode },
            ...(coveredBy.has(id) ? { blockId: coveredBy.get(id) } : {}),
        };
    });
    const allBlocks = [...state.blockRegistry.values()];
    const blocks = allBlocks.slice(view.blockOffset, view.blockOffset + view.limit).map(block => {
        const active = (block.active ?? !block.consumed) && !block.consumed;
        return {
            blockId: block.blockId,
            status: active ? "active" : block.deactivatedByUser ? "restored" : "nested",
            projectionTier: block.projectionTier ?? "warm",
            topic: block.topic.slice(0, 512),
            sourceTokens: block.sourceTokens,
            summaryTokens: block.summaryTokens,
            sourceCount: (block.effectiveMessageIds ?? block.sourceMessageIds ?? []).length,
        };
    });
    return {
        view: "inventory", sessionId: state.sessionId, revision: state.controlRevision,
        generation: controlProjectionGeneration(data),
        messageOffset: view.messageOffset, blockOffset: view.blockOffset, overrideOffset: view.overrideOffset, limit: view.limit,
        messageCount: hot.length, blockCount: allBlocks.length, excludedOverrideCount: excludedIds.length,
        hotTokenCount: metrics.hotTokens,
        messages, blocks, excludedOverrides,
        settings: jsonSafe(state.runtimeConfig),
        effectiveSettings: jsonSafe(editableSettings(data.config)),
        stats: jsonSafe({ ...state.stats, projectedTokens: metrics.projectedTokens + state.systemPromptTokens,
            systemPromptTokens: state.systemPromptTokens, modelContextLimit: data.config.modelContextLimit }),
        pendingProjectionEdit: hasPendingProjectionRewrite(state),
        updatedAt: data.updatedAt,
    };
}
function buildControlSnapshot(data, tokenizer, view) {
    if (view)
        return buildControlInventory(data, tokenizer, view);
    const raw = controlMessages(data.rawEntries, tokenizer, data.state);
    const projected = controlMessages(data.projectedEntries, tokenizer, data.state);
    const automaticState = cloneCoreState(data.state);
    automaticState.manualOverrides.clear();
    const automaticProjected = controlMessages(rebuildProjectedEntries(data.recoveryEntries, automaticState, data.config, tokenizer), tokenizer, automaticState);
    const projectedTokens = estimateContextTokens(toNeutral(data.projectedEntries, data.state), tokenizer) + data.state.systemPromptTokens;
    return {
        sessionId: data.state.sessionId,
        revision: data.state.controlRevision,
        rawHostHistory: raw,
        projectedContext: projected,
        automaticProjectedContext: automaticProjected,
        blocks: [...data.state.blockRegistry.values()].map(fullControlBlock),
        settings: jsonSafe(data.state.runtimeConfig),
        effectiveSettings: jsonSafe(editableSettings(data.config)),
        stats: jsonSafe({
            ...data.state.stats,
            projectedTokens,
            systemPromptTokens: data.state.systemPromptTokens,
            modelContextLimit: data.config.modelContextLimit,
        }),
        overrides: jsonSafe(Object.fromEntries(data.state.manualOverrides)),
        runtimeOverrides: jsonSafe(data.state.runtimeConfig),
        // True while a saved edit has not yet been delivered: the projection below is
        // exactly what the next request will carry, ahead of that request happening.
        pendingProjectionEdit: hasPendingProjectionRewrite(data.state),
        updatedAt: data.updatedAt,
    };
}
function editableSettings(config) {
    return {
        profile: config.profile,
        recencyGuardTurns: config.recencyGuardTurns,
        compressionRecencyRequests: config.compressionRecencyRequests,
        minRepruneInterval: config.minRepruneInterval,
        clearAtLeast: config.clearAtLeast,
        hardCap: config.hardCap,
        cacheModel: { ...config.cacheModel },
        costRoi: { ...config.costRoi },
        automation: { ...config.automation },
        contextTiers: { ...config.contextTiers },
        cachePrune: { ...config.cachePrune },
        summarization: {
            ...config.summarization,
            protectedToolGlobs: [...(config.summarization.protectedToolGlobs ?? [])],
            protectedFilePathGlobs: [...(config.summarization.protectedFilePathGlobs ?? [])],
        },
        nearDupe: { ...config.nearDupe },
        nudges: { ...config.nudges },
        toolClasses: Object.fromEntries(Object.entries(config.toolClasses).map(([name, item]) => [name, { ...item }])),
    };
}
function controlMessages(entries, tokenizer, state) {
    const neutralById = new Map(toNeutral(entries, state).map(message => [message.id, message]));
    return entries.map(entry => {
        const neutral = neutralById.get(entry.info.id);
        return jsonSafe({
            ...entry,
            id: entry.info.id,
            role: entry.info.role,
            createdAt: entry.info.time.created,
            tokenCount: neutral ? estimateMessageTokens(neutral, tokenizer) : 0,
        });
    });
}
function jsonSafe(value) {
    return JSON.parse(JSON.stringify(value));
}
/**
 * Stable digest of an outbound projection: message identity plus the exact text
 * and tool payloads that would reach the provider. Used to decide whether a
 * dashboard save actually changed what the model will see.
 */
function projectionFingerprint(entries) {
    const shape = entries.map(entry => [
        entry.info.id,
        entry.info.role,
        entry.parts.map(part => {
            const record = part;
            return [part.type, record.text ?? "", record.callID ?? "", JSON.stringify(record.state ?? null)];
        }),
    ]);
    return contentHash(JSON.stringify(shape));
}
function sessionTitle(entries) {
    for (const entry of entries) {
        if (entry.info.role !== "user")
            continue;
        const text = entry.parts.find(part => part.type === "text");
        if (text?.text?.trim())
            return text.text.trim().replace(/\s+/g, " ").slice(0, 80);
    }
    return undefined;
}
function projectIdFromEntries(entries) {
    for (const entry of entries) {
        if (entry.info.role === "assistant")
            return entry.info.path.root;
    }
    return undefined;
}
function isCtxTool(tool) {
    const normalized = tool.trim().toLowerCase();
    return normalized === "compress" || normalized.startsWith("ctx-") || normalized.startsWith("ctx_");
}
function boundedGuidance(guidance) {
    return guidance.replace(/\s+/g, " ").slice(0, 400);
}
/**
 * Delete offload files older than maxAgeMs from the session workspace dir.
 * Fire-and-forget — errors are swallowed so cleanup never aborts a user turn.
 */
async function cleanupOldOffloadFiles(dir, maxAgeMs, referencedPaths = new Set()) {
    try {
        const { readdir, stat, rm } = await import("node:fs/promises");
        const now = Date.now();
        // readdir with recursive: true requires Node 18.17+ / Bun 1+
        const files = await readdir(dir, { recursive: true }).catch(() => []);
        for (const file of files) {
            const filePath = join(dir, file);
            try {
                const s = await stat(filePath);
                if (s.isFile() && !referencedPaths.has(filePath) && now - s.mtimeMs > maxAgeMs) {
                    await rm(filePath, { force: true });
                }
            }
            catch { /* individual file errors are safe to ignore */ }
        }
    }
    catch { /* dir doesn't exist or other setup error — ignore */ }
}
/**
 * Write the owner-only bootstrap file that hands the dashboard credential to the
 * browser through a URL fragment (never an HTTP path, query, log, or referrer).
 * The caller chooses the filename so the general dashboard can share one
 * authenticated bootstrap with its session selector.
 */
async function writeControlBootstrap(storageRoot, baseUrl, token, sessionId) {
    const name = sessionId ? `ctx-control-${safePathSegment(sessionId)}.html` : "ctx-control.html";
    const path = join(storageRoot, name);
    const url = `${baseUrl}#token=${token}`;
    await writePrivateText(path, `<!doctype html><meta name="referrer" content="no-referrer"><script>location.replace(${JSON.stringify(url)})</script>`);
    return path;
}
async function writePrivateText(path, text) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
    }
    catch (err) {
        try {
            await import("node:fs/promises").then(fs => fs.rm(tmp, { force: true }));
        }
        catch { /* best effort */ }
        throw err;
    }
}
async function openLocalBrowser(target) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
    return new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(result);
        };
        try {
            const child = spawn(command, args, { stdio: "ignore", detached: false });
            timer = setTimeout(() => { child.kill(); finish(false); }, 3000);
            child.once("error", () => finish(false));
            child.once("close", code => finish(code === 0));
        }
        catch {
            // spawn throws synchronously when the launcher binary is missing from a
            // restricted PATH (e.g. Electron); treat it as a failed open, not a crash.
            finish(false);
        }
    });
}
/** Format session savings stats for the /ctx-stats command. */
function formatStats(stats) {
    return [
        "ctx stats — tokens saved this session:",
        `  total saved:     ${stats.totalTokensSaved}`,
        `  · masked:        ${stats.totalTokensMasked}`,
        `  · offloaded:     ${stats.totalTokensOffloaded}`,
        `  · compressed:    ${stats.totalTokensCompressed}`,
        `  masking passes:  ${stats.totalMaskingPasses}`,
        `  compress runs:   ${stats.totalCompressRuns}`,
    ].join("\n");
}
// ── Module export (opencode plugin module shape) ──────────────────────────────
/**
 * opencode plugin module export.
 *
 * Hosts must NOT load this module directly: opencode v1 registers every exported
 * function as a separate plugin, and the named `CtxPlugin` export (needed by the
 * library API and tests) would then be registered alongside `default`, running
 * every hook twice per turn. Load the single-export entry instead, compiled:
 *   "plugin": ["file:///abs/path/clean-impl/dist/adapters/opencode/plugin-entry.js"]
 *
 * See `plugin-entry.ts` for the runtime constraints behind that.
 */
export default CtxPlugin;
function sessionIdFromTransform(input, entries) {
    if (typeof input.sessionID === "string")
        return input.sessionID;
    return entries.find(entry => typeof entry.info?.sessionID === "string")?.info.sessionID;
}
function pluginContextDirectories(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return [];
    const record = input;
    // Current OpenCode always supplies an exact project directory. A worktree can
    // be shared by independent sessions rooted in different subdirectories, so it
    // is safe only as a compatibility fallback when directory is unavailable.
    const value = typeof record.directory === "string" && record.directory.trim() && isAbsolute(record.directory)
        ? record.directory
        : typeof record.worktree === "string" && record.worktree.trim() && isAbsolute(record.worktree)
            ? record.worktree
            : undefined;
    return value ? [normalize(resolve(value))] : [];
}
function pluginContextDirectory(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return undefined;
    const directory = input.directory;
    return typeof directory === "string" && directory.trim() && isAbsolute(directory)
        ? normalize(resolve(directory)) : undefined;
}
function pluginContextOwnerToken(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return "";
    const record = input;
    const normalized = (value) => typeof value === "string" && value.trim() && isAbsolute(value)
        ? normalize(resolve(value))
        : null;
    return JSON.stringify({
        directory: normalized(record.directory),
        worktree: normalized(record.worktree),
    });
}
function validateRemoteSelectionRequest(value) {
    if (value === undefined)
        return { mode: "full", includeRecovery: true };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("remote context selection must be an object");
    }
    if (value.mode !== "full" && value.mode !== "selected" && value.mode !== "none") {
        throw new Error("remote context mode must be full, selected, or none");
    }
    if (value.includeRecovery !== undefined && typeof value.includeRecovery !== "boolean") {
        throw new Error("remote context includeRecovery must be boolean");
    }
    const strings = (items, name) => {
        if (items === undefined)
            return undefined;
        if (!Array.isArray(items) || items.some(item => typeof item !== "string" || !item.trim())) {
            throw new Error(`remote context ${name} must contain non-empty strings`);
        }
        if (items.length > 10_000)
            throw new Error(`remote context ${name} exceeds limit`);
        return items;
    };
    const messageRefs = strings(value.messageRefs, "messageRefs");
    const blockIds = strings(value.blockIds, "blockIds");
    let ranges;
    if (value.ranges !== undefined) {
        if (!Array.isArray(value.ranges) || value.ranges.length > 10_000) {
            throw new Error("remote context ranges must be a bounded array");
        }
        ranges = value.ranges.map((range, index) => {
            if (!range || typeof range !== "object" || Array.isArray(range)
                || typeof range.startId !== "string" || !range.startId.trim()
                || typeof range.endId !== "string" || !range.endId.trim()) {
                throw new Error(`remote context range ${index} requires non-empty startId and endId`);
            }
            return { startId: range.startId, endId: range.endId };
        });
    }
    if (value.mode !== "selected" && ((messageRefs?.length ?? 0) + (blockIds?.length ?? 0) + (ranges?.length ?? 0) > 0)) {
        throw new Error(`remote context ${value.mode} mode cannot include selectors`);
    }
    if (value.mode === "selected" && (messageRefs?.length ?? 0) + (blockIds?.length ?? 0) + (ranges?.length ?? 0) === 0) {
        throw new Error("remote context selected mode requires at least one selector");
    }
    return { mode: value.mode, messageRefs, blockIds, ranges, includeRecovery: value.includeRecovery !== false };
}
function sanitizeRemoteCaptureHistory(entries, requestedMessageId, requestedCallId) {
    if (requestedMessageId !== undefined && (!requestedMessageId.trim())) {
        throw new Error("remote context messageId must be a non-empty string");
    }
    if (requestedCallId !== undefined && (!requestedCallId.trim())) {
        throw new Error("remote context callId must be a non-empty string");
    }
    let boundaryMessage = -1;
    let boundaryPart = -1;
    if (requestedCallId) {
        const matches = [];
        for (let message = 0; message < entries.length; message++) {
            for (let part = 0; part < entries[message].parts.length; part++) {
                const candidate = entries[message].parts[part];
                if (candidate.type === "tool" && candidate.callID === requestedCallId) {
                    matches.push({ message, part });
                }
            }
        }
        if (matches.length !== 1)
            throw new Error(`remote context callId was ${matches.length ? "ambiguous" : "not found"}: ${requestedCallId}`);
        boundaryMessage = matches[0].message;
        boundaryPart = matches[0].part;
        const target = entries[boundaryMessage].parts[boundaryPart];
        if (!isRemoteSubmitTool(target.tool) || !["pending", "running"].includes(target.state?.status ?? "")) {
            throw new Error(`remote context callId is not the active remote_submit invocation: ${requestedCallId}`);
        }
        if (requestedMessageId && entries[boundaryMessage].info.id !== requestedMessageId) {
            throw new Error("remote context messageId and callId belong to different messages");
        }
    }
    else if (requestedMessageId) {
        boundaryMessage = entries.findIndex(entry => entry.info.id === requestedMessageId);
        if (boundaryMessage < 0)
            throw new Error(`remote context messageId not found: ${requestedMessageId}`);
        boundaryPart = entries[boundaryMessage].parts.findIndex(part => part.type === "tool" && isRemoteSubmitTool(part.tool)
            && ["pending", "running"].includes(part.state?.status ?? ""));
        if (boundaryPart < 0) {
            // Without a call ID there is no safe part-level boundary. Exclude the
            // invoking assistant rather than risk feeding its self-referential input.
            boundaryPart = 0;
        }
    }
    else {
        for (let message = entries.length - 1; message >= 0 && boundaryMessage < 0; message--) {
            const part = entries[message].parts.findIndex(candidate => candidate.type === "tool" && isRemoteSubmitTool(candidate.tool)
                && ["pending", "running"].includes(candidate.state?.status ?? ""));
            if (part >= 0) {
                boundaryMessage = message;
                boundaryPart = part;
            }
        }
    }
    if (boundaryMessage >= 0) {
        const result = cloneHostEntries(entries.slice(0, boundaryMessage));
        const prefix = cloneHostEntries([entries[boundaryMessage]])[0];
        prefix.parts = prefix.parts.slice(0, boundaryPart);
        if (prefix.parts.some(part => captureVisiblePart(part)))
            result.push(prefix);
        return result;
    }
    // Older tool hosts may omit message/call identity. Keep the exact completed
    // transcript and safe completed prefixes of an in-flight assistant, but never
    // include pending/running tool inputs or anything that follows them.
    const result = [];
    for (const source of entries) {
        if (source.info.role === "user" || isCompletedAssistant(source)) {
            result.push(cloneHostEntries([source])[0]);
            continue;
        }
        const copy = cloneHostEntries([source])[0];
        const unsafe = copy.parts.findIndex(part => part.type === "tool"
            && ["pending", "running"].includes(part.state?.status ?? ""));
        copy.parts = unsafe < 0 ? [] : copy.parts.slice(0, unsafe);
        if (copy.parts.some(part => captureVisiblePart(part)))
            result.push(copy);
    }
    return result;
}
function mergeStoredCaptureHistory(stored, fresh) {
    if (stored.length === 0)
        return fresh;
    const freshById = new Map(fresh.map(entry => [entry.info.id, entry]));
    const result = stored.map(entry => cloneHostEntries([freshById.get(entry.info.id) ?? entry])[0]);
    const included = new Set(result.map(entry => entry.info.id));
    const userIds = new Set(stored.filter(entry => entry.info.role === "user").map(entry => entry.info.id));
    for (const entry of fresh) {
        if (included.has(entry.info.id))
            continue;
        // With no invocation identity, do not cross into a later user turn that was
        // never in the exact stored request. A newly persisted assistant child of a
        // stored user is safe and may contain completed tool output worth carrying.
        if (entry.info.role !== "assistant" || !userIds.has(entry.info.parentID))
            continue;
        result.push(cloneHostEntries([entry])[0]);
        included.add(entry.info.id);
    }
    return result.sort((left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id));
}
function mergeProjectedCaptureHistory(stored, fresh) {
    const byId = new Map();
    for (const entry of stored)
        byId.set(entry.info.id, cloneHostEntries([entry])[0]);
    for (const entry of fresh)
        byId.set(entry.info.id, cloneHostEntries([entry])[0]);
    return [...byId.values()].sort((left, right) => left.info.time.created - right.info.time.created || left.info.id.localeCompare(right.info.id));
}
function isRemoteSubmitTool(tool) {
    if (!tool)
        return false;
    return tool.toLowerCase().split(/[.:/]/).at(-1) === "remote_submit";
}
function isCompletedAssistant(entry) {
    return entry.info.role === "assistant"
        && (entry.info.error !== undefined
            || (typeof entry.info.finish === "string" && entry.info.finish.length > 0)
            || Number.isFinite(entry.info.time.completed));
}
function captureVisiblePart(part) {
    if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
        return Boolean(part.text.trim());
    }
    if (part.type === "tool") {
        return ["completed", "error"].includes(part.state?.status ?? "");
    }
    return part.type === "file";
}
function resolveRemoteContextSelection(request, state, stableRefs, visibleEntries, projectedEntries, orderingEntries) {
    const activeRoots = new Set([...state.blockRegistry.values()]
        .filter(block => (block.active ?? !block.consumed) && !block.consumed)
        .map(block => block.blockId));
    const rootIds = new Set();
    for (const id of request.blockIds ?? []) {
        if (!activeRoots.has(id))
            throw new Error(`remote context block is not an active root: ${id}`);
        rootIds.add(id);
    }
    const visibleByRaw = new Map();
    for (const entry of visibleEntries) {
        if (entry.info.id.startsWith("__summary_"))
            continue;
        visibleByRaw.set(rawProjectionMessageId(entry.info.id), entry);
    }
    const projectedByRaw = new Map();
    for (const entry of projectedEntries) {
        if (entry.info.id.startsWith("__summary_"))
            continue;
        projectedByRaw.set(rawProjectionMessageId(entry.info.id), entry);
    }
    const rawForRef = (ref) => {
        const rawId = stableRefs.get(ref);
        if (!rawId)
            throw new Error(`remote context message ref is stale or unknown: ${ref}`);
        if (!visibleByRaw.has(rawId))
            throw new Error(`remote context message ref is not currently visible: ${ref}`);
        if (!projectedByRaw.has(rawId))
            throw new Error(`remote context message ref is unavailable in safe history: ${ref}`);
        return rawId;
    };
    const rawMessageIds = new Set();
    for (const ref of request.messageRefs ?? [])
        rawMessageIds.add(rawForRef(ref));
    const nodes = [];
    const emittedHot = new Set();
    const emittedRoots = new Set();
    const append = (entry) => {
        if (entry.info.id === "__summary___ctx_cold_catalog")
            return;
        if (entry.info.id.startsWith("__summary_")) {
            const rootId = entry.info.id.slice("__summary_".length);
            if (activeRoots.has(rootId) && !emittedRoots.has(rootId)) {
                emittedRoots.add(rootId);
                nodes.push({ type: "root", rootId });
            }
            return;
        }
        const rawId = rawProjectionMessageId(entry.info.id);
        const projected = projectedByRaw.get(rawId);
        if (projected && !emittedHot.has(rawId)) {
            emittedHot.add(rawId);
            nodes.push({ type: "hot", rawId });
        }
    };
    for (const entry of orderingEntries)
        append(entry);
    for (const entry of projectedEntries)
        append(entry);
    const nodeIndex = (rawId) => nodes.findIndex(node => node.type === "hot" && node.rawId === rawId);
    for (const range of request.ranges ?? []) {
        const startRaw = rawForRef(range.startId);
        const endRaw = rawForRef(range.endId);
        const start = nodeIndex(startRaw);
        const end = nodeIndex(endRaw);
        if (start < 0 || end < 0)
            throw new Error(`remote context range endpoint is unavailable: ${range.startId}..${range.endId}`);
        if (start > end)
            throw new Error(`remote context range is reversed: ${range.startId}..${range.endId}`);
        for (const node of nodes.slice(start, end + 1)) {
            if (node.type === "hot")
                rawMessageIds.add(node.rawId);
            else
                rootIds.add(node.rootId);
        }
    }
    const messageIds = new Set();
    for (const rawId of rawMessageIds)
        messageIds.add(projectedByRaw.get(rawId).info.id);
    if (messageIds.size + rootIds.size === 0)
        throw new Error("remote context selection resolved to no visible context");
    return { messageIds, rawMessageIds, rootIds };
}
function rawProjectionMessageId(messageId) {
    return messageId.startsWith("__manual_") ? messageId.slice("__manual_".length) : messageId;
}
function projectedEntryForRaw(entries, rawId) {
    return entries.find(entry => !entry.info.id.startsWith("__summary_")
        && rawProjectionMessageId(entry.info.id) === rawId);
}
//# sourceMappingURL=plugin.js.map