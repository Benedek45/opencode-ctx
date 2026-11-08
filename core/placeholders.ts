// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Exact placeholder strings used by the cascade strategies.

/** Dedup strategy: output replaced because it was superseded. */
export const PLACEHOLDER_DEDUP =
  "[Output removed to save context - information superseded or no longer needed]";

/** Stale-error strategy: input removed because the tool call failed. */
export const PLACEHOLDER_STALE_ERROR_INPUT =
  "[input removed due to failed tool call]";

/**
 * Near-duplicate dedup: output replaced because a SimHash comparison found a
 * later, near-identical result for the same stateless tool (e.g. a re-read of
 * mostly-overlapping file content, a re-run search with a near-identical result
 * set). Distinct wording from PLACEHOLDER_DEDUP since this is a similarity match,
 * not a byte-identical one.
 */
export const PLACEHOLDER_NEAR_DUPE =
  "[Output superseded by a later near-identical read of the same resource with the same tool]";

/** Plain mask: output masked, tool call preserved, re-runnable. */
export const PLACEHOLDER_PLAIN_MASK =
  "[Tool output masked to save context \u2014 older than the recency window. The tool call and its inputs are preserved; re-run the tool if this output is needed again.]";

/**
 * Offload pointer: large output offloaded to disk.
 * @param path  Absolute path to the offloaded file.
 * @param previewLines  Number of preview lines shown.
 * @param preview  The preview text.
 */
export function buildOffloadPointer(
  path: string,
  previewLines: number,
  preview: string
): string {
  return (
    `[Large tool output offloaded to save context. Source: ${path}. ` +
    `Preview (first ${previewLines} lines):\n${preview}\n` +
    `\u2026(truncated; use the read tool on "${path}" to load the full content if you need it again).]`
  );
}

/**
 * Stateful mask: non-re-fetchable output condensed.
 * @param exitCode  Exit code string (e.g. "0", "1", or "unknown").
 * @param summary   Pass/fail summary line.
 * @param tailLines  Number of tail lines shown.
 * @param tail      The tail text.
 */
export function buildStatefulMask(
  exitCode: string,
  summary: string,
  tailLines: number,
  tail: string
): string {
  return (
    `[Stateful tool output condensed to save context. Exit code: ${exitCode}. ${summary}.\n` +
    `Last ${tailLines} lines:\n${tail}\n` +
    `\u2026(full output not re-fetchable; re-run the tool if needed).]`
  );
}
