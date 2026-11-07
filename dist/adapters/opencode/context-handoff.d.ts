import type { ContentStore } from "../../services/contentStore.js";
import type { Persistence } from "../../services/persistence.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { CoreConfig } from "../../types/config.js";
import { type CoreState } from "../../types/state.js";
import type { HostMessageEntry } from "./host-types.js";
import { type PortableBundle } from "./portable-context.js";
export declare const IMPORTED_ENTRY_PREFIX = "__ctx_import_";
export interface HandoffSnapshot {
    state: CoreState;
    /** Nudge-free projection with tiers rendered in full, rather than as a catalog. */
    projectedEntries: HostMessageEntry[];
    /** Same projection before root-summary overrides, retaining invisible root positions. */
    orderingEntries?: HostMessageEntry[];
    importedSeed?: ImportedSeed;
}
export interface CollectHandoffOptions {
    /** Exact projected host message IDs to emit as HOT records. Undefined means all. */
    messageIds?: ReadonlySet<string>;
    /** Exact active root block IDs to emit. Undefined means all active roots. */
    rootIds?: ReadonlySet<string>;
    /** Include and verify durable root sources. Defaults to true. */
    includeRecovery?: boolean;
}
export interface HandoffResourceReader {
    read(path: string, purpose?: "offload" | "attachment"): Promise<Uint8Array>;
}
/**
 * Read only a required local attachment/offload, never arbitrary URLs.
 * Concurrent filesystem writers are trusted; static symlinks and observed path
 * changes are rejected, but Node cannot pin every parent lookup without openat.
 */
export declare function localHandoffResourceReader(projectRoot: string, options?: {
    offloadRoots?: string[];
}): HandoffResourceReader;
/** Collect only the live projection and effective sources of active roots. */
export declare function collectHandoff(snapshot: HandoffSnapshot, store: ContentStore, resources: HandoffResourceReader, options?: CollectHandoffOptions): Promise<PortableBundle>;
export interface ImportedSeed {
    bundle: PortableBundle;
    entries: HostMessageEntry[];
    sourceEntries: Map<string, HostMessageEntry[]>;
    rootAnchors: Map<string, HostMessageEntry>;
    summaries: Map<string, string>;
    recordByMessageId: Map<string, string>;
}
/** Never merge an imported synthetic ID supplied by the host as a new raw source. */
export declare function composeRecoveryEntries(raw: HostMessageEntry[], seed?: ImportedSeed): HostMessageEntry[];
export declare function loadImportedSeed(state: CoreState, store: ContentStore, resourceRoot: string, options?: {
    readOnly?: boolean;
    messageIds?: ReadonlySet<string>;
    blockIds?: ReadonlySet<string>;
    includeRecovery?: boolean;
}): Promise<ImportedSeed | undefined>;
export interface ImportHandoffInput {
    bundle: PortableBundle;
    currentState: CoreState;
    hostEntries: HostMessageEntry[];
    /** Exact current command text if the host has already persisted it. */
    invocationText?: string;
    store: ContentStore;
    persistence: Persistence;
    tokenizer: Tokenizer;
    config: CoreConfig;
    resourceRoot: string;
    /** Pure candidate rebuild, with ordinary settings but without new pruning. */
    project(entries: HostMessageEntry[], state: CoreState): HostMessageEntry[];
    /** Count the finalized projection with system/framing reserve. */
    measure(entries: HostMessageEntry[], state: CoreState): number;
}
export interface ImportHandoffResult {
    state: CoreState;
    seed: ImportedSeed;
    projectedEntries: HostMessageEntry[];
    alreadyImported: boolean;
    unrecoverableRoots: string[];
}
export declare function assertNewHandoffSession(entries: HostMessageEntry[], invocationText?: string): void;
/** Caller holds the destination's session coordinator for validation through publish. */
export declare function importHandoff(input: ImportHandoffInput): Promise<ImportHandoffResult>;
//# sourceMappingURL=context-handoff.d.ts.map