// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Coalesce background directory scans; this scheduler never deletes content itself.

export class OffloadCleanupScheduler {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly attemptedAt = new Map<string, number>();

  constructor(
    private readonly intervalMs = 10 * 60 * 1000,
    private readonly maxRemembered = 512,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error("Invalid cleanup interval");
    if (!Number.isSafeInteger(maxRemembered) || maxRemembered < 1) throw new Error("Invalid cleanup cache size");
  }

  request(directory: string, scan: () => Promise<void>): Promise<void> {
    const running = this.inFlight.get(directory);
    if (running) return running;
    const now = this.now();
    const previous = this.attemptedAt.get(directory);
    if (previous !== undefined && now - previous < this.intervalMs) return Promise.resolve();

    // Failed scans are throttled too; a filesystem error must not trigger a
    // new complete scan (and warning) on every assistant/tool-loop re-feed.
    this.attemptedAt.delete(directory);
    this.attemptedAt.set(directory, now);
    while (this.attemptedAt.size > this.maxRemembered) {
      this.attemptedAt.delete(this.attemptedAt.keys().next().value!);
    }
    const operation = Promise.resolve().then(scan).finally(() => {
      if (this.inFlight.get(directory) === operation) this.inFlight.delete(directory);
    });
    this.inFlight.set(directory, operation);
    return operation;
  }
}

export const offloadCleanupScheduler = new OffloadCleanupScheduler();
