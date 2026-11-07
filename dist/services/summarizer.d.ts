import type { NeutralMessage } from "../types/neutral.js";
/** Summarizer service interface. */
export interface Summarizer {
    /**
     * Summarize the given messages into a compressed narrative.
     *
     * Returns the summary text (ready to pass to `applyCompress`), or null if the
     * summarizer cannot produce one — e.g. the adapter has no programmatic model
     * access. The adapter should treat a null return as "skip this request; leave
     * the mechanical masking escalation in place".
     */
    summarize(messages: NeutralMessage[], topic?: string): Promise<string | null>;
}
/**
 * No-op Summarizer: used by adapters without direct model access.
 * Always returns null so the caller skips the compress apply step.
 */
export declare class NoopSummarizer implements Summarizer {
    summarize(_messages: NeutralMessage[], _topic?: string): Promise<string | null>;
}
/** Shared no-op summarizer singleton. */
export declare const noopSummarizer: Summarizer;
//# sourceMappingURL=summarizer.d.ts.map