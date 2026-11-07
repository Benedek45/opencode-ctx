// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Fully mocked native V2 lifecycle and real shared pipeline/archives. No network.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCtxV2Plugin } from "../adapters/opencode-v2/plugin.js";
import { V2HostRuntime } from "../adapters/opencode-v2/host.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { loadCompressionSource, loadCompressionSummary } from "../adapters/opencode/compression-archive.js";
import { isSummaryWorkerSession } from "../adapters/opencode/summary-worker.js";
import { SUMMARY_AGENT, SUMMARY_TITLE } from "../adapters/opencode-v2/summary-worker.js";

const model = { providerID: "mock", id: "summarizer" };
const summary = "## Goal & Framework\nPreserve the investigation.\n## Next Steps\nContinue safely. WORKER_MARKER";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const task of cleanup.splice(0)) await task(); });
const registry = () => (globalThis as any)[Symbol.for("opencode.context-manager.proactive-compression.v1")] as Map<string, any>;
const workerRegistry = () => (globalThis as any)[Symbol.for("opencode.context-manager.summary-workers.v1")] as Map<string, unknown>;
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("mock worker condition timed out");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

async function fixture(worker: Record<string, unknown> | false = {}, customAgent?: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ctx-native-worker-")));
  const storage = join(root, "storage");
  const hooks = new Map<string, (event: any) => any>();
  const tools: any[] = [];
  const commands: any[] = [];
  const calls: Array<{ name: string; input?: any }> = [];
  const agents = new Map<string, any>(customAgent ? [[SUMMARY_AGENT, customAgent]] : []);
  const histories = new Map<string, any[]>();
  const queue: any[] = [];
  let wake = () => {};
  let count = 0;
  const registration = { async dispose() {} };
  const fx = { root, storage, hooks, tools, commands, calls, agents, histories, workerId: "",
    response: summary, onWait: undefined as undefined | ((id: string, options: any) => Promise<void>),
    onRemove: undefined as undefined | ((id: string) => Promise<void>),
    mutateAssistant: undefined as undefined | ((assistant: any) => void),
    emit(event: any) { queue.push(event); wake(); }, async dispose() {}, ctx: {} as any };
  const ctx = {
    location: { directory: root, project: { directory: root, id: "project" } },
    options: { ctx: { storagePath: storage, tokenizer: "char", compressionRecencyRequests: 3,
      nudges: { lowerThreshold: 1000, midSoftNudge: 900000, upperThreshold: 950000, safetyCap: "99%", maskTriggerThreshold: 1000000 },
      ...(worker === false ? {} : { summaryWorker: { enabled: true, model: "mock/summarizer",
        timeoutMs: 1000, cleanupTimeoutMs: 30, minIntervalMs: 1, ...worker } }) } },
    event: { subscribe({ signal }: { signal: AbortSignal }) { return { async *[Symbol.asyncIterator]() {
      while (!signal.aborted) {
        const event = queue.shift();
        if (event) { yield event; continue; }
        await new Promise<void>(resolve => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } }; } },
    agent: { async transform(change: (editor: any) => void) {
      calls.push({ name: "agent" });
      change({ get: (id: string) => agents.get(id), update(id: string, fn: (value: any) => void) {
        const value = agents.get(id) ?? { id, permissions: [] };
        fn(value); agents.set(id, value);
      } }); return registration;
    } },
    session: {
      async hook(name: string, callback: any) { hooks.set(name, callback); return registration; },
      async get({ sessionID }: any) { return { id: sessionID, location: { directory: root } }; },
      async context({ sessionID }: any) { calls.push({ name: "context", input: sessionID }); return histories.get(sessionID) ?? []; },
      async create(input: any) {
        calls.push({ name: "create", input });
        fx.workerId = `ses_worker_${++count}`;
        return { id: fx.workerId, ...input };
      },
      async prompt(input: any) {
        calls.push({ name: "prompt", input });
        const user = { id: "msg_prompt", type: "user", text: input.text, time: { created: 1 } };
        histories.set(input.sessionID, [user]);
        const event = { sessionID: input.sessionID, agent: SUMMARY_AGENT, model,
          system: [{ type: "text", text: "PROJECT_INSTRUCTIONS_MUST_NOT_LEAK" }], tools: { shell: {}, compress: {} },
          messages: [{ id: user.id, role: "user", content: [{ type: "text", text: input.text }] }] };
        await hooks.get("context")!(event);
        expect(event.tools).toEqual({});
        expect(JSON.stringify(event.system)).not.toContain("PROJECT_INSTRUCTIONS_MUST_NOT_LEAK");
        expect(event.messages[0].content[0].text).toBe(input.text);
        const title: any = { sessionID: input.sessionID };
        await hooks.get("title")!(title);
        expect(title.result).toBe(SUMMARY_TITLE);
        return { id: user.id, sessionID: input.sessionID, type: "user", delivery: "steer", payload: { text: input.text }, time: user.time }; // inbox receipt, NOT assistant
      },
      async wait({ sessionID }: any, options: any) {
        calls.push({ name: "wait", input: sessionID });
        await fx.onWait?.(sessionID, options);
        const assistant = { id: "msg_answer", type: "assistant", agent: SUMMARY_AGENT, model,
          finish: "stop", time: { created: 2, completed: 3 }, content: [{ type: "text", text: fx.response }] };
        fx.mutateAssistant?.(assistant);
        histories.get(sessionID)!.push(assistant);
      },
      async interrupt(input: any) { calls.push({ name: "interrupt", input }); return { interrupted: false }; },
      async remove({ sessionID }: any) { calls.push({ name: "remove", input: sessionID }); await fx.onRemove?.(sessionID); },
      async synthetic() {},
    },
    tool: {
      async transform(fn: any) { fn({ add: (tool: any) => tools.push(tool) }); return registration; },
      async hook(name: string, fn: any) { hooks.set(`tool:${name}`, fn); return registration; },
    },
    command: { async transform(fn: any) { fn({ add: (command: any) => commands.push(command) }); return registration; } },
    model: {
      async list() { return [{ id: "parent-model", providerID: "mock", limit: { context: 200000 } }]; },
      async default() { return { id: "parent-model", providerID: "mock" }; },
    },
  };
  fx.ctx = ctx;
  const dispose = await createCtxV2Plugin({ logger: { info() {}, warn() {}, debug() {} } }).setup(ctx);
  fx.dispose = dispose;
  cleanup.push(async () => { await dispose(); workerRegistry().delete(fx.workerId); await rm(root, { recursive: true, force: true }); });
  return fx;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function history() {
  return Array.from({ length: 6 }, (_, i) => [
    { id: `u${i}`, role: "user", content: [{ type: "text", text: `Investigate ${i}` }] },
    { id: `a${i}`, role: "assistant", content: [{ type: "text", text: `ORIGINAL_${i} ${"details ".repeat(600)}` }] },
  ]).flat();
}
async function transform(fx: Fixture, messages = history(), sessionID = "parent") {
  const event = { sessionID, model: { providerID: "mock", id: "parent-model" }, agent: "build",
    system: [{ type: "text", text: "Parent instructions" }], tools: {}, messages: structuredClone(messages) };
  await fx.hooks.get("context")!(event);
  return event;
}
async function start(fx: Fixture) {
  fx.emit({ type: "session.execution.succeeded", data: { sessionID: "parent" } });
  await until(() => fx.calls.some(call => call.name === "prompt"));
}
async function settle(fx: Fixture) { await registry().get(fx.storage)?.jobs.get("parent")?.completion; }
const state = (fx: Fixture) => new FilePersistence(fx.storage).load("parent");

test("native V2 worker default OFF is byte-identical to explicit disabled; seven tools and no worker side effects", async () => {
  const absent = await fixture(false);
  const disabled = await fixture({ enabled: false });
  expect(JSON.stringify(await transform(absent))).toBe(JSON.stringify(await transform(disabled)));
  for (const fx of [absent, disabled]) {
    fx.emit({ type: "session.execution.succeeded", data: { sessionID: "parent" } });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fx.calls).toEqual([]);
    expect(fx.tools).toHaveLength(7);
    expect([...fx.hooks.keys()]).toEqual(["context", "tool:execute.before", "tool:execute.after"]);
  }
});

test("native receipt → wait → validated assistant → dual archive commit, no attempts and no worker state", async () => {
  const fx = await fixture();
  await transform(fx); await start(fx); await settle(fx);
  expect(fx.calls.map(call => call.name)).toEqual(["agent", "create", "prompt", "wait", "context", "interrupt", "remove"]);
  const create = fx.calls.find(call => call.name === "create")!.input;
  expect(create).toEqual({ title: SUMMARY_TITLE, agent: SUMMARY_AGENT, model,
    location: { directory: fx.root }, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
  expect(fx.agents.get(SUMMARY_AGENT)).toMatchObject({ hidden: true, mode: "subagent", permissions: create.permissions });
  expect(fx.calls.find(call => call.name === "interrupt")!.input).toEqual({ sessionID: fx.workerId, resume: false });
  const saved = (await state(fx))!;
  expect(saved.blockRegistry.size).toBe(1);
  expect(saved.nudgeEscalation.attempts ?? 0).toBe(0);
  const block = [...saved.blockRegistry.values()][0];
  const store = new FilesystemContentStore(fx.storage);
  const sources = await loadCompressionSource(store, block.durableSourceRef!, "parent", block.blockId, block.effectiveMessageIds ?? block.sourceMessageIds);
  expect(JSON.stringify(sources)).toContain("ORIGINAL_0");
  expect(await loadCompressionSummary(store, block.durableSummaryRef!, "parent", block.blockId)).toBe(block.summaryText);
  expect(await new FilePersistence(fx.storage).load(fx.workerId)).toBeUndefined();
  expect(await store.loadSessionHistory(fx.workerId)).toBeUndefined();
  expect(isSummaryWorkerSession(fx.workerId)).toBe(false);
  expect(JSON.stringify(await transform(fx))).toContain("WORKER_MARKER");
});

test("busy/retry/new transform cancels waiting worker; no summary commits", async () => {
  for (const reason of ["busy", "retry", "transform"]) {
    const fx = await fixture();
    fx.onWait = (_, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    await transform(fx); await start(fx);
    if (reason === "transform") await transform(fx);
    else fx.emit({ type: "session.status", data: { sessionID: "parent", status: { type: reason } } });
    await settle(fx);
    expect((await state(fx))!.blockRegistry.size).toBe(0);
    expect(fx.calls.map(call => call.name)).toContain("remove");
  }
});

test("changed control revision during worker response rejects exact-key commit", async () => {
  const fx = await fixture();
  fx.onWait = async () => {
    const tool = fx.tools.find(tool => tool.name === "compress");
    const result = await tool.execute({ topic: "manual", content: [{ startId: "m0001", endId: "m0002", summary: "## Decisions\nManual summary" }] },
      { sessionID: "parent", messageID: "tool", id: "call", agent: "build" });
    expect(result.content).toContain("Compressed");
  };
  await transform(fx); await start(fx); await settle(fx);
  const blocks = [...(await state(fx))!.blockRegistry.values()];
  expect(blocks).toHaveLength(1);
  expect(blocks[0].summaryText).not.toContain("WORKER_MARKER");
});

test("invalid/unfinished/model-mismatched/tool-bearing responses preserve originals", async () => {
  for (const mutate of [
    (a: any) => { delete a.time.completed; },
    (a: any) => { a.model = { ...model, id: "wrong" }; },
    (a: any) => { a.content.push({ type: "tool", name: "shell" }); },
    (a: any) => { a.finish = "length"; },
    (a: any) => { a.error = { message: "failed" }; },
    (a: any) => { a.content = [{ type: "text", text: "unstructured" }]; },
  ]) {
    const fx = await fixture(); fx.mutateAssistant = mutate;
    await transform(fx); await start(fx); await settle(fx);
    expect((await state(fx))!.blockRegistry.size).toBe(0);
    expect((await state(fx))!.nudgeEscalation.attempts ?? 0).toBe(0);
    expect(JSON.stringify(await transform(fx))).toContain("ORIGINAL_0");
  }
});

test("bounded timeout and unconfirmed cleanup fail closed and keep worker ID suppressed", async () => {
  const fx = await fixture({ timeoutMs: 20 });
  fx.onWait = () => new Promise(() => {});
  fx.onRemove = () => new Promise(() => {});
  await transform(fx); await start(fx); await settle(fx);
  expect((await state(fx))!.blockRegistry.size).toBe(0);
  expect(isSummaryWorkerSession(fx.workerId)).toBe(true);
  await expect(fx.tools[0].execute({}, { sessionID: fx.workerId })).rejects.toThrow("disabled");
  await expect(fx.hooks.get("tool:execute.before")!({ sessionID: fx.workerId })).rejects.toThrow("disabled");
});

test("worker pending response is cancelled and cleaned on plugin disposal", async () => {
  const fx = await fixture();
  fx.onWait = (_, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("disposed")), { once: true }));
  await transform(fx); await start(fx); await fx.dispose();
  expect(fx.calls.map(call => call.name)).toContain("remove");
  expect((await state(fx))!.blockRegistry.size).toBe(0);
});

test("existing user summarizer definition is not clobbered; session still denies all tools", async () => {
  const custom = { mode: "all", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
  const fx = await fixture({}, structuredClone(custom));
  expect(fx.agents.get(SUMMARY_AGENT)).toEqual(custom);
  await transform(fx); await start(fx); await settle(fx);
  expect(fx.calls.find(call => call.name === "create")!.input.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
});

test("worker requires explicit model and verifiable native lifecycle, fails before agent registration", async () => {
  const fx = await fixture(false);
  const plugin = createCtxV2Plugin();
  await expect(plugin.setup({ ...fx.ctx, options: { ctx: { summaryWorker: { enabled: true } } } })).rejects.toThrow("explicit provider/model");
  await expect(plugin.setup({ ...fx.ctx, options: { ctx: { summaryWorker: { enabled: true, model: "mock/summarizer" } } },
    session: { ...fx.ctx.session, wait: undefined } })).rejects.toThrow("session.wait");
  expect(fx.calls).toEqual([]);
});

test("status authority needs an exact observed idle, not merely a connected event stream", async () => {
  const fx = await fixture(false);
  const runtime = new V2HostRuntime(fx.ctx);
  expect(runtime.workerStatus("parent")).toBeUndefined();
  await runtime.observe({ type: "session.execution.started", data: { sessionID: "parent" } }, false);
  expect(runtime.statusReliable).toBe(false);
  expect(runtime.workerStatus("parent")).toBeUndefined();
  await runtime.observe({ type: "server.connected" });
  expect(runtime.workerStatus("unseen")).toBeUndefined();
  await runtime.observe({ type: "session.execution.started", data: { sessionID: "parent" } });
  expect(runtime.workerStatus("parent")).toBe("busy");
  await runtime.observe({ type: "session.execution.succeeded", data: { sessionID: "parent" } });
  expect(runtime.workerStatus("parent")).toBe("idle");
  await runtime.observe({ type: "session.deleted", data: { sessionID: "parent" } });
  expect(runtime.workerStatus("parent")).toBeUndefined();
});

test("worker idle authority evicts old statuses at the LRU bound", async () => {
  const fx = await fixture(false);
  const runtime = new V2HostRuntime(fx.ctx);
  for (let i = 0; i < 2048; i++) await runtime.observe({ type: "session.idle", data: { sessionID: `parent-${i}` } });
  await runtime.observe({ type: "session.idle", data: { sessionID: "parent-0" } });
  await runtime.observe({ type: "session.idle", data: { sessionID: "new-parent" } });
  expect(runtime.workerStatus("parent-1")).toBeUndefined();
  expect(runtime.workerStatus("parent-0")).toBe("idle");
  expect(runtime.workerStatus("new-parent")).toBe("idle");
});

test("repeat idle events respect cooldown and never launch worker descendants", async () => {
  const fx = await fixture({ minIntervalMs: 60000 });
  fx.onWait = async id => {
    fx.emit({ type: "session.execution.succeeded", data: { sessionID: id } });
    await expect(fx.hooks.get("compaction")!({ sessionID: id })).rejects.toThrow("compaction is disabled");
    await expect(fx.tools[0].execute({}, { sessionID: id })).rejects.toThrow("disabled");
  };
  await transform(fx); await start(fx); await settle(fx);
  fx.emit({ type: "session.execution.succeeded", data: { sessionID: "parent" } });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(fx.calls.filter(call => call.name === "create")).toHaveLength(1);
});

test("complete source exceeding the input cap never creates a worker", async () => {
  const fx = await fixture({ maxInputTokens: 5 });
  await transform(fx);
  fx.emit({ type: "session.execution.succeeded", data: { sessionID: "parent" } });
  await new Promise(resolve => setTimeout(resolve, 10));
  await settle(fx);
  expect(fx.calls.filter(call => call.name === "create")).toHaveLength(0);
  expect((await state(fx))!.blockRegistry.size).toBe(0);
});

test("local output cap and missing DATA NEEDED items reject summaries without truncation", async () => {
  for (const mode of ["output-cap", "data-needed"]) {
    const fx = await fixture(mode === "output-cap" ? { maxOutputTokens: 1 } : {});
    const source = history();
    if (mode === "data-needed") source[1].content[0].text += " [DATA NEEDED: exact source record]";
    await transform(fx, source); await start(fx); await settle(fx);
    expect((await state(fx))!.blockRegistry.size).toBe(0);
    expect((await state(fx))!.nudgeEscalation.attempts ?? 0).toBe(0);
  }
});
