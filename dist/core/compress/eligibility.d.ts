import type { CoreConfig } from "../../types/config.js";
import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
export interface CompressionCandidate {
    startRef: string;
    endRef: string;
    messageIds: string[];
    /** Visible source estimate, NOT actual retained net savings (protected facts/summaries survive). */
    sourceTokens: number;
}
export interface CompressionCandidateReport {
    candidates: CompressionCandidate[];
    /** Visible eligible tokens across all ranges, including ranges below the savings gate. */
    eligibleTokens: number;
    /** Visible tokens excluded by structural or recency protection. */
    protectedTokens: number;
    reason?: "noeligible" | "protectedcontent" | "insufficient-estimate" | "compression-disabled";
    /** Smallest remaining request wait among structurally eligible recent messages. */
    requestsUntilEligible?: number;
}
/**
 * Supply the complete visible conversation, not a selected suffix: request ages
 * deliberately use exactly the transaction validator's full-input basis.
 * Returns at most three oldest stable contiguous ranges. Source estimates exclude
 * hidden originals; validation still uses its historical block source accounting.
 * A real summary must be preflighted again: its size and retained facts can fail
 * the savings gate even when this minimal-summary estimate passes.
 */
export declare function planCompressionCandidates(messages: readonly NeutralMessage[], state: CoreState, config: CoreConfig, tokenizer: Tokenizer): CompressionCandidateReport;
//# sourceMappingURL=eligibility.d.ts.map