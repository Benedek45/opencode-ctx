import type { ContentStore, ContentRecord, ContentWriteRequest, ContentSearchQuery, ContentSearchResults, ContentMetadata, ContentStoreSnapshot, ContentWriteResult } from "../../services/contentStore.js";
import type { HostMessageEntry } from "./host-types.js";
export interface SessionHistorySnapshot {
    version: 1;
    sessionId: string;
    rawEntries: HostMessageEntry[];
    projectedEntries: HostMessageEntry[];
    updatedAt: number;
    /** Composite persisted-state generation; absent on legacy snapshots. */
    stateVersion?: string;
    /** Optional exact dashboard metrics from the writer; unknown counts stay absent. */
    summary?: {
        revision?: number;
        tokenCount?: number;
        workspace?: string;
    };
}
export interface SessionHistorySummary {
    sessionId: string;
    updatedAt: number;
    title?: string;
    revision?: number;
    messageCount: number;
    tokenCount?: number;
    /** Exact assistant cwd only when every assistant agrees; no worktree inference. */
    workspace?: string;
}
export declare class FilesystemContentStore implements ContentStore {
    private readonly storageDir;
    private readonly blobsDir;
    private readonly indexFile;
    private readonly snapshotsDir;
    private readonly shared;
    constructor(storageDir: string);
    /**
     * Ensure directory structure exists.
     * Call once before any read/write operations.
     */
    ensureDir(): Promise<void>;
    private loadIndex;
    private isPending;
    private writePendingMarker;
    /**
     * Called only by writers about to (re)publish `id`. A marker left by a killed
     * writer would otherwise block that ID forever (and fail every batch that
     * contains it). A marker is stale when its recorded PID is dead or it is older
     * than PENDING_STALE_MS; legacy markers without a PID rely on age alone. Live
     * markers still reject. Reads keep treating any marker as unpublished.
     */
    private reclaimStalePending;
    private indexFileStamp;
    private readDiskIndex;
    private acquireIndexLock;
    private saveIndex;
    private rebuildIndex;
    /** Force a full rescan from blob files. Useful after external changes. */
    rescan(): Promise<void>;
    write(request: ContentWriteRequest): Promise<ContentRecord>;
    writeWithStatus(request: ContentWriteRequest): Promise<ContentWriteResult>;
    private writeWithStatusExclusive;
    /**
     * Batched immutable write. Each new blob is published exactly like
     * {@link writeWithStatus} (pending marker → atomic blob rename), but the
     * shared index — which spans every session and can be tens of MB — is
     * serialized ONCE for the batch instead of once per blob. Rewriting it per
     * blob made archiving a long re-fed history quadratic (minutes per turn).
     * Indexed records are skipped without reading their blobs; intact unindexed
     * blobs are adopted into the same publication without being overwritten. If the single
     * index publication fails, every blob created by this batch is removed and
     * the shared index reverted, matching the single-write rollback contract.
     */
    writeMany(requests: ReadonlyArray<ContentWriteRequest>): Promise<Array<{
        id: string;
        created: boolean;
    }>>;
    private writeManyExclusive;
    get(id: string): Promise<ContentRecord | undefined>;
    private getExclusive;
    delete(id: string): Promise<boolean>;
    private deleteExclusive;
    list(filter?: Partial<ContentMetadata>): Promise<ContentRecord[]>;
    search(query: ContentSearchQuery): Promise<ContentSearchResults>;
    clear(): Promise<void>;
    private clearExclusive;
    size(): Promise<number>;
    private readBlob;
    /**
     * Remove all records whose id is NOT in the active set.
     * Returns the number of records removed.
     */
    deleteUnreferenced(activeIds: Set<string>): Promise<number>;
    /**
     * Return a serializable snapshot of all content records.
     * The dashboard uses this for the "raw" history view.
     */
    historySnapshot(): Promise<ContentStoreSnapshot>;
    /** Atomically replace the latest raw/projected view for one session. */
    saveSessionHistory(snapshot: SessionHistorySnapshot): Promise<void>;
    private saveSessionHistoryExclusive;
    loadSessionHistory(sessionId: string): Promise<SessionHistorySnapshot | undefined>;
    listSessionHistories(resolveLegacyRevision?: (sessionId: string) => Promise<number>): Promise<SessionHistorySummary[]>;
    private listSessionHistoriesExclusive;
    private isSessionSnapshotPath;
    private saveHistoryMetadata;
    private sessionSnapshotPath;
    private legacySessionSnapshotPath;
    /**
     * Save a full snapshot to a JSON file.
     * Useful for dashboard export or debugging.
     */
    saveSnapshot(filePath: string): Promise<void>;
    /**
     * Load a snapshot from a JSON file and merge into the current store.
     * Existing records are NOT overwritten (immutability).
     * Returns the number of new records added.
     */
    loadSnapshot(filePath: string): Promise<number>;
}
//# sourceMappingURL=content-store.d.ts.map