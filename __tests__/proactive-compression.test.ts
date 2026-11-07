import { describe, expect, test } from "bun:test";
import { ProactiveCompressionScheduler, type ProactiveCompressionSnapshot, type ProactiveCompressionSchedulerOptions } from "../adapters/opencode/proactive-compression.js";
import { SessionCoordinator } from "../adapters/opencode/session-coordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(key = "source/model/owner-1"): ProactiveCompressionSnapshot {
  return { key, startRef: "m1", endRef: "m1", topic: "Decisions", source: [{
    id: "m1", sessionId: "parent", role: "user", createdAt: 0,
    parts: [{ type: "text", text: "Exact source [DATA NEEDED: measurement]" }],
  }] };
}
function setup(overrides: Partial<ProactiveCompressionSchedulerOptions<ProactiveCompressionSnapshot>> = {}) {
  const coordinator = new SessionCoordinator();
  const calls: string[] = [];
  const options: ProactiveCompressionSchedulerOptions<ProactiveCompressionSnapshot> = {
    runExclusive: (id, task) => coordinator.run(id, task),
    capture: async (_id, limit) => { calls.push(`capture:${limit}`); return snapshot(); },
    summarize: async () => { calls.push("summarize"); return "## Decisions\nExact summary"; },
    commit: async () => { calls.push("commit"); return true; },
    minIntervalMs: 100, now: () => 0, ...overrides,
  };
  return { scheduler: new ProactiveCompressionScheduler(options), coordinator, calls };
}

describe("proactive compression scheduler (mocked)", () => {
  test("captures and commits under lock, releases it throughout transport, clones exact bounded source", async () => {
    const candidate = snapshot();
    const entered = deferred<void>();
    const result = deferred<string | null>();
    const events: string[] = [];
    let held = false;
    const scheduler = new ProactiveCompressionScheduler({
      runExclusive: async <T>(_id: string, task: () => Promise<T>) => {
        expect(held).toBe(false); held = true;
        try { return await task(); } finally { held = false; }
      },
      capture: async (_id, limit) => { expect(held).toBe(true); expect(limit).toBe(16_000); return candidate; },
      summarize: async (captured, signal) => {
        expect(held).toBe(false); expect(signal.aborted).toBe(false);
        expect(captured).not.toBe(candidate);
        entered.resolve();
        const summary = await result.promise;
        expect(captured.source[0]!.parts[0]).toEqual({ type: "text", text: "Exact source [DATA NEEDED: measurement]" });
        return summary;
      },
      commit: async (_id, captured, summary) => {
        expect(held).toBe(true); expect(captured.key).toBe("source/model/owner-1");
        expect(summary).toBe("  ## Decisions\n" + "x".repeat(40_000) + "  ");
        events.push("commit"); return true;
      }, minIntervalMs: 100,
    });
    const pending = scheduler.start("parent");
    await entered.promise;
    candidate.key = "mutated"; candidate.source[0]!.parts = [];
    result.resolve("  ## Decisions\n" + "x".repeat(40_000) + "  ");
    expect(await pending).toBe(true); expect(events).toEqual(["commit"]);
    await scheduler.dispose();
  });

  test("duplicate idle hooks synchronously share one job", async () => {
    const entered = deferred<void>(); const result = deferred<string | null>(); let networks = 0;
    const { scheduler } = setup({ summarize: async () => { networks++; entered.resolve(); return result.promise; } });
    const first = scheduler.start("parent"); const second = scheduler.start("parent");
    expect(first).toBe(second); await entered.promise; expect(networks).toBe(1);
    result.resolve("summary"); expect(await first).toBe(true); await scheduler.dispose();
  });

  test("failed, null, empty, and stale results never publish", async () => {
    for (const outcome of ["throw", "null", "empty", "stale"]) {
      let commits = 0; let diagnostics = 0;
      const { scheduler } = setup({
        summarize: async () => { if (outcome === "throw") throw new Error("timeout"); return outcome === "null" ? null : outcome === "empty" ? " \n" : "summary"; },
        commit: async () => { commits++; return false; },
        onDiagnostic: () => { diagnostics++; throw new Error("logger failure"); },
      });
      expect(await scheduler.start("parent")).toBe(false);
      expect(commits).toBe(outcome === "stale" ? 1 : 0);
      expect(diagnostics).toBe(outcome === "throw" ? 1 : 0);
      await scheduler.dispose();
    }
  });

  test("cancel while capture is queued skips capture and network, without waiting for queue", async () => {
    const { scheduler, coordinator, calls } = setup();
    const entered = deferred<void>(); const release = deferred<void>();
    const blocker = coordinator.run("parent", async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const job = scheduler.start("parent"); await Promise.resolve();
    scheduler.cancel("parent"); expect(await job).toBe(false);
    await scheduler.dispose(); expect(calls).toEqual([]);
    release.resolve(); await blocker;
    await coordinator.run("parent", async () => {}); expect(calls).toEqual([]);
  });

  test("cancel during capture skips network after capture settles", async () => {
    const entered = deferred<void>(); const captured = deferred<ProactiveCompressionSnapshot | null>();
    const { scheduler, coordinator, calls } = setup({ capture: async () => { entered.resolve(); return captured.promise; } });
    const job = scheduler.start("parent"); await entered.promise; scheduler.cancel("parent");
    expect(await job).toBe(false); captured.resolve(snapshot());
    await coordinator.run("parent", async () => {}); expect(calls).toEqual([]); await scheduler.dispose();
  });

  test("cancel while commit is queued prevents its callback from mutating", async () => {
    const entered = deferred<void>(); const result = deferred<string | null>();
    const { scheduler, coordinator, calls } = setup({ summarize: async () => { entered.resolve(); return result.promise; } });
    const job = scheduler.start("parent"); await entered.promise;
    const locked = deferred<void>(); const release = deferred<void>();
    const blocker = coordinator.run("parent", async () => { locked.resolve(); await release.promise; });
    await locked.promise; result.resolve("summary");
    await Promise.resolve(); await Promise.resolve();
    scheduler.cancel("parent"); expect(await job).toBe(false);
    release.resolve(); await blocker; await coordinator.run("parent", async () => {});
    expect(calls).toEqual(["capture:16000"]); await scheduler.dispose();
  });

  test("cooldown includes unsuccessful attempts; changed candidates run after interval", async () => {
    let clock = 0; let key = "one"; let networks = 0;
    const { scheduler } = setup({ now: () => clock, capture: async () => snapshot(key), summarize: async () => { networks++; return null; } });
    expect(await scheduler.start("parent")).toBe(false);
    clock = 99; expect(await scheduler.start("parent")).toBe(false); expect(networks).toBe(1);
    key = "two"; expect(await scheduler.start("parent")).toBe(false); expect(networks).toBe(1);
    clock = 100; expect(await scheduler.start("parent")).toBe(false); expect(networks).toBe(2);
    await scheduler.dispose();
  });

  test("null capture and capture errors retain context and never call network", async () => {
    for (const fail of [false, true]) {
      const { scheduler, calls } = setup({ capture: async () => { if (fail) throw new Error("capture failed"); return null; } });
      expect(await scheduler.start("parent")).toBe(false); expect(calls).toEqual([]); await scheduler.dispose();
    }
  });

  test("cancelling immediately prevents even coordinator capture", async () => {
    const { scheduler, calls } = setup();
    const pending = scheduler.start("parent"); scheduler.cancel("parent");
    expect(await pending).toBe(false); expect(calls).toEqual([]); await scheduler.dispose();
  });

  test("commit errors are diagnosed and resolve false", async () => {
    const diagnostics: string[] = [];
    const { scheduler } = setup({ commit: async () => { throw new Error("durable commit rejected"); }, onDiagnostic: item => { diagnostics.push(item.detail); } });
    expect(await scheduler.start("parent")).toBe(false);
    expect(diagnostics).toEqual(["durable commit rejected"]); await scheduler.dispose();
  });

  test("namespace cooldown survives factory replacement; same key can retry after interval", async () => {
    let clock = 0; const namespace = `test-${crypto.randomUUID()}`;
    const first = setup({ namespace, now: () => clock });
    expect(await first.scheduler.start("parent")).toBe(true); await first.scheduler.dispose();
    const second = setup({ namespace, now: () => clock });
    expect(await second.scheduler.start("parent")).toBe(false); expect(second.calls).toEqual([]);
    clock = 100; expect(await second.scheduler.start("parent")).toBe(true); await second.scheduler.dispose();
  });

  test("different namespaces admit independent transport jobs", async () => {
    const entered = deferred<void>(); const result = deferred<string | null>();
    const first = setup({ namespace: `test-${crypto.randomUUID()}`, summarize: async () => { entered.resolve(); return result.promise; } });
    const second = setup({ namespace: `test-${crypto.randomUUID()}` });
    const pending = first.scheduler.start("parent"); await entered.promise;
    expect(await second.scheduler.start("parent")).toBe(true);
    result.resolve("summary"); expect(await pending).toBe(true);
    await first.scheduler.dispose(); await second.scheduler.dispose();
  });

  test("cooldown cache evicts oldest inactive identities at its 128-entry bound", async () => {
    const { scheduler } = setup({ namespace: `test-${crypto.randomUUID()}` });
    expect(await scheduler.start("oldest")).toBe(true);
    for (let index = 0; index < 128; index++) expect(await scheduler.start(`parent-${index}`)).toBe(true);
    // The clock has not advanced: a retained identity is still throttled,
    // while the oldest identity was evicted and can be captured again.
    expect(await scheduler.start("parent-127")).toBe(false);
    expect(await scheduler.start("oldest")).toBe(true); await scheduler.dispose();
  });

  test("source limits are passed intact and invalid limits are rejected", async () => {
    const { scheduler, calls } = setup({ maxSourceTokens: 42 });
    expect(await scheduler.start("parent")).toBe(true); expect(calls[0]).toBe("capture:42"); await scheduler.dispose();
    for (const options of [{ minIntervalMs: -1 }, { maxSourceTokens: 0 }, { cleanupTimeoutMs: 0 }, { namespace: " " }]) {
      expect(() => setup(options)).toThrow();
    }
  });

  test("namespace shares in-flight dedup and one child across sessions/factories; cancellation is owner-only", async () => {
    const namespace = `test-${crypto.randomUUID()}`;
    const entered = deferred<void>(); const cleanup = deferred<string | null>(); let signal!: AbortSignal;
    const first = setup({ namespace, summarize: async (_snapshot, callerSignal) => { signal = callerSignal; entered.resolve(); return cleanup.promise; } });
    const second = setup({ namespace });
    const pending = first.scheduler.start("parent");
    expect(second.scheduler.start("parent")).toBe(pending);
    expect(await second.scheduler.start("other")).toBe(false);
    await entered.promise; second.scheduler.cancel("parent"); await second.scheduler.dispose();
    expect(signal.aborted).toBe(false); cleanup.resolve("summary"); expect(await pending).toBe(true);
    expect(second.calls).toEqual([]); await first.scheduler.dispose();
  });

  test("dispose aborts and awaits owned transport cleanup, is idempotent and rejects later starts", async () => {
    const entered = deferred<void>(); const cleanup = deferred<string | null>(); let signal!: AbortSignal;
    const { scheduler, calls } = setup({ summarize: async (_snapshot, callerSignal) => { signal = callerSignal; entered.resolve(); return cleanup.promise; } });
    const job = scheduler.start("parent"); await entered.promise;
    let disposed = false; const closing = scheduler.dispose(); closing.then(() => { disposed = true; });
    expect(scheduler.dispose()).toBe(closing); expect(signal.aborted).toBe(true);
    await Promise.resolve(); expect(disposed).toBe(false); expect(await scheduler.start("other")).toBe(false);
    cleanup.resolve("late summary"); await closing; expect(await job).toBe(false);
    expect(calls).toEqual(["capture:16000"]);
  });

  test("bounded disposal reports non-cooperative transport and keeps reservation until late settlement", async () => {
    const namespace = `test-${crypto.randomUUID()}`; const entered = deferred<void>(); const late = deferred<string | null>();
    const diagnostics: string[] = [];
    const first = setup({ namespace, cleanupTimeoutMs: 5, summarize: async () => { entered.resolve(); return late.promise; }, onDiagnostic: item => { diagnostics.push(item.code); } });
    const second = setup({ namespace }); const job = first.scheduler.start("parent"); await entered.promise;
    await first.scheduler.dispose(); expect(diagnostics).toEqual(["cleanup-timeout"]);
    expect(await second.scheduler.start("other")).toBe(false);
    late.reject(new Error("late failure")); expect(await job).toBe(false);
    expect(await second.scheduler.start("other")).toBe(true); await second.scheduler.dispose();
  });
});
