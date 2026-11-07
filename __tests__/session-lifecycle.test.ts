import { describe, expect, test } from "bun:test";
import { SessionCache } from "../adapters/opencode/session-cache.js";
import { SessionOwners } from "../adapters/opencode/session-owners.js";
import { REMOTE_CONTEXT_BRIDGE_KEY } from "../adapters/opencode/remote-context-bridge.js";
import { SessionCoordinator, sharedSessionCoordinator } from "../adapters/opencode/session-coordinator.js";
import { ControlService } from "../adapters/opencode/control-service.js";
import { validateSessionCache } from "../adapters/opencode/config.js";
import { buildCoreConfig } from "../adapters/opencode/config.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import { createInitialState } from "../types/state.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RevisionConflictError, type ControlPlaneBackend, type ControlSessionSnapshot } from "../adapters/opencode/control-server.js";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

async function disposeFixture(hooks: Record<string, unknown>, directory: string, root: string, sessionIds: string[]): Promise<void> {
  const event = hooks.event as (input: { event: { type: string; properties: { directory: string } } }) => Promise<void>;
  await event({ event: { type: "server.instance.disposed", properties: { directory } } });
  // A cache sweep may have queued a checkpoint before disposal. Wait for its
  // coordinator work before deleting the test-owned storage directory.
  for (const id of sessionIds) await sharedSessionCoordinator(root).run(id, async () => {});
}

describe("root session lifecycle", () => {
  test("strict cache options and stricter shared policy", () => {
    expect(validateSessionCache(undefined)).toEqual({ maxBytes: 268435456, maxSessions: 64, idleTtlMs: 900000 });
    for (const value of [{ maxSessions: 0 }, { maxBytes: "1024" }, { idleTtlMs: -1 }, { other: 1 }]) {
      expect(() => validateSessionCache(value)).toThrow();
    }
  });

  test("same-owner registration replaces stale SDK ports without letting an old token remove them", async () => {
    const owners = new SessionOwners();
    const ports = { realWorkspace: true, config: (id: string, limit: number, provider: string, model: string) =>
      buildCoreConfig(id, {}, limit, provider, model), tokenizer: () => new CharTokenizer() };
    const old = owners.register("/workspace/one", { ...ports, durable: false, status: async () => "unknown" as const });
    owners.claim("one", old);
    const replacement = owners.register("/workspace/one", { ...ports, durable: true, status: async () => "idle" as const });
    old();
    expect(owners.durable("one")).toBe(true);
    expect(await owners.status("one")).toBe("idle");
    replacement();
    expect(owners.get("one")).toBeUndefined();
    expect(await owners.status("one")).toBe("unknown");
  });

  test("retired non-durable owner preserves recovery metadata until a new durable owner claims it", async () => {
    const owners = new SessionOwners();
    const ports = { realWorkspace: true, config: (id: string, limit: number, provider: string, model: string) =>
      buildCoreConfig(id, {}, limit, provider, model), tokenizer: () => new CharTokenizer() };
    const old = owners.register("/workspace/one", { ...ports, durable: false, status: async () => "unknown" as const });
    owners.claim("chat", old);
    expect(owners.retire(old)).toEqual(["chat"]);
    old();
    expect(owners.durable("chat")).toBe(false);
    expect(owners.knownWorkspace("chat")).toBe("/workspace/one");
    expect(await owners.status("chat")).toBe("unknown");
    const reopened = owners.register("/workspace/one", { ...ports, durable: true, status: async () => "idle" as const });
    expect(reopened.reopened).toEqual(["chat"]);
    expect(owners.durable("chat")).toBe(true);
    reopened();
  });

  test("queued and executing operations pin; failed saves and busy streams retain state", async () => {
    const coordinator = new SessionCoordinator();
    let persistFails = true;
    let busy = false;
    const persisted: string[] = [];
    const cache = new SessionCache({ maxBytes: 1, maxSessions: 1, idleTtlMs: 1 }, coordinator,
      async id => { if (persistFails) throw new Error("disk unavailable"); persisted.push(id); },
      async () => !busy, () => {}, () => {});
    try {
      cache.set("one", { history: "a" });
      cache.set("two", { history: "b" });
      const first = gate();
      const second = gate();
      const executing = cache.run("one", () => first.wait);
      const queued = cache.run("one", () => second.wait);
      await cache.sweep(Date.now() + 100);
      expect(cache.sessions.has("one")).toBe(true);
      first.release();
      await executing;
      await cache.sweep(Date.now() + 100);
      expect(cache.sessions.has("one")).toBe(true);
      second.release();
      await queued;
      await cache.sweep(Date.now() + 100);
      expect(cache.sessions.has("one")).toBe(true);
      persistFails = false;
      busy = true;
      await cache.sweep(Date.now() + 2000);
      expect(cache.sessions.has("one")).toBe(true);
      busy = false;
      await cache.sweep(Date.now() + 2000);
      expect(persisted).toContain("one");
      expect(cache.sessions.has("one")).toBe(false);
    } finally { cache.close(); }
  });

  test("retired owner drains only after queued state work, retries failed checkpoints, and never probes closed host", async () => {
    const coordinator = new SessionCoordinator();
    const first = gate(), second = gate();
    let fail = true;
    let statusCalls = 0;
    const checkpoints: Array<{ history: string; revision: number }> = [];
    const cache = new SessionCache({ maxBytes: 1_000_000, maxSessions: 4, idleTtlMs: 60_000 }, coordinator,
      async (_id, data: { history: string; revision: number }) => {
        if (fail) throw new Error("temporary snapshot failure");
        checkpoints.push({ ...data });
      }, async () => { statusCalls++; return false; }, () => {}, () => {});
    const data = { history: "old", revision: 0 };
    cache.set("chat", data);
    try {
      const executing = cache.run("chat", async () => {
        await first.wait;
        data.history = "new exact history";
        data.revision++;
      });
      const queued = cache.run("chat", async () => {
        await second.wait;
        data.history += " + queued mutation";
        data.revision++;
      });
      cache.status("chat", "busy");
      await cache.retire(["chat"]);
      expect(cache.sessions.has("chat")).toBe(true);
      expect(checkpoints).toEqual([]);
      first.release();
      await executing;
      await cache.sweep();
      expect(cache.sessions.has("chat")).toBe(true);
      second.release();
      await queued;
      await cache.sweep();
      expect(cache.sessions.has("chat")).toBe(true); // failed save stays resident
      expect(statusCalls).toBe(0);
      fail = false;
      await cache.sweep(Date.now() + 2_000); // retry after backoff
      expect(checkpoints).toEqual([{ history: "new exact history + queued mutation", revision: 2 }]);
      expect(cache.sessions.has("chat")).toBe(false);
      expect(statusCalls).toBe(0);
    } finally { first.release(); second.release(); cache.close(); }
  });

  test("reopened workspace cancels an outstanding retirement before the pinned operation completes", async () => {
    const gateWork = gate();
    let saved = 0;
    const cache = new SessionCache({ maxBytes: 1_000_000, maxSessions: 4, idleTtlMs: 60_000 },
      new SessionCoordinator(), async () => { saved++; }, async () => false, () => {}, () => {});
    cache.set("chat", { exact: "recoverable" });
    try {
      const running = cache.run("chat", () => gateWork.wait);
      await cache.retire(["chat"]);
      cache.cancelRetirement("chat"); // new verified workspace registration
      gateWork.release();
      await running;
      await cache.sweep();
      expect(saved).toBe(0);
      expect(cache.sessions.get("chat")).toEqual({ exact: "recoverable" });
    } finally { gateWork.release(); cache.close(); }
  });

  test("verified disposal waits for queued transform and slash state before exact checkpoint and reload", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-retired-queued-"));
    const directory = join(root, "workspace");
    const sessionID = "retired-chat";
    let closed = false;
    const input = { directory, client: { session: {
      status: async () => { if (closed) throw new Error("disposed SDK was queried"); return { data: {} }; },
      get: async (args: { path: { id: string } }) => ({ data: { id: args.path.id, directory } }),
      messages: async () => ({ data: [] }),
    } } };
    const options = { ctx: { storagePath: root, tokenizer: "char" as const,
      sessionCache: { maxSessions: 4, idleTtlMs: 60_000 } } };
    const originalSave = FilePersistence.prototype.save;
    const originalLoad = FilesystemContentStore.prototype.loadSessionHistory;
    const writing = gate(), release = gate();
    let pause = false, loads = 0;
    const entry = (id: string, time: number): HostMessageEntry => ({
      info: { id, sessionID, role: "user", time: { created: time }, agent: "build",
        model: { providerID: "test", modelID: "test" } },
      parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text: `Exact ${id}` }],
    });
    const hooks = await CtxPlugin(input, options);
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID: string }, output: { messages: HostMessageEntry[] },
    ) => Promise<void>;
    const slash = hooks["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string }, output: { parts: HostMessageEntry["parts"] },
    ) => Promise<void>;
    let pending: Promise<void> | undefined, queued: Promise<void> | undefined;
    let reopened: Record<string, unknown> | undefined;
    try {
      await transform({ sessionID }, { messages: [entry("u1", 1)] });
      FilePersistence.prototype.save = async function (id, state) {
        if (pause && id === sessionID) { writing.release(); await release.wait; }
        return originalSave.call(this, id, state);
      };
      pause = true;
      pending = transform({ sessionID }, { messages: [entry("u1", 1), entry("u2", 2)] });
      await writing.wait;
      const receipt = { parts: [] as HostMessageEntry["parts"] };
      queued = slash({ command: "ctx-stats", sessionID, arguments: "" }, receipt);
      closed = true;
      const event = hooks.event as (input: { event: { type: string; properties: { directory: string } } }) => Promise<void>;
      await event({ event: { type: "server.instance.disposed", properties: { directory } } });
      expect((await new FilesystemContentStore(root).loadSessionHistory(sessionID))?.rawEntries.map(item => item.info.id)).toEqual(["u1"]);
      release.release();
      await Promise.all([pending, queued]);
      expect((receipt.parts[0] as { text: string }).text).toContain("ctx stats");
      await sharedSessionCoordinator(root).run(sessionID, async () => {});
      await new Promise(resolve => setTimeout(resolve, 20));
      const saved = await new FilesystemContentStore(root).loadSessionHistory(sessionID);
      expect(saved?.rawEntries.map(item => item.info.id)).toEqual(["u1", "u2"]);
      expect(JSON.stringify(saved?.rawEntries)).toContain("Exact u2");
      FilePersistence.prototype.save = originalSave;
      FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
        if (id === sessionID) loads++;
        return originalLoad.call(this, id);
      };
      reopened = await CtxPlugin({ ...input, client: { session: {
        ...input.client.session, status: async () => ({ data: {} }),
      } } }, options);
      const command = reopened["command.execute.before"] as typeof slash;
      await command({ command: "ctx-stats", sessionID, arguments: "" }, { parts: [] });
      expect(loads).toBeGreaterThan(0);
    } finally {
      release.release();
      await Promise.allSettled([pending, queued].filter((item): item is Promise<void> => item !== undefined));
      FilePersistence.prototype.save = originalSave;
      FilesystemContentStore.prototype.loadSessionHistory = originalLoad;
      if (reopened) await disposeFixture(reopened, directory, root, [sessionID]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evicted plugin history reloads exact projection and command-first state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-cache-reload-"));
    const project = join(root, "project");
    const persistence = new FilePersistence(root);
    const state = createInitialState("first");
    state.manualOverrides.set("first-user", { mode: "replace", text: "Durable selected text" });
    await persistence.save("first", state);
    const hooks = await CtxPlugin({ directory: project, client: { session: {
      status: async () => ({ data: {} }),
      get: async (args: { path: { id: string } }) => ({ data: { id: args.path.id, directory: project } }),
      messages: async () => ({ data: [] }),
    } } }, { ctx: { storagePath: root, tokenizer: "char",
      sessionCache: { maxSessions: 1, maxBytes: 1024 * 1024, idleTtlMs: 60_000 },
      automation: { automaticPruning: false, modelCompression: false } } });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID: string }, output: { messages: HostMessageEntry[] },
    ) => Promise<void>;
    const command = hooks["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: HostMessageEntry["parts"] },
    ) => Promise<void>;
    const entry = (id: string): HostMessageEntry => ({
      info: { id: `${id}-user`, sessionID: id, role: "user", agent: "build", time: { created: 1 },
        model: { providerID: "test", modelID: "test" } },
      parts: [{ id: `${id}-text`, sessionID: id, messageID: `${id}-user`, type: "text", text: "raw original" }],
    });
    const loadHistory = FilesystemContentStore.prototype.loadSessionHistory;
    let firstLoads = 0;
    FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
      if (id === "first") firstLoads++;
      return loadHistory.call(this, id);
    };
    try {
      const first = { messages: [entry("first")] };
      await transform({ sessionID: "first" }, first);
      const savedProjection = structuredClone(first.messages);
      expect(JSON.stringify(savedProjection)).toContain("Durable selected text");
      await transform({ sessionID: "second" }, { messages: [entry("second")] });
      for (let i = 0; i < 30 && firstLoads < 2; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        const stat = { parts: [] as HostMessageEntry["parts"] };
        await command({ sessionID: "first", command: "ctx-stats", arguments: "" }, stat);
        expect((stat.parts[0] as { text: string }).text).toContain("ctx stats");
      }
      expect(firstLoads).toBeGreaterThanOrEqual(2);
      const snapshot = await new FilesystemContentStore(root).loadSessionHistory("first");
      expect(snapshot?.projectedEntries).toEqual(savedProjection);
      const afterReload = { messages: [entry("first")] };
      await transform({ sessionID: "first" }, afterReload);
      expect(JSON.stringify(afterReload.messages)).toContain("Durable selected text");
    } finally {
      FilesystemContentStore.prototype.loadSessionHistory = loadHistory;
      await disposeFixture(hooks, project, root, ["first", "second"]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("compressed sources survive eviction, reload and command-first decompression", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-cache-compressed-"));
    const project = join(root, "project");
    const sessionID = "compressed";
    const hooks = await CtxPlugin({ directory: project, client: { session: {
      status: async () => ({ data: {} }),
      get: async (args: { path: { id: string } }) => ({ data: { id: args.path.id, directory: project } }),
      messages: async () => ({ data: [] }),
    } } }, { ctx: { storagePath: root, tokenizer: "char", recencyGuardTurns: 0, compressionRecencyRequests: 0,
      sessionCache: { maxSessions: 1 },
      nudges: { lowerThreshold: 1_000_000, midSoftNudge: 1_000_000, upperThreshold: 1_000_000,
        safetyCap: "99%", maskTriggerThreshold: 1_000_000 } } });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID: string }, output: { messages: HostMessageEntry[] },
    ) => Promise<void>;
    const command = hooks["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string }, output: { parts: HostMessageEntry["parts"] },
    ) => Promise<void>;
    const user = (id: string, text: string, time: number): HostMessageEntry => ({
      info: { id, sessionID, role: "user", agent: "build", time: { created: time }, model: { providerID: "test", modelID: "test" } },
      parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
    });
    const original = [user("old-user", "Exact early requirement", 1), {
      info: { id: "old-assistant", sessionID, role: "assistant" as const, time: { created: 2, completed: 3 },
        parentID: "old-user", modelID: "test", providerID: "test", mode: "chat", path: { cwd: project, root: project },
        cost: 0, tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
      parts: [{ id: "old-assistant-text", sessionID, messageID: "old-assistant", type: "text", text: "Exact early answer" }],
    }, user("new-user", "Continue", 4)] as HostMessageEntry[];
    const loadHistory = FilesystemContentStore.prototype.loadSessionHistory;
    let compressedLoads = 0;
    FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
      if (id === sessionID) compressedLoads++;
      return loadHistory.call(this, id);
    };
    try {
      await transform({ sessionID }, { messages: structuredClone(original) });
      const compress = hooks.tool as { compress: { execute(args: unknown, context: unknown): Promise<{ output: string }> } };
      const result = await compress.compress.execute({ topic: "Early work", content: [
        { startId: "m0001", endId: "m0002", summary: "Consolidated early work." },
      ] }, { sessionID, messageID: "new-user", agent: "build", directory: project, worktree: project,
        abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });
      expect(result.output).toContain("b1");
      const compressed = { messages: structuredClone(original) };
      await transform({ sessionID }, compressed);
      expect(JSON.stringify(compressed.messages)).toContain("Consolidated early work.");
      expect(JSON.stringify(compressed.messages)).not.toContain("Exact early requirement");
      const other: HostMessageEntry = user("other-user", "Another chat", 5);
      other.info.sessionID = "other";
      other.parts[0].sessionID = "other";
      await transform({ sessionID: "other" }, { messages: [other] });
      // Let the post-request sweep publish the checkpoint before the slash call.
      await new Promise(resolve => setTimeout(resolve, 15));
      const receipt = { parts: [] as HostMessageEntry["parts"] };
      await command({ command: "ctx-decompress", sessionID, arguments: "b1" }, receipt);
      expect(compressedLoads).toBeGreaterThanOrEqual(2);
      expect((receipt.parts[0] as { text: string }).text).toContain("restored block b1");
      const restored = { messages: structuredClone(original) };
      await transform({ sessionID }, restored);
      expect(JSON.stringify(restored.messages)).toContain("Exact early requirement");
      expect((await new FilePersistence(root).load(sessionID))?.blockRegistry.get("b1")?.deactivatedByUser).toBe(true);
    } finally {
      FilesystemContentStore.prototype.loadSessionHistory = loadHistory;
      await disposeFixture(hooks, project, root, [sessionID, "other"]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("headless-first cache uses latest bound workspace status and durability; failed checkpoint retains resident state", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-cache-rebind-"));
    const project = join(root, "project");
    const options = { storagePath: root, tokenizer: "char" as const,
      sessionCache: { maxSessions: 1, idleTtlMs: 60_000 },
      automation: { automaticPruning: false, modelCompression: false } };
    const entry = (sessionID: string): HostMessageEntry => ({
      info: { id: `${sessionID}-user`, sessionID, role: "user", agent: "build", time: { created: 1 },
        model: { providerID: "test", modelID: "test" } },
      parts: [{ type: "text", id: `${sessionID}-part`, sessionID, messageID: `${sessionID}-user`, text: "Exact retained instruction" }],
    });
    const old = await CtxPlugin({}, { ctx: { ...options, contentStore: { enabled: false } } });
    const oldTransform = old["experimental.chat.messages.transform"] as (
      input: { sessionID: string }, output: { messages: HostMessageEntry[] },
    ) => Promise<void>;
    await oldTransform({ sessionID: "first" }, { messages: [entry("first")] });
    let calls = 0;
    const sessionClient = {
      status(this: unknown) {
        if (this !== sessionClient) throw new Error("status lost SDK receiver");
        calls++;
        return Promise.resolve({ data: {} });
      },
      get: async (args: { path: { id: string } }) => ({ data: { id: args.path.id, directory: project } }),
      messages: async () => ({ data: [] }),
    };
    const current = await CtxPlugin({ directory: project, client: { session: sessionClient } }, { ctx: options });
    const transform = current["experimental.chat.messages.transform"] as typeof oldTransform;
    const command = current["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string }, output: { parts: HostMessageEntry["parts"] },
    ) => Promise<void>;
    const history = FilesystemContentStore.prototype.loadSessionHistory;
    const write = FilesystemContentStore.prototype.saveSessionHistory;
    let loads = 0;
    let fail = false;
    FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
      if (id === "first") loads++;
      return history.call(this, id);
    };
    FilesystemContentStore.prototype.saveSessionHistory = async function (snapshot) {
      if (fail && snapshot.sessionId === "first") throw new Error("checkpoint unavailable");
      return write.call(this, snapshot);
    };
    try {
      await transform({ sessionID: "first" }, { messages: [entry("first")] });
      fail = true;
      await transform({ sessionID: "second" }, { messages: [entry("second")] });
      await new Promise(resolve => setTimeout(resolve, 20));
      const before = loads;
      const stats = { parts: [] as HostMessageEntry["parts"] };
      await command({ command: "ctx-stats", sessionID: "first", arguments: "" }, stats);
      expect((stats.parts[0] as { text: string }).text).toContain("ctx stats");
      expect(loads).toBe(before); // failed checkpoint cannot discard resident history
      expect(calls).toBeGreaterThan(0);
      fail = false;
      await new Promise(resolve => setTimeout(resolve, 1_100)); // eviction retry backoff
      await transform({ sessionID: "second" }, { messages: [entry("second")] });
      await new Promise(resolve => setTimeout(resolve, 20));
      const again = { parts: [] as HostMessageEntry["parts"] };
      await command({ command: "ctx-stats", sessionID: "first", arguments: "" }, again);
      expect(loads).toBeGreaterThan(before);
      expect((await new FilesystemContentStore(root).loadSessionHistory("first"))?.rawEntries[0].parts[0])
        .toEqual(entry("first").parts[0]);
    } finally {
      FilesystemContentStore.prototype.loadSessionHistory = history;
      FilesystemContentStore.prototype.saveSessionHistory = write;
      await disposeFixture(current, project, root, ["first", "second"]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("same workspace reload updates resident transform and dashboard config without losing runtime overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-cache-config-reload-"));
    const directory = join(root, "project");
    const sessionID = "config-reload";
    const state = createInitialState(sessionID);
    state.runtimeConfig = { recencyGuardTurns: 33 };
    await new FilePersistence(root).save(sessionID, state);
    const history = (id: string, created: number): HostMessageEntry => ({
      info: { id, sessionID, role: "user", agent: "build", time: { created },
        model: { providerID: "test", modelID: "same-model" } },
      parts: [{ id: `${id}-part`, sessionID, messageID: id, type: "text", text: "Meaningful user instruction" }],
    });
    const baseline = { storagePath: root, tokenizer: "char" as const, recencyGuardTurns: 4,
      nudges: { lowerThreshold: 1, midSoftNudge: 2, upperThreshold: 1_000_000,
        safetyCap: "99%", maskTriggerThreshold: 1_000_000 },
      controlServer: { enabled: true, port: 0, openBrowser: false } };
    const input = { directory, client: { session: {
      get: async (args: { path: { id: string } }) => ({ data: { id: args.path.id, directory } }),
      messages: async () => ({ data: [] }), status: async () => ({ data: {} }),
    } } };
    let newest: Record<string, unknown> | undefined;
    try {
      const old = await CtxPlugin(input, { ctx: { ...baseline, clearAtLeast: 10,
        automation: { modelCompression: false } } });
      const oldTransform = old["experimental.chat.messages.transform"] as (
        input: { sessionID: string }, output: { messages: HostMessageEntry[] },
      ) => Promise<void>;
      const first = { messages: [history("u1", 1)] };
      await oldTransform({ sessionID }, first);
      expect(JSON.stringify(first.messages)).not.toContain("[Context management:");
      newest = await CtxPlugin(input, { ctx: { ...baseline, clearAtLeast: 90,
        automation: { modelCompression: true } } });
      const transform = newest["experimental.chat.messages.transform"] as typeof oldTransform;
      const second = { messages: [history("u1", 1), history("u2", 2)] };
      await transform({ sessionID }, second);
      expect(JSON.stringify(second.messages)).toContain("[Context management:");
      const server = (await import("../adapters/opencode/control-service.js")).sharedControlService(root).listener!;
      const detail = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionID}`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect(detail.status).toBe(200);
      const config = (await detail.json() as { data: { effectiveSettings: {
        clearAtLeast: number; recencyGuardTurns: number; automation: { modelCompression: boolean } },
        settings: { recencyGuardTurns: number } } }).data;
      expect(config.effectiveSettings.clearAtLeast).toBe(90);
      expect(config.effectiveSettings.recencyGuardTurns).toBe(33);
      expect(config.effectiveSettings.automation.modelCompression).toBe(true);
      expect(config.settings.recencyGuardTurns).toBe(33);
      const oldAfterReload = { messages: [history("u1", 1), history("u2", 2), history("u3", 3)] };
      await oldTransform({ sessionID }, oldAfterReload);
      expect(JSON.stringify(oldAfterReload.messages)).toContain("[Context management:");
      const again = await fetch(`http://127.0.0.1:${server.port}/api/sessions/${sessionID}`, {
        headers: { Authorization: `Bearer ${server.token}` },
      });
      expect((await again.json() as { data: { effectiveSettings: { clearAtLeast: number } } }).data.effectiveSettings.clearAtLeast).toBe(90);
    } finally {
      if (newest) await disposeFixture(newest, directory, root, [sessionID]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function backend(label: string, listed = [`${label}-chat`]): ControlPlaneBackend {
  const latest = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const snapshot = (id: string): ControlSessionSnapshot => ({ sessionId: id, revision: 0, rawHostHistory: [],
    projectedContext: [], blocks: [], settings: {}, stats: { workspace: label } });
  return {
    listSessions: async () => listed.map(id => ({ sessionId: id, revision: 0,
      workspace: `/workspace/${id.split("-")[0]}` })),
    getSession: async id => snapshot(id),
    getMessageDetail: async (id, message, revision, generation) => {
      if (generation !== latest) throw new RevisionConflictError("Stale generation", revision, revision);
      return { sessionId: id, revision, id: message, message: { generation, workspace: label } };
    },
    getBlockDetail: async (id, block, revision, generation) => {
      if (generation !== latest) throw new RevisionConflictError("Stale generation", revision, revision);
      return { sessionId: id, revision, id: block, block: { blockId: block, status: "active", generation } };
    },
    updateSettings: async id => snapshot(id),
    putMessageOverride: async id => snapshot(id),
    deleteMessageOverride: async id => snapshot(id),
    applyProjectionEdits: async id => snapshot(id),
    performBlockAction: async id => snapshot(id),
    searchArchivedContent: async () => ({ items: [] }),
  };
}

describe("shared workspace control service", () => {
  test("verified exact-directory disposal releases only owned listener/bridge/status ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-disposed-owner-"));
    const a = join(root, "a"), b = join(root, "b");
    const statusCalls = new Map<string, number>();
    const input = (directory: string) => ({ directory, worktree: root, client: { session: {
      get: async (args: { path: { id: string } }) => ({ data: { id: args.path.id, directory } }),
      messages: async () => ({ data: [] }), status: async () => {
        statusCalls.set(directory, (statusCalls.get(directory) ?? 0) + 1);
        return { data: {} };
      },
    } } });
    const options = { ctx: { storagePath: root, controlServer: { enabled: true, port: 0, openBrowser: false } } };
    const event = (hooks: Record<string, unknown>) => hooks.event as (
      input: { event: { type: string; properties: { directory: string } } },
    ) => Promise<void>;
    const bridge = () => (globalThis as unknown as Record<symbol, Map<string, unknown>>)[REMOTE_CONTEXT_BRIDGE_KEY];
    try {
      const oldA = await CtxPlugin(input(a), options);
      const ownerB = await CtxPlugin(input(b), options);
      const currentA = await CtxPlugin(input(a), options);
      const currentBridge = bridge().get(a);
      const service = (await import("../adapters/opencode/control-service.js")).sharedControlService(root);
      const server = service.listener;
      expect(server).toBeDefined();
      expect(currentBridge).toBeDefined();
      await event(oldA)({ event: { type: "server.instance.disposed", properties: { directory: a } } });
      await event(ownerB)({ event: { type: "server.instance.disposed", properties: { directory: a } } });
      expect(service.listener).toBe(server);
      expect(bridge().get(a)).toBe(currentBridge);
      expect(bridge().has(b)).toBe(true);
      const sessionID = "owned-chat";
      const transform = currentA["experimental.chat.messages.transform"] as (
        input: { sessionID: string }, output: { messages: HostMessageEntry[] },
      ) => Promise<void>;
      await transform({ sessionID }, { messages: [{
        info: { id: "owned-user", sessionID, role: "user", agent: "build", time: { created: 1 },
          model: { providerID: "test", modelID: "test" } },
        parts: [{ id: "owned-text", sessionID, messageID: "owned-user", type: "text", text: "preserve exact history" }],
      }] });
      const beforeDisposal = statusCalls.get(a) ?? 0;
      await event(currentA)({ event: { type: "server.instance.disposed", properties: { directory: join(a, "..", "a") } } });
      expect(statusCalls.get(a) ?? 0).toBe(beforeDisposal);
      expect(bridge().has(a)).toBe(false);
      expect(bridge().has(b)).toBe(true);
      expect(service.listener).toBe(server);
      expect((await new FilesystemContentStore(root).loadSessionHistory(sessionID))?.rawEntries[0].info.id).toBe("owned-user");
      const reopened = await CtxPlugin(input(a), options);
      const stats = { parts: [] as HostMessageEntry["parts"] };
      const command = reopened["command.execute.before"] as (
        input: { sessionID: string; command: string; arguments: string }, output: typeof stats,
      ) => Promise<void>;
      await command({ sessionID, command: "ctx-stats", arguments: "" }, stats);
      expect((stats.parts[0] as { text: string }).text).toContain("ctx stats");
      const reloaded = await fetch(`http://127.0.0.1:${server!.port}/api/sessions/${sessionID}`, {
        headers: { Authorization: `Bearer ${server!.token}` },
      });
      expect(reloaded.status).toBe(200);
      expect(JSON.stringify(await reloaded.json())).toContain("preserve exact history");
      await event(reopened)({ event: { type: "server.instance.disposed", properties: { directory: a } } });
      await event(ownerB)({ event: { type: "server.instance.disposed", properties: { directory: b } } });
      expect(bridge().has(b)).toBe(false);
      expect(service.listener).toBeUndefined();
      expect((await new FilePersistence(root).load(sessionID))?.sessionId).toBe(sessionID);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  test("real writers mark user-only cold chats so multi-workspace listing routes without SDK or full-history reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-user-only-owners-"));
    const store = new FilesystemContentStore(root);
    let sdkGets = 0;
    const transform = async (key: string, recencyGuardTurns: number) => {
      const directory = join(root, key);
      const hooks = await CtxPlugin({ directory, client: { session: {
        status: async () => ({ data: {} }),
        get: async (args: { path: { id: string } }) => {
          sdkGets++;
          return { data: { id: args.path.id, directory } };
        },
        messages: async () => ({ data: [] }),
      } } }, { ctx: { storagePath: root, sessionCache: { maxSessions: 1 },
        recencyGuardTurns, controlServer: { enabled: true, port: 0, openBrowser: false } } });
      const sessionID = `${key}-chat`;
      const entry: HostMessageEntry = { info: { id: `${key}-user`, sessionID, role: "user", time: { created: 1 },
        agent: "build", model: { providerID: "test", modelID: "test" } },
        parts: [{ id: `${key}-text`, sessionID, messageID: `${key}-user`, type: "text", text: "user only" }] };
      const run = hooks["experimental.chat.messages.transform"] as (
        input: { sessionID: string }, output: { messages: HostMessageEntry[] },
      ) => Promise<void>;
      await run({ sessionID }, { messages: [entry] });
      return { sessionID, directory, hooks };
    };
    const factories: Awaited<ReturnType<typeof transform>>[] = [];
    try {
      const a = await transform("a", 9); factories.push(a);
      const b = await transform("b", 25); factories.push(b);
      factories.push(await transform("c", 7));
      await new Promise(resolve => setTimeout(resolve, 20));
      const metadata = await store.listSessionHistories();
      expect(metadata.find(item => item.sessionId === a.sessionID)?.workspace).toBe(a.directory);
      expect(metadata.find(item => item.sessionId === b.sessionID)?.workspace).toBe(b.directory);
      const list = FilesystemContentStore.prototype.listSessionHistories;
      const loadHistory = FilesystemContentStore.prototype.loadSessionHistory;
      const loadState = FilePersistence.prototype.load;
      let lists = 0, histories = 0, states = 0;
      FilesystemContentStore.prototype.listSessionHistories = async function (...args) {
        lists++;
        return list.apply(this, args);
      };
      FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
        histories++;
        return loadHistory.call(this, id);
      };
      FilePersistence.prototype.load = async function (id) {
        states++;
        return loadState.call(this, id);
      };
      try {
        const server = (await import("../adapters/opencode/control-service.js")).sharedControlService(root).listener!;
        const headers = { Authorization: `Bearer ${server.token}` };
        const base = `http://127.0.0.1:${server.port}`;
        const response = await fetch(`${base}/api/sessions`, { headers });
        const listed = (await response.json() as { data: Array<{ sessionId: string }> }).data;
        expect(new Set(listed.map(item => item.sessionId))).toEqual(new Set(["a-chat", "b-chat", "c-chat"]));
        expect(lists).toBe(1);
        expect(histories).toBe(0);
        expect(states).toBe(0);
        expect(sdkGets).toBe(0);
        const detail = await fetch(`${base}/api/sessions/b-chat`, { headers });
        expect(detail.status).toBe(200);
        expect((await detail.json() as { data: { effectiveSettings: { recencyGuardTurns: number } } }).data.effectiveSettings.recencyGuardTurns).toBe(25);
      } finally {
        FilesystemContentStore.prototype.listSessionHistories = list;
        FilesystemContentStore.prototype.loadSessionHistory = loadHistory;
        FilePersistence.prototype.load = loadState;
      }
    } finally {
      for (const factory of factories.reverse()) {
        await disposeFixture(factory.hooks, factory.directory, root, ["a-chat", "b-chat", "c-chat"]);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  test("cold multi-workspace listing enumerates one metadata index without loading histories or repeated state/token passes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-control-owners-"));
    const a = join(root, "a");
    const b = join(root, "b");
    const store = new FilesystemContentStore(root);
    const persistence = new FilePersistence(root);
    const make = (id: string, cwd: string): HostMessageEntry[] => [{
      info: { id: `${id}-u`, sessionID: id, role: "user", time: { created: 1 }, agent: "build",
        model: { providerID: "test", modelID: "test" } },
      parts: [{ id: `${id}-p`, sessionID: id, messageID: `${id}-u`, type: "text", text: "A user title" }],
    }, {
      info: { id: `${id}-a`, sessionID: id, role: "assistant", time: { created: 2, completed: 3 },
        parentID: `${id}-u`, providerID: "test", modelID: "test", mode: "build",
        path: { cwd, root }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
      parts: [{ id: `${id}-ap`, sessionID: id, messageID: `${id}-a`, type: "text", text: "Exact answer" }],
    }];
    for (const [id, cwd] of [["a-chat", a], ["b-chat", b]] as const) {
      await persistence.save(id, createInitialState(id));
      const history = make(id, cwd);
      await store.saveSessionHistory({ version: 1, sessionId: id, rawEntries: history,
        projectedEntries: history, updatedAt: 1, summary: { revision: 0 } });
    }
    // Two conflicting assistant directories must remain unroutable.
    await store.saveSessionHistory({ version: 1, sessionId: "ambiguous", rawEntries: [...make("ambiguous", a),
      make("other", b)[1]], projectedEntries: make("ambiguous", a), updatedAt: 1, summary: { revision: 0 } });
    let lists = 0;
    let loads = 0;
    let stateLoads = 0;
    const list = FilesystemContentStore.prototype.listSessionHistories;
    const load = FilesystemContentStore.prototype.loadSessionHistory;
    const loadState = FilePersistence.prototype.load;
    FilesystemContentStore.prototype.listSessionHistories = async function (...args) {
      lists++;
      return list.apply(this, args);
    };
    FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
      loads++;
      return load.call(this, id);
    };
    FilePersistence.prototype.load = async function (id) {
      stateLoads++;
      return loadState.call(this, id);
    };
    try {
      const first = await CtxPlugin({ directory: a }, { ctx: { storagePath: root,
        recencyGuardTurns: 9, controlServer: { enabled: true, port: 0, openBrowser: false } } });
      const second = await CtxPlugin({ directory: b }, { ctx: { storagePath: root,
        recencyGuardTurns: 25, controlServer: { enabled: true, port: 0, openBrowser: false } } });
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      const server = (await import("../adapters/opencode/control-service.js")).sharedControlService(root).listener!;
      const request = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          headers: { Authorization: `Bearer ${server.token}` },
        });
        return { status: response.status, json: await response.json() as { data?: any } };
      };
      const summaries = await request("/api/sessions");
      expect(summaries.status).toBe(200);
      expect(summaries.json.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(["a-chat", "b-chat"]);
      expect(lists).toBe(1);
      expect(loads).toBe(0);
      expect(stateLoads).toBe(0);
      const detail = await request("/api/sessions/b-chat");
      expect(detail.status).toBe(200);
      expect(detail.json.data.effectiveSettings.recencyGuardTurns).toBe(25);
      expect(loads).toBe(1);
      expect((await request("/api/sessions/ambiguous")).status).toBe(404);
    } finally {
      FilesystemContentStore.prototype.listSessionHistories = list;
      FilesystemContentStore.prototype.loadSessionHistory = load;
      FilePersistence.prototype.load = loadState;
      await rm(root, { recursive: true, force: true });
    }
  });
  test("one listener, correct owners on reload, unknown chats rejected, bootstrap failure closes", async () => {
    const service = new ControlService("/tmp/ctx-lifecycle-test");
    let bootstrapCount = 0;
    const first = await service.register({ workspace: "/workspace/a", backend: backend("a", ["a-chat", "b-chat"]),
      persistedOwner: async id => id === "a-chat" || id === "b-chat" ? `/workspace/${id.split("-")[0]}` : undefined }, {}, async () => { bootstrapCount++; });
    const second = await service.register({ workspace: "/workspace/b", backend: backend("b"),
      persistedOwner: async id => id === "b-chat" ? "/workspace/b" : undefined }, {}, async () => { bootstrapCount++; });
    try {
      expect(second.server).toBe(first.server);
      expect(bootstrapCount).toBe(2);
      await expect(service.register({ workspace: "/workspace/conflict", backend: backend("conflict"),
        persistedOwner: async () => undefined }, { port: first.server.port === 65535 ? 65534 : first.server.port + 1 }, async () => {}))
        .rejects.toThrow("conflicts");
      const request = async (path: string) => {
        const response = await fetch(`http://127.0.0.1:${first.server.port}${path}`, {
          headers: { Authorization: `Bearer ${first.server.token}` },
        });
        return { status: response.status, body: await response.json() as { data?: any } };
      };
      expect((await request("/api/sessions")).body.data.map((s: { sessionId: string }) => s.sessionId)).toEqual(["a-chat", "b-chat"]);
      expect((await request("/api/sessions/b-chat")).body.data.stats.workspace).toBe("b");
      const generation = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      expect((await request(`/api/sessions/b-chat/messages/m1?revision=0&generation=${generation}`)).body.data.message.generation).toBe(generation);
      expect((await request(`/api/sessions/b-chat/blocks/b1/detail?revision=0&generation=${generation}`)).body.data.block.generation).toBe(generation);
      expect((await request("/api/sessions/b-chat/messages/m1?revision=0&generation=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")).status).toBe(409);
      expect((await request("/api/sessions/unknown")).status).toBe(404);
      const replacement = await service.register({ workspace: "/workspace/b", backend: backend("replacement"),
        persistedOwner: async id => id === "b-chat" ? "/workspace/b" : undefined }, {}, async () => {});
      expect((await request("/api/sessions/b-chat")).body.data.stats.workspace).toBe("replacement");
      await second.unregister(); // stale factory cannot remove replacement
      expect((await request("/api/sessions/b-chat")).status).toBe(200);
      await replacement.unregister();
      expect((await request("/api/sessions/b-chat")).status).toBe(404);
      await first.unregister();
    } finally {
      await second.unregister();
      await first.unregister();
    }
    const failed = new ControlService("/tmp/ctx-lifecycle-bootstrap-fail");
    await expect(failed.register({ workspace: "/workspace/a", backend: backend("a"), persistedOwner: async () => undefined },
      {}, async () => { throw new Error("bootstrap write failed"); })).rejects.toThrow("bootstrap write failed");
    expect(failed.listener).toBeUndefined();
  });

  test("registration invalidates inferred ownership when a second workspace appears", async () => {
    const service = new ControlService("/tmp/ctx-lifecycle-ownership");
    const root = "/workspace/shared";
    const anonymous = await service.register({ workspace: root, backend: backend("a"),
      persistedOwner: async () => service.isSoleWorkspace(root) ? root : undefined }, {}, async () => {});
    const headers = { Authorization: `Bearer ${anonymous.server.token}` };
    const url = `http://127.0.0.1:${anonymous.server.port}/api/sessions/a-chat`;
    const other = { workspace: "/workspace/other", backend: backend("other"), persistedOwner: async () => undefined };
    try {
      expect((await fetch(url, { headers })).status).toBe(200);
      const second = await service.register(other, {}, async () => {});
      try { expect((await fetch(url, { headers })).status).toBe(404); }
      finally { await second.unregister(); }
    } finally { await anonymous.unregister(); }
  });
});
