import type { NeutralMessage } from "../../types/neutral.js";
/** Parent-owned identity must include source, model/config and owner generation. */
export interface ProactiveCompressionSnapshot {
    key: string;
    source: NeutralMessage[];
    startRef: string;
    endRef: string;
    topic: string;
}
export interface ProactiveCompressionDiagnostic {
    code: "failed" | "cleanup-timeout";
    sessionID?: string;
    detail: string;
}
export interface ProactiveCompressionSchedulerOptions<S extends ProactiveCompressionSnapshot> {
    runExclusive<T>(sessionID: string, task: () => Promise<T>): Promise<T>;
    /** Return a bounded, complete candidate; never truncate a selected source. */
    capture(sessionID: string, maxSourceTokens: number): Promise<S | null>;
    /** Must settle after abort, including bounded transport cleanup. */
    summarize(snapshot: S, signal: AbortSignal): Promise<string | null>;
    /** Revalidate exact source/config/user/owner and host idle status before mutation. */
    commit(sessionID: string, snapshot: S, summary: string, signal: AbortSignal): Promise<boolean>;
    minIntervalMs: number;
    now?: () => number;
    onDiagnostic?: (diagnostic: ProactiveCompressionDiagnostic) => void;
    /** Same storage root across factories: one active job, no pending job queue. */
    namespace?: string;
    maxSourceTokens?: number;
    /** Disposal grace only; transport owns its request/cleanup deadlines. */
    cleanupTimeoutMs?: number;
}
/** Idle-only orchestration; no timers launch work, no retries, no core mutations. */
export declare class ProactiveCompressionScheduler<S extends ProactiveCompressionSnapshot = ProactiveCompressionSnapshot> {
    private readonly options;
    private readonly scope;
    private readonly owned;
    private readonly now;
    private readonly maxSourceTokens;
    private readonly cleanupTimeoutMs;
    private disposed;
    private disposal?;
    constructor(options: ProactiveCompressionSchedulerOptions<S>);
    /** True only after a successful commit. Duplicate hooks share the same promise. */
    start(sessionID: string): Promise<boolean>;
    /** Only this scheduler's jobs can be cancelled; another factory owns its work. */
    cancel(sessionID: string): void;
    dispose(): Promise<void>;
    private execute;
    private diagnostic;
}
//# sourceMappingURL=proactive-compression.d.ts.map