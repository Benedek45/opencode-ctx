import type { LayeredConfig, ProfileName } from "./config.js";
export type CompressionMode = "range" | "message";
export type RetrievalMode = "summary" | "exact";
export interface TemporaryBlockRetrieval {
    blockId: string;
    mode: RetrievalMode;
    /** Host message containing the retrieval tool result, for exact cache cuts. */
    messageId?: string;
    activatedAtTurn: number;
    expiresAtTurn: number;
    tokenCost: number;
}
/** Metadata for a single compression block in the durable compression graph. */
export interface BlockMetadata {
    blockId: string;
    runId: string;
    mode: CompressionMode;
    topic: string;
    batchTopic?: string;
    startRef: string;
    endRef: string;
    anchorMessageId: string;
    active: boolean;
    deactivatedByUser: boolean;
    includedBlockIds: string[];
    consumedBlockIds: string[];
    parentBlockIds: string[];
    directMessageIds: string[];
    effectiveMessageIds: string[];
    directToolCallIds: string[];
    effectiveToolCallIds: string[];
    sourceTokens: number;
    summaryTokens: number;
    netTokens: number;
    summaryText: string;
    durableSourceRef?: string;
    durableSummaryRef?: string;
    /** Legacy blocks without this field are treated as warm. */
    projectionTier?: "warm" | "cold";
    createdAt: number;
    updatedAt: number;
    updatedAtTurn: number;
    /** The raw message IDs that were compressed into this block. */
    sourceMessageIds: string[];
    /** Turn number when this block was created. */
    createdAtTurn: number;
    /** Token count of the block text. */
    tokens: number;
    /** Whether this block has been consumed by a subsequent consolidation. */
    consumed: boolean;
}
/** Per-message compression index entry. */
export interface MessageCompressionEntry {
    messageId: string;
    /** Block ID that replaced this message, if any. */
    replacedByBlockId?: string;
    /** Whether this message is currently masked. */
    masked: boolean;
    /** Whether this message's tool output has been offloaded to disk. */
    offloaded: boolean;
    /** Turn at which masking was applied. */
    maskedAt?: number;
    /** Path to the offloaded file, if offloaded. */
    offloadPath?: string;
}
/** User-authored override applied after automatic context management. */
export interface ManualMessageOverride {
    mode: "keep" | "exclude" | "replace";
    /** Required when mode is "replace". */
    text?: string;
}
/** Nudge anchor tracking. */
export interface NudgeAnchors {
    contextLimitAnchors: Set<string>;
    midSoftNudgeAnchors: Set<string>;
    turnNudgeAnchors: Set<number>;
    iterationNudgeAnchors: Set<number>;
}
/**
 * Tracks sustained non-compliance with "upper"/"safety-cap" nudges so the
 * pipeline can escalate: both the wording shown to the model (buildNudgeText)
 * and, past a streak threshold, a forced mechanical masking pass with a
 * tightened recency guard (core/pipeline.ts) run BEFORE the hard cap — a
 * genuinely enforceable fallback for when the model is not calling the
 * compress tool, since nothing in the host hook API lets the adapter invoke
 * the model directly to force a real narrative compress.
 */
export interface NudgeEscalationState {
    /** Consecutive pipeline turns spent at "upper" or "safety-cap" without an intervening compress run. */
    ignoredStreak: number;
    /** stats.totalCompressRuns observed the last time the streak was evaluated (detects model compliance). */
    compressRunsAtLastCheck: number;
    /** Attempts are not ignored nudges, even when guards or persistence reject them. */
    attempts?: number;
    attemptsAtLastCheck?: number;
    lastAttempt?: {
        turn: number;
        outcome: "rejected" | "failed";
        codes: string[];
    };
}
/**
 * Statistics tracked across the session.
 *
 * All `*Tokens*` fields are token counts (estimated via the active tokenizer or
 * char/4 fallback). `totalTokensSaved` is the cumulative grand total across every
 * strategy (dedup + stale-error + mask + offload + compress); the other token
 * fields are per-strategy breakdowns that sum into it.
 */
export interface SessionStats {
    totalTurns: number;
    totalMaskingPasses: number;
    /** Tokens recovered by plain/stateful masking. */
    totalTokensMasked: number;
    /** Tokens recovered by offloading output to disk. */
    totalTokensOffloaded: number;
    totalCompressRuns: number;
    /** Tokens recovered by model-driven compression. */
    totalTokensCompressed: number;
    /** Grand total tokens saved across all strategies. */
    totalTokensSaved: number;
    /** Number of times the hard-cap mechanical floor fired. */
    totalHardCapPasses: number;
}
/** Compression timing info. */
export interface CompressionTiming {
    lastCompressMs?: number;
    lastMaskMs?: number;
}
/** The full core session state. */
export interface CoreState {
    sessionId: string;
    /** Adapter-owned immutable handoff seed; contains no host types or machine paths. */
    importedContext?: {
        version: 1;
        seedRef: string;
        bundleDigest: string;
        importedAtTurn: number;
    };
    isSubAgent: boolean;
    manualMode: boolean;
    compressPermission: boolean;
    blockRegistry: Map<string, BlockMetadata>;
    /** Short-lived retrieval leases, keyed by block ID. */
    temporaryRetrievals: Map<string, TemporaryBlockRetrieval>;
    messageIndex: Map<string, MessageCompressionEntry>;
    /** Dedicated effective messageId -> active compression block entry. */
    compressionIndex: Map<string, MessageCompressionEntry>;
    /** Persisted, dashboard-authored message projection overrides. */
    manualOverrides: Map<string, ManualMessageOverride>;
    /** Persisted highest-precedence config layer authored by the dashboard. */
    runtimeConfig: LayeredConfig;
    /** Optimistic revision for control-plane mutations. */
    controlRevision: number;
    /**
     * Monotonic counter of dashboard edits that actually changed the outbound
     * projection (overrides, block activation, or settings that re-prune it).
     *
     * A projection edit rewrites message positions the provider already cached,
     * so the next request is a cache write from the earliest edited position
     * onward. `projectionEditAppliedRevision` records the value that has already
     * been delivered to the model; while it lags, core treats the coming prefix
     * rewrite as unavoidable and lets otherwise cache-deferred pruning ride the
     * same invalidation instead of causing a second one (core/projectionEdits.ts).
     *
     * Only edits that actually change the projection are counted. A settings change
     * does not arm this by itself: it alters FUTURE pruning decisions, and whichever
     * pass acts on them records its own invalidation.
     */
    projectionEditRevision: number;
    /** Value of projectionEditRevision already applied to an outgoing request. */
    projectionEditAppliedRevision: number;
    /**
     * Message IDs touched by the not-yet-delivered edits, used to measure the
     * rewritten prefix from the earliest NEWLY edited position rather than from
     * the oldest override still in force.
     */
    projectionEditPendingIds: string[];
    /** Additional changed positions used only to find the cache rewrite cut point. */
    projectionEditCutIds: string[];
    activeByAnchorMessageId: Map<string, string>;
    nextBlockId: number;
    nextRunId: number;
    /** Dedup decisions: callIds whose output should be replaced with PLACEHOLDER_DEDUP. */
    dedupDecisions: Set<string>;
    /** Stale-error decisions: callIds whose input should be replaced with PLACEHOLDER_STALE_ERROR_INPUT. */
    staleErrorDecisions: Set<string>;
    /** Near-duplicate (SimHash) decisions: callIds whose output should be replaced with PLACEHOLDER_NEAR_DUPE. */
    nearDupeDecisions: Set<string>;
    /** Missing = unsafe pre-resource/syntax fingerprint decisions; reset once. */
    nearDupeVersion?: 2;
    /**
     * Mask/offload replacement text per callId.
     * Stored at decide time so re-apply can reproduce the exact placeholder text
     * without re-running the masking logic (which needs the original output).
     * For offloads, this is the pointer text (not the full content).
     */
    maskDecisions: Map<string, string>;
    /**
     * Message IDs dropped by the hard-cap mechanical floor (last-resort whole-message
     * removal when masking alone can't get under config.hardCap). Re-applied every
     * turn by applyDecisions (set isIgnored) so the drop survives the host re-feed.
     */
    hardCapDroppedIds: Set<string>;
    toolParameters: Map<string, unknown>;
    toolIdList: string[];
    messageIds: {
        byRawId: Map<string, string>;
        byRef: Map<string, string>;
        nextRef: number;
    };
    nudges: NudgeAnchors;
    /** Sustained non-compliance tracking for the nudge escalation ladder (core/nudges.ts). */
    nudgeEscalation: NudgeEscalationState;
    lastMaskingPassTurn: number;
    lastMaskingPassTime: number;
    lastPruneCompressRuns: number;
    lastRequestTime: number;
    lastCacheMiss: boolean;
    /**
     * Adaptive Cost-ROI `E_turns` estimate (core/budget/costRoi.ts): an EWMA of
     * the observed turn-gap between successive cache-busting events (dedup/
     * stale-error/near-dupe rewrites or observation-mask passes that cleared the
     * Cost-ROI gate), replacing a fixed heuristic constant. Initialized to 5 (the
     * prior hardcoded default) so a fresh session behaves identically until it
     * has observed history of its own.
     */
    eTurnsEstimate: number;
    /** Whether `lastCacheBustTurn` contains an observed event, including turn zero. */
    hasRecordedCacheBust: boolean;
    /** Turn number at which the last cache-busting event was recorded. */
    lastCacheBustTurn: number;
    /**
     * Token count calibration state.
     *
     * `ratio` is an EWMA of (provider_actual_input_tokens / local_estimated_tokens)
     * associated adapter-side with the exact prior outbound request via parentID.
     * A CharTokenizer (len/4) can underestimate by 15–40% on code-heavy sessions;
     * once calibrated, all thresholds (nudge percentages, hardCap, cost-ROI) are
     * applied to accurate counts instead of systematically biased estimates.
     *
     * Initialized to ratio=1.0 (no correction) until the first real turn with a
     * provider-reported count. `sampleCount` tracks how many turns have been
     * used to estimate (used to decide whether to apply correction at all).
     */
    tokenCalibration: {
        ratio: number;
        sampleCount: number;
        /** Canonical provider/model key this ratio was learned for. */
        modelKey?: string;
    };
    /**
     * Model-visible request metrics and the exact outbound sample awaiting the
     * provider's usage report. Derived target/removal values are never persisted.
     */
    contextTokenMetrics: {
        modelKey?: string;
        /** Calibrated projected-history estimate from the previous provider request. */
        lastRequestTokens?: number;
        /** Monotonic pipeline request sequence, distinct from user-turn count. */
        lastRequestSequence?: number;
        /** Recent assistant usage records already consumed, preventing re-feed duplication. */
        consumedCalibrationAssistantIds?: string[];
        /** Base-tokenizer estimate matched later via assistant.parentID. */
        pendingCalibration?: {
            modelKey: string;
            requestMessageId: string;
            baseEstimatedTokens: number;
        };
        /** Byte-stable status/nudge reapplied to one user turn throughout its tool loop. */
        anchoredStatus?: {
            userMessageId: string;
            text: string;
        };
    };
    latestSummaryBlockId?: string;
    fullRestructureTriggered: boolean;
    stats: SessionStats;
    modelContextLimit: number;
    systemPromptTokens: number;
    compressionTiming: CompressionTiming;
    lastCompaction?: number;
    currentTurn: number;
    /** Adapter-observed turns for the latest raw feed, plus the latest user anchor.
     * Optional for existing sidecars; tuples remain JSON-safe without a host type.
     */
    turnBasis?: {
        latestUserId?: string;
        messageTurns: Array<[string, number]>;
    };
    activeProfile: ProfileName;
}
/** Create a fresh CoreState for a new session. */
export declare function createInitialState(sessionId: string): CoreState;
/** Deep clone core state for transactional, side-effect-free operations. */
export declare function cloneCoreState(state: CoreState): CoreState;
//# sourceMappingURL=state.d.ts.map