// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Summarizer service: optional port for adapter-driven proactive compression.
//
// When the pipeline signals that compression is needed (via `compressRequests`
// in PipelineResult), the adapter can fulfil the request by calling a model to
// summarise the specified messages. The core is pure and synchronous, so this
// fulfillment happens entirely in the adapter layer between pipeline runs.
//
// Protocol:
//   Turn N   — pipeline returns compressRequests = [{messageIds:[...]}]
//   Adapter  — stores as pendingCompressRequests in session data
//   Turn N+1 — adapter calls summarizer.summarize(messages, topic) BEFORE
//              running the pipeline; if non-null, calls executeCompress +
//              applyCompress with the result, then runs the pipeline normally
//
// Adapters without programmatic model access (opencode v1 — no public
// `complete` API) use NoopSummarizer, which returns null and leaves the
// existing mechanical masking escalation as the fallback. Adapters that CAN
// call a model (BFF, claude-code) should provide a real implementation.
//
// This port is structurally symmetric to the existing `offloadRequests` /
// file-write pattern: the core signals what needs doing; the adapter does it.

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
export class NoopSummarizer implements Summarizer {
  async summarize(_messages: NeutralMessage[], _topic?: string): Promise<string | null> {
    return null;
  }
}

/** Shared no-op summarizer singleton. */
export const noopSummarizer: Summarizer = new NoopSummarizer();
