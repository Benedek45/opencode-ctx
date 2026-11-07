// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Pure planning and transactional application for compression graph updates.
import { cloneCoreState } from "../../types/state.js";
import { estimateMessageTokens } from "../tokens.js";
import { matchesGlob } from "../glob.js";
function blockFromMessage(message) {
    for (const part of message.parts)
        if (part.type === "summary-block")
            return part.blockId;
    return undefined;
}
function resolveMessage(ref, messages) {
    return messages.find(message => message.id === ref || message.ref === ref || blockFromMessage(message) === ref);
}
/**
 * Explain why a ref could not be resolved against the current projection, so a
 * caller can retry with a valid boundary instead of concluding the engine is
 * broken. Refs are write-once, so a stale ref can usually be traced back to the
 * block that absorbed its message.
 */
function describeMissingRef(ref, state) {
    if (!ref)
        return "no ref was supplied";
    const rawId = state.messageIds.byRef.get(ref);
    if (rawId) {
        for (const raw of state.blockRegistry.values()) {
            const block = legacyBlock(raw);
            if (!block.active || block.consumed)
                continue;
            if (block.effectiveMessageIds.includes(rawId)) {
                return `ref "${ref}" was already compressed into block ${block.blockId}`;
            }
        }
        return `ref "${ref}" is no longer present in the projected context`;
    }
    return `ref "${ref}" was not found`;
}
/** Span of currently resolvable refs, for quick boundary re-targeting. */
function currentRefSpan(messages) {
    const refs = messages.map(message => message.ref).filter((ref) => Boolean(ref)).sort();
    if (refs.length === 0)
        return "no message refs are currently available";
    return `current refs span ${refs[0]}..${refs[refs.length - 1]}`;
}
function toolIds(messages) {
    const result = [];
    for (const message of messages)
        for (const part of message.parts)
            if (part.type === "tool")
                result.push(part.callId);
    return [...new Set(result)];
}
function serializeMessage(message) {
    return message.parts.map(part => {
        if (part.type === "text" || part.type === "reasoning" || part.type === "summary-block")
            return part.text;
        if (part.type === "step-start")
            return part.label ?? "";
        const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
        return `[TOOL: ${part.tool}]\nInput: ${input}\nOutput: ${part.output ?? ""}`;
    }).filter(Boolean).join("\n");
}
function extractPaths(value, key = "", seen = new Set()) {
    if (value === null || value === undefined || seen.has(value))
        return [];
    if (typeof value === "string") {
        return /(?:path|file|filename|directory|dir|cwd|root)$/i.test(key) ? [value] : [];
    }
    if (typeof value !== "object")
        return [];
    seen.add(value);
    if (Array.isArray(value))
        return value.flatMap(item => extractPaths(item, key, seen));
    return Object.entries(value).flatMap(([childKey, child]) => extractPaths(child, childKey, seen));
}
function protectedContent(messages, config) {
    const result = [];
    const summarization = config.summarization;
    for (const message of messages) {
        const serialized = serializeMessage(message);
        if ((summarization.preserveUserMessages ?? false) && message.role === "user" && serialized)
            result.push(serialized);
        if (summarization.preserveProtectTags ?? true) {
            result.push(...(serialized.match(/<protect>[\s\S]*?<\/protect>/g) ?? []));
        }
        for (const part of message.parts) {
            if (part.type === "tool") {
                const toolProtected = (summarization.protectedToolGlobs ?? []).some(glob => matchesGlob(part.tool, glob));
                const pathProtected = extractPaths(part.input).some(path => (summarization.protectedFilePathGlobs ?? []).some(glob => matchesGlob(path, glob)));
                if (toolProtected || pathProtected) {
                    const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
                    result.push(`[TOOL: ${part.tool}]\nInput: ${input}\nOutput: ${part.output ?? ""}`);
                }
            }
        }
    }
    return [...new Set(result)];
}
/** Append mechanically protected source content to a model supplied summary. */
export function appendProtectedContent(messages, summary, config) {
    const preserved = protectedContent(messages, config);
    return preserved.length ? `${summary}\n\n${preserved.join("\n\n")}` : summary;
}
export function preserveIncludedBlockSummaries(summary, blockIds, state) {
    const included = new Set(blockIds);
    const referenced = [...summary.matchAll(/\((b\d+)\)/g)].map(match => match[1]);
    const invalidBlockIds = [...new Set(referenced.filter(blockId => !included.has(blockId)))];
    let expanded = summary;
    for (const blockId of blockIds) {
        const block = state.blockRegistry.get(blockId);
        if (!block)
            continue;
        const body = block.summaryText ?? "";
        const placeholder = `(${blockId})`;
        const preserved = `### Preserved ${blockId}\n${body}`;
        if (expanded.includes(placeholder)) {
            expanded = expanded.split(placeholder).join(preserved);
        }
        else {
            expanded = `${expanded}\n\n${preserved}`;
        }
    }
    return { summary: expanded, invalidBlockIds };
}
/** Count real model requests strictly after each message over the complete input. */
export function compressionRequestAges(messages) {
    let requestsAfter = 0;
    const ages = new Map();
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        ages.set(message.id, requestsAfter);
        if (message.role === "assistant" && !message.id.startsWith("__")
            && !message.isSummary && !message.isManualReplacement) {
            requestsAfter++;
        }
    }
    return ages;
}
export function isRecent(messages, guard, ages) {
    if (guard <= 0)
        return false;
    // Unknown targets fail closed; tool parts share their containing message's age.
    return messages.some(message => (ages.get(message.id) ?? 0) < guard);
}
function legacyBlock(meta) {
    const effective = meta.effectiveMessageIds ?? meta.sourceMessageIds;
    return {
        ...meta,
        runId: meta.runId ?? "legacy",
        mode: meta.mode ?? "range",
        topic: meta.topic ?? "legacy",
        startRef: meta.startRef ?? meta.sourceMessageIds[0] ?? "",
        endRef: meta.endRef ?? meta.sourceMessageIds.at(-1) ?? "",
        anchorMessageId: meta.anchorMessageId ?? meta.sourceMessageIds[0] ?? "",
        active: meta.active ?? !meta.consumed,
        deactivatedByUser: meta.deactivatedByUser ?? false,
        includedBlockIds: meta.includedBlockIds ?? meta.consumedBlockIds ?? [],
        consumedBlockIds: meta.consumedBlockIds ?? [],
        parentBlockIds: meta.parentBlockIds ?? [],
        directMessageIds: meta.directMessageIds ?? meta.sourceMessageIds,
        effectiveMessageIds: effective,
        directToolCallIds: meta.directToolCallIds ?? [],
        effectiveToolCallIds: meta.effectiveToolCallIds ?? [],
        sourceTokens: meta.sourceTokens ?? meta.tokens,
        summaryTokens: meta.summaryTokens ?? meta.tokens,
        netTokens: meta.netTokens ?? 0,
        summaryText: meta.summaryText ?? "",
        projectionTier: meta.projectionTier ?? "warm",
        createdAt: meta.createdAt ?? 0,
        updatedAt: meta.updatedAt ?? meta.createdAt ?? 0,
        updatedAtTurn: meta.updatedAtTurn ?? meta.createdAtTurn,
    };
}
/** Rebuild the dedicated compression index from durable active graph metadata. */
export function buildCompressionIndex(state) {
    const index = new Map();
    for (const raw of state.blockRegistry.values()) {
        const block = legacyBlock(raw);
        if (!block.active || block.consumed)
            continue;
        for (const messageId of block.effectiveMessageIds) {
            index.set(messageId, { messageId, replacedByBlockId: block.blockId, masked: false, offloaded: false });
        }
    }
    return index;
}
/** Validate and resolve every request before any state mutation. */
export function planCompressionBatch(input) {
    const { messages, requests, state, config, tokenizer } = input;
    const errors = [];
    const plans = [];
    const occupied = new Set();
    const ages = config.compressionRecencyRequests > 0 ? compressionRequestAges(messages) : new Map();
    requests.forEach((request, index) => {
        let malformed = false;
        for (const [field, value] of [["topic", request.topic], ["summary", request.summary]]) {
            // Tool arguments are untrusted model output; a missing field must be a
            // validation error, never a TypeError that aborts the whole tool call.
            if (typeof value !== "string") {
                malformed = true;
                errors.push({ index, code: "missing-field", message: `${field} is required and must be a string` });
            }
            else if (!value.trim()) {
                errors.push({ index, code: "empty-field", message: `${field} must not be empty` });
            }
        }
        // Later planning tokenizes and expands the summary; it cannot proceed safely.
        if (malformed)
            return;
        let selected = [];
        if (request.mode === "range") {
            const start = request.startRef ? resolveMessage(request.startRef, messages) : undefined;
            const end = request.endRef ? resolveMessage(request.endRef, messages) : undefined;
            if (!start || !end) {
                const boundary = !start ? "start" : "end";
                const missing = !start ? request.startRef : request.endRef;
                errors.push({
                    index,
                    code: "missing-target",
                    message: `range ${boundary} ${describeMissingRef(missing, state)}; ${currentRefSpan(messages)}`,
                });
            }
            else {
                const startIndex = messages.indexOf(start);
                const endIndex = messages.indexOf(end);
                if (startIndex > endIndex)
                    errors.push({ index, code: "reversed-range", message: "range start follows range end" });
                else
                    selected = messages.slice(startIndex, endIndex + 1).filter(message => !message.isIgnored || message.isSummary);
            }
        }
        else {
            const message = request.messageRef ? resolveMessage(request.messageRef, messages) : undefined;
            if (!message) {
                errors.push({
                    index,
                    code: "missing-target",
                    message: `${describeMissingRef(request.messageRef, state)}; ${currentRefSpan(messages)}`,
                });
            }
            else
                selected = [message];
        }
        if (selected.length === 0 && !errors.some(error => error.index === index)) {
            errors.push({ index, code: "empty-range", message: "target resolves to no messages" });
        }
        if (selected.length && isRecent(selected, config.compressionRecencyRequests, ages)) {
            errors.push({ index, code: "recent-range", message: `target intersects the last ${config.compressionRecencyRequests} model requests (compression recency guard)` });
        }
        const consumedBlockIds = [...new Set(selected.map(blockFromMessage).filter((id) => Boolean(id)))];
        const directMessageIds = selected.map(message => message.id);
        const effectiveMessageIds = [];
        const effectiveToolCallIds = [];
        for (const message of selected) {
            const blockId = blockFromMessage(message);
            const raw = blockId ? state.blockRegistry.get(blockId) : undefined;
            if (raw) {
                const block = legacyBlock(raw);
                effectiveMessageIds.push(...block.effectiveMessageIds);
                effectiveToolCallIds.push(...block.effectiveToolCallIds);
            }
            else {
                effectiveMessageIds.push(message.id);
                effectiveToolCallIds.push(...toolIds([message]));
            }
        }
        const effective = [...new Set(effectiveMessageIds)];
        if (effective.some(id => occupied.has(id)))
            errors.push({ index, code: "overlap", message: "batch targets overlap" });
        effective.forEach(id => occupied.add(id));
        const preserved = protectedContent(selected, config);
        const summaryWithProtected = preserved.length ? `${request.summary}\n\n${preserved.join("\n\n")}` : request.summary;
        const nested = preserveIncludedBlockSummaries(summaryWithProtected, consumedBlockIds, state);
        if (nested.invalidBlockIds.length > 0) {
            errors.push({
                index,
                code: "invalid-block-reference",
                message: `summary references block(s) outside the target: ${nested.invalidBlockIds.join(", ")}`,
            });
        }
        const finalSummary = nested.summary;
        const sourceTokens = selected.reduce((sum, message) => {
            const nestedId = blockFromMessage(message);
            const nested = nestedId ? state.blockRegistry.get(nestedId) : undefined;
            return sum + (nested?.sourceTokens ?? estimateMessageTokens(message, tokenizer));
        }, 0);
        const summaryTokens = tokenizer.countTokens(finalSummary);
        const netTokens = sourceTokens - summaryTokens;
        if (netTokens < (config.summarization.minNetSavingsTokens ?? 0)) {
            errors.push({ index, code: "insufficient-savings", message: `net savings ${netTokens} are below the configured minimum` });
        }
        plans.push({
            request,
            directMessageIds,
            effectiveMessageIds: effective,
            directToolCallIds: toolIds(selected),
            effectiveToolCallIds: [...new Set(effectiveToolCallIds)],
            consumedBlockIds,
            anchorMessageId: effective[0] ?? selected[0]?.id ?? "",
            startRef: request.mode === "message" ? request.messageRef ?? "" : request.startRef ?? "",
            endRef: request.mode === "message" ? request.messageRef ?? "" : request.endRef ?? "",
            protectedContent: preserved,
            finalSummary,
            sourceTokens,
            summaryTokens,
            netTokens,
        });
    });
    return errors.length ? { ok: false, errors } : { ok: true, plans };
}
/** Apply an already validated batch to a cloned state and cloned message array. */
export function applyCompressionBatch(input) {
    const planned = planCompressionBatch(input);
    if (!planned.ok)
        return planned;
    const state = cloneCoreState(input.state);
    let messages = input.messages.map(message => ({ ...message, parts: message.parts.map(part => ({ ...part })) }));
    const blockIds = [];
    const runId = `r${state.nextRunId++}`;
    for (const plan of planned.plans) {
        const blockId = `b${state.nextBlockId++}`;
        blockIds.push(blockId);
        for (const childId of plan.consumedBlockIds) {
            const raw = state.blockRegistry.get(childId);
            if (!raw)
                continue;
            const child = legacyBlock(raw);
            child.active = false;
            child.consumed = true;
            child.parentBlockIds = [...new Set([...child.parentBlockIds, blockId])];
            child.updatedAt = input.nowMs;
            child.updatedAtTurn = state.currentTurn;
            state.blockRegistry.set(childId, child);
            for (const [anchor, activeId] of state.activeByAnchorMessageId)
                if (activeId === childId)
                    state.activeByAnchorMessageId.delete(anchor);
            const childLease = state.temporaryRetrievals.get(childId);
            const retrievalMessageId = childLease?.messageId;
            for (const [retrievedBlockId, retrieval] of state.temporaryRetrievals) {
                if (retrievedBlockId === childId || (retrievalMessageId && retrieval.messageId === retrievalMessageId)) {
                    state.temporaryRetrievals.delete(retrievedBlockId);
                }
            }
        }
        const meta = {
            blockId,
            runId,
            mode: plan.request.mode,
            topic: plan.request.topic,
            batchTopic: plan.request.batchTopic,
            startRef: plan.startRef,
            endRef: plan.endRef,
            anchorMessageId: plan.anchorMessageId,
            active: true,
            deactivatedByUser: false,
            includedBlockIds: [...plan.consumedBlockIds],
            consumedBlockIds: [...plan.consumedBlockIds],
            parentBlockIds: [],
            directMessageIds: [...plan.directMessageIds],
            effectiveMessageIds: [...plan.effectiveMessageIds],
            directToolCallIds: [...plan.directToolCallIds],
            effectiveToolCallIds: [...plan.effectiveToolCallIds],
            sourceMessageIds: [...plan.effectiveMessageIds],
            sourceTokens: plan.sourceTokens,
            summaryTokens: plan.summaryTokens,
            netTokens: plan.netTokens,
            tokens: plan.summaryTokens,
            summaryText: plan.finalSummary,
            durableSourceRef: plan.request.durableSourceRef,
            durableSummaryRef: plan.request.durableSummaryRef,
            projectionTier: "warm",
            createdAt: input.nowMs,
            updatedAt: input.nowMs,
            createdAtTurn: state.currentTurn,
            updatedAtTurn: state.currentTurn,
            consumed: false,
        };
        state.blockRegistry.set(blockId, meta);
        state.activeByAnchorMessageId.set(meta.anchorMessageId, blockId);
        state.latestSummaryBlockId = blockId;
        const source = new Set(meta.effectiveMessageIds);
        messages = messages.map(message => source.has(message.id) || plan.directMessageIds.includes(message.id) ? { ...message, isIgnored: true } : message);
        const foundInsertAt = messages.findIndex(message => message.id === meta.anchorMessageId);
        const insertAt = foundInsertAt < 0 ? messages.length : foundInsertAt;
        const anchorCreatedAt = messages[insertAt]?.createdAt ?? input.nowMs;
        messages.splice(insertAt, 0, {
            id: `__summary_${blockId}`,
            ref: blockId,
            role: "assistant",
            sessionId: state.sessionId,
            createdAt: anchorCreatedAt,
            isSummary: true,
            parts: [{ type: "summary-block", blockId, text: meta.summaryText }],
        });
        state.stats.totalCompressRuns++;
        const saved = Math.max(0, meta.netTokens);
        state.stats.totalTokensCompressed += saved;
        state.stats.totalTokensSaved += saved;
    }
    state.compressionIndex = buildCompressionIndex(state);
    return { ok: true, messages, state, plans: planned.plans, blockIds };
}
//# sourceMappingURL=transaction.js.map