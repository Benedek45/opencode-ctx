// PolyForm Noncommercial License 1.0.0 — see LICENSE
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

interface Job {
  controller: AbortController;
  completion: Promise<boolean>;
  key?: string;
}
interface Cooldown { sessionID: string; lastStarted: number }
interface Scope { jobs: Map<string, Job>; cooldowns: Map<string, Cooldown> }
const registryKey = Symbol.for("opencode.context-manager.proactive-compression.v1");
const registryHost = globalThis as typeof globalThis & { [registryKey]?: Map<string, Scope> };
const registry = registryHost[registryKey] ??= new Map<string, Scope>();
const MAX_COOLDOWNS = 128;

/** Stop waiting on a coordinator queue, but guard its eventual callback as well. */
function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const cancel = () => finish(() => resolve(undefined));
    let done = false;
    function finish(action: () => void) {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", cancel);
      action();
    }
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    pending.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

/** Idle-only orchestration; no timers launch work, no retries, no core mutations. */
export class ProactiveCompressionScheduler<S extends ProactiveCompressionSnapshot = ProactiveCompressionSnapshot> {
  private readonly scope: Scope;
  private readonly owned = new Map<string, Job>();
  private readonly now: () => number;
  private readonly maxSourceTokens: number;
  private readonly cleanupTimeoutMs: number;
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(private readonly options: ProactiveCompressionSchedulerOptions<S>) {
    for (const value of [options.minIntervalMs, options.maxSourceTokens ?? 16_000, options.cleanupTimeoutMs ?? 20_000]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Scheduler limits must be non-negative safe integers");
    }
    if ((options.maxSourceTokens ?? 16_000) === 0 || (options.cleanupTimeoutMs ?? 20_000) === 0) {
      throw new Error("Source and cleanup limits must be positive");
    }
    this.now = options.now ?? Date.now;
    this.maxSourceTokens = options.maxSourceTokens ?? 16_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 20_000;
    if (options.namespace !== undefined) {
      if (!options.namespace.trim()) throw new Error("Namespace must be non-empty");
      let scope = registry.get(options.namespace);
      if (!scope) registry.set(options.namespace, scope = { jobs: new Map(), cooldowns: new Map() });
      this.scope = scope;
    } else {
      this.scope = { jobs: new Map(), cooldowns: new Map() };
    }
  }

  /** True only after a successful commit. Duplicate hooks share the same promise. */
  start(sessionID: string): Promise<boolean> {
    if (this.disposed || !sessionID) return Promise.resolve(false);
    const existing = this.scope.jobs.get(sessionID);
    if (existing) return existing.completion;
    // Namespace concurrency is deliberately drop-on-busy, never a child queue.
    if (this.scope.jobs.size) return Promise.resolve(false);
    const now = this.now();
    for (const cooldown of this.scope.cooldowns.values()) {
      if (cooldown.sessionID === sessionID && now - cooldown.lastStarted < this.options.minIntervalMs) return Promise.resolve(false);
    }
    const job: Job = { controller: new AbortController(), completion: Promise.resolve(false) };
    this.scope.jobs.set(sessionID, job);
    this.owned.set(sessionID, job);
    job.completion = Promise.resolve().then(() => this.execute(sessionID, job)).catch(error => {
      this.diagnostic("failed", error instanceof Error ? error.message : "Proactive compression failed", sessionID);
      return false;
    }).finally(() => {
      if (this.scope.jobs.get(sessionID) === job) this.scope.jobs.delete(sessionID);
      if (this.owned.get(sessionID) === job) this.owned.delete(sessionID);
    });
    return job.completion;
  }

  /** Only this scheduler's jobs can be cancelled; another factory owns its work. */
  cancel(sessionID: string): void { this.owned.get(sessionID)?.controller.abort(); }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const jobs = [...this.owned.values()];
    for (const job of jobs) job.controller.abort();
    this.disposal = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.diagnostic("cleanup-timeout", "Owned tasks did not settle within disposal grace; active namespace reservations remain until settlement");
        resolve();
      }, this.cleanupTimeoutMs);
      Promise.all(jobs.map(job => job.completion)).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.disposal;
  }

  private async execute(sessionID: string, job: Job): Promise<boolean> {
    const signal = job.controller.signal;
    if (signal.aborted) return false;
    const snapshot = await untilAbort(this.options.runExclusive(sessionID, async () => {
      if (signal.aborted) return null;
      const candidate = await this.options.capture(sessionID, this.maxSourceTokens);
      if (signal.aborted || candidate === null) return null;
      // Parent captures bounded source only. Clone under lock, before networking:
      // later host mutations cannot change this job's source or identity fields.
      return structuredClone(candidate);
    }), signal);
    if (!snapshot || signal.aborted) return false;
    if (!snapshot.key || !snapshot.source.length) return false;
    const now = this.now();
    const key = JSON.stringify([sessionID, snapshot.key]);
    const previous = this.scope.cooldowns.get(key);
    if (previous && now - previous.lastStarted < this.options.minIntervalMs) return false;
    job.key = key;
    this.scope.cooldowns.delete(key);
    this.scope.cooldowns.set(key, { sessionID, lastStarted: now });
    // At most 128 candidate identities per namespace, never source payloads.
    // Old identities for the same session are inactive too; protect only the
    // exact current job, not all candidates ever attempted for its parent.
    for (const [oldKey, cooldown] of this.scope.cooldowns) {
      if (this.scope.cooldowns.size <= MAX_COOLDOWNS) break;
      if (this.scope.jobs.get(cooldown.sessionID)?.key !== oldKey) this.scope.cooldowns.delete(oldKey);
    }
    // Await transport settlement even on abort: settlement includes child cleanup.
    const summary = await this.options.summarize(snapshot, signal);
    if (signal.aborted || summary === null || !summary.trim()) return false;
    const committed = await untilAbort(this.options.runExclusive(sessionID, async () => {
      if (signal.aborted) return false;
      return this.options.commit(sessionID, snapshot, summary, signal);
    }), signal);
    return committed === true;
  }

  private diagnostic(code: ProactiveCompressionDiagnostic["code"], detail: string, sessionID?: string): void {
    try { this.options.onDiagnostic?.({ code, detail, sessionID }); } catch { /* hook reporting must never reject */ }
  }
}
