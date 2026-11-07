// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Pure hot/warm/cold compressed-context lifecycle and retrieval planning.

import type { ContextTierConfig } from "../types/config.js";
import type { BlockMetadata, CoreState, RetrievalMode, TemporaryBlockRetrieval } from "../types/state.js";
import type { Tokenizer } from "../services/tokenizer.js";
import { resolveThreshold } from "./tokens.js";

export interface TierDemotionPlan {
  blockIds: string[];
}

export interface TierDemotionResult {
  changedBlockIds: string[];
  effectiveMessageIds: string[];
  cutIds: string[];
}

export interface DirectedTierSelection {
  promoteBlockIds?: string[];
  demoteBlockIds?: string[];
}

export interface DirectedTierPlan {
  promoteBlockIds: string[];
  demoteBlockIds: string[];
}

export type DirectedTierPlanResult =
  | { ok: true; plan: DirectedTierPlan }
  | { ok: false; reason: string };

export interface ColdCatalog {
  text: string;
  blockIds: string[];
  overflow: number;
}

export type RetrievalPlanResult =
  | { ok: true; retrieval: TemporaryBlockRetrieval }
  | { ok: false; reason: "missing-block" | "not-cold" | "missing-durable-source" | "budget-exceeded" };

function numericBlockId(blockId: string): number {
  const match = /^b(\d+)$/.exec(blockId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function compareBlocks(left: BlockMetadata, right: BlockMetadata): number {
  return (left.createdAtTurn ?? 0) - (right.createdAtTurn ?? 0)
    || (left.createdAt ?? 0) - (right.createdAt ?? 0)
    || numericBlockId(left.blockId) - numericBlockId(right.blockId)
    || left.blockId.localeCompare(right.blockId);
}

function isActiveRoot(block: BlockMetadata): boolean {
  return (block.active ?? !block.consumed) && !block.consumed;
}

/** Active, unconsumed graph roots in deterministic oldest-first order. */
export function selectActiveRootBlocks(state: CoreState): BlockMetadata[] {
  return [...state.blockRegistry.values()].filter(isActiveRoot).sort(compareBlocks);
}

/** Plan archive-ready warm-root demotions required by age or the strict warm cap. */
export function planTierDemotions(
  state: CoreState,
  config: ContextTierConfig,
  tokenizer: Tokenizer,
  modelContextLimit: number,
  currentTurn: number,
  allowAgeDemotion = true
): TierDemotionPlan {
  const roots = selectActiveRootBlocks(state);
  const warm = roots.filter(block => (block.projectionTier ?? "warm") === "warm");
  const eligible = new Set(warm.filter(block => block.durableSourceRef && block.durableSummaryRef).map(block => block.blockId));
  const demoted = new Set<string>();
  for (const block of warm) {
    if (allowAgeDemotion && eligible.has(block.blockId) && currentTurn - (block.updatedAtTurn ?? block.createdAtTurn ?? 0) >= config.warmMaxAgeTurns) {
      demoted.add(block.blockId);
    }
  }

  if (config.warmBudgetMode === "advisory") {
    return { blockIds: warm.filter(block => demoted.has(block.blockId)).map(block => block.blockId) };
  }
  const cap = Math.max(0, resolveThreshold(config.warmMaxTokens, modelContextLimit));
  let retainedTokens = warm.reduce((sum, block) =>
    sum + (demoted.has(block.blockId) ? 0 : tokenizer.countTokens(block.summaryText ?? "")), 0);
  for (const block of warm) {
    if (retainedTokens <= cap) break;
    if (demoted.has(block.blockId) || !eligible.has(block.blockId)) continue;
    demoted.add(block.blockId);
    retainedTokens -= tokenizer.countTokens(block.summaryText ?? "");
  }
  return { blockIds: warm.filter(block => demoted.has(block.blockId)).map(block => block.blockId) };
}

export function applyTierDemotions(state: CoreState, plan: TierDemotionPlan): TierDemotionResult {
  const changedBlockIds: string[] = [];
  const effective = new Set<string>();
  const cuts = new Set<string>();
  for (const blockId of plan.blockIds) {
    const block = state.blockRegistry.get(blockId);
    if (!block || !isActiveRoot(block) || (block.projectionTier ?? "warm") === "cold") continue;
    if (!block.durableSourceRef || !block.durableSummaryRef) continue;
    block.projectionTier = "cold";
    changedBlockIds.push(blockId);
    for (const id of block.effectiveMessageIds ?? block.sourceMessageIds ?? []) effective.add(id);
    cuts.add(`__summary_${blockId}`);
  }
  if (changedBlockIds.length) cuts.add("__summary___ctx_cold_catalog");
  return { changedBlockIds, effectiveMessageIds: [...effective], cutIds: [...cuts] };
}

/**
 * Validate a model-authored tier selection and enforce the strict WARM budget.
 * Explicit promotions are protected: if they cannot fit, reject rather than
 * immediately undoing the model's choice.
 */
export function planDirectedTierSelection(
  state: CoreState,
  selection: DirectedTierSelection,
  config: ContextTierConfig,
  tokenizer: Tokenizer,
  modelContextLimit: number,
): DirectedTierPlanResult {
  const promote = selection.promoteBlockIds ?? [];
  const explicitDemote = selection.demoteBlockIds ?? [];
  if (new Set(promote).size !== promote.length || new Set(explicitDemote).size !== explicitDemote.length) {
    return { ok: false, reason: "tier block IDs must be unique" };
  }
  const overlap = promote.find(blockId => explicitDemote.includes(blockId));
  if (overlap) return { ok: false, reason: `${overlap} cannot be both promoted and demoted` };

  const roots = selectActiveRootBlocks(state);
  const rootsById = new Map(roots.map(block => [block.blockId, block]));
  for (const blockId of promote) {
    const block = rootsById.get(blockId);
    if (!block) return { ok: false, reason: `${blockId} is not an active root after compression` };
    if ((block.projectionTier ?? "warm") !== "cold") return { ok: false, reason: `${blockId} is not cold` };
    if (!block.durableSourceRef || !block.durableSummaryRef) return { ok: false, reason: `${blockId} lacks complete durable archives` };
  }
  for (const blockId of explicitDemote) {
    const block = rootsById.get(blockId);
    if (!block) return { ok: false, reason: `${blockId} is not an active root after compression` };
    if ((block.projectionTier ?? "warm") !== "warm") return { ok: false, reason: `${blockId} is not warm` };
    if (!block.durableSourceRef || !block.durableSummaryRef) return { ok: false, reason: `${blockId} lacks complete durable archives` };
  }

  const promoted = new Set(promote);
  const demoted = new Set(explicitDemote);
  if (config.warmBudgetMode === "advisory") {
    return { ok: true, plan: { promoteBlockIds: [...promote], demoteBlockIds: [...explicitDemote] } };
  }
  const cap = Math.max(0, resolveThreshold(config.warmMaxTokens, modelContextLimit));
  let warmTokens = roots.reduce((sum, block) => {
    const willBeWarm = promoted.has(block.blockId)
      || (!demoted.has(block.blockId) && (block.projectionTier ?? "warm") === "warm");
    return sum + (willBeWarm ? tokenizer.countTokens(block.summaryText ?? "") : 0);
  }, 0);

  for (const block of roots) {
    if (warmTokens <= cap) break;
    const isWarm = promoted.has(block.blockId)
      || (!demoted.has(block.blockId) && (block.projectionTier ?? "warm") === "warm");
    if (!isWarm || promoted.has(block.blockId) || demoted.has(block.blockId)) continue;
    if (!block.durableSourceRef || !block.durableSummaryRef) continue;
    demoted.add(block.blockId);
    warmTokens -= tokenizer.countTokens(block.summaryText ?? "");
  }
  if (warmTokens > cap) {
    return { ok: false, reason: `selected WARM summaries require ${warmTokens} tokens but the budget is ${cap}` };
  }
  return { ok: true, plan: { promoteBlockIds: [...promote], demoteBlockIds: [...demoted] } };
}

/** Apply one validated promotion/demotion batch and return cache-cut attribution. */
export function applyDirectedTierSelection(state: CoreState, plan: DirectedTierPlan): TierDemotionResult {
  const changedBlockIds: string[] = [];
  const effective = new Set<string>();
  const cuts = new Set<string>();
  for (const [blockIds, tier] of [[plan.demoteBlockIds, "cold"], [plan.promoteBlockIds, "warm"]] as const) {
    for (const blockId of blockIds) {
      const block = state.blockRegistry.get(blockId);
      if (!block || !isActiveRoot(block) || (block.projectionTier ?? "warm") === tier) continue;
      block.projectionTier = tier;
      block.updatedAtTurn = state.currentTurn;
      changedBlockIds.push(blockId);
      for (const id of block.effectiveMessageIds ?? block.sourceMessageIds ?? []) effective.add(id);
      cuts.add(`__summary_${blockId}`);
      const lease = state.temporaryRetrievals.get(blockId);
      const retrievalMessageId = lease?.messageId;
      for (const [retrievedBlockId, retrieved] of state.temporaryRetrievals) {
        if (retrievedBlockId !== blockId && (!retrievalMessageId || retrieved.messageId !== retrievalMessageId)) continue;
        if (retrieved.messageId) effective.add(retrieved.messageId);
        state.temporaryRetrievals.delete(retrievedBlockId);
      }
    }
  }
  if (changedBlockIds.length) cuts.add("__summary___ctx_cold_catalog");
  return { changedBlockIds, effectiveMessageIds: [...effective], cutIds: [...cuts] };
}

function catalogEntry(block: BlockMetadata): string {
  const sourceCount = (block.effectiveMessageIds ?? block.sourceMessageIds ?? []).length;
  return `${block.blockId} | ${block.topic ?? "legacy"} | turn ${block.createdAtTurn ?? 0} | ${sourceCount} sources`;
}

/** Build a stable newest-first catalog, adding only whole entries that fit. */
export function buildColdCatalog(
  blocks: BlockMetadata[],
  config: ContextTierConfig,
  tokenizer: Tokenizer,
  modelContextLimit: number
): ColdCatalog {
  const cold = blocks
    .filter(block => isActiveRoot(block) && (block.projectionTier ?? "warm") === "cold")
    .sort(compareBlocks)
    .reverse();
  const cap = Math.max(0, resolveThreshold(config.catalogMaxTokens, modelContextLimit));
  const prefix = "Cold context catalog:";
  const selected: string[] = [];
  const selectedBlockIds: string[] = [];
  for (const block of cold) {
    const candidate = [...selected, catalogEntry(block)];
    const text = `${prefix}\n${candidate.join("\n")}`;
    if (tokenizer.countTokens(text) <= cap) {
      selected.push(candidate.at(-1)!);
      selectedBlockIds.push(block.blockId);
    }
  }
  let overflow = cold.length - selected.length;
  let text = selected.length ? `${prefix}\n${selected.join("\n")}` : "";
  if (overflow > 0) {
    const withOverflow = `${text || prefix}\n+${overflow} more cold blocks`;
    if (tokenizer.countTokens(withOverflow) <= cap) text = withOverflow;
  }
  return { text, blockIds: selectedBlockIds, overflow };
}

export function planTemporaryRetrieval(
  state: CoreState,
  blockId: string,
  mode: RetrievalMode,
  tokenCost: number,
  config: ContextTierConfig,
  modelContextLimit: number,
  currentTurn: number
): RetrievalPlanResult {
  const block = state.blockRegistry.get(blockId);
  if (!block) return { ok: false, reason: "missing-block" };
  if ((block.projectionTier ?? "warm") !== "cold") return { ok: false, reason: "not-cold" };
  if (mode === "exact" && !block.durableSourceRef) return { ok: false, reason: "missing-durable-source" };
  const used = [...(state.temporaryRetrievals?.values() ?? [])]
    .filter(lease => lease.expiresAtTurn > currentTurn && lease.blockId !== blockId)
    .reduce((sum, lease) => sum + lease.tokenCost, 0);
  const cost = Math.max(0, tokenCost);
  const cap = Math.max(0, resolveThreshold(config.retrievalMaxTokens, modelContextLimit));
  if (used + cost > cap) return { ok: false, reason: "budget-exceeded" };
  return {
    ok: true,
    retrieval: {
      blockId,
      mode,
      activatedAtTurn: currentTurn,
      expiresAtTurn: currentTurn + config.retrievalTtlTurns,
      tokenCost: cost,
    },
  };
}

export function activateTemporaryRetrieval(state: CoreState, retrieval: TemporaryBlockRetrieval): void {
  if (!(state.temporaryRetrievals instanceof Map)) state.temporaryRetrievals = new Map();
  state.temporaryRetrievals.set(retrieval.blockId, retrieval);
}

/** A TTL of N covers exactly N turns: [activatedAtTurn, expiresAtTurn). */
export function expireTemporaryRetrievals(state: CoreState, currentTurn: number): TemporaryBlockRetrieval[] {
  if (!(state.temporaryRetrievals instanceof Map)) state.temporaryRetrievals = new Map();
  const expired: TemporaryBlockRetrieval[] = [];
  for (const [blockId, retrieval] of state.temporaryRetrievals) {
    if (currentTurn < retrieval.expiresAtTurn) continue;
    expired.push(retrieval);
    state.temporaryRetrievals.delete(blockId);
  }
  return expired.sort((left, right) => left.activatedAtTurn - right.activatedAtTurn || left.blockId.localeCompare(right.blockId));
}
