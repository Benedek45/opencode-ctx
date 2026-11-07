export declare class OffloadCleanupScheduler {
    private readonly intervalMs;
    private readonly maxRemembered;
    private readonly now;
    private readonly inFlight;
    private readonly attemptedAt;
    constructor(intervalMs?: number, maxRemembered?: number, now?: () => number);
    request(directory: string, scan: () => Promise<void>): Promise<void>;
}
export declare const offloadCleanupScheduler: OffloadCleanupScheduler;
//# sourceMappingURL=offload-cleanup.d.ts.map