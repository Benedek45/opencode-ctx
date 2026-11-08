// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";

import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import { decodeBundle } from "../adapters/opencode/portable-context.js";
import {
  REMOTE_CONTEXT_BRIDGE_KEY,
  type RemoteContextBridge,
} from "../adapters/opencode/remote-context-bridge.js";
import type { HostMessageEntry, HostToolPart } from "../adapters/opencode/host-types.js";
import { sessionHistoryToHost } from "../adapters/opencode-v2/map.js";

const dirs: string[] = [];
afterEach(async () => {
  const registry = (globalThis as any)[REMOTE_CONTEXT_BRIDGE_KEY] as Map<string, RemoteContextBridge> | undefined;
  const ownedRoots = dirs.splice(0);
  for (const key of registry?.keys() ?? []) {
    if (ownedRoots.some(root => key === root || key.startsWith(`${root}${sep}`))) registry!.delete(key);
  }
  for (const dir of ownedRoots) {
    await rm(dir, { force: true, recursive: true });
  }
});

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ctx-remote-bridge-")));
  dirs.push(dir);
  return dir;
}

function user(sessionID: string, id: string, text: string, created: number): HostMessageEntry {
  return {
    info: { id, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ type: "text", id: `${id}-text`, sessionID, messageID: id, text }],
  };
}

function assistant(sessionID: string, id: string, parentID: string, text: string, created: number): HostMessageEntry {
  return {
    info: { id, sessionID, role: "assistant", parentID, time: { created, completed: created + 1 }, providerID: "p", modelID: "m", mode: "build",
      path: { cwd: "/OLD", root: "/OLD" }, cost: 0, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
    parts: [{ type: "text", id: `${id}-text`, sessionID, messageID: id, text }],
  };
}

function busyAssistant(sessionID: string): HostMessageEntry {
  const completed: HostToolPart = {
    type: "tool", id: "part-read", sessionID, messageID: "a2", callID: "call-read", tool: "read",
    state: { status: "completed", input: { filePath: "safe.ts" }, output: "LATEST COMPLETED TOOL OUTPUT", title: "safe.ts", time: { start: 7, end: 8 } },
  };
  const remote: HostToolPart = {
    type: "tool", id: "part-remote", sessionID, messageID: "a2", callID: "call-remote", tool: "remote_submit",
    state: { status: "running", input: { prompt: "SELF REFERENTIAL REMOTE INPUT" }, title: "remote", time: { start: 9 } },
  };
  return {
    info: { id: "a2", sessionID, role: "assistant", parentID: "u2", time: { created: 6 }, providerID: "p", modelID: "m", mode: "build",
      path: { cwd: "/OLD", root: "/OLD" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [
      { type: "text", id: "a2-before", sessionID, messageID: "a2", text: "PRECEDING ASSISTANT TEXT" },
      completed,
      { type: "text", id: "a2-middle", sessionID, messageID: "a2", text: "TEXT AFTER COMPLETED TOOL" },
      remote,
      { type: "text", id: "a2-after", sessionID, messageID: "a2", text: "LATER UNCOMPLETED SELF CONTENT" },
    ],
  };
}

function busyAssistantFor(sessionID: string, id: string, parentID: string, callID: string): HostMessageEntry {
  return {
    info: { id, sessionID, role: "assistant", parentID, time: { created: 2 }, providerID: "p", modelID: "m", mode: "build",
      path: { cwd: "/OLD", root: "/OLD" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [{
      type: "tool", id: `${id}-remote`, sessionID, messageID: id, callID, tool: "remote_submit",
      state: { status: "running", input: { prompt: `remote ${sessionID}` }, title: "remote", time: { start: 2 } },
    }],
  };
}

function pluginInput(root: string, histories: Map<string, HostMessageEntry[]>, calls: string[] = []) {
  return { directory: root, worktree: root, client: {
    session: {
      get: async (args: any) => {
        calls.push("get");
        if (!histories.has(args.path.id)) throw new Error("session not found in this plugin workspace");
        return { data: { id: args.path.id } };
      },
      messages: async (args: any) => { calls.push("messages"); return { data: structuredClone(histories.get(args.path.id) ?? []) }; },
      status: async () => ({ data: { source: { type: "busy" } } }),
    },
    config: { get: async () => ({ data: { model: "p/m" } }), providers: async () => ({ data: { providers: [{ id: "p", models: { m: { id: "m", limit: { context: 1_000_000 } } } }] } }) },
  } };
}

function options(root: string) {
  return { ctx: { storagePath: join(root, "store"), tokenizer: "char", recencyGuardTurns: 0, compressionRecencyRequests: 0, contextTiers: { warmBudgetMode: "advisory" } } };
}

function bridge(root: string): RemoteContextBridge {
  const registry = (globalThis as any)[REMOTE_CONTEXT_BRIDGE_KEY] as Map<string, RemoteContextBridge>;
  const result = registry?.get(root);
  if (!result) throw new Error("bridge was not registered");
  return result;
}

function bundleText(bytes: Uint8Array): string {
  const bundle = decodeBundle(bytes);
  return Object.values(bundle.payload.blobs).map(blob => blob.data).join("\n");
}

describe("remote context bridge", () => {
  it("rejects native V2 files rather than silently capturing a text-only remote handoff", async () => {
    const root = await temp();
    const history = sessionHistoryToHost([{ id: "u-files", type: "user", text: "inspect image", files: [{ uri: "file:///image.png" }] }], "media-session");
    await CtxPlugin(pluginInput(root, new Map([["media-session", history]])) as any, options(root));
    await expect(bridge(root).capture({ sessionId: "media-session", directory: root, context: { mode: "full" } })).rejects.toThrow("unsupported visible history part: v2-history-files");
  });
  it("replaces a stale same-owner exact-directory bridge on plugin reload", async () => {
    const directory = await temp();
    const worktree = await temp();
    const input = pluginInput(worktree, new Map()) as any;
    input.directory = directory;
    await CtxPlugin(input, options(worktree));
    const registry = (globalThis as any)[REMOTE_CONTEXT_BRIDGE_KEY] as Map<string, RemoteContextBridge>;
    const first = registry.get(directory)!;
    expect(registry.has(worktree)).toBe(false);

    await CtxPlugin(input, options(worktree));
    const replacement = registry.get(directory)!;
    expect(replacement).not.toBe(first);
    expect(registry.has(worktree)).toBe(false);
    expect((await replacement.capture({ sessionId: "none", directory, context: { mode: "none" } })).selection.messageCount).toBe(0);
  });

  it("does not let a different worktree owner steal the same exact directory", async () => {
    const directory = await temp();
    const firstWorktree = await temp();
    const secondWorktree = await temp();
    const firstInput = pluginInput(firstWorktree, new Map()) as any;
    firstInput.directory = directory;
    await CtxPlugin(firstInput, options(firstWorktree));
    const registry = (globalThis as any)[REMOTE_CONTEXT_BRIDGE_KEY] as Map<string, RemoteContextBridge>;
    const owner = registry.get(directory)!;
    expect(registry.has(firstWorktree)).toBe(false);

    const secondInput = pluginInput(secondWorktree, new Map()) as any;
    secondInput.directory = directory;
    await CtxPlugin(secondInput, options(secondWorktree));
    expect(registry.get(directory)).toBe(owner);
    expect(registry.has(firstWorktree)).toBe(false);
    expect(registry.has(secondWorktree)).toBe(false);
  });

  it("routes two subdirectory sessions sharing one worktree in either load order", async () => {
    for (const reverse of [false, true]) {
      const worktree = await temp();
      const firstDirectory = join(worktree, "a");
      const secondDirectory = join(worktree, "b");
      await mkdir(firstDirectory);
      await mkdir(secondDirectory);
      const firstHistory = new Map<string, HostMessageEntry[]>([["session-a", [
        user("session-a", "ua", "SESSION A ONLY", 1),
        busyAssistantFor("session-a", "aa", "ua", "call-a"),
      ]]]);
      const secondHistory = new Map<string, HostMessageEntry[]>([["session-b", [
        user("session-b", "ub", "SESSION B ONLY", 1),
        busyAssistantFor("session-b", "ab", "ub", "call-b"),
      ]]]);
      const firstInput = pluginInput(worktree, firstHistory) as any;
      firstInput.directory = firstDirectory;
      const secondInput = pluginInput(worktree, secondHistory) as any;
      secondInput.directory = secondDirectory;
      for (const input of reverse ? [secondInput, firstInput] : [firstInput, secondInput]) {
        await CtxPlugin(input, options(worktree));
      }

      const firstBridge = bridge(firstDirectory);
      const secondBridge = bridge(secondDirectory);
      expect(firstBridge).not.toBe(secondBridge);
      const first = await firstBridge.capture({ sessionId: "session-a", directory: firstDirectory, messageId: "aa", callId: "call-a" });
      const second = await secondBridge.capture({ sessionId: "session-b", directory: secondDirectory, messageId: "ab", callId: "call-b" });
      expect(bundleText(first.bytes)).toContain("SESSION A ONLY");
      expect(bundleText(first.bytes)).not.toContain("SESSION B ONLY");
      expect(bundleText(second.bytes)).toContain("SESSION B ONLY");
      expect(bundleText(second.bytes)).not.toContain("SESSION A ONLY");
      await expect(firstBridge.capture({ sessionId: "session-b", directory: firstDirectory, messageId: "ab", callId: "call-b" })).rejects.toThrow();
      await expect(secondBridge.capture({ sessionId: "session-a", directory: secondDirectory, messageId: "aa", callId: "call-a" })).rejects.toThrow();
      expect(((globalThis as any)[REMOTE_CONTEXT_BRIDGE_KEY] as Map<string, RemoteContextBridge>).has(worktree)).toBe(false);
    }
  });

  it("keeps root and child directory owners isolated and reloadable", async () => {
    const worktree = await temp();
    const child = join(worktree, "child");
    await mkdir(child);
    const rootHistory = new Map<string, HostMessageEntry[]>([["root-session", [
      user("root-session", "ur", "ROOT SESSION ONLY", 1),
      busyAssistantFor("root-session", "ar", "ur", "call-root"),
    ]]]);
    const childHistory = new Map<string, HostMessageEntry[]>([["child-session", [
      user("child-session", "uc", "CHILD SESSION ONLY", 1),
      busyAssistantFor("child-session", "ac", "uc", "call-child"),
    ]]]);
    const rootInput = pluginInput(worktree, rootHistory) as any;
    const childInput = pluginInput(worktree, childHistory) as any;
    childInput.directory = child;
    await CtxPlugin(childInput, options(worktree));
    await CtxPlugin(rootInput, options(worktree));
    const childBefore = bridge(child);
    const rootBefore = bridge(worktree);

    await CtxPlugin(rootInput, options(worktree));
    await CtxPlugin(childInput, options(worktree));
    const rootAfter = bridge(worktree);
    const childAfter = bridge(child);
    expect(rootAfter).not.toBe(rootBefore);
    expect(childAfter).not.toBe(childBefore);
    expect(rootAfter).not.toBe(childAfter);
    const rootCapture = await rootAfter.capture({ sessionId: "root-session", directory: worktree, messageId: "ar", callId: "call-root" });
    const childCapture = await childAfter.capture({ sessionId: "child-session", directory: child, messageId: "ac", callId: "call-child" });
    expect(bundleText(rootCapture.bytes)).toContain("ROOT SESSION ONLY");
    expect(bundleText(rootCapture.bytes)).not.toContain("CHILD SESSION ONLY");
    expect(bundleText(childCapture.bytes)).toContain("CHILD SESSION ONLY");
    expect(bundleText(childCapture.bytes)).not.toContain("ROOT SESSION ONLY");
  });

  it("captures a busy tool loop without its own remote_submit call and does not mutate durable state", async () => {
    const root = await temp();
    const source = [
      user("source", "u1", "EARLY USER", 1),
      assistant("source", "a1", "u1", "EARLY ANSWER", 2),
      user("source", "u2", "LATEST USER INTENT", 5),
    ];
    const histories = new Map([["source", source]]);
    const calls: string[] = [];
    const hooks = await CtxPlugin(pluginInput(root, histories, calls), options(root)) as Record<string, any>;
    const transformed = { messages: structuredClone(source) };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "source" }, transformed);
    histories.set("source", [...source, busyAssistant("source")]);
    const persistence = new FilePersistence(join(root, "store"));
    const before = (await persistence.load("source"))!;
    const capture = await bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote" });
    const text = bundleText(capture.bytes);
    expect(capture.bundleDigest).toBe(decodeBundle(capture.bytes).sha256);
    expect(capture.selection).toEqual({ mode: "full", messageCount: 4, blockCount: 0, recoverableBlockCount: 0, summaryOnlyBlockCount: 0 });
    expect(text).toContain("LATEST USER INTENT");
    expect(text).toContain("LATEST COMPLETED TOOL OUTPUT");
    expect(text).toContain("TEXT AFTER COMPLETED TOOL");
    expect(text).not.toContain("SELF REFERENTIAL REMOTE INPUT");
    expect(text).not.toContain("LATER UNCOMPLETED SELF CONTENT");
    expect(calls).toEqual(["get", "messages"]);
    const after = (await persistence.load("source"))!;
    expect(after.currentTurn).toBe(before.currentTurn);
    expect(after.stats).toEqual(before.stats);
    expect(after.messageIds).toEqual(before.messageIds);
    expect(after.lastCacheBustTurn).toBe(before.lastCacheBustTurn);
    await expect(lstat(join(root, ".ctx", "context.json"))).rejects.toThrow();

    const none = await bridge(root).capture({ sessionId: "not-loaded", directory: root, context: { mode: "none" } });
    expect(none.selection).toEqual({ mode: "none", messageCount: 0, blockCount: 0, recoverableBlockCount: 0, summaryOnlyBlockCount: 0 });
    expect(decodeBundle(none.bytes).payload.sequence).toEqual([]);
    expect(calls).toEqual(["get", "messages"]);
  });

  it("selects exact visible refs, ranges, and COLD blocks without reading unrelated block sources", async () => {
    const root = await temp();
    const source = [
      user("source", "u1", "BLOCK ORIGINAL SOURCE", 1),
      assistant("source", "a1", "u1", "VISIBLE RANGE ANSWER", 2),
      user("source", "u2", "VISIBLE RANGE USER", 5),
    ];
    const histories = new Map([["source", source]]);
    const hooks = await CtxPlugin(pluginInput(root, histories), options(root)) as Record<string, any>;
    const transformed = { messages: structuredClone(source) };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "source" }, transformed);
    const toolContext = { sessionID: "source", messageID: "tool-message", callID: "compress-call", ask: async () => {} };
    const compressed = await hooks.tool.compress_message.execute({
      topic: "early source",
      content: [{ messageId: "m0001", topic: "early source", summary: "COLD BLOCK SUMMARY" }],
    }, toolContext);
    expect(compressed.output).toContain("b1");
    const tiered = await hooks.tool.ctx_tier_update.execute({ promoteBlockIds: [], demoteBlockIds: ["b1"] }, toolContext);
    expect(tiered.output).toContain("b1");
    histories.set("source", [...source, busyAssistant("source")]);

    const selectedBlock = await bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote",
      context: { mode: "selected", blockIds: ["b1"] } });
    expect(selectedBlock.selection).toEqual({ mode: "selected", messageCount: 0, blockCount: 1, recoverableBlockCount: 1, summaryOnlyBlockCount: 0 });
    expect(bundleText(selectedBlock.bytes)).toContain("BLOCK ORIGINAL SOURCE");
    expect(bundleText(selectedBlock.bytes)).toContain("COLD BLOCK SUMMARY");

    const summaryOnly = await bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote",
      context: { mode: "selected", blockIds: ["b1"], includeRecovery: false } });
    const summaryBundle = decodeBundle(summaryOnly.bytes);
    expect(summaryOnly.selection).toEqual({ mode: "selected", messageCount: 0, blockCount: 1, recoverableBlockCount: 0, summaryOnlyBlockCount: 1 });
    expect(summaryBundle.payload.roots[0].recoverable).toBe(false);
    expect(summaryBundle.payload.roots[0].tier).toBe("warm");
    expect(bundleText(summaryOnly.bytes)).not.toContain("BLOCK ORIGINAL SOURCE");

    const ranged = await bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote",
      context: { mode: "selected", ranges: [{ startId: "m0002", endId: "m0003" }] } });
    expect(ranged.selection.messageCount).toBe(2);
    expect(bundleText(ranged.bytes)).toContain("VISIBLE RANGE ANSWER");
    expect(bundleText(ranged.bytes)).toContain("VISIBLE RANGE USER");
    expect(bundleText(ranged.bytes)).not.toContain("BLOCK ORIGINAL SOURCE");

    const state = (await new FilePersistence(join(root, "store")).load("source"))!;
    await new FilesystemContentStore(join(root, "store")).delete(state.blockRegistry.get("b1")!.durableSourceRef!);
    const unrelated = await bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote",
      context: { mode: "selected", messageRefs: ["m0003"] } });
    expect(unrelated.selection).toEqual({ mode: "selected", messageCount: 1, blockCount: 0, recoverableBlockCount: 0, summaryOnlyBlockCount: 0 });
    expect(bundleText(unrelated.bytes)).toContain("VISIBLE RANGE USER");
  });

  it("rejects stale selectors, cross-session blocks, invocation mismatches, and mixed directories", async () => {
    const root = await temp();
    const other = await temp();
    const histories = new Map<string, HostMessageEntry[]>([["source", [user("source", "u1", "SOURCE", 1)]]]);
    const hooks = await CtxPlugin(pluginInput(root, histories), options(root)) as Record<string, any>;
    const transformed = { messages: structuredClone(histories.get("source")!) };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "source" }, transformed);
    histories.set("source", [...histories.get("source")!, busyAssistant("source")]);
    await expect(bridge(root).capture({ sessionId: "source", directory: other })).rejects.toThrow("does not belong");
    await expect(bridge(root).capture({ sessionId: "source", directory: root, messageId: "wrong", callId: "call-remote" })).rejects.toThrow("different messages");
    await expect(bridge(root).capture({ sessionId: "source", directory: root, callId: "missing" })).rejects.toThrow("not found");
    await expect(bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote",
      context: { mode: "selected", messageRefs: ["m9999"] } })).rejects.toThrow("stale or unknown");
    await expect(bridge(root).capture({ sessionId: "source", directory: root, messageId: "a2", callId: "call-remote",
      context: { mode: "selected", blockIds: ["b1"] } })).rejects.toThrow("not an active root");
    await expect(bridge(root).capture({ sessionId: "source", directory: root,
      context: { mode: "selected", messageRefs: [] } })).rejects.toThrow("at least one selector");
  });

  it("captures from persisted state after a cold process restart", async () => {
    const root = await temp();
    const source = [user("source", "u1", "COLD RESTART USER", 1), assistant("source", "a1", "u1", "COLD RESTART ANSWER", 2)];
    const histories = new Map([["source", source]]);
    const hooks = await CtxPlugin(pluginInput(root, histories), options(root)) as Record<string, any>;
    const transformed = { messages: structuredClone(source) };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "source" }, transformed);
    const busy = [...source, busyAssistant("source")];
    const pluginPath = new URL("../adapters/opencode/plugin.ts", import.meta.url).pathname;
    const keyPath = new URL("../adapters/opencode/remote-context-bridge.ts", import.meta.url).pathname;
    const script = `import { CtxPlugin } from ${JSON.stringify(pluginPath)};
      import { REMOTE_CONTEXT_BRIDGE_KEY } from ${JSON.stringify(keyPath)};
      const history=${JSON.stringify(busy)};
      const root=${JSON.stringify(root)};
      await CtxPlugin({directory:root,worktree:root,client:{session:{get:async a=>({data:{id:a.path.id}}),messages:async()=>({data:history})}}},${JSON.stringify(options(root))});
      const bridge=globalThis[REMOTE_CONTEXT_BRIDGE_KEY].get(root);
      const result=await bridge.capture({sessionId:'source',directory:root,messageId:'a2',callId:'call-remote'});
      process.stdout.write('BRIDGE_RESULT:'+JSON.stringify({selection:result.selection,text:new TextDecoder().decode(result.bytes)}));`;
    const output = execFileSync(process.execPath, ["--eval", script], { encoding: "utf8" });
    const result = JSON.parse(output.split("BRIDGE_RESULT:").at(-1)!);
    expect(result.selection.messageCount).toBe(3);
    expect(result.text).toContain("COLD RESTART USER");
    expect(result.text).toContain("LATEST COMPLETED TOOL OUTPUT");
    expect(result.text).not.toContain("SELF REFERENTIAL REMOTE INPUT");
  });
});
