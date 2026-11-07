// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Coalesce background directory scans; this scheduler never deletes content itself.
export class OffloadCleanupScheduler {
    intervalMs;
    maxRemembered;
    now;
    inFlight = new Map();
    attemptedAt = new Map();
    constructor(intervalMs = 10 * 60 * 1000, maxRemembered = 512, now = Date.now) {
        this.intervalMs = intervalMs;
        this.maxRemembered = maxRemembered;
        this.now = now;
        if (!Number.isSafeInteger(intervalMs) || intervalMs < 0)
            throw new Error("Invalid cleanup interval");
        if (!Number.isSafeInteger(maxRemembered) || maxRemembered < 1)
            throw new Error("Invalid cleanup cache size");
    }
    request(directory, scan) {
        const running = this.inFlight.get(directory);
        if (running)
            return running;
        const now = this.now();
        const previous = this.attemptedAt.get(directory);
        if (previous !== undefined && now - previous < this.intervalMs)
            return Promise.resolve();
        // Failed scans are throttled too; a filesystem error must not trigger a
        // new complete scan (and warning) on every assistant/tool-loop re-feed.
        this.attemptedAt.delete(directory);
        this.attemptedAt.set(directory, now);
        while (this.attemptedAt.size > this.maxRemembered) {
            this.attemptedAt.delete(this.attemptedAt.keys().next().value);
        }
        const operation = Promise.resolve().then(scan).finally(() => {
            if (this.inFlight.get(directory) === operation)
                this.inFlight.delete(directory);
        });
        this.inFlight.set(directory, operation);
        return operation;
    }
}
export const offloadCleanupScheduler = new OffloadCleanupScheduler();
//# sourceMappingURL=offload-cleanup.js.map