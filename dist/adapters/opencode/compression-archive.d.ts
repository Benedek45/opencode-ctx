import type { ContentSearchSnippet, ContentStore, ContentWriteResult } from "../../services/contentStore.js";
import type { BlockMetadata, CoreState } from "../../types/state.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { HostMessageEntry } from "./host-types.js";
export declare const COMPRESSION_SOURCE_KIND = "compression-source-v1";
export declare const COMPRESSION_SUMMARY_KIND = "compression-summary-v1";
export interface CompressionSourceArchiveV1 {
    version: 1;
    kind: "compression-source";
    sessionId: string;
    blockId: string;
    messageIds: string[];
    entries: HostMessageEntry[];
    digest: string;
}
export interface CompressionSummaryArchiveV1 {
    version: 1;
    kind: "compression-summary";
    sessionId: string;
    blockId: string;
    summaryText: string;
    digest: string;
}
export interface ArchiveWriteResult<T> extends ContentWriteResult {
    envelope: T;
}
export declare function archiveCompressionSource(store: ContentStore, sessionId: string, blockId: string, topic: string, messageIds: string[], entries: HostMessageEntry[]): Promise<ArchiveWriteResult<CompressionSourceArchiveV1>>;
export declare function archiveCompressionSummary(store: ContentStore, sessionId: string, blockId: string, topic: string, summaryText: string): Promise<ArchiveWriteResult<CompressionSummaryArchiveV1>>;
export declare function loadCompressionSource(store: ContentStore, contentId: string, sessionId: string, blockId: string, expectedMessageIds: string[]): Promise<HostMessageEntry[]>;
export declare function loadCompressionSummary(store: ContentStore, contentId: string, sessionId: string, blockId: string): Promise<string>;
export interface CompressionArchiveSearchItem {
    blockId: string;
    label?: string;
    score: number;
    snippet?: ContentSearchSnippet;
    summaryBytes: number;
    estimatedTokens: number;
}
export interface CompressionArchiveSearchResults {
    items: CompressionArchiveSearchItem[];
    totalMatches: number;
    truncatedResults: boolean;
    truncatedBytes: boolean;
}
export declare function searchCompressionSummaries(store: ContentStore, sessionId: string, query: string, limits: {
    maxResults: number;
    maxBytes: number;
    snippetMaxChars?: number;
}): Promise<CompressionArchiveSearchResults>;
export type SummaryOmissionReason = "missing-reference" | "not-found" | "invalid-archive" | "item-limit" | "byte-limit" | "token-limit";
export interface RetrievedCompressionSummary {
    blockId: string;
    topic: string;
    summaryText: string;
    byteSize: number;
    estimatedTokens: number;
}
export interface CompressionSummaryRetrieval {
    items: RetrievedCompressionSummary[];
    omitted: Array<{
        blockId: string;
        reason: SummaryOmissionReason;
    }>;
    totalBytes: number;
    estimatedTokens: number;
}
/** Integrity-frame the complete retrieval result so modified re-feeds fail closed. */
export declare function buildRetrievalToolOutput(items: Array<{
    blockId: string;
    topic: string;
    summaryText: string;
}>, omitted: Array<{
    blockId: string;
    reason: string;
}>): string;
/** Verify the complete retrieval output and return its exact block membership. */
export declare function parseRetrievalToolOutput(output: string): {
    blockIds: string[];
} | undefined;
export declare const RETRIEVAL_PLACEHOLDER = "[Archived summary retrieval expired or released. Use ctx_archive_search and ctx_archive_retrieve to load it again.]";
/** Redact retrieval results whose complete lease group is no longer active. */
export declare function redactInactiveArchiveRetrievals(entries: HostMessageEntry[], state: CoreState): HostMessageEntry[];
export declare function retrieveCompressionSummaries(store: ContentStore, sessionId: string, blocks: readonly BlockMetadata[], limits: {
    maxItems: number;
    maxBytes: number;
    maxTokens: number;
    tokenizer?: Tokenizer;
}): Promise<CompressionSummaryRetrieval>;
//# sourceMappingURL=compression-archive.d.ts.map