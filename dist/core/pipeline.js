// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Pipeline: orchestrates the context management transform.
// Stages: tagging → budget → cascade → apply decisions → escalation masking
//         (only on sustained nudge non-compliance) → hard cap → nudges → finalize
import { CalibratedTokenizer } from "../services/tokenizer.js";
import { runTagging } from "./tagging.js";
import { computeBudgetBreakdown } from "./budget.js";
import { runCascade } from "./cascade.js";
import { applyDecisions } from "./applyDecisions.js";
import { runHardCap } from "./strategies/hardCap.js";
import { runObservationMask } from "./strategies/observationMask.js";
import { buildTightenedRecencyConfig } from "./strategies/guards.js";
import { getNudgeLevel, buildNudgeText, shouldInjectCompress, updateNudgeEscalation, shouldForceMechanicalEscalation, resolveCompressionTarget, buildContextStatusText, appendNudgeToLastUser, } from "./nudges.js";
import { runFinalize } from "./finalize.js";
import { estimateContextTokens, estimateMessageTokens } from "./tokens.js";
import { runStateGc } from "./stateGc.js";
import { applyManualOverrides } from "./manualOverrides.js";
import { hasPendingProjectionRewrite, recordProjectionEdit } from "./projectionEdits.js";
import { applyTierDemotions, expireTemporaryRetrievals, planTierDemotions } from "./contextTiers.js";
import { cachePruneAllowed } from "./budget/costRoi.js";
import { planCompressionCandidates } from "./compress/eligibility.js";
/**
 * Run the full context management pipeline.
 *
 * This is a pure transform: it does not call the model, write files, or
 * perform any I/O. Offload write requests are returned for the adapter to handle.
 */
export function runPipeline(input, services) {
    const { messages, state, config, nowMs } = input;
    const { workspaceDir } = services;
    const emit = services.telemetry;
    // Counts completed pipeline projections, not user messages. Besides session
    // telemetry, adapters use this monotonic value to version exact persisted
    // projections, so every state-changing transform advances the generation.
    state.stats.totalTurns++;
    // Read BEFORE the cascade: a pending dashboard edit rewrites the cached prefix
    // on this request regardless of what else happens, so the cascade's cache gates
    // (core/budget/costRoi.ts) treat deferred pruning as free this turn.
    let prefixRewritePending = hasPendingProjectionRewrite(state);
    // Stage 1: Tagging
    const tagged = runTagging(messages, state);
    const manualOverrideSource = tagged.map(message => ({
        ...message,
        parts: message.parts.map(part => ({ ...part })),
    }));
    // Only completed assistant input usage describes a provider cache lookup.
    // Once the adapter marks a model, its request-matched consumed IDs are the
    // sole evidence that usage belongs to THIS model (neutral messages have no
    // provider identity). In particular, old-model history and zero-usage stubs
    // cannot turn a warm prefix into a false cold-cache signal.
    const matchedIds = state.contextTokenMetrics.modelKey
        ? new Set(state.contextTokenMetrics.consumedCalibrationAssistantIds ?? [])
        : undefined;
    const latestWithTokens = [...tagged].reverse().find(m => m.role === "assistant" && !m.isSummary && !m.isManualReplacement && !m.isIgnored
        && (matchedIds === undefined || matchedIds.has(m.id))
        && m.tokens !== undefined
        && m.tokens.input + m.tokens.cacheRead + m.tokens.cacheWrite > 0);
    if (latestWithTokens?.tokens) {
        state.lastCacheMiss = latestWithTokens.tokens.cacheRead === 0;
    }
    // The adapter associates provider usage with the exact prior outbound request
    // (assistant.parentID -> persisted pending sample) and updates calibration
    // before entering the pure core. Apply that model-specific ratio exactly once.
    const tokenizer = state.tokenCalibration.sampleCount > 0 &&
        Math.abs(state.tokenCalibration.ratio - 1.0) > 0.01
        ? new CalibratedTokenizer(services.tokenizer, state.tokenCalibration.ratio)
        : services.tokenizer;
    const automaticPruning = config.automation.automaticPruning;
    const modelCompression = config.automation.modelCompression;
    // Tier lifecycle runs independently of model-driven compression. Coalesce all
    // demotions and expired retrieval leases into one pending projection rewrite.
    const expiredRetrievals = expireTemporaryRetrievals(state, state.currentTurn);
    const projectionOptions = {
        automaticPruning,
        contextTiers: config.contextTiers,
        tokenizer,
        modelContextLimit: config.modelContextLimit,
    };
    // Both tier and cascade economics must use what the model can actually see.
    // Reuse the projection unless demotion below changes its visible contents.
    let visibleBeforeCascade = applyDecisions(tagged, state, projectionOptions);
    if (automaticPruning && config.contextTiers.enabled) {
        const activeTokens = estimateContextTokens(visibleBeforeCascade, tokenizer) + (config.systemPromptTokens || 0);
        const demotions = applyTierDemotions(state, planTierDemotions(state, config.contextTiers, tokenizer, config.modelContextLimit, state.currentTurn, config.contextTiers.ageDemotionEnabled && cachePruneAllowed(config, state, nowMs, activeTokens)));
        const changedIds = new Set(demotions.effectiveMessageIds);
        const cutIds = new Set(demotions.cutIds);
        for (const retrieval of expiredRetrievals) {
            if (retrieval.messageId)
                changedIds.add(retrieval.messageId);
        }
        if (demotions.changedBlockIds.length > 0 || expiredRetrievals.length > 0) {
            recordProjectionEdit(state, changedIds, cutIds);
            prefixRewritePending = true;
        }
        if (demotions.changedBlockIds.length > 0) {
            visibleBeforeCascade = applyDecisions(tagged, state, projectionOptions);
        }
    }
    else if (expiredRetrievals.length > 0) {
        // Explicit retrieval TTLs remain real even when automatic pruning or tier
        // demotion is disabled. Expiry changes old retrieval tool results adapter-side.
        recordProjectionEdit(state, expiredRetrievals.flatMap(retrieval => retrieval.messageId ? [retrieval.messageId] : []));
        prefixRewritePending = true;
    }
    // Compression and persisted mechanical decisions define the automatic
    // visible projection. Budget and cascade economics must see that projection,
    // not the raw recovery sources that a WARM summary or COLD catalog replaces.
    // Keep the full tagged list for manual keep/replace and decision GC below.
    const budget = computeBudgetBreakdown(visibleBeforeCascade, config, tokenizer);
    // Stage 3: Cascade (mechanical strategies — gated recompute). The explicit
    // automation master switch skips both new decisions and later mechanical
    // passes; persisted decisions remain stored for deterministic re-enable.
    const cascadeResult = automaticPruning
        ? runCascade(visibleBeforeCascade, state.currentTurn, config, state, tokenizer, workspaceDir, nowMs, emit)
        : {
            messages: visibleBeforeCascade,
            tokensSaved: 0,
            dedupCount: 0,
            staleErrorCount: 0,
            nearDupeCount: 0,
            maskedCount: 0,
            offloadedCount: 0,
            offloadRequests: [],
        };
    // Update state stats (only NEW savings from this recompute pass)
    state.stats.totalTokensSaved += cascadeResult.tokensSaved;
    // Stage 3b: Apply decisions (ungated, every turn while enabled)
    // Re-applies ALL stored decisions (dedup/stale/mask/compress) to the re-fed
    // original messages so the outgoing prefix is stable even when the gate skips
    // recompute. This is the core of the decide/apply split (P1).
    // Merge decisions for visible raw messages into the complete tagged list.
    // A synthetic summary/catalog is reinserted exactly once by applyDecisions;
    // covered originals retain their exact source parts for recovery and GC.
    const cascadeById = new Map(cascadeResult.messages
        .filter(message => !message.isSummary && !message.isIgnored)
        .map(message => [message.id, message]));
    const fullAfterCascade = tagged.map(message => cascadeById.get(message.id) ?? message);
    const afterApply = applyDecisions(fullAfterCascade, state, {
        automaticPruning,
        contextTiers: config.contextTiers,
        tokenizer,
        modelContextLimit: config.modelContextLimit,
    });
    // Stage 3c: Nudge-escalation masking — if LAST turn's escalation state shows
    // sustained non-compliance (>= ESCALATION_STREAK_THRESHOLD consecutive turns
    // at "upper"/"safety-cap" with no intervening compress run), force one extra
    // masking pass with a tightened recency guard, mirroring hardCap's Phase 1 but
    // firing BEFORE the hard cap instead of waiting for the token ceiling.
    // Rationale: nudges only ASK the model to compress; if it keeps ignoring them,
    // there is no host hook that lets this adapter invoke the model directly to
    // force a real narrative compress (see core/nudges.ts). Reclaiming headroom
    // mechanically now — while still less destructive than hardCap's whole-message
    // drops — is the strongest available fallback short of that ceiling, and
    // sustained non-compliance is itself a signal that waiting for the ceiling is
    // too late to preserve summary quality.
    let afterEscalation = afterApply;
    let escalationOffloadRequests = [];
    let escalationTokensSaved = 0;
    const compressRequests = [];
    // A prior streak already establishes ignored actionable nudges. Mechanical
    // masking has its own age guard; it needs no current compression candidate.
    const unacknowledgedAttempt = (state.nudgeEscalation.attempts ?? 0) > (state.nudgeEscalation.attemptsAtLastCheck ?? 0);
    const escalationDue = modelCompression && !unacknowledgedAttempt
        && shouldForceMechanicalEscalation(state.nudgeEscalation);
    if (escalationDue && automaticPruning) {
        // buildTightenedRecencyConfig clamps BOTH recencyGuardTurns and every tool
        // class's retentionTurns to 2 — clamping recencyGuardTurns alone would not
        // reach classified tools (read/bash/edit/etc.), since getRetentionTurns
        // prefers their fixed per-class value (core/strategies/guards.ts).
        const escalationConfig = {
            ...buildTightenedRecencyConfig(config, 2),
            costRoi: { enabled: false },
            minRepruneInterval: 0,
            clearAtLeast: 0,
        };
        const escalationResult = runObservationMask(afterApply, state.currentTurn, escalationConfig, state, workspaceDir, tokenizer, nowMs, emit);
        afterEscalation = escalationResult.messages;
        state.stats.totalTokensSaved += escalationResult.tokensSaved;
        escalationOffloadRequests = escalationResult.offloadRequests;
        escalationTokensSaved = escalationResult.tokensSaved;
    }
    // Form validator-compatible requests from the final visible projection after caps.
    // Stage 3d: Hard cap — model-independent policy floor. Fires only when
    // context is near the limit (config.hardCap, default "92%"): force-mask tool
    // outputs, then drop the oldest whole messages, so a request can never exceed
    // the provider's real context limit even if the model ignored every nudge.
    const hardCapResult = automaticPruning
        ? runHardCap(afterEscalation, state.currentTurn, config, state, workspaceDir, tokenizer, nowMs)
        : {
            messages: afterEscalation,
            tokensSaved: 0,
            droppedCount: 0,
            offloadRequests: [],
            fired: false,
            remainingTokens: estimateContextTokens(afterEscalation, tokenizer) + (config.systemPromptTokens || 0),
            underCap: true,
        };
    state.stats.totalTokensSaved += hardCapResult.tokensSaved;
    // Explicit user projection edits are authoritative over automatic decisions.
    // They are applied after the mechanical cap so the dashboard shows exactly
    // what will be sent. The control plane reports the resulting token count so a
    // user can see if a forced keep/replacement exceeds the configured cap.
    const afterOverrides = applyManualOverrides(hardCapResult.messages, state, manualOverrideSource);
    // A manual keep restores exact raw content, including messages/tool outputs
    // previously marked by the policy cap. Clear those stale skip markers before
    // the provider-limit pass so it can still mask or drop the restored content if
    // keeping it would make the actual request invalid.
    if (automaticPruning) {
        for (const [messageId, override] of state.manualOverrides) {
            if (override.mode !== "keep")
                continue;
            state.hardCapDroppedIds.delete(messageId);
            const source = manualOverrideSource.find(message => message.id === messageId);
            for (const part of source?.parts ?? []) {
                if (part.type !== "tool")
                    continue;
                state.maskDecisions.delete(part.callId);
                state.messageIndex.delete(part.callId);
            }
        }
    }
    // Manual keep/replace edits may add substantial content after the configured
    // 92% policy cap. Respect those edits while there is room, but never let them
    // bypass the provider's actual context limit. This second pass uses the model
    // limit itself, not the lower policy cap.
    const previousRequestTokens = state.contextTokenMetrics.lastRequestTokens;
    const compressionTarget = resolveCompressionTarget(config);
    const preEmergencyTokens = estimateContextTokens(afterOverrides, tokenizer) + (config.systemPromptTokens || 0);
    const reserveMetrics = {
        modelKey: state.contextTokenMetrics.modelKey,
        currentTokens: preEmergencyTokens,
        previousTokens: previousRequestTokens,
        addedTokens: previousRequestTokens === undefined ? undefined : preEmergencyTokens - previousRequestTokens,
        targetTokens: compressionTarget,
        tokensToRemove: Math.max(0, preEmergencyTokens - compressionTarget),
    };
    const reserveText = [
        buildContextStatusText(reserveMetrics, modelCompression),
        buildNudgeText("safety-cap", preEmergencyTokens, budget.effectiveBudget, state.nudgeEscalation.ignoredStreak + 1),
    ].filter(Boolean).join("\n\n");
    const contextSuffixReserve = input.injectContextStatus ? tokenizer.countTokens(reserveText) + 128 : 0;
    // Finalize adds one visible ref tag to each eligible message after this cap.
    // Reserve the exact current overhead up front; pruning can only reduce it.
    const beforeFinalizeTokens = estimateContextTokens(afterOverrides, tokenizer);
    const finalizeTagReserve = Math.max(0, estimateContextTokens(runFinalize(afterOverrides), tokenizer) - beforeFinalizeTokens);
    const providerReserve = contextSuffixReserve + finalizeTagReserve;
    const emergencyCapResult = automaticPruning
        ? runHardCap(afterOverrides, state.currentTurn, { ...config, hardCap: Math.max(0, config.modelContextLimit - providerReserve) }, state, workspaceDir, tokenizer, nowMs)
        : {
            messages: afterOverrides,
            tokensSaved: 0,
            droppedCount: 0,
            offloadRequests: [],
            fired: false,
            remainingTokens: estimateContextTokens(afterOverrides, tokenizer) + (config.systemPromptTokens || 0),
            underCap: estimateContextTokens(afterOverrides, tokenizer) + (config.systemPromptTokens || 0)
                <= config.modelContextLimit - providerReserve,
        };
    state.stats.totalTokensSaved += emergencyCapResult.tokensSaved;
    const afterHardCap = emergencyCapResult.messages;
    // Stage 4: Nudges (compute nudge level after cascade + apply + escalation + hard cap)
    // GC needs the full pre-finalize list so persisted decisions for ignored
    // messages survive host re-feed. The status calculation below uses finalized
    // messages so its self-reported count includes all visible ref tags.
    runStateGc(afterHardCap, state);
    const finalizedBase = runFinalize(afterHardCap);
    const compressionCandidates = planCompressionCandidates(finalizedBase, state, config, tokenizer);
    const basePostCascadeTokens = estimateContextTokens(finalizedBase, tokenizer) + (config.systemPromptTokens || 0);
    let predictedTokens = basePostCascadeTokens;
    let nudgeLevel = "none";
    let updatedEscalation = state.nudgeEscalation;
    let nudgeText;
    let contextStatusText = "";
    let contextMetrics = {
        modelKey: state.contextTokenMetrics.modelKey,
        currentTokens: predictedTokens,
        previousTokens: previousRequestTokens,
        addedTokens: previousRequestTokens === undefined ? undefined : predictedTokens - previousRequestTokens,
        targetTokens: compressionTarget,
        tokensToRemove: Math.max(0, predictedTokens - compressionTarget),
    };
    let withContextStatus = finalizedBase;
    // Even if the cap could not meet the conservative worst-case reserve, build
    // the exact suffix and admit it when the fully counted request still fits.
    const mayInjectContextStatus = input.injectContextStatus === true;
    const conversationTail = [...finalizedBase].reverse().find(message => !message.isIgnored && !message.isSummary);
    const latestUser = [...finalizedBase].reverse().find(message => !message.isIgnored && message.role === "user");
    const freshUserTurn = conversationTail?.role === "user" && conversationTail.id === latestUser?.id;
    const persistedAnchor = state.contextTokenMetrics.anchoredStatus;
    const reusableAnchor = !freshUserTurn
        && latestUser !== undefined
        && persistedAnchor?.userMessageId === latestUser.id
        ? persistedAnchor
        : undefined;
    let deliveredSuffix = "";
    let statusConverged = !mayInjectContextStatus;
    // The status contains its own count. Iterate to a fixed point (normally two
    // passes; extra passes cover digit-width and tokenizer boundary changes).
    for (let iteration = 0; iteration < 32; iteration++) {
        nudgeLevel = freshUserTurn && modelCompression ? getNudgeLevel(predictedTokens, config) : "none";
        updatedEscalation = freshUserTurn
            ? updateNudgeEscalation(nudgeLevel, state.stats.totalCompressRuns, state.nudgeEscalation, compressionCandidates.candidates.length > 0)
            : state.nudgeEscalation;
        contextMetrics = {
            modelKey: state.contextTokenMetrics.modelKey,
            currentTokens: predictedTokens,
            previousTokens: previousRequestTokens,
            addedTokens: previousRequestTokens === undefined ? undefined : predictedTokens - previousRequestTokens,
            targetTokens: compressionTarget,
            tokensToRemove: Math.max(0, predictedTokens - compressionTarget),
        };
        contextStatusText = buildContextStatusText(contextMetrics, modelCompression, compressionCandidates);
        nudgeText = buildNudgeText(nudgeLevel, predictedTokens, budget.effectiveBudget, updatedEscalation.ignoredStreak, compressionCandidates);
        const freshSuffix = [contextStatusText, nudgeText].filter(Boolean).join("\n\n");
        deliveredSuffix = freshUserTurn ? freshSuffix : reusableAnchor?.text ?? "";
        withContextStatus = mayInjectContextStatus
            ? appendNudgeToLastUser(finalizedBase, deliveredSuffix, reusableAnchor?.userMessageId)
            : finalizedBase;
        const next = estimateContextTokens(withContextStatus, tokenizer) + (config.systemPromptTokens || 0);
        if (next === predictedTokens) {
            statusConverged = true;
            break;
        }
        predictedTokens = next;
    }
    // A custom tokenizer could theoretically fail to converge, or an unusually
    // long status could exceed the conservative reserve. Never let observability
    // text itself push an otherwise valid request beyond the provider limit.
    const injectedTokens = estimateContextTokens(withContextStatus, tokenizer) + (config.systemPromptTokens || 0);
    if (mayInjectContextStatus && (!statusConverged || injectedTokens > config.modelContextLimit)) {
        withContextStatus = finalizedBase;
        predictedTokens = basePostCascadeTokens;
        // Nothing was delivered, so do not advance the "model ignored this nudge"
        // streak or claim an injected compression request.
        nudgeLevel = "none";
        updatedEscalation = state.nudgeEscalation;
        contextMetrics = {
            modelKey: state.contextTokenMetrics.modelKey,
            currentTokens: predictedTokens,
            previousTokens: previousRequestTokens,
            addedTokens: previousRequestTokens === undefined ? undefined : predictedTokens - previousRequestTokens,
            targetTokens: compressionTarget,
            tokensToRemove: Math.max(0, predictedTokens - compressionTarget),
        };
        contextStatusText = "";
        nudgeText = undefined;
        if (freshUserTurn)
            delete state.contextTokenMetrics.anchoredStatus;
    }
    else if (mayInjectContextStatus && freshUserTurn && latestUser && deliveredSuffix) {
        state.contextTokenMetrics.anchoredStatus = {
            userMessageId: latestUser.id,
            text: deliveredSuffix,
        };
    }
    state.nudgeEscalation = updatedEscalation;
    const injectCompress = modelCompression && compressionCandidates.candidates.length > 0 && shouldInjectCompress(nudgeLevel);
    if (modelCompression && compressionCandidates.candidates.length > 0
        && (escalationDue || getNudgeLevel(predictedTokens, config) !== "none")) {
        for (const candidate of compressionCandidates.candidates) {
            compressRequests.push({ ...candidate, topic: escalationDue ? "escalation" : "stable-context" });
        }
        emit?.({ type: "compress-request", messageCount: compressionCandidates.candidates
                .reduce((total, candidate) => total + candidate.messageIds.length, 0) });
    }
    state.contextTokenMetrics.lastRequestTokens = predictedTokens;
    state.contextTokenMetrics.lastRequestSequence = state.stats.totalTurns;
    // Stage 5: Finalize is idempotent. `withContextStatus` was built from the
    // finalized base so the fixed-point count already includes visible ref tags.
    const finalized = runFinalize(withContextStatus);
    // A pending dashboard edit rides on exactly this projection. The cache-bust
    // accounting is NOT applied here: the caller acknowledges it only once the host
    // has actually received these messages (see PipelineResult.projectionEdit), so a
    // failure between projection and delivery leaves the edit pending.
    const projectionEdit = prefixRewritePending
        ? measureProjectionEditImpact(afterHardCap, finalized, state, tokenizer)
        : undefined;
    const estimatedTokens = estimateContextTokens(finalized, tokenizer) + (config.systemPromptTokens || 0);
    // Preserve exact returned accounting. On normal converged paths this equals
    // the model-visible status count because that count was computed after tags.
    contextMetrics.currentTokens = estimatedTokens;
    contextMetrics.addedTokens = previousRequestTokens === undefined ? undefined : estimatedTokens - previousRequestTokens;
    contextMetrics.tokensToRemove = Math.max(0, estimatedTokens - compressionTarget);
    state.contextTokenMetrics.lastRequestTokens = estimatedTokens;
    // Record the time of this request so the next turn's Cost-ROI gate can measure
    // cache idle time (warm vs cold) against config.cacheModel.effectiveTtlSeconds.
    state.lastRequestTime = nowMs;
    // Emit pipeline-complete telemetry for the full turn
    if (emit) {
        const actualInput = latestWithTokens?.tokens
            ? latestWithTokens.tokens.input + latestWithTokens.tokens.cacheRead + latestWithTokens.tokens.cacheWrite
            : 0;
        const actualOutput = latestWithTokens?.tokens?.output ?? 0;
        emit({
            type: "pipeline-complete",
            inputTokens: actualInput,
            outputTokens: actualOutput,
            savedTokens: cascadeResult.tokensSaved + escalationTokensSaved + hardCapResult.tokensSaved + emergencyCapResult.tokensSaved,
        });
    }
    return {
        messages: finalized,
        state,
        nudgeText,
        shouldInjectCompress: injectCompress,
        estimatedTokens,
        contextStatusText,
        contextMetrics,
        savedThisRun: cascadeResult.tokensSaved + escalationTokensSaved + hardCapResult.tokensSaved + emergencyCapResult.tokensSaved,
        cumulativeSaved: state.stats.totalTokensSaved,
        compressRequests,
        compressionCandidates,
        projectionEdit,
        telemetryEvents: [], // events are streamed via emit callback; array is for callers without a callback
        offloadRequests: [
            ...cascadeResult.offloadRequests,
            ...escalationOffloadRequests,
            ...hardCapResult.offloadRequests,
            ...emergencyCapResult.offloadRequests,
        ],
    };
}
/**
 * Measure the prompt-cache cost of the dashboard edits delivered this turn.
 *
 * `rewrittenTokens` counts the tokens the provider must re-write rather than read
 * from cache: everything from the earliest edited position to the end of the
 * outgoing context. The cut point uses finalize's stable `(createdAt, input
 * position)` ordering, so equal timestamps do not charge byte-stable messages
 * that were ordered before the edited source.
 *
 * Only the sources recorded by the pending edits are measured, so an override
 * that was already delivered on an earlier turn does not inflate this turn's
 * reported cost. When the pending change is not attributable to specific
 * messages (a block action), the whole context is reported, since any position
 * may differ.
 */
function measureProjectionEditImpact(preFinalize, finalized, state, tokenizer) {
    const pendingIds = state.projectionEditPendingIds ?? [];
    const cutIds = state.projectionEditCutIds ?? [];
    // A block action should normally supply its effective source IDs. If legacy
    // metadata has no coverage list, conservatively report the whole rewrite
    // rather than attributing it to unrelated historical manual overrides.
    if (pendingIds.length === 0 && cutIds.length === 0) {
        return {
            editedMessages: 0,
            rewrittenTokens: finalized.reduce((total, message) => total + estimateMessageTokens(message, tokenizer), 0),
        };
    }
    const edited = new Set(pendingIds);
    const affected = new Set([...pendingIds, ...cutIds]);
    // Count each edited SOURCE once: a replace contributes both the suppressed
    // original and its synthetic replacement to the pre-finalize list.
    const editedSources = new Set();
    const ordered = preFinalize
        .map((message, inputIndex) => ({ message, inputIndex }))
        .sort((left, right) => left.message.createdAt - right.message.createdAt || left.inputIndex - right.inputIndex);
    let cutIndex = Number.POSITIVE_INFINITY;
    for (let index = 0; index < ordered.length; index++) {
        const message = ordered[index].message;
        const sourceId = message.isManualReplacement && message.id.startsWith("__manual_")
            ? message.id.slice("__manual_".length)
            : message.id;
        if (!affected.has(sourceId))
            continue;
        if (edited.has(sourceId))
            editedSources.add(sourceId);
        cutIndex = Math.min(cutIndex, index);
    }
    const editedMessages = editedSources.size;
    if (!Number.isFinite(cutIndex)) {
        return {
            editedMessages: 0,
            rewrittenTokens: finalized.reduce((total, message) => total + estimateMessageTokens(message, tokenizer), 0),
        };
    }
    const rewrittenIds = new Set(ordered
        .slice(cutIndex)
        .filter(({ message }) => !message.isIgnored)
        .map(({ message }) => message.id));
    let rewrittenTokens = 0;
    for (const message of finalized) {
        if (rewrittenIds.has(message.id))
            rewrittenTokens += estimateMessageTokens(message, tokenizer);
    }
    return { editedMessages, rewrittenTokens };
}
//# sourceMappingURL=pipeline.js.map