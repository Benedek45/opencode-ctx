import type { NeutralMessage } from "../types/neutral.js";
import type { CoreConfig } from "../types/config.js";
import type { Tokenizer } from "../services/tokenizer.js";
/** Token budget breakdown by category. */
export interface BudgetBreakdown {
    systemAndTools: number;
    documents: number;
    reasoning: number;
    conversation: number;
    total: number;
    effectiveBudget: number;
    usedFraction: number;
}
/** Compute a rough budget breakdown from a list of messages. */
export declare function computeBudgetBreakdown(messages: NeutralMessage[], config: CoreConfig, tokenizer: Tokenizer): BudgetBreakdown;
/** Check whether the current token count exceeds a threshold. */
export declare function exceedsThreshold(totalTokens: number, threshold: number): boolean;
/** Check whether masking should be triggered. */
export declare function shouldTriggerMasking(totalTokens: number, config: CoreConfig): boolean;
//# sourceMappingURL=budget.d.ts.map