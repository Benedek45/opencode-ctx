// PolyForm Noncommercial License 1.0.0 — see LICENSE
// OpenCode V2 binding: real V1 context-manager hooks driven through a fake V2 plugin context.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { createCtxV2Plugin, normalizeV2Options } from "../adapters/opencode-v2/plugin.js";
import { V2HostRuntime, type V2EventLike } from "../adapters/opencode-v2/host.js";
import type { V2Message } from "../adapters/opencode-v2/map.js";
import { buildCompressionGuidance } from "../core/nudges.js";
import { ALWAYS_PROTECTED_TOOLS } from "../core/defaults.js";
import { FilePersistence } from "../adapters/opencode/services.js";

class FakeMessage implements V2Message {
  readonly id?: string;
  readonly role!: string;
  readonly content!: V2Message["content"];
  constructor(input: Record<string, unknown>) {
    Object.assign(this, input);
  }
}

const msg = (fields: Record<string, unknown>) => new FakeMessage(fields);
const T0 = Date.now() - 3_600_000;
const mid = (offset: number) => `msg_${((BigInt(T0 + offset) * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0")}abcdefghijklmn`;

interface FakeTool {
  name: string;
  description: string;
  input: { type: string; properties: Record<string, unknown> };
  options: { codemode?: boolean };
  execute(input: unknown, context: Record<string, unknown>): Promise<{ content?: unknown; metadata?: unknown }>;
}

function fakeContext(directory: string, options: Record<string, unknown>) {
  const tools: FakeTool[] = [];
  const commands: Array<{ name: string; description?: string; execute(input: unknown): Promise<void> }> = [];
  const sessionHooks = new Map<string, (event: any) => Promise<void> | void>();
  const toolHooks = new Map<string, (event: any) => Promise<void> | void>();
  const synthetic: Array<Record<string, unknown>> = [];
  const prompts: Array<Record<string, unknown>> = [];
  const history = new Map<string, unknown[]>();
  const queue: V2EventLike[] = [];
  let wake: (() => void) | undefined;
  const registration = { dispose: async () => undefined };

  const ctx = {
    app: { name: "opencode", version: "2.0.29", channel: "test" },
    options,
    location: { directory, project: { id: "proj", directory, canonical: directory } },
    event: {
      subscribe({ signal }: { signal?: AbortSignal } = {}): AsyncIterable<V2EventLike> {
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              const next = queue.shift();
              if (next) { yield next; continue; }
              await new Promise<void>(resolve => {
                wake = resolve;
                signal?.addEventListener("abort", () => resolve(), { once: true });
              });
            }
          },
        };
      },
    },
    session: {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => { sessionHooks.set(name, callback); return registration; },
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory }, model: { id: "gpt-x", providerID: "openai" } }),
      context: async ({ sessionID }: { sessionID: string }) => history.get(sessionID) ?? [],
      prompt: async (input: Record<string, unknown>) => { prompts.push(input); return {}; },
      synthetic: async (input: Record<string, unknown>) => { synthetic.push(input); return {}; },
    },
    tool: {
      transform: async (callback: (editor: { add(tool: Record<string, unknown>): void }) => void) => {
        callback({ add: tool => tools.push(tool as unknown as FakeTool) });
        return registration;
      },
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => { toolHooks.set(name, callback); return registration; },
    },
    command: {
      transform: async (callback: (editor: { add(command: any): void }) => void) => {
        callback({ add: command => commands.push(command) });
        return registration;
      },
    },
    model: {
      list: async () => ({ location: { directory }, data: [{ id: "gpt-x", modelID: "gpt-x", providerID: "openai", limit: { context: 200_000, output: 32_000 } }] }),
      default: async () => ({ location: { directory }, data: { id: "gpt-x", providerID: "openai" } }),
    },
  };
  const emit = (event: V2EventLike) => { queue.push(event); wake?.(); };
  return { ctx, tools, commands, sessionHooks, toolHooks, synthetic, prompts, history, emit };
}

function turn(n: number, withTool: boolean): V2Message[] {
  const user = mid(n * 100);
  const assistant = mid(n * 100 + 10);
  const out: V2Message[] = [msg({ id: user, role: "user", content: [{ type: "text", text: `question ${n}` }] })];
  if (withTool) {
    out.push(msg({ id: assistant, role: "assistant", content: [{ type: "tool-call", id: `call_${n}`, name: "read", input: { filePath: `/f${n}.ts` } }] }));
    out.push(msg({ role: "tool", content: [{ type: "tool-result", id: `call_${n}`, name: "read", result: { type: "text", value: `contents of file ${n} `.repeat(20) } }] }));
  } else {
    out.push(msg({ id: assistant, role: "assistant", content: [{ type: "text", text: `answer ${n}` }] }));
  }
  return out;
}

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function loadPlugin(ctx: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ctx-v2-"));
  tempDirs.push(dir);
  const fake = fakeContext(dir, { ctx: { storagePath: join(dir, "storage"), ...ctx } });
  const plugin = createCtxV2Plugin({ logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } });
  const cleanup = await plugin.setup(fake.ctx);
  cleanups.push(cleanup);
  return { ...fake, plugin, cleanup, dir };
}

async function runContext(fake: Awaited<ReturnType<typeof loadPlugin>>, sessionID: string, messages: V2Message[]) {
  const event = {
    sessionID,
    agent: "build",
    model: { id: "gpt-x", providerID: "openai" },
    system: [{ type: "text", text: "You are a coding agent." }],
    messages: [...messages],
    tools: {},
    options: {},
  };
  await fake.sessionHooks.get("context")!(event);
  return event.messages;
}

describe("opencode v2 plugin binding", () => {
  it("conforms to the @opencode/plugin Plugin interface", () => {
    const plugin: Plugin.Plugin = createCtxV2Plugin();
    expect(typeof plugin.id).toBe("string");
    expect(typeof plugin.setup).toBe("function");
  });

  it("registers context-manager tools as direct (non Code Mode) JSON-schema tools and context-manager commands", async () => {
    const fake = await loadPlugin();
    expect(fake.tools.map(tool => tool.name).sort()).toEqual([
      "compress", "compress_message", "ctx_archive_release", "ctx_archive_retrieve", "ctx_archive_search", "ctx_compression_status", "ctx_tier_update",
    ]);
    for (const tool of fake.tools) {
      expect(tool.options.codemode).toBe(false);
      expect(tool.input.type).toBe("object");
      expect(typeof tool.description).toBe("string");
    }
    expect(fake.commands.map(command => command.name)).toEqual(expect.arrayContaining([
      "ctx-compress", "ctx-decompress", "ctx-recompress", "ctx-stats", "ctx-ui", "ctx-export", "ctx-import",
    ]));
    expect([...fake.sessionHooks.keys()]).toEqual(["context"]);
    expect([...fake.toolHooks.keys()].sort()).toEqual(["execute.after", "execute.before"]);
  });

  it("declares required top-level compress arguments in the V2 schema", async () => {
    // Without `required`, models omitted the top-level `topic` of range compress
    // and the planner crashed with "undefined is not an object (value.trim)".
    const fake = await loadPlugin();
    const byName = new Map(fake.tools.map(tool => [tool.name, tool]));
    const compress = byName.get("compress")!.input as { required?: string[]; properties: Record<string, unknown> };
    const single = byName.get("compress_message")!.input as { required?: string[] };
    expect(compress.required).toEqual(["topic", "content"]);
    expect(Object.keys(compress.properties)).toEqual(expect.arrayContaining(["topic", "content"]));
    expect(single.required).toEqual(["content"]);
    // Tools that declare nothing keep the previous schema shape.
    expect((byName.get("ctx_archive_search")!.input as { required?: unknown }).required).toBeUndefined();
  });

  it("registers and protects the exact status tool referenced by nudges", async () => {
    const fake = await loadPlugin();
    const guidance = buildCompressionGuidance({ candidates: [{ startRef: "m0001", endRef: "m0002", messageIds: ["a", "b"], sourceTokens: 1000 }], eligibleTokens: 1000, protectedTokens: 0 });
    const toolName = /Use (\w+) to refresh eligibility/.exec(guidance)![1];
    expect(fake.tools.some(tool => tool.name === toolName)).toBe(true);
    expect(ALWAYS_PROTECTED_TOOLS).toContain(toolName);
  });

  it("exposes metadata-only status and persists guarded attempts through the real V2 binding", async () => {
    const fake = await loadPlugin();
    const messages = [...turn(1, true), ...turn(2, false), ...turn(3, false), ...turn(4, false)];
    const sessionID = "ses_status";
    await runContext(fake, sessionID, messages);
    const context = { sessionID, messageID: mid(410), agent: "build", id: "call_status" };
    const status = fake.tools.find(tool => tool.name === "ctx_compression_status")!;
    const report = await status.execute({}, context);
    expect((report.metadata as any).candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("contents of file 1");
    const rejected = await fake.tools.find(tool => tool.name === "compress")!.execute({ topic: "x", content: [
      { startId: "m0002", endId: "m0001", summary: "x" },
    ] }, context);
    expect(String(rejected.content)).toContain("reversed-range");
    expect(String(rejected.content)).toContain("ctx_compression_status");
    // Escalation acknowledgements run on a new user turn, not anchored
    // tool-loop re-feeds (those must retain byte-identical nudge text).
    await runContext(fake, sessionID, [...messages, turn(5, false)[0]]);
    const persistence = new FilePersistence(join(fake.dir, "storage"));
    const state = await persistence.load(sessionID);
    expect(state!.nudgeEscalation.attempts).toBe(1);
    expect(state!.nudgeEscalation.attemptsAtLastCheck).toBe(1);
    expect(state!.nudgeEscalation.lastAttempt?.codes).toContain("reversed-range");
    const next = { ...state!.nudgeEscalation, attemptsAtLastCheck: 0,
      lastAttempt: { turn: 7, outcome: "failed" as const, codes: ["archive-failed"] } };
    state!.nudgeEscalation = next;
    await persistence.save(sessionID, state!);
    expect((await new FilePersistence(join(fake.dir, "storage")).load(sessionID))!.nudgeEscalation).toEqual(next);
    expect(fake.prompts).toEqual([]);
  });

  it("returns a validation rejection, not a crash, when range compress omits topic", async () => {
    const fake = await loadPlugin();
    const compress = fake.tools.find(tool => tool.name === "compress")!;
    const result = await compress.execute(
      { content: [{ startId: "m0001", endId: "m0002", summary: "s" }] },
      { sessionID: "ses_args", messageID: "msg_args", agent: "build", id: "call_args" },
    );
    expect(typeof result.content).toBe("string");
    expect(String(result.content)).not.toContain("value.trim");
  });

  it("runs the pipeline in the context hook and keeps the V2 message structure valid", async () => {
    const fake = await loadPlugin();
    const messages = [...turn(1, true), ...turn(2, false), ...turn(3, false)];
    const out = await runContext(fake, "ses_ctx", messages);
    expect(out.length).toBe(messages.length);
    expect(out.every(message => message instanceof FakeMessage)).toBe(true);
    expect(out.map(message => message.role)).toEqual(messages.map(message => message.role));
    const toolResult = out[2].content[0] as { id?: string; type: string };
    expect(toolResult).toMatchObject({ type: "tool-result", id: "call_1" });
  });

  it("compresses a range through the V2 tool and projects the summary on the next request", async () => {
    const fake = await loadPlugin({ recencyGuardTurns: 1 });
    const messages = [...turn(1, true), ...turn(2, false), ...turn(3, false), ...turn(4, false)];
    await runContext(fake, "ses_cmp", messages);

    const compress = fake.tools.find(tool => tool.name === "compress")!;
    const result = await compress.execute({
      topic: "File read",
      content: [{ startId: "m0001", endId: "m0003", summary: "## Goal & Framework\nRead /f1.ts and answered question 2." }],
    }, { sessionID: "ses_cmp", messageID: mid(410), agent: "build", id: "call_compress", signal: new AbortController().signal, progress: async () => undefined });
    expect(typeof result.content).toBe("string");
    expect(String(result.content)).not.toMatch(/error|invalid|rejected/i);

    const out = await runContext(fake, "ses_cmp", messages);
    const texts = out.map(message => message.content.map(part => (part as { text?: string }).text ?? "").join(""));
    expect(texts.some(text => text.includes("Read /f1.ts and answered question 2."))).toBe(true);
    expect(out.some(message => message.role === "tool")).toBe(false);
    expect(out.some(message => message.id === mid(100))).toBe(false);
    expect(out.some(message => message.id === mid(410))).toBe(true);
  });

  it("delivers /ctx-stats as a silent synthetic note and /ctx-compress as a model prompt", async () => {
    const fake = await loadPlugin({ recencyGuardTurns: 1 });
    const messages = [...turn(1, true), ...turn(2, false), ...turn(3, false), ...turn(4, false)];
    await runContext(fake, "ses_cmd", messages);

    await fake.commands.find(command => command.name === "ctx-stats")!.execute({ sessionID: "ses_cmd", prompt: { text: "" }, delivery: "steer" });
    expect(fake.synthetic.at(-1)).toMatchObject({ sessionID: "ses_cmd", resume: false });
    expect(String(fake.synthetic.at(-1)!.text)).toContain("ctx stats");
    expect(fake.prompts.length).toBe(0);

    await fake.commands.find(command => command.name === "ctx-compress")!.execute({ sessionID: "ses_cmd", prompt: { text: "" }, delivery: "steer" });
    expect(fake.prompts.at(-1)).toMatchObject({ sessionID: "ses_cmd", delivery: "steer" });
    expect(String(fake.prompts.at(-1)!.text)).toContain("[Manual compress trigger]");
  });

  it("exports a portable handoff bundle through the V1 client facade", async () => {
    const fake = await loadPlugin();
    const messages = [...turn(1, true), ...turn(2, false)];
    fake.history.set("ses_exp", [
      { id: mid(100), type: "user", time: { created: T0 + 100 }, text: "question 1" },
      { id: mid(110), type: "assistant", time: { created: T0 + 110, completed: T0 + 111 }, agent: "build", model: { id: "gpt-x", providerID: "openai" }, finish: "tool-calls",
        content: [{ type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { filePath: "/f1.ts" }, content: [{ type: "text", text: "contents" }] }, time: { created: T0 + 110 } }] },
      { id: mid(200), type: "user", time: { created: T0 + 200 }, text: "question 2" },
      { id: mid(210), type: "assistant", time: { created: T0 + 210, completed: T0 + 211 }, agent: "build", model: { id: "gpt-x", providerID: "openai" }, finish: "stop",
        content: [{ type: "text", text: "answer 2" }] },
    ]);
    await runContext(fake, "ses_exp", messages);
    fake.emit({ type: "session.idle", data: { sessionID: "ses_exp" } });
    await new Promise(resolve => setTimeout(resolve, 20));

    await fake.commands.find(command => command.name === "ctx-export")!.execute({ sessionID: "ses_exp", prompt: { text: "" } });
    const note = String(fake.synthetic.at(-1)?.text ?? "");
    expect(note).toContain("ctx-export: wrote");
    expect(fake.prompts.length).toBe(0);
  });

  it("feeds event-stream status and usage into the host runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-v2-rt-"));
    tempDirs.push(dir);
    const fake = fakeContext(dir, {});
    const runtime = new V2HostRuntime(fake.ctx as never);
    const client = (runtime.pluginInput().client as any).session;
    expect((await client.status({})).error).toBeDefined();

    await runtime.observe({ type: "session.status", data: { sessionID: "ses_a", status: { type: "busy" } } });
    await runtime.observe({ type: "session.step.ended", data: { sessionID: "ses_a", assistantMessageID: "msg_x", tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 1 } } } });
    expect((await client.status({})).data).toEqual({ ses_a: { type: "busy" } });
    expect(runtime.usageFor("ses_a", "msg_x")).toEqual({ input: 10, output: 2, reasoning: 0, cache: { read: 5, write: 1 } });
    await runtime.observe({ type: "session.idle", data: { sessionID: "ses_a" } });
    expect((await client.status({})).data).toEqual({});
    expect(await runtime.contextLimit({ id: "gpt-x", providerID: "openai" })).toBe(200_000);

    fake.history.set("ses_a", [{ id: mid(1), type: "user", time: { created: T0 }, text: "hi" }]);
    const messages = await client.messages({ path: { id: "ses_a" } });
    expect(messages.data[0].info).toMatchObject({ id: mid(1), sessionID: "ses_a", role: "user" });
    const session = await client.get({ path: { id: "ses_a" } });
    expect(session.data).toMatchObject({ id: "ses_a", directory: dir, model: { id: "gpt-x", providerID: "openai" } });
  });

  it("consumes the live event subscription and stops it on cleanup", async () => {
    const fake = await loadPlugin();
    fake.emit({ type: "session.status", data: { sessionID: "ses_ev", status: { type: "busy" } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    await fake.cleanup();
    cleanups.splice(cleanups.indexOf(fake.cleanup), 1);
  });

  it("never breaks a turn when the pipeline throws", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-v2-throw-"));
    tempDirs.push(dir);
    const fake = fakeContext(dir, {});
    const plugin = createCtxV2Plugin({
      logger: { warn: () => undefined, info: () => undefined, debug: () => undefined },
      v1Factory: async () => ({
        "experimental.chat.messages.transform": async () => { throw new Error("boom"); },
        "experimental.chat.system.transform": async () => undefined,
        event: async () => undefined,
        config: async () => undefined,
        "command.execute.before": async () => undefined,
        "tool.execute.before": async () => undefined,
        tool: {},
      }),
    });
    cleanups.push(await plugin.setup(fake.ctx));
    const messages = turn(1, true);
    const event = { sessionID: "ses_t", model: { id: "gpt-x", providerID: "openai" }, system: [], messages: [...messages] };
    await fake.sessionHooks.get("context")!(event);
    event.messages.forEach((message, index) => expect(message).toBe(messages[index]));
  });

  it("mirrors renamed V1 tool classes onto V2 tool names without overriding explicit ones", () => {
    const normalized = normalizeV2Options({
      ctx: {
        toolClasses: { bash: { stateless: false, retentionTurns: 9 } },
        providers: { openai: { toolClasses: { bash: { stateless: false, retentionTurns: 3 }, shell: { stateless: false, retentionTurns: 4 } } } },
      },
    }) as { ctx: { toolClasses: Record<string, unknown>; providers: { openai: { toolClasses: Record<string, unknown> } } } };
    expect(normalized.ctx.toolClasses.shell).toEqual({ stateless: false, retentionTurns: 9 });
    expect(normalized.ctx.providers.openai.toolClasses.shell).toEqual({ stateless: false, retentionTurns: 4 });
  });
});

describe("opencode v2 plugin entry", () => {
  it("exposes exactly one default { id, setup } export", async () => {
    const entry = await import("../adapters/opencode-v2/server.js");
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(entry.default.id).toBe("context-manager");
    expect(typeof entry.default.setup).toBe("function");
  });
});
