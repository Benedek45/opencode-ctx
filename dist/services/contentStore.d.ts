export interface ContentMetadata {
    sessionId: string;
    projectId?: string;
    source?: string;
    kind?: string;
    blockId?: string;
    callId?: string;
    label?: string;
}
export interface ContentRecord {
    id: string;
    data: string;
    metadata: ContentMetadata;
    createdAt: number;
    byteSize: number;
}
export interface ContentWriteRequest {
    data: string;
    metadata: ContentMetadata;
    /** Optional explicit ID. Derived from hash of content+metadata when omitted. */
    id?: string;
}
export interface ContentWriteResult {
    record: ContentRecord;
    created: boolean;
}
export interface ContentSearchQuery {
    text: string;
    filters?: Partial<ContentMetadata>;
    maxResults?: number;
    maxBytes?: number;
    snippetMaxChars?: number;
}
export interface ContentSearchSnippet {
    before: string;
    match: string;
    after: string;
}
export interface ContentSearchResultItem {
    record: ContentRecord;
    score: number;
    snippet?: ContentSearchSnippet;
}
export interface ContentSearchResults {
    items: ContentSearchResultItem[];
    totalMatches: number;
    truncatedResults: boolean;
    truncatedBytes: boolean;
    queryTimeMs: number;
}
export interface ContentStoreSnapshot {
    version: 1;
    records: ContentRecord[];
    exportedAt: number;
}
export interface ContentStore {
    write(request: ContentWriteRequest): Promise<ContentRecord>;
    writeWithStatus(request: ContentWriteRequest): Promise<ContentWriteResult>;
    /**
     * Optional batched write: same immutable semantics as `writeWithStatus` per
     * request, but implementations may publish their index once for the whole
     * batch. Returns, per request in order, the content ID and whether it was new.
     */
    writeMany?(requests: ReadonlyArray<ContentWriteRequest>): Promise<Array<{
        id: string;
        created: boolean;
    }>>;
    get(id: string): Promise<ContentRecord | undefined>;
    delete(id: string): Promise<boolean>;
    list(filter?: Partial<ContentMetadata>): Promise<ContentRecord[]>;
    search(query: ContentSearchQuery): Promise<ContentSearchResults>;
    clear(): Promise<void>;
    size(): Promise<number>;
}
/**
 * Stable 64-bit hash from DJB2 + FNV-1a mixing.
 * Deterministic across all JS runtimes. Returns a base-36 string.
 */
export declare function contentHash(data: string): string;
/** Derive a content ID from data + metadata. */
export declare function deriveContentId(data: string, metadata: ContentMetadata): string;
export declare class InMemoryContentStore implements ContentStore {
    private records;
    write(request: ContentWriteRequest): Promise<ContentRecord>;
    writeWithStatus(request: ContentWriteRequest): Promise<ContentWriteResult>;
    get(id: string): Promise<ContentRecord | undefined>;
    delete(id: string): Promise<boolean>;
    list(filter?: Partial<ContentMetadata>): Promise<ContentRecord[]>;
    search(query: ContentSearchQuery): Promise<ContentSearchResults>;
    clear(): Promise<void>;
    size(): Promise<number>;
    /** Return all records for snapshot export (no copy). */
    allRecords(): ContentRecord[];
}
/** Host-neutral UTF-8 byte length. */
export declare function utf8ByteLength(value: string): number;
//# sourceMappingURL=contentStore.d.ts.map