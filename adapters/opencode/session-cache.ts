// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Root-scoped, conservatively accounted resident session cache. No archive is GC'd.
import type { SessionCoordinator } from "./session-coordinator.js";

export interface SessionCacheOptions {
  maxBytes: number;
  maxSessions: number;
  idleTtlMs: number;
}

export const DEFAULT_SESSION_CACHE: Readonly<SessionCacheOptions> = {
  maxBytes: 256 * 1024 * 1024,
  maxSessions: 64,
  idleTtlMs: 15 * 60 * 1000,
};

interface Resident<T> { value: T; bytes: number; touched: number }

/** Approximate retained data without serializing complete histories per tool call. */
export function retainedBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): number => {
    if (typeof item === "string") return item.length * 2 + 24;
    if (typeof item !== "object" || item === null || seen.has(item)) return 8;
    seen.add(item);
    if (item instanceof Map) {
      let bytes = 64;
      for (const [key, entry] of item) bytes += visit(key) + visit(entry);
      return bytes;
    }
    if (item instanceof Set) {
      let bytes = 64;
      for (const entry of item) bytes += visit(entry);
      return bytes;
    }
    let bytes = 64;
    for (const [key, entry] of Object.entries(item)) bytes += key.length * 2 + 16 + visit(entry);
    return bytes;
  };
  return visit(value);
}

export class SessionCache<T> {
  readonly sessions = new Map<string, T>();
  private readonly resident = new Map<string, Resident<T>>();
  private readonly pins = new Map<string, number>();
  private readonly busy = new Set<string>();
  private readonly retired = new Map<string, object>();
  private readonly retries = new Map<string, { after: number; delay: number }>();
  private onQuiescent?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private limits: SessionCacheOptions;

  constructor(
    options: SessionCacheOptions,
    private readonly coordinator: SessionCoordinator,
    private readonly persist: (sessionId: string, value: T) => Promise<void>,
    private readonly canEvict: (sessionId: string) => Promise<boolean>,
    private readonly onEvict: (sessionId: string) => void,
    private readonly report: (error: unknown) => void,
  ) {
    this.limits = { ...options };
    this.armTimer();
  }

  private armTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.sweep().catch(this.report); },
      Math.max(1_000, Math.min(this.limits.idleTtlMs, 60_000)));
    this.timer.unref?.();
  }

  // A shared root uses the strictest limits, irrespective of factory registration order.
  constrain(options: SessionCacheOptions): void {
    const previousTtl = this.limits.idleTtlMs;
    this.limits = {
      maxBytes: Math.min(this.limits.maxBytes, options.maxBytes),
      maxSessions: Math.min(this.limits.maxSessions, options.maxSessions),
      idleTtlMs: Math.min(this.limits.idleTtlMs, options.idleTtlMs),
    };
    if (previousTtl !== this.limits.idleTtlMs) this.armTimer();
    void this.sweep().catch(this.report);
  }

  set(sessionId: string, value: T): void {
    this.sessions.set(sessionId, value);
    this.refresh(sessionId);
  }

  refresh(sessionId: string): void {
    const value = this.sessions.get(sessionId);
    if (value === undefined) return;
    this.resident.set(sessionId, { value, bytes: retainedBytes(value), touched: Date.now() });
    void this.sweep().catch(this.report);
  }

  touch(sessionId: string): void {
    const entry = this.resident.get(sessionId);
    if (entry) entry.touched = Date.now();
  }

  /** Acquire before entering the coordinator, so queued work cannot lose its state. */
  async run<R>(sessionId: string, task: () => Promise<R>): Promise<R> {
    this.pins.set(sessionId, (this.pins.get(sessionId) ?? 0) + 1);
    try {
      return await this.coordinator.run(sessionId, async () => {
        this.touch(sessionId);
        try { return await task(); }
        finally { this.touch(sessionId); }
      });
    } finally {
      const remaining = (this.pins.get(sessionId) ?? 1) - 1;
      if (remaining) this.pins.set(sessionId, remaining);
      else this.pins.delete(sessionId);
      void this.sweep().catch(this.report);
    }
  }

  status(sessionId: string, status: "busy" | "retry" | "idle"): void {
    if (!this.resident.has(sessionId)) return;
    if (status === "idle") this.busy.delete(sessionId);
    else this.busy.add(sessionId);
    if (status === "idle") void this.sweep().catch(this.report);
  }

  /** Host scope has closed: checkpoint without calling that scope's SDK status. */
  async retire(sessionIds: Iterable<string>): Promise<void> {
    for (const id of sessionIds) {
      if (this.resident.has(id)) {
        this.retired.set(id, {});
        this.busy.delete(id); // disposal, unlike an idle guess, closes the stream scope
      }
    }
    // A prior sweep may have started before the retirement flags were set.
    await this.sweep();
    await this.sweep();
  }

  cancelRetirement(sessionId: string): void {
    this.retired.delete(sessionId);
    this.retries.delete(sessionId);
  }

  setOnQuiescent(listener: () => void): void { this.onQuiescent = listener; }

  async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepExclusive(now).finally(() => {
      this.sweeping = undefined;
      if (this.resident.size === 0 && this.pins.size === 0) this.onQuiescent?.();
    });
    return this.sweeping;
  }

  private async sweepExclusive(now: number): Promise<void> {
    let total = [...this.resident.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [id, entry] of [...this.resident].sort((a, b) => a[1].touched - b[1].touched)) {
      const retirement = this.retired.get(id);
      if (!retirement && now - entry.touched < this.limits.idleTtlMs
        && this.resident.size <= this.limits.maxSessions && total <= this.limits.maxBytes) continue;
      if (this.pins.has(id) || this.coordinator.isActive(id)) continue;
      if ((this.retries.get(id)?.after ?? 0) > now) continue;
      // Failure (including unknown host status) leaves the entire item resident.
      try {
        if (!retirement && !await this.canEvict(id)) continue;
        if (this.retired.get(id) !== retirement) continue;
        if (this.pins.has(id) || this.coordinator.isActive(id) || (!retirement && this.busy.has(id))) continue;
        const removed = await this.coordinator.run(id, async () => {
          if (this.retired.get(id) !== retirement || this.pins.has(id)
            || (!retirement && this.busy.has(id)) || this.sessions.get(id) !== entry.value) return false;
          await this.persist(id, entry.value);
          if (this.retired.get(id) !== retirement || this.pins.has(id)
            || (!retirement && this.busy.has(id)) || this.sessions.get(id) !== entry.value) return false;
          this.sessions.delete(id);
          this.resident.delete(id);
          this.retired.delete(id);
          this.busy.delete(id);
          this.retries.delete(id);
          this.onEvict(id);
          return true;
        });
        if (removed) total -= entry.bytes;
      } catch (error) {
        const delay = Math.min((this.retries.get(id)?.delay ?? 500) * 2, 60_000);
        this.retries.set(id, { after: now + delay, delay });
        this.report(error);
      }
    }
  }

  /** Tests/host shutdown only; does not discard resident sessions. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stats(): { sessions: number; accountedBytes: number; pinned: number } {
    return { sessions: this.resident.size, accountedBytes: [...this.resident.values()].reduce((n, v) => n + v.bytes, 0), pinned: this.pins.size + this.busy.size };
  }
}
