import type { ContextTierConfig } from "../types/config.js";
import type { BlockMetadata, CoreState, RetrievalMode, TemporaryBlockRetrieval } from "../types/state.js";
import type { Tokenizer } from "../services/tokenizer.js";
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
export type DirectedTierPlanResult = {
    ok: true;
    plan: DirectedTierPlan;
} | {
    ok: false;
    reason: string;
};
export interface ColdCatalog {
    text: string;
    blockIds: string[];
    overflow: number;
}
export type RetrievalPlanResult = {
    ok: true;
    retrieval: TemporaryBlockRetrieval;
} | {
    ok: false;
    reason: "missing-block" | "not-cold" | "missing-durable-source" | "budget-exceeded";
};
/** Active, unconsumed graph roots in deterministic oldest-first order. */
export declare function selectActiveRootBlocks(state: CoreState): BlockMetadata[];
/** Plan archive-ready warm-root demotions required by age or the strict warm cap. */
export declare function planTierDemotions(state: CoreState, config: ContextTierConfig, tokenizer: Tokenizer, modelContextLimit: number, currentTurn: number, allowAgeDemotion?: boolean): TierDemotionPlan;
export declare function applyTierDemotions(state: CoreState, plan: TierDemotionPlan): TierDemotionResult;
/**
 * Validate a model-authored tier selection and enforce the strict WARM budget.
 * Explicit promotions are protected: if they cannot fit, reject rather than
 * immediately undoing the model's choice.
 */
export declare function planDirectedTierSelection(state: CoreState, selection: DirectedTierSelection, config: ContextTierConfig, tokenizer: Tokenizer, modelContextLimit: number): DirectedTierPlanResult;
/** Apply one validated promotion/demotion batch and return cache-cut attribution. */
export declare function applyDirectedTierSelection(state: CoreState, plan: DirectedTierPlan): TierDemotionResult;
/** Build a stable newest-first catalog, adding only whole entries that fit. */
export declare function buildColdCatalog(blocks: BlockMetadata[], config: ContextTierConfig, tokenizer: Tokenizer, modelContextLimit: number): ColdCatalog;
export declare function planTemporaryRetrieval(state: CoreState, blockId: string, mode: RetrievalMode, tokenCost: number, config: ContextTierConfig, modelContextLimit: number, currentTurn: number): RetrievalPlanResult;
export declare function activateTemporaryRetrieval(state: CoreState, retrieval: TemporaryBlockRetrieval): void;
/** A TTL of N covers exactly N turns: [activatedAtTurn, expiresAtTurn). */
export declare function expireTemporaryRetrievals(state: CoreState, currentTurn: number): TemporaryBlockRetrieval[];
//# sourceMappingURL=contextTiers.d.ts.map