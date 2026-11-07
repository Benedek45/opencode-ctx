// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import { decodeBundle } from "../adapters/opencode/portable-context.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true }); });
async function temp() { const dir = await realpath(await mkdtemp(join(tmpdir(), "ctx-handoff-plugin-"))); dirs.push(dir); return dir; }
function user(sessionID: string, id: string, text: string): HostMessageEntry {
  return { info: { id, sessionID, role: "user", time: { created: 100 }, agent: "build", model: { providerID: "p", modelID: "m" } }, parts: [{ type: "text", id: id + "-p", sessionID, messageID: id, text }] };
}
function assistant(sessionID: string, id: string, text: string): HostMessageEntry {
  return { info: { id, sessionID, role: "assistant", parentID: "u1", time: { created: 101, completed: 102 }, providerID: "p", modelID: "m", mode: "build", path: { cwd: "/OLD_MACHINE", root: "/OLD_MACHINE" }, cost: 1, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }, parts: [{ type: "text", id: id + "-p", sessionID, messageID: id, text }] };
}
function ctx(root: string, histories: Map<string, HostMessageEntry[]>) {
  return { worktree: root, directory: root, client: {
    session: { get: async (args: any) => ({ data: { id: args.path.id } }), messages: async (args: any) => ({ data: structuredClone(histories.get(args.path.id) ?? []) }), status: async () => ({ data: {} }) },
    config: { get: async () => ({ data: { model: "p/m" } }), providers: async () => ({ data: { providers: [{ id: "p", models: { m: { id: "m", limit: { context: 1_000_000, output: 8192 } } } }] } }) },
  } };
}
function opts(root: string) { return { ctx: { storagePath: join(root, "private-store"), tokenizer: "char", recencyGuardTurns: 0, compressionRecencyRequests: 0, contextTiers: { warmBudgetMode: "advisory" } } }; }
async function command(hooks: Record<string, any>, sessionID: string, name: string, args = "") {
  const parts: any[] = [{ type: "text", text: "ORIGINAL TEMPLATE" }];
  const out = { parts };
  await hooks["command.execute.before"]({ command: name, sessionID, arguments: args }, out);
  expect(out.parts).toBe(parts);
  for (const part of parts) {
    expect(/^prt_[a-f0-9]{32}$/.test(part.id)).toBe(true);
    expect(/^msg_[a-f0-9]{32}$/.test(part.messageID)).toBe(true);
  }
  return parts.map(part => part.text).join("\n");
}
function allText(entries: HostMessageEntry[]) { return entries.flatMap(entry => entry.parts).filter(part => part.type === "text").map(part => (part as { text: string }).text).join("\n"); }

describe("portable slash command integration", () => {
  it("uses fresh host-compatible command part IDs on repeated calls", async () => {
    const root = await temp();
    const hooks = await CtxPlugin(ctx(root, new Map()), opts(root)) as Record<string, any>;
    const first = { parts: [] as any[] };
    const second = { parts: [] as any[] };
    for (const output of [first, second]) {
      await hooks["command.execute.before"]({ command: "ctx-stats", sessionID: "destination", arguments: "" }, output);
      expect(/^prt_[a-f0-9]{32}$/.test(output.parts[0].id)).toBe(true);
    }
    expect(first.parts[0].id).not.toBe(second.parts[0].id);
  });

  it("exports the fresh final assistant reply, imports before any transform, and survives a true process restart", async () => {
    const root = await temp();
    const histories = new Map<string, HostMessageEntry[]>([["source", [user("source", "u1", "PRESERVE USER INTENT")]]]);
    const hooks = await CtxPlugin(ctx(root, histories), opts(root)) as Record<string, any>;
    const initial = { messages: structuredClone(histories.get("source")!) };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "source" }, initial);
    // This reply was never included in a previous outgoing transform.
    histories.get("source")!.push(assistant("source", "a1", "LATEST COMPLETED ASSISTANT ANSWER"));
    expect(await command(hooks, "source", "ctx-export")).toContain("wrote .ctx/context.json");
    const bundle = decodeBundle(await readFile(join(root, ".ctx/context.json")));
    const encoded = JSON.stringify(bundle);
    expect(encoded).toContain("LATEST COMPLETED ASSISTANT ANSWER");
    expect(encoded).not.toContain("OLD_MACHINE");
    expect(encoded).not.toContain("Context status");
    const receipt = await command(hooks, "destination", "ctx-import");
    expect(receipt).toContain("imported durable historical context");
    expect(receipt).not.toContain("LATEST COMPLETED ASSISTANT ANSWER");
    expect(histories.has("destination")).toBe(false); // no host writes
    const nextUser = user("destination", "du1", "CONTINUE HERE");
    const next = { messages: [nextUser] };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "destination" }, next);
    expect(allText(next.messages)).toContain("LATEST COMPLETED ASSISTANT ANSWER");
    expect(next.messages.at(-1)?.info.id).toBe("du1");
    const storage = join(root, "private-store");
    const saved = (await new FilesystemContentStore(storage).loadSessionHistory("destination"))!;
    expect(saved.rawEntries.map(item => item.info.id)).toEqual(["du1"]);
    expect(saved.projectedEntries.length).toBeGreaterThan(saved.rawEntries.length);
    const stateBefore = (await new FilePersistence(storage).load("destination"))!;
    histories.set("destination", [nextUser]);
    expect(await command(hooks, "destination", "ctx-import")).toContain("already imported; current progress preserved");
    expect((await new FilePersistence(storage).load("destination"))?.stats.totalTurns).toBe(stateBefore.stats.totalTurns);

    await rm(join(root, ".ctx"), { recursive: true });
    // A new process guarantees no sharedSessionStore or content-store cache reuse.
    const pluginPath = new URL("../adapters/opencode/plugin.ts", import.meta.url).pathname;
    const script = `import { CtxPlugin } from ${JSON.stringify(pluginPath)};
      import { readFile } from 'node:fs/promises';
      const hooks = await CtxPlugin({}, ${JSON.stringify({ ctx: { ...opts(root).ctx, controlServer: { enabled: true, port: 0, openBrowser: false } } })});
      const html=await readFile(${JSON.stringify(join(storage, "ctx-control.html"))},'utf8');
      const url=new URL(JSON.parse(html.match(/location\\.replace\\((".*")\\)/)[1]));
      const response=await fetch(url.origin+'/api/sessions/destination',{headers:{Authorization:'Bearer '+url.hash.replace(/^#token=/,'')}});
      const dashboard=await response.json();
      const out = { messages: [${JSON.stringify(user("destination", "du2", "AFTER RESTART"))}] };
      await hooks['experimental.chat.messages.transform']({sessionID:'destination'},out);
      await new Promise(resolve=>process.stdout.write('HANDOFF_RESULT:'+JSON.stringify({messages:out.messages,dashboard}),resolve));
      process.exit(0);`;
    const child = JSON.parse(execFileSync(process.execPath, ["--eval", script], { encoding: "utf8" }).split("HANDOFF_RESULT:").at(-1)!);
    const restarted = child.messages as HostMessageEntry[];
    expect(child.dashboard.data.rawHostHistory.map((item: any) => item.id)).toEqual(["du1"]);
    expect(JSON.stringify(child.dashboard.data.projectedContext)).toContain("LATEST COMPLETED ASSISTANT ANSWER");
    expect(allText(restarted)).toContain("LATEST COMPLETED ASSISTANT ANSWER");
    expect(allText(restarted)).toContain("PRESERVE USER INTENT");
    expect(restarted.at(-1)?.info.id).toBe("du2");
    const after = (await new FilesystemContentStore(storage).loadSessionHistory("destination"))!;
    expect(after.rawEntries.map(item => item.info.id)).toEqual(["du2"]);
  });

  it("compresses imported HOT context, exports flat roots, and decompresses after restart", async () => {
    const root = await temp();
    const histories = new Map<string, HostMessageEntry[]>([["source", [user("source", "u1", "SOURCE DETAIL ".repeat(100)), assistant("source", "a1", "SOURCE RESPONSE")]]]);
    const hooks = await CtxPlugin(ctx(root, histories), { ctx: { ...opts(root).ctx, sessionCache: { maxSessions: 1 } } }) as Record<string, any>;
    expect(await command(hooks, "source", "ctx-export", '".ctx-context/with spaces.json"')).toContain("wrote");
    expect(await command(hooks, "destination", "ctx-import", '".ctx-context/with spaces.json"')).toContain("imported durable");
    const next = { messages: [user("destination", "du1", "NEW QUESTION")] };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "destination" }, next);
    const storage = join(root, "private-store");
    const before = (await new FilePersistence(storage).load("destination"))!;
    const first = next.messages.find(item => item.info.id.startsWith("__ctx_import_"))!;
    const ref = before.messageIds.byRawId.get(first.info.id)!;
    const result = await hooks.tool.compress_message.execute({ topic: "imported detail", content: [{ messageId: ref, topic: "detail", summary: "IMPORTED DETAIL SUMMARY" }] }, { sessionID: "destination", messageID: "compress", callID: "compress", ask: async () => {} });
    expect(result.output).toContain("b1");
    expect(result.output).not.toContain("rejected");
    const refeed = { messages: [user("destination", "du2", "AFTER COMPRESSION")] };
    await hooks["experimental.chat.messages.transform"]({ sessionID: "destination" }, refeed);
    expect(allText(refeed.messages)).toContain("IMPORTED DETAIL SUMMARY");
    expect(allText(refeed.messages)).not.toContain("SOURCE DETAIL SOURCE DETAIL");
    // A different chat exceeds the one-resident-session policy. The imported
    // seed and compression source must be reloaded from their immutable stores.
    const originalLoad = FilesystemContentStore.prototype.loadSessionHistory;
    let destinationLoads = 0;
    FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
      if (id === "destination") destinationLoads++;
      return originalLoad.call(this, id);
    };
    try {
      await hooks["experimental.chat.messages.transform"]({ sessionID: "another" },
        { messages: [user("another", "other-u1", "Another active chat")] });
      await new Promise(resolve => setTimeout(resolve, 15));
      const afterEviction = { messages: [user("destination", "du2", "AFTER COMPRESSION")] };
      await hooks["experimental.chat.messages.transform"]({ sessionID: "destination" }, afterEviction);
      expect(destinationLoads).toBeGreaterThan(0);
      expect(allText(afterEviction.messages)).toContain("IMPORTED DETAIL SUMMARY");
      expect(allText(afterEviction.messages)).not.toContain("SOURCE DETAIL SOURCE DETAIL");
    } finally { FilesystemContentStore.prototype.loadSessionHistory = originalLoad; }

    const pluginPath = new URL("../adapters/opencode/plugin.ts", import.meta.url).pathname;
    const script = `import { CtxPlugin } from ${JSON.stringify(pluginPath)};
      const hooks = await CtxPlugin({}, ${JSON.stringify(opts(root))});
      const cmd={parts:[]}; await hooks['command.execute.before']({command:'ctx-decompress',sessionID:'destination',arguments:'b1'},cmd);
      const out={messages:[${JSON.stringify(user("destination", "du3", "RESTORED"))}]};
      await hooks['experimental.chat.messages.transform']({sessionID:'destination'},out);
      process.stdout.write('HANDOFF_RESULT:'+JSON.stringify({cmd,messages:out.messages}));`;
    const restored = JSON.parse(execFileSync(process.execPath, ["--eval", script], { encoding: "utf8" }).split("HANDOFF_RESULT:").at(-1)!);
    expect(JSON.stringify(restored.cmd)).toContain("restored block b1");
    expect(allText(restored.messages)).toContain("SOURCE DETAIL SOURCE DETAIL");
    expect(allText(restored.messages)).not.toContain("IMPORTED DETAIL SUMMARY");
  });

  it("rejects populated full history and missing host API without publishing imported state", async () => {
    const root = await temp();
    const histories = new Map<string, HostMessageEntry[]>([["source", [user("source", "u1", "SOURCE"), assistant("source", "a1", "ANSWER")]], ["used", [user("used", "u1", "UNRELATED")]]]);
    const hooks = await CtxPlugin(ctx(root, histories), opts(root)) as Record<string, any>;
    expect(await command(hooks, "source", "ctx-export")).toContain("wrote");
    expect(await command(hooks, "used", "ctx-import")).toContain("new empty chat");
    expect((await new FilePersistence(join(root, "private-store")).load("used"))?.importedContext).toBeUndefined();
    const unavailable = await CtxPlugin({}, opts(root)) as Record<string, any>;
    expect(await command(unavailable, "fresh", "ctx-import")).toContain("ctx-import:");
    expect((await new FilePersistence(join(root, "private-store")).load("fresh"))?.importedContext).toBeUndefined();
  });

  it("uses system-first model identity and provider overrides instead of the configured default model", async () => {
    const root = await temp();
    const histories = new Map<string, HostMessageEntry[]>([["source", [user("source", "u1", "SOURCE"), assistant("source", "a1", "ANSWER")]]]);
    const options = opts(root);
    const hooks = await CtxPlugin(ctx(root, histories), { ctx: { ...options.ctx, providers: { anthropic: { hardCap: 100 } } } }) as Record<string, any>;
    expect(await command(hooks, "source", "ctx-export")).toContain("wrote");
    const system = { system: ["DESTINATION SYSTEM TEXT"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "destination", model: { id: "claude-sonnet", providerID: "anthropic", limit: { context: 200_000 } } }, system);
    expect(system.system).toEqual(["DESTINATION SYSTEM TEXT"]);
    expect(await command(hooks, "destination", "ctx-import")).toContain("destination cap 100");
    expect((await new FilePersistence(join(root, "private-store")).load("destination"))?.importedContext).toBeUndefined();
  });
});
