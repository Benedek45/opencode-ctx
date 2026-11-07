import type { SessionCoordinator } from "./session-coordinator.js";
export interface SessionCacheOptions {
    maxBytes: number;
    maxSessions: number;
    idleTtlMs: number;
}
export declare const DEFAULT_SESSION_CACHE: Readonly<SessionCacheOptions>;
/** Approximate retained data without serializing complete histories per tool call. */
export declare function retainedBytes(value: unknown): number;
export declare class SessionCache<T> {
    private readonly coordinator;
    private readonly persist;
    private readonly canEvict;
    private readonly onEvict;
    private readonly report;
    readonly sessions: Map<string, T>;
    private readonly resident;
    private readonly pins;
    private readonly busy;
    private readonly retired;
    private readonly retries;
    private onQuiescent?;
    private timer?;
    private sweeping?;
    private limits;
    constructor(options: SessionCacheOptions, coordinator: SessionCoordinator, persist: (sessionId: string, value: T) => Promise<void>, canEvict: (sessionId: string) => Promise<boolean>, onEvict: (sessionId: string) => void, report: (error: unknown) => void);
    private armTimer;
    constrain(options: SessionCacheOptions): void;
    set(sessionId: string, value: T): void;
    refresh(sessionId: string): void;
    touch(sessionId: string): void;
    /** Acquire before entering the coordinator, so queued work cannot lose its state. */
    run<R>(sessionId: string, task: () => Promise<R>): Promise<R>;
    status(sessionId: string, status: "busy" | "retry" | "idle"): void;
    /** Host scope has closed: checkpoint without calling that scope's SDK status. */
    retire(sessionIds: Iterable<string>): Promise<void>;
    cancelRetirement(sessionId: string): void;
    setOnQuiescent(listener: () => void): void;
    sweep(now?: number): Promise<void>;
    private sweepExclusive;
    /** Tests/host shutdown only; does not discard resident sessions. */
    close(): void;
    stats(): {
        sessions: number;
        accountedBytes: number;
        pinned: number;
    };
}
//# sourceMappingURL=session-cache.d.ts.map