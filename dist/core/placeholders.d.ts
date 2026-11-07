/** Dedup strategy: output replaced because it was superseded. */
export declare const PLACEHOLDER_DEDUP = "[Output removed to save context - information superseded or no longer needed]";
/** Stale-error strategy: input removed because the tool call failed. */
export declare const PLACEHOLDER_STALE_ERROR_INPUT = "[input removed due to failed tool call]";
/**
 * Near-duplicate dedup: output replaced because a SimHash comparison found a
 * later, near-identical result for the same stateless tool (e.g. a re-read of
 * mostly-overlapping file content, a re-run search with a near-identical result
 * set). Distinct wording from PLACEHOLDER_DEDUP since this is a similarity match,
 * not a byte-identical one.
 */
export declare const PLACEHOLDER_NEAR_DUPE = "[Output removed to save context - near-duplicate of a later, more complete result for the same tool]";
/** Plain mask: output masked, tool call preserved, re-runnable. */
export declare const PLACEHOLDER_PLAIN_MASK = "[Tool output masked to save context \u2014 older than the recency window. The tool call and its inputs are preserved; re-run the tool if this output is needed again.]";
/**
 * Offload pointer: large output offloaded to disk.
 * @param path  Absolute path to the offloaded file.
 * @param previewLines  Number of preview lines shown.
 * @param preview  The preview text.
 */
export declare function buildOffloadPointer(path: string, previewLines: number, preview: string): string;
/**
 * Stateful mask: non-re-fetchable output condensed.
 * @param exitCode  Exit code string (e.g. "0", "1", or "unknown").
 * @param summary   Pass/fail summary line.
 * @param tailLines  Number of tail lines shown.
 * @param tail      The tail text.
 */
export declare function buildStatefulMask(exitCode: string, summary: string, tailLines: number, tail: string): string;
//# sourceMappingURL=placeholders.d.ts.map