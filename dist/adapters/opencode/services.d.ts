import type { Tokenizer } from "../../services/tokenizer.js";
import type { Clock } from "../../services/clock.js";
import type { Persistence } from "../../services/persistence.js";
import type { Logger } from "../../services/logger.js";
import type { CoreState } from "../../types/state.js";
import { WallClock } from "../../services/clock.js";
import { FilesystemContentStore } from "./content-store.js";
export declare class AnthropicTokenizer implements Tokenizer {
    private delegate;
    private initialized;
    private loaded;
    init(): Promise<void>;
    /**
     * The pipeline re-estimates the same history many times per turn (budget,
     * cascade ROI, nudges, hard caps, status suffix). With the char tokenizer that
     * is free; exact BPE over a long session took minutes per turn and stalled
     * Claude sessions entirely. Counts are memoized per exact string, bounded by
     * the total characters retained as keys (oldest entries evicted first).
     */
    private readonly memo;
    private memoChars;
    countTokens(text: string): number;
    get isAvailable(): boolean;
}
export type TokenizerMode = "auto" | "char" | "anthropic";
/** Build the selected tokenizer. Char mode is the fast provider-calibrated default. */
export declare function buildTokenizer(mode?: "char" | "anthropic"): Promise<Tokenizer>;
export { WallClock };
/**
 * File-based persistence: writes an atomic JSON sidecar per session.
 *
 * Storage path: <storageDir>/ctx/<sessionId>.json
 * Default storageDir: process.env.CONTEXT_MANAGER_STORAGE_DIR, or
 * <WORKSPACES_ROOT>/.context-manager so app/opencode share lifecycle cleanup.
 *
 * Atomic write: write to a temp file then rename (same directory, so rename is atomic
 * on POSIX; on Windows rename is also atomic for same-volume moves).
 *
 * CoreState contains Map and Set instances which are not JSON-serializable by default.
 * We serialize them as arrays and deserialize back.
 */
export declare class FilePersistence implements Persistence {
    private readonly storageDir;
    constructor(storageDir?: string);
    private sidecarPath;
    private legacySidecarPath;
    load(sessionId: string): Promise<CoreState | undefined>;
    save(sessionId: string, state: CoreState): Promise<void>;
}
export declare function resolveStorageDir(storageDir?: string): string;
/**
 * Append one log line to a size-capped file. Hosts that run plugins inside a
 * background service (OpenCode V2 desktop) discard plugin console output, so
 * without a file sink failures are invisible.
 */
export declare function appendLogLine(filePath: string | undefined, level: string, message: string, args: unknown[]): void;
/** Logger that prefixes all messages with [ctx-adapter]; info+ also go to `filePath`. */
export declare class AdapterLogger implements Logger {
    private readonly prefix;
    private readonly filePath;
    constructor(prefix?: string, filePath?: string);
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/** File sink shared by every context-manager logger for one storage root. */
export declare function ctxLogFile(storageRoot: string): string;
/** Build all services for the opencode adapter. */
export declare function buildServices(storageDir?: string, tokenizerMode?: TokenizerMode): Promise<{
    tokenizer: Tokenizer;
    tokenizerFor(providerId: string, modelId: string): Tokenizer;
    clock: Clock;
    persistence: Persistence;
    logger: Logger;
    contentStore: FilesystemContentStore;
    storageRoot: string;
}>;
/** Build a fresh initial state, loading from persistence if available. */
export declare function loadOrCreateState(sessionId: string, persistence: Persistence): Promise<CoreState>;
//# sourceMappingURL=services.d.ts.map