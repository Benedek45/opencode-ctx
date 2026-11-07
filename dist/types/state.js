// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Core session state shape. Persisted between turns.
/** Create a fresh CoreState for a new session. */
export function createInitialState(sessionId) {
    return {
        sessionId,
        isSubAgent: false,
        manualMode: false,
        compressPermission: true,
        blockRegistry: new Map(),
        temporaryRetrievals: new Map(),
        messageIndex: new Map(),
        compressionIndex: new Map(),
        manualOverrides: new Map(),
        runtimeConfig: {},
        controlRevision: 0,
        projectionEditRevision: 0,
        projectionEditAppliedRevision: 0,
        projectionEditPendingIds: [],
        projectionEditCutIds: [],
        activeByAnchorMessageId: new Map(),
        nextBlockId: 1,
        nextRunId: 1,
        dedupDecisions: new Set(),
        staleErrorDecisions: new Set(),
        nearDupeDecisions: new Set(),
        maskDecisions: new Map(),
        hardCapDroppedIds: new Set(),
        toolParameters: new Map(),
        toolIdList: [],
        messageIds: {
            byRawId: new Map(),
            byRef: new Map(),
            nextRef: 1,
        },
        nudges: {
            contextLimitAnchors: new Set(),
            midSoftNudgeAnchors: new Set(),
            turnNudgeAnchors: new Set(),
            iterationNudgeAnchors: new Set(),
        },
        nudgeEscalation: {
            ignoredStreak: 0,
            compressRunsAtLastCheck: 0,
        },
        lastMaskingPassTurn: 0,
        lastMaskingPassTime: 0,
        lastPruneCompressRuns: 0,
        lastRequestTime: 0,
        lastCacheMiss: false,
        eTurnsEstimate: 5,
        hasRecordedCacheBust: false,
        lastCacheBustTurn: 0,
        tokenCalibration: { ratio: 1.0, sampleCount: 0 },
        contextTokenMetrics: {},
        fullRestructureTriggered: false,
        stats: {
            totalTurns: 0,
            totalMaskingPasses: 0,
            totalTokensMasked: 0,
            totalTokensOffloaded: 0,
            totalCompressRuns: 0,
            totalTokensCompressed: 0,
            totalTokensSaved: 0,
            totalHardCapPasses: 0,
        },
        modelContextLimit: 1_000_000,
        systemPromptTokens: 0,
        compressionTiming: {},
        currentTurn: 0,
        activeProfile: "documents",
    };
}
/** Deep clone core state for transactional, side-effect-free operations. */
export function cloneCoreState(state) {
    const cloneUnknown = (value) => {
        if (Array.isArray(value))
            return value.map(cloneUnknown);
        if (value instanceof Map)
            return new Map([...value].map(([k, v]) => [cloneUnknown(k), cloneUnknown(v)]));
        if (value instanceof Set)
            return new Set([...value].map(cloneUnknown));
        if (value && typeof value === "object") {
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloneUnknown(v)]));
        }
        return value;
    };
    return cloneUnknown(state);
}
//# sourceMappingURL=state.js.map