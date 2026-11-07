import type { ContentStore } from "../services/contentStore.js";
import type { Persistence } from "../services/persistence.js";
import type { Tokenizer } from "../services/tokenizer.js";
import type { CoreState } from "../types/state.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
interface UpstreamBlock {
    blockId: number;
    runId: number;
    active: boolean;
    deactivatedByUser: boolean;
    compressedTokens: number;
    summaryTokens: number;
    mode?: "range" | "message";
    topic: string;
    batchTopic?: string;
    startId: string;
    endId: string;
    anchorMessageId: string;
    includedBlockIds: number[];
    consumedBlockIds: number[];
    parentBlockIds: number[];
    directMessageIds: string[];
    directToolIds: string[];
    effectiveMessageIds: string[];
    effectiveToolIds: string[];
    createdAt: number;
    summary: string;
}
export interface UpstreamImportPlan {
    sessionId: string;
    blocks: UpstreamBlock[];
    nextState: CoreState;
    sourceEntriesByBlock: Map<string, HostMessageEntry[]>;
    incompleteSourceBlockIds: string[];
    activeBlockIds: string[];
    totalSourceTokens: number;
    totalSummaryTokens: number;
    skippedPrunedTools: number;
    alreadyImported: boolean;
    needsStateRepair: boolean;
    projectionNeedsRepair: boolean;
}
export interface UpstreamImportReport {
    dryRun: boolean;
    alreadyImported: boolean;
    importedBlocks: number;
    activeBlocks: number;
    archivedSources: number;
    archivedSummaries: number;
    incompleteSourceBlocks: number;
    totalSourceTokens: number;
    totalSummaryTokens: number;
    skippedPrunedTools: number;
    stateRepaired: boolean;
}
export interface ImportUpstreamSessionInput {
    sessionId: string;
    upstreamState: unknown;
    currentState: CoreState;
    hostEntries: HostMessageEntry[];
    tokenizer: Tokenizer;
    contentStore: ContentStore;
    persistence: Persistence;
    dryRun?: boolean;
    /**
     * Preserve legacy summaries whose original source messages are already absent.
     * Such blocks intentionally receive no durableSourceRef and cannot be restored.
     */
    allowIncompleteSources?: boolean;
}
/** Resolve the original plugin's sidecar without modifying it. */
export declare function upstreamSidecarPath(sessionId: string, dataHome?: string): string;
export declare function readUpstreamSidecar(sessionId: string, dataHome?: string): Promise<unknown>;
/** Validate and map an upstream sidecar without writing archives or state. */
export declare function planUpstreamSessionImport(input: Omit<ImportUpstreamSessionInput, "contentStore" | "persistence" | "dryRun">): UpstreamImportPlan;
/** Archive and publish a validated conversion. The upstream sidecar is read-only. */
export declare function importUpstreamSession(input: ImportUpstreamSessionInput): Promise<{
    state: CoreState;
    report: UpstreamImportReport;
}>;
export {};
//# sourceMappingURL=importer.d.ts.map