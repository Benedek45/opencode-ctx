import type { Summarizer } from "../../services/summarizer.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { NeutralMessage } from "../../types/neutral.js";
export interface SummaryWorkerOptions {
    model: {
        providerID: string;
        modelID: string;
    };
    agent: "ctx-summarizer";
    timeoutMs: number;
    maxInputTokens: number;
    /** Local acceptance cap only: neither installed SDK prompt API has this field. */
    maxOutputTokens?: number;
    /** Explicit version selection; PluginInput.client currently uses v1. */
    sdkVersion?: "v1" | "v2";
    directory?: string;
    /** Each cleanup request and late-create settlement gets this bounded grace. */
    cleanupTimeoutMs?: number;
}
export interface SummaryWorkerDiagnostic {
    code: "refused" | "failed" | "creation-outcome-unknown" | "cleanup-unconfirmed";
    sessionID?: string;
    detail: string;
}
export interface SummaryWorkerCallbacks {
    /** Synchronous registration, called after internal registration and BEFORE prompt. */
    onCreated?(sessionID: string): void;
    /** Called only after BOTH abort and deletion are confirmed; safe to unregister. */
    onFinished?(sessionID: string): void;
    onDiagnostic?(diagnostic: SummaryWorkerDiagnostic): void;
}
export interface OpenCodeSummarizer extends Summarizer {
    /** Optional caller cancellation without changing the host-neutral service port. */
    summarize(messages: NeutralMessage[], topic?: string, signal?: AbortSignal): Promise<string | null>;
}
export declare function isSummaryWorkerSession(sessionID: string, directory?: string): boolean;
/**
 * Optional SDK-only transport. No provider credentials, shell, retries, history
 * fetch, continuation/fork, or core mutation. Parent MUST register the dedicated
 * agent with permission {'*':'deny'} and tools disabled before enabling this port.
 * Tool enumeration is defense in depth, not a replacement for host permissions.
 *
 * Verified @opencode-ai/sdk 1.17.11 sources (under dist/):
 * gen/types.gen.d.ts: SessionCreateData 1811, Delete 1860, Abort 2059, Prompt 2244;
 * gen/sdk.gen.d.ts: create 114, delete 122, abort 150, prompt 174;
 * v2/gen/sdk.gen.d.ts: create 982, delete 1013, prompt 1094, abort 1151;
 * v2/gen/types.gen.d.ts: SessionPromptData 8492; AssistantMessage 213.
 * Request options inherit RequestInit.signal via gen/client/types.gen.d.ts:6.
 * Current https://opencode.ai/docs/sdk/ confirms v1 path/body APIs. V2 must be
 * selected explicitly, since method arity is not reliable version detection.
 *
 * HTTP abort does not prove server cancellation. An unacknowledged create can
 * still create a session whose ID is unknown. We wait a bounded late-create
 * grace, clean up any recovered ID, otherwise report creation-outcome-unknown.
 * No detached late cleanup is launched and no cancellation success is invented.
 */
export declare function createOpenCodeSummarizer(client: unknown, suppliedOptions: SummaryWorkerOptions, tokenizer: Tokenizer, callbacks?: SummaryWorkerCallbacks): OpenCodeSummarizer;
//# sourceMappingURL=summary-worker.d.ts.map