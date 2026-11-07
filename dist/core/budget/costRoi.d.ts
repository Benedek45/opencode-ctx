import type { CacheModel, CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
/** Input to the Cost-ROI gate. */
export interface CostRoiInput {
    /** Tokens that would be saved by the prune. */
    nSaved: number;
    /** Estimated number of future turns that will reuse the cache. */
    eTurns: number;
    /** Tokens remaining after the prune. */
    nAfter: number;
    /** Current total active tokens. */
    activeTokens: number;
    /** Cache model parameters. */
    cacheModel: CacheModel;
    /** Whether the cache is currently cold (idle > TTL or prior miss). */
    isColdCache: boolean;
    /** Whether the quality trigger is active (activeTokens > upperThreshold). */
    isQualityTrigger: boolean;
    /** Whether the Cost-ROI gate is enabled. */
    enabled: boolean;
    /** Minimum tokens that must be cleared (clearAtLeast floor). */
    clearAtLeast: number;
}
/** Result of the Cost-ROI gate. */
export interface CostRoiResult {
    /** Whether the prune should proceed. */
    shouldPrune: boolean;
    /** Reason for the decision. */
    reason: string;
}
/**
 * Evaluate the Cost-ROI gate.
 *
 * Returns shouldPrune=true if the prune is economically justified or
 * an override condition is met.
 */
export declare function evaluateCostRoi(input: CostRoiInput): CostRoiResult;
/**
 * Whether perturbing a (possibly warm) cached prefix is acceptable this turn.
 *
 * Dedup and stale-error rewrite OLDER message positions, which invalidates a
 * prompt cache from that point forward. This predicate says "go ahead and prune"
 * only when doing so is cheap or unavoidable:
 *   - the cost-ROI gate is disabled, or
 *   - there is no cache benefit to protect (R <= 1), or
 *   - this is the first request, or the provider reported the previous prefix was
 *     cold/missed, so the next request is a full cache write anyway, or
 *   - a model-driven compress happened since the last dedup/stale recompute, so
 *     cleanup rides that already-invalidated prefix instead of causing a separate
 *     cache miss, or
 *   - a dashboard projection edit is pending, which rewrites the cached prefix on
 *     this request anyway (same rationale as post-compress), or
 *   - `cachePrune.afterTtl` is enabled and the session has been idle longer than
 *     `cachePrune.ttlSeconds`, so the next request is expected to be a full cache
 *     write anyway, or
 *   - context is critically full (quality trigger) — prune regardless of cache, or
 *   - the cost-ROI formula is positive for the candidate savings (P2: dedup/stale
 *     also fire when mathematically worth it, not just on cold/compress/TTL signals).
 *
 * When the cache is warm and there is headroom, returns false: keep duplicates /
 * stale inputs riding the cached prefix (cheap reads) until the next compress,
 * configured TTL-cold window, or definite cold/missed-cache signal.
 *
 * @param candidateSavings  Optional: estimated tokens that would be saved by the
 *   prune. When provided, the cost-ROI formula is also evaluated as an allow
 *   condition (P2). Pass undefined to skip the formula check (legacy behaviour).
 */
export declare function cachePruneAllowed(config: CoreConfig, state: CoreState, nowMs: number, activeTokens: number, candidateSavings?: number): boolean;
/**
 * Determine whether the cache is cold given the last request time and TTL.
 */
export declare function isColdCache(lastRequestTimeMs: number, nowMs: number, cacheModel: CacheModel, lastCacheMiss: boolean): boolean;
/**
 * Default/fallback E_turns estimate, used before a session has observed any
 * cache-busting events of its own (see recordCacheBust below). This was
 * previously a hardcoded constant baked into every ROI evaluation; it is now
 * only the cold-start prior for state.eTurnsEstimate.
 */
export declare const DEFAULT_E_TURNS = 5;
/**
 * Build a CostRoiInput from config and context stats.
 *
 * `eTurns` (expected number of future turns that will reuse the cache) is
 * caller-supplied rather than hardcoded: pass `state.eTurnsEstimate` (see
 * recordCacheBust) so the formula reflects this session's observed cadence of
 * cache-busting events instead of a fixed guess.
 */
export declare function buildCostRoiInput(nSaved: number, nAfter: number, activeTokens: number, config: CoreConfig, nowMs: number, lastRequestTimeMs: number, lastCacheMiss: boolean, eTurns?: number, prefixRewritePending?: boolean): CostRoiInput;
/**
 * Record a cache-busting event (dedup/stale-error/near-dupe rewrite, or an
 * observation-mask pass that cleared its own Cost-ROI gate) and update the
 * adaptive `state.eTurnsEstimate` via an exponentially-weighted moving average
 * of the observed turn-gap since the previous bust.
 *
 * Rationale: E_turns in the Cost-ROI formula (N_saved * E_turns > (R-1) *
 * N_after) estimates how many future turns will reuse the cache if we DON'T
 * bust it now — i.e. how long a prefix tends to stay both stable and worth
 * protecting in this session. The turn-gap between successive bust decisions
 * is a direct, session-grounded proxy for that cadence: a session that busts
 * the cache every 2 turns has a very different reuse profile than one that
 * goes 20 turns between busts, and a fixed constant cannot distinguish them.
 *
 * The very first bust in a session only seeds `lastCacheBustTurn` (no prior
 * gap to measure); the EWMA starts adapting from the second bust onward. The
 * observed gap is clamped to [1, 30] turns before folding in, so a single
 * anomalous outlier (e.g. a session that goes very long without any prune
 * activity) cannot swing the estimate to an extreme in one step.
 */
export declare function recordCacheBust(state: CoreState, currentTurn: number): void;
//# sourceMappingURL=costRoi.d.ts.map