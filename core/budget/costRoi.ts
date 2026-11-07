// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Cost-ROI gate: pure function deciding whether a warm-prefix-busting prune is worth it.
//
// Formula: N_saved * E_turns > (R - 1) * N_after
//
// Overrides (always pass):
//   - Cold cache: idle > cacheModel.effectiveTtlSeconds OR prior turn was a cache miss
//   - Quality trigger: active tokens > upperThreshold
//   - R = 1 (no cache benefit to protect)
//   - costRoi.enabled = false

import type { CacheModel, CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import { resolveThreshold } from "../tokens.js";
import { hasPendingProjectionRewrite } from "../projectionEdits.js";

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
export function evaluateCostRoi(input: CostRoiInput): CostRoiResult {
  const { nSaved, eTurns, nAfter, cacheModel, isColdCache, isQualityTrigger, enabled, clearAtLeast } = input;
  const R = cacheModel.R;

  // Gate disabled: always pass
  if (!enabled) {
    return { shouldPrune: true, reason: "cost-roi disabled" };
  }

  // clearAtLeast floor: if we can't save enough, skip
  if (nSaved < clearAtLeast) {
    return { shouldPrune: false, reason: `nSaved (${nSaved}) < clearAtLeast (${clearAtLeast})` };
  }

  // R = 1: no cache benefit to protect, always pass
  if (R <= 1) {
    return { shouldPrune: true, reason: "R=1: no cache benefit to protect" };
  }

  // Cold cache override: penalty term is 0, always pass
  if (isColdCache) {
    return { shouldPrune: true, reason: "cold cache: penalty term 0" };
  }

  // Quality trigger override: always pass
  if (isQualityTrigger) {
    return { shouldPrune: true, reason: "quality trigger: activeTokens > upperThreshold" };
  }

  // Core formula: N_saved * E_turns > (R - 1) * N_after
  const lhs = nSaved * eTurns;
  const rhs = (R - 1) * nAfter;

  if (lhs > rhs) {
    return { shouldPrune: true, reason: `formula: ${lhs} > ${rhs}` };
  }

  return {
    shouldPrune: false,
    reason: `formula: ${lhs} <= ${rhs} (N_saved=${nSaved}, E_turns=${eTurns}, R=${R}, N_after=${nAfter})`,
  };
}

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
export function cachePruneAllowed(
  config: CoreConfig,
  state: CoreState,
  nowMs: number,
  activeTokens: number,
  candidateSavings?: number
): boolean {
  if (!config.costRoi.enabled) return true;
  if (config.cacheModel.R <= 1) return true;
  if (state.lastRequestTime === 0) return true;
  if (state.lastCacheMiss) return true;
  // A pending dashboard edit rewrites the cached prefix on this very request,
  // so deferred cleanup is free to ride the same invalidation.
  if (hasPendingProjectionRewrite(state)) return true;
  if (config.cachePrune.afterCompress && state.stats.totalCompressRuns > (state.lastPruneCompressRuns ?? 0)) return true;
  if (config.cachePrune.afterTtl && isIdlePastTtl(state.lastRequestTime, nowMs, config.cachePrune.ttlSeconds)) return true;
  if (activeTokens > resolveThreshold(config.nudges.upperThreshold, config.modelContextLimit)) return true;

  // P2: also allow when the cost-ROI formula is positive for the candidate savings.
  // This lets dedup/stale fire on a warm cache when the prune is clearly worth it
  // (large duplicate, high savings relative to the cache penalty).
  if (candidateSavings !== undefined && candidateSavings > 0) {
    const nAfter = Math.max(0, activeTokens - candidateSavings);
    const roi = evaluateCostRoi(
      buildCostRoiInput(
        candidateSavings,
        nAfter,
        activeTokens,
        config,
        nowMs,
        state.lastRequestTime,
        state.lastCacheMiss,
        state.eTurnsEstimate
      )
    );
    if (roi.shouldPrune) return true;
  }

  return false;
}

function isIdlePastTtl(lastRequestTimeMs: number, nowMs: number, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false;
  return (nowMs - lastRequestTimeMs) / 1000 > ttlSeconds;
}

/**
 * Determine whether the cache is cold given the last request time and TTL.
 */
export function isColdCache(
  lastRequestTimeMs: number,
  nowMs: number,
  cacheModel: CacheModel,
  lastCacheMiss: boolean
): boolean {
  if (lastCacheMiss) return true;
  if (lastRequestTimeMs === 0) return true; // first turn
  const idleSeconds = (nowMs - lastRequestTimeMs) / 1000;
  return idleSeconds > cacheModel.effectiveTtlSeconds;
}

/**
 * Default/fallback E_turns estimate, used before a session has observed any
 * cache-busting events of its own (see recordCacheBust below). This was
 * previously a hardcoded constant baked into every ROI evaluation; it is now
 * only the cold-start prior for state.eTurnsEstimate.
 */
export const DEFAULT_E_TURNS = 5;

/**
 * Build a CostRoiInput from config and context stats.
 *
 * `eTurns` (expected number of future turns that will reuse the cache) is
 * caller-supplied rather than hardcoded: pass `state.eTurnsEstimate` (see
 * recordCacheBust) so the formula reflects this session's observed cadence of
 * cache-busting events instead of a fixed guess.
 */
export function buildCostRoiInput(
  nSaved: number,
  nAfter: number,
  activeTokens: number,
  config: CoreConfig,
  nowMs: number,
  lastRequestTimeMs: number,
  lastCacheMiss: boolean,
  eTurns: number = DEFAULT_E_TURNS,
  prefixRewritePending = false
): CostRoiInput {
  // A pending projection edit is economically identical to a cold prefix: the
  // penalty term is already being paid by the edit itself this turn.
  const cold =
    prefixRewritePending ||
    isColdCache(lastRequestTimeMs, nowMs, config.cacheModel, lastCacheMiss);
  const qualityTrigger =
    activeTokens > resolveThreshold(config.nudges.upperThreshold, config.modelContextLimit);

  return {
    nSaved,
    eTurns,
    nAfter,
    activeTokens,
    cacheModel: config.cacheModel,
    isColdCache: cold,
    isQualityTrigger: qualityTrigger,
    enabled: config.costRoi.enabled,
    clearAtLeast: config.clearAtLeast,
  };
}

/** Exponential-moving-average smoothing factor for the E_turns estimate. */
const E_TURNS_EWMA_ALPHA = 0.3;
/** Clamp bounds for the observed turn-gap sample before folding into the EWMA. */
const E_TURNS_MIN = 1;
const E_TURNS_MAX = 30;

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
export function recordCacheBust(state: CoreState, currentTurn: number): void {
  // One request can invalidate the prefix only once, however many passes rewrite
  // it (cascade, masking, and a delivered dashboard edit can all fire in the same
  // turn). Later same-turn callers must not re-seed the estimate.
  // `lastCacheBustTurn > 0` preserves compatibility with callers/tests and old
  // in-memory state that predate the explicit presence bit.
  const hasPrior = state.hasRecordedCacheBust || state.lastCacheBustTurn > 0;
  if (hasPrior && state.lastCacheBustTurn === currentTurn) return;
  if (hasPrior) {
    const gap = currentTurn - state.lastCacheBustTurn;
    if (gap > 0) {
      const clamped = Math.max(E_TURNS_MIN, Math.min(E_TURNS_MAX, gap));
      state.eTurnsEstimate =
        E_TURNS_EWMA_ALPHA * clamped + (1 - E_TURNS_EWMA_ALPHA) * state.eTurnsEstimate;
    }
  }
  state.lastCacheBustTurn = currentTurn;
  state.hasRecordedCacheBust = true;
}
