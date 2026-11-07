// MIT License - see LICENSE
// Non-destructive importer for @tarquinen/opencode-dcp v3.x session sidecars.
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { cloneCoreState } from "../types/state.js";
import { buildCompressionIndex } from "../core/compress/transaction.js";
import { recordProjectionEdit } from "../core/projectionEdits.js";
import { archiveCompressionSource, archiveCompressionSummary, loadCompressionSource, loadCompressionSummary, } from "../adapters/opencode/compression-archive.js";
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
const MAX_BLOCKS = 10_000;
const MAX_IDS_PER_BLOCK = 100_000;
const MAX_TOTAL_GRAPH_IDS = 1_000_000;
const MAX_TEXT_CHARS = 8_000_000;
/** Resolve the original plugin's sidecar without modifying it. */
export function upstreamSidecarPath(sessionId, dataHome) {
    if (!/^[-_a-zA-Z0-9]+$/.test(sessionId))
        throw new Error("upstream import: invalid session id");
    const root = dataHome ?? process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".local", "share");
    return join(root, "opencode", "storage", "plugin", "dcp", `${sessionId}.json`);
}
export async function readUpstreamSidecar(sessionId, dataHome) {
    const path = upstreamSidecarPath(sessionId, dataHome);
    let raw;
    try {
        const info = await lstat(path);
        if (!info.isFile())
            throw new Error("sidecar must be a regular file");
        if (info.size > MAX_SIDECAR_BYTES)
            throw new Error("sidecar exceeds the 64 MiB import limit");
        raw = await readFile(path, "utf8");
        if (Buffer.byteLength(raw) > MAX_SIDECAR_BYTES)
            throw new Error("sidecar exceeds the 64 MiB import limit");
    }
    catch (error) {
        if (error instanceof Error && error.message.includes("64 MiB"))
            throw new Error(`upstream import: ${error.message}`);
        throw new Error(`upstream import: sidecar not found for ${sessionId}`);
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        throw new Error("upstream import: sidecar JSON is malformed");
    }
}
/** Validate and map an upstream sidecar without writing archives or state. */
export function planUpstreamSessionImport(input) {
    const parsed = parseUpstreamState(input.upstreamState);
    const parsedById = new Map(parsed.blocks.map(block => [block.blockId, block]));
    const turnsByMessageId = userTurnsByMessage(input.hostEntries);
    if (input.currentState.sessionId !== input.sessionId)
        throw new Error("upstream import: local state belongs to another session");
    const byId = new Map(input.hostEntries.map(entry => [entry.info.id, entry]));
    if (byId.size !== input.hostEntries.length)
        throw new Error("upstream import: host history contains duplicate message ids");
    if (input.hostEntries.some(entry => entry.info.sessionID !== input.sessionId)) {
        throw new Error("upstream import: host history contains another session");
    }
    const mappedBlocks = parsed.blocks.map(block => mapBlock(block, parsed.messageIndex, turnsByMessageId, input.tokenizer));
    const sourceEntriesByBlock = new Map();
    const missing = [];
    const incompleteSourceBlockIds = new Set();
    for (const block of parsed.blocks) {
        const blockId = `b${block.blockId}`;
        const entries = [];
        for (const messageId of block.effectiveMessageIds) {
            const entry = byId.get(messageId);
            if (!entry) {
                missing.push(`${blockId}:${messageId}`);
                incompleteSourceBlockIds.add(blockId);
            }
            else
                entries.push(entry);
        }
        sourceEntriesByBlock.set(blockId, entries);
    }
    if (missing.length > 0 && !input.allowIncompleteSources) {
        throw new Error(`upstream import: ${missing.length} exact source message reference(s) are unavailable`);
    }
    const equivalent = importedGraphIsEquivalent(input.currentState, mappedBlocks, incompleteSourceBlockIds);
    if (input.currentState.blockRegistry.size > 0 && !equivalent) {
        throw new Error("upstream import: our session already has a different compression graph");
    }
    const nextState = cloneCoreState(input.currentState);
    if (!equivalent) {
        nextState.blockRegistry.clear();
        nextState.activeByAnchorMessageId.clear();
        for (const mapped of mappedBlocks) {
            nextState.blockRegistry.set(mapped.blockId, mapped);
            if (mapped.active && !mapped.consumed)
                nextState.activeByAnchorMessageId.set(mapped.anchorMessageId, mapped.blockId);
        }
        nextState.nextBlockId = Math.max(parsed.nextBlockId, maxNumericId(parsed.blocks.map(block => block.blockId)) + 1);
        nextState.nextRunId = Math.max(parsed.nextRunId, maxNumericId(parsed.blocks.map(block => block.runId)) + 1);
        nextState.latestSummaryBlockId = latestBlockId(parsed.blocks);
        nextState.compressionIndex = buildCompressionIndex(nextState);
        const importedRuns = new Set(parsed.blocks.map(block => block.runId)).size;
        const importedNetSavings = parsed.blocks.reduce((sum, block) => sum + Math.max(0, block.compressedTokens
            + block.consumedBlockIds.reduce((childSum, childId) => childSum + (parsedById.get(childId)?.summaryTokens ?? 0), 0)
            - block.summaryTokens), 0);
        nextState.stats.totalCompressRuns += importedRuns;
        nextState.stats.totalTokensCompressed += importedNetSavings;
        nextState.stats.totalTokensSaved += importedNetSavings;
    }
    const canonicalActive = new Map();
    for (const block of nextState.blockRegistry.values()) {
        if (block.active && !block.consumed)
            canonicalActive.set(block.anchorMessageId, block.blockId);
    }
    const canonicalCompression = buildCompressionIndex(nextState);
    const canonicalNextBlockId = Math.max(parsed.nextBlockId, maxNumericId(parsed.blocks.map(block => block.blockId)) + 1);
    const canonicalNextRunId = Math.max(parsed.nextRunId, maxNumericId(parsed.blocks.map(block => block.runId)) + 1);
    const canonicalLatest = latestBlockId(parsed.blocks);
    const projectionNeedsRepair = equivalent && !sameCompressionIndex(nextState.compressionIndex, canonicalCompression);
    const needsStateRepair = equivalent && (!sameMap(nextState.activeByAnchorMessageId, canonicalActive)
        || projectionNeedsRepair
        || nextState.nextBlockId !== canonicalNextBlockId
        || nextState.nextRunId !== canonicalNextRunId
        || nextState.latestSummaryBlockId !== canonicalLatest);
    nextState.activeByAnchorMessageId = canonicalActive;
    nextState.compressionIndex = canonicalCompression;
    nextState.nextBlockId = canonicalNextBlockId;
    nextState.nextRunId = canonicalNextRunId;
    nextState.latestSummaryBlockId = canonicalLatest;
    return {
        sessionId: input.sessionId,
        blocks: parsed.blocks,
        nextState,
        sourceEntriesByBlock,
        incompleteSourceBlockIds: [...incompleteSourceBlockIds],
        activeBlockIds: parsed.blocks.filter(block => block.active).map(block => `b${block.blockId}`),
        totalSourceTokens: mappedBlocks.reduce((sum, block) => sum + block.sourceTokens, 0),
        totalSummaryTokens: parsed.blocks.reduce((sum, block) => sum + block.summaryTokens, 0),
        skippedPrunedTools: parsed.prunedToolCount,
        alreadyImported: equivalent,
        needsStateRepair,
        projectionNeedsRepair,
    };
}
/** Archive and publish a validated conversion. The upstream sidecar is read-only. */
export async function importUpstreamSession(input) {
    const plan = planUpstreamSessionImport(input);
    const report = {
        dryRun: input.dryRun !== false,
        alreadyImported: plan.alreadyImported,
        importedBlocks: plan.blocks.length,
        activeBlocks: plan.activeBlockIds.length,
        archivedSources: 0,
        archivedSummaries: 0,
        incompleteSourceBlocks: plan.incompleteSourceBlockIds.length,
        totalSourceTokens: plan.totalSourceTokens,
        totalSummaryTokens: plan.totalSummaryTokens,
        skippedPrunedTools: plan.skippedPrunedTools,
        stateRepaired: false,
    };
    if (input.dryRun !== false)
        return { state: plan.nextState, report };
    if (plan.alreadyImported) {
        for (const block of plan.nextState.blockRegistry.values()) {
            const sourceIsComplete = !plan.incompleteSourceBlockIds.includes(block.blockId);
            if ((sourceIsComplete && !block.durableSourceRef) || !block.durableSummaryRef) {
                throw new Error(`upstream import: imported ${block.blockId} is missing durable archives`);
            }
            if (sourceIsComplete) {
                await loadCompressionSource(input.contentStore, block.durableSourceRef, input.sessionId, block.blockId, block.effectiveMessageIds);
            }
            const summary = await loadCompressionSummary(input.contentStore, block.durableSummaryRef, input.sessionId, block.blockId);
            if (summary !== block.summaryText)
                throw new Error(`upstream import: imported ${block.blockId} summary archive differs`);
        }
        if (plan.needsStateRepair) {
            plan.nextState.controlRevision++;
            if (plan.projectionNeedsRepair) {
                const activeSources = [...plan.nextState.blockRegistry.values()]
                    .filter(block => block.active && !block.consumed)
                    .flatMap(block => block.effectiveMessageIds);
                const activeSummaries = [...plan.nextState.blockRegistry.values()]
                    .filter(block => block.active && !block.consumed)
                    .map(block => `__summary_${block.blockId}`);
                recordProjectionEdit(plan.nextState, activeSources, activeSummaries);
            }
            await input.persistence.save(input.sessionId, plan.nextState);
            report.stateRepaired = true;
        }
        return { state: plan.nextState, report };
    }
    const candidate = cloneCoreState(plan.nextState);
    const createdIds = [];
    try {
        for (const upstream of plan.blocks) {
            const blockId = `b${upstream.blockId}`;
            const block = candidate.blockRegistry.get(blockId);
            const entries = plan.sourceEntriesByBlock.get(blockId);
            const sourceIsComplete = !plan.incompleteSourceBlockIds.includes(blockId);
            let sourceRef;
            if (sourceIsComplete) {
                const source = await archiveCompressionSource(input.contentStore, input.sessionId, blockId, block.topic, block.effectiveMessageIds, entries);
                if (source.created)
                    createdIds.push(source.record.id);
                await loadCompressionSource(input.contentStore, source.record.id, input.sessionId, blockId, block.effectiveMessageIds);
                sourceRef = source.record.id;
                report.archivedSources++;
            }
            const summary = await archiveCompressionSummary(input.contentStore, input.sessionId, blockId, block.topic, block.summaryText);
            if (summary.created)
                createdIds.push(summary.record.id);
            const verifiedSummary = await loadCompressionSummary(input.contentStore, summary.record.id, input.sessionId, blockId);
            if (verifiedSummary !== block.summaryText)
                throw new Error(`upstream import: summary verification failed for ${blockId}`);
            block.durableSourceRef = sourceRef;
            block.durableSummaryRef = summary.record.id;
            report.archivedSummaries++;
        }
        candidate.compressionIndex = buildCompressionIndex(candidate);
        candidate.controlRevision++;
        const activeSources = [...candidate.blockRegistry.values()]
            .filter(block => block.active && !block.consumed)
            .flatMap(block => block.effectiveMessageIds);
        const activeSummaries = [...candidate.blockRegistry.values()]
            .filter(block => block.active && !block.consumed)
            .map(block => `__summary_${block.blockId}`);
        if (activeSources.length > 0)
            recordProjectionEdit(candidate, activeSources, activeSummaries);
        await input.persistence.save(input.sessionId, candidate);
        return { state: candidate, report };
    }
    catch (error) {
        const cleanupFailures = [];
        for (const id of createdIds.reverse()) {
            try {
                await input.contentStore.delete(id);
            }
            catch {
                cleanupFailures.push(id);
            }
        }
        if (cleanupFailures.length > 0) {
            throw new Error(`upstream import failed and ${cleanupFailures.length} unreferenced archive(s) could not be removed: ${error instanceof Error ? error.message : "unknown failure"}`);
        }
        throw error;
    }
}
function mapBlock(block, messageIndex, turnsByMessageId, tokenizer) {
    const blockId = `b${block.blockId}`;
    const createdAtTurn = turnsByMessageId.get(block.anchorMessageId) ?? 0;
    const sourceTokens = block.effectiveMessageIds.reduce((sum, messageId) => sum + (messageIndex.get(messageId)?.tokenCount ?? 0), 0);
    const summaryTokens = Math.max(0, block.summaryTokens || tokenizer.countTokens(block.summary));
    const consumed = !block.active && block.parentBlockIds.length > 0 && !block.deactivatedByUser;
    return {
        blockId,
        runId: `r${block.runId}`,
        mode: block.mode ?? "range",
        topic: block.topic,
        batchTopic: block.batchTopic,
        startRef: block.startId,
        endRef: block.endId,
        anchorMessageId: block.anchorMessageId,
        active: block.active,
        deactivatedByUser: block.deactivatedByUser,
        includedBlockIds: block.includedBlockIds.map(id => `b${id}`),
        consumedBlockIds: block.consumedBlockIds.map(id => `b${id}`),
        parentBlockIds: block.parentBlockIds.map(id => `b${id}`),
        directMessageIds: [...block.directMessageIds],
        effectiveMessageIds: [...block.effectiveMessageIds],
        directToolCallIds: [...block.directToolIds],
        effectiveToolCallIds: [...block.effectiveToolIds],
        sourceTokens,
        summaryTokens,
        netTokens: sourceTokens - summaryTokens,
        summaryText: block.summary,
        projectionTier: "warm",
        createdAt: block.createdAt,
        updatedAt: block.createdAt,
        createdAtTurn,
        updatedAtTurn: createdAtTurn,
        sourceMessageIds: [...block.effectiveMessageIds],
        tokens: summaryTokens,
        consumed,
    };
}
function parseUpstreamState(value) {
    if (!isObject(value) || !isObject(value.prune) || !isObject(value.prune.messages)) {
        throw new Error("upstream import: unsupported or malformed sidecar");
    }
    const messages = value.prune.messages;
    if (!isObject(messages.blocksById))
        throw new Error("upstream import: sidecar has no compression graph");
    const blocks = Object.values(messages.blocksById).map(parseBlock).sort((a, b) => a.blockId - b.blockId);
    if (blocks.length === 0)
        throw new Error("upstream import: sidecar contains no compression blocks");
    if (blocks.length > MAX_BLOCKS)
        throw new Error(`upstream import: sidecar exceeds ${MAX_BLOCKS} blocks`);
    const ids = new Set(blocks.map(block => block.blockId));
    if (ids.size !== blocks.length)
        throw new Error("upstream import: duplicate block id");
    for (const block of blocks) {
        for (const related of [...block.includedBlockIds, ...block.consumedBlockIds, ...block.parentBlockIds]) {
            if (!ids.has(related))
                throw new Error(`upstream import: b${block.blockId} references missing b${related}`);
        }
    }
    const messageIndex = parseMessageIndex(messages.byMessageId, blocks);
    validateGraph(blocks, messages, messageIndex);
    const stats = isObject(value.stats) ? value.stats : {};
    const tools = isObject(value.prune.tools) ? Object.keys(value.prune.tools).length : 0;
    return {
        blocks,
        messageIndex,
        nextBlockId: safePositiveInt(messages.nextBlockId, maxNumericId([...ids]) + 1),
        nextRunId: safePositiveInt(messages.nextRunId, maxNumericId(blocks.map(block => block.runId)) + 1),
        totalPruneTokens: safeNonNegativeNumber(stats.totalPruneTokens, 0),
        prunedToolCount: tools,
    };
}
function parseBlock(value) {
    if (!isObject(value))
        throw new Error("upstream import: malformed compression block");
    const blockId = requiredPositiveInt(value.blockId, "blockId");
    const effectiveMessageIds = stringArray(value.effectiveMessageIds, "effectiveMessageIds", true);
    const summary = requiredString(value.summary, "summary");
    const mode = value.mode === undefined ? undefined : value.mode;
    if (mode !== undefined && mode !== "range" && mode !== "message")
        throw new Error(`upstream import: b${blockId} has invalid mode`);
    return {
        blockId,
        runId: requiredPositiveInt(value.runId, "runId"),
        active: requiredBoolean(value.active, "active"),
        deactivatedByUser: requiredBoolean(value.deactivatedByUser, "deactivatedByUser"),
        compressedTokens: safeNonNegativeNumber(value.compressedTokens, 0),
        summaryTokens: safeNonNegativeNumber(value.summaryTokens, 0),
        mode,
        topic: requiredString(value.topic, "topic"),
        batchTopic: optionalString(value.batchTopic, "batchTopic"),
        startId: requiredString(value.startId, "startId"),
        endId: requiredString(value.endId, "endId"),
        anchorMessageId: requiredString(value.anchorMessageId, "anchorMessageId"),
        includedBlockIds: numberArray(value.includedBlockIds, "includedBlockIds"),
        consumedBlockIds: numberArray(value.consumedBlockIds, "consumedBlockIds"),
        parentBlockIds: numberArray(value.parentBlockIds, "parentBlockIds"),
        directMessageIds: stringArray(value.directMessageIds, "directMessageIds"),
        directToolIds: stringArray(value.directToolIds, "directToolIds"),
        effectiveMessageIds,
        effectiveToolIds: stringArray(value.effectiveToolIds, "effectiveToolIds"),
        createdAt: safeNonNegativeNumber(value.createdAt, 0),
        summary,
    };
}
function importedGraphIsEquivalent(state, blocks, incompleteSourceBlockIds) {
    if (state.blockRegistry.size === 0)
        return false;
    if (state.blockRegistry.size !== blocks.length)
        return false;
    return blocks.every(block => {
        const existing = state.blockRegistry.get(block.blockId);
        return Boolean(existing
            && blockFingerprint(existing) === blockFingerprint(block)
            && (incompleteSourceBlockIds.has(block.blockId) || existing.durableSourceRef)
            && existing.durableSummaryRef);
    });
}
function blockFingerprint(block) {
    return JSON.stringify({
        blockId: block.blockId,
        runId: block.runId,
        mode: block.mode,
        topic: block.topic,
        batchTopic: block.batchTopic,
        startRef: block.startRef,
        endRef: block.endRef,
        anchorMessageId: block.anchorMessageId,
        active: block.active,
        deactivatedByUser: block.deactivatedByUser,
        consumed: block.consumed,
        includedBlockIds: block.includedBlockIds,
        consumedBlockIds: block.consumedBlockIds,
        parentBlockIds: block.parentBlockIds,
        directMessageIds: block.directMessageIds,
        effectiveMessageIds: block.effectiveMessageIds,
        directToolCallIds: block.directToolCallIds,
        effectiveToolCallIds: block.effectiveToolCallIds,
        sourceTokens: block.sourceTokens,
        summaryTokens: block.summaryTokens,
        summaryText: block.summaryText,
    });
}
function parseMessageIndex(value, blocks) {
    if (!isObject(value))
        throw new Error("upstream import: sidecar has no message token index");
    const entries = new Map();
    for (const [messageId, raw] of Object.entries(value)) {
        if (!isObject(raw))
            throw new Error("upstream import: malformed message token entry");
        entries.set(messageId, {
            tokenCount: safeNonNegativeNumber(raw.tokenCount, -1),
            allBlockIds: numberArray(raw.allBlockIds, "byMessageId.allBlockIds"),
            activeBlockIds: numberArray(raw.activeBlockIds, "byMessageId.activeBlockIds"),
        });
    }
    const missing = [...new Set(blocks.flatMap(block => block.effectiveMessageIds))].filter(id => (entries.get(id)?.tokenCount ?? -1) < 0);
    if (missing.length > 0)
        throw new Error(`upstream import: message token index is incomplete (${missing.length} missing)`);
    return entries;
}
function validateGraph(blocks, messages, messageIndex) {
    const byId = new Map(blocks.map(block => [block.blockId, block]));
    const includedSets = new Map(blocks.map(block => [block.blockId, new Set(block.includedBlockIds)]));
    const parentSets = new Map(blocks.map(block => [block.blockId, new Set(block.parentBlockIds)]));
    const totalGraphIds = blocks.reduce((sum, block) => sum
        + block.includedBlockIds.length + block.consumedBlockIds.length + block.parentBlockIds.length
        + block.directMessageIds.length + block.effectiveMessageIds.length
        + block.directToolIds.length + block.effectiveToolIds.length, 0);
    if (totalGraphIds > MAX_TOTAL_GRAPH_IDS)
        throw new Error("upstream import: graph exceeds the total item limit");
    for (const block of blocks) {
        if (block.includedBlockIds.some(id => id === block.blockId) || block.parentBlockIds.some(id => id === block.blockId)) {
            throw new Error(`upstream import: b${block.blockId} contains a self-reference`);
        }
        if (!sameNumbers(block.includedBlockIds, block.consumedBlockIds)) {
            throw new Error(`upstream import: b${block.blockId} included/consumed blocks differ`);
        }
        for (const childId of block.includedBlockIds) {
            if (!parentSets.get(childId).has(block.blockId)) {
                throw new Error(`upstream import: b${block.blockId}/b${childId} relationship is not reciprocal`);
            }
        }
        for (const parentId of block.parentBlockIds) {
            if (!includedSets.get(parentId).has(block.blockId)) {
                throw new Error(`upstream import: b${block.blockId}/b${parentId} relationship is not reciprocal`);
            }
        }
    }
    const indegree = new Map([...byId.keys()].map(id => [id, 0]));
    for (const block of blocks)
        for (const child of block.includedBlockIds)
            indegree.set(child, (indegree.get(child) ?? 0) + 1);
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
    let visitedCount = 0;
    while (queue.length > 0) {
        const id = queue.pop();
        visitedCount++;
        for (const child of byId.get(id).includedBlockIds) {
            const degree = (indegree.get(child) ?? 0) - 1;
            indegree.set(child, degree);
            if (degree === 0)
                queue.push(child);
        }
    }
    if (visitedCount !== blocks.length)
        throw new Error("upstream import: compression graph contains a cycle");
    let expandedValidationWork = 0;
    for (const block of blocks) {
        const expectedEffective = new Set(block.directMessageIds);
        for (const childId of block.consumedBlockIds) {
            const childMessages = byId.get(childId).effectiveMessageIds;
            expandedValidationWork += childMessages.length;
            if (expandedValidationWork > MAX_TOTAL_GRAPH_IDS)
                throw new Error("upstream import: expanded graph validation exceeds the work limit");
            for (const messageId of childMessages)
                expectedEffective.add(messageId);
        }
        if (![...expectedEffective].every(messageId => block.effectiveMessageIds.includes(messageId))) {
            throw new Error(`upstream import: b${block.blockId} effective message coverage is inconsistent`);
        }
        const expectedTools = new Set(block.directToolIds);
        for (const childId of block.consumedBlockIds) {
            const childTools = byId.get(childId).effectiveToolIds;
            expandedValidationWork += childTools.length;
            if (expandedValidationWork > MAX_TOTAL_GRAPH_IDS)
                throw new Error("upstream import: expanded graph validation exceeds the work limit");
            for (const toolId of childTools)
                expectedTools.add(toolId);
        }
        if (![...expectedTools].every(toolId => block.effectiveToolIds.includes(toolId))) {
            throw new Error(`upstream import: b${block.blockId} effective tool coverage is inconsistent`);
        }
        if (!block.effectiveMessageIds.includes(block.anchorMessageId)) {
            throw new Error(`upstream import: b${block.blockId} anchor is outside effective coverage`);
        }
    }
    const graphAll = new Map();
    const graphActive = new Map();
    for (const block of blocks) {
        for (const messageId of block.effectiveMessageIds) {
            let allIds = graphAll.get(messageId);
            if (!allIds) {
                allIds = [];
                graphAll.set(messageId, allIds);
            }
            allIds.push(block.blockId);
            if (block.active) {
                let activeIds = graphActive.get(messageId);
                if (!activeIds) {
                    activeIds = [];
                    graphActive.set(messageId, activeIds);
                }
                activeIds.push(block.blockId);
            }
        }
    }
    if (messageIndex.size !== graphAll.size)
        throw new Error("upstream import: message coverage index has stale entries");
    for (const [messageId, allIds] of graphAll) {
        const indexed = messageIndex.get(messageId);
        if (!indexed
            || !sameNumberSets(indexed.allBlockIds, allIds)
            || !sameNumberSets(indexed.activeBlockIds, graphActive.get(messageId) ?? [])) {
            throw new Error("upstream import: message coverage index disagrees with the graph");
        }
    }
    const active = blocks.filter(block => block.active);
    const anchors = new Set();
    for (const block of active) {
        if (block.deactivatedByUser || block.parentBlockIds.some(parentId => byId.get(parentId)?.active)) {
            throw new Error(`upstream import: b${block.blockId} has inconsistent active state`);
        }
        if (anchors.has(block.anchorMessageId))
            throw new Error("upstream import: active blocks share an anchor");
        anchors.add(block.anchorMessageId);
    }
    const declaredActive = numberArray(messages.activeBlockIds, "activeBlockIds");
    if (!sameNumbers(declaredActive.slice().sort((a, b) => a - b), active.map(block => block.blockId).sort((a, b) => a - b))) {
        throw new Error("upstream import: active block index disagrees with block flags");
    }
    if (!isObject(messages.activeByAnchorMessageId))
        throw new Error("upstream import: malformed active anchor index");
    const declaredAnchors = Object.keys(messages.activeByAnchorMessageId);
    // Upstream v3 sidecars can leave this derived index empty even when block
    // flags and activeBlockIds are current. We rebuild it canonically on import.
    if (declaredAnchors.length > 0 && declaredAnchors.length !== active.length) {
        throw new Error("upstream import: active anchor index has stale entries");
    }
    if (declaredAnchors.length > 0) {
        for (const block of active) {
            if (messages.activeByAnchorMessageId[block.anchorMessageId] !== block.blockId) {
                throw new Error("upstream import: active anchor index disagrees with block flags");
            }
        }
    }
}
function userTurnsByMessage(entries) {
    const turnsByMessage = new Map();
    let turns = 0;
    for (const entry of entries.slice().sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))) {
        if (entry.info.role === "user")
            turns++;
        turnsByMessage.set(entry.info.id, turns);
    }
    return turnsByMessage;
}
function latestBlockId(blocks) {
    const latest = blocks.slice().sort((a, b) => b.createdAt - a.createdAt || b.blockId - a.blockId)[0];
    return latest ? `b${latest.blockId}` : undefined;
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function requiredString(value, field) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_CHARS)
        throw new Error(`upstream import: ${field} must be a bounded non-empty string`);
    return value;
}
function optionalString(value, field) {
    if (value === undefined)
        return undefined;
    return requiredString(value, field);
}
function requiredBoolean(value, field) {
    if (typeof value !== "boolean")
        throw new Error(`upstream import: ${field} must be boolean`);
    return value;
}
function requiredPositiveInt(value, field) {
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`upstream import: ${field} must be a positive integer`);
    return value;
}
function safePositiveInt(value, fallback) {
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function safeNonNegativeNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function stringArray(value, field, nonEmpty = false) {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
        throw new Error(`upstream import: ${field} must be a string array`);
    }
    if (nonEmpty && value.length === 0)
        throw new Error(`upstream import: ${field} must not be empty`);
    if (value.length > MAX_IDS_PER_BLOCK)
        throw new Error(`upstream import: ${field} exceeds the item limit`);
    if (new Set(value).size !== value.length)
        throw new Error(`upstream import: ${field} contains duplicates`);
    return [...value];
}
function numberArray(value, field) {
    if (!Array.isArray(value) || value.some(item => !Number.isSafeInteger(item) || item < 1)) {
        throw new Error(`upstream import: ${field} must be a positive integer array`);
    }
    if (value.length > MAX_IDS_PER_BLOCK)
        throw new Error(`upstream import: ${field} exceeds the item limit`);
    if (new Set(value).size !== value.length)
        throw new Error(`upstream import: ${field} contains duplicates`);
    return [...value];
}
function maxNumericId(values) {
    return values.length > 0 ? Math.max(...values) : 0;
}
function sameStrings(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameStringSets(left, right) {
    if (left.length !== right.length)
        return false;
    const values = new Set(right);
    return left.every(value => values.has(value));
}
function sameNumbers(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameNumberSets(left, right) {
    if (left.length !== right.length)
        return false;
    const values = new Set(right);
    return left.every(value => values.has(value));
}
function sameMap(left, right) {
    return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}
function sameCompressionIndex(left, right) {
    return left.size === right.size && [...left].every(([key, value]) => {
        const candidate = right.get(key);
        return candidate !== undefined
            && candidate.replacedByBlockId === value.replacedByBlockId
            && candidate.masked === value.masked
            && candidate.offloaded === value.offloaded;
    });
}
//# sourceMappingURL=importer.js.map