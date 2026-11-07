import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import type {
  HostMessageEntry,
  HostToolContext,
  MessagesTransformOutput,
  ToolExecuteBeforeInput,
  ToolExecuteBeforeOutput,
} from "../adapters/opencode/host-types.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function tempPath(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ctx-archive-routing-"));
  cleanupPaths.push(path);
  return path;
}

function user(id: string, sessionId: string, text: string): HostMessageEntry {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: Number(id.replace(/\D/g, "")) || 1 },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [{ id: `${id}-text`, sessionID: sessionId, messageID: id, type: "text", text }],
  };
}

function assistantWithTool(
  id: string,
  sessionId: string,
  callId: string,
  output: string
): HostMessageEntry {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "assistant",
      time: { created: 2, completed: 3 },
      parentID: "u1",
      modelID: "test",
      providerID: "test",
      mode: "test",
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{
      id: `${id}-tool`,
      sessionID: sessionId,
      messageID: id,
      type: "tool",
      callID: callId,
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "/project/large.txt" },
        output,
        title: "Read large file",
        time: { start: 1, end: 2 },
      },
    }],
  };
}

function compressionContext(sessionID: string): HostToolContext {
  return {
    sessionID,
    messageID: "compress-call",
    agent: "test",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe("OpenCode content archive integration", () => {
  it("keeps raw and projected snapshots distinct and archives original tool output", async () => {
    const storagePath = await tempPath();
    const sessionId = "archive-session";
    const originalOutput = "ORIGINAL-TOOL-OUTPUT\n" + "x".repeat(8_000);
    const entries = [
      user("u1", sessionId, "Read the file"),
      assistantWithTool("a1", sessionId, "call-1", originalOutput),
    ];
    for (let i = 2; i <= 14; i++) entries.push(user(`u${i}`, sessionId, `Later turn ${i}`));

    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        costRoi: { enabled: false },
        recencyGuardTurns: 0,
        minRepruneInterval: 0,
        clearAtLeast: 0,
        nudges: { maskTriggerThreshold: 0 },
      },
    }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    const output = { messages: entries };
    await transform({}, output);

    const store = new FilesystemContentStore(storagePath);
    const history = await store.loadSessionHistory(sessionId);
    const rawMessages = await store.list({ sessionId, kind: "history-message" });
    const toolOutputs = await store.list({ sessionId, kind: "tool-output", callId: "call-1" });

    expect(history).toBeDefined();
    expect(rawMessages.length).toBe(entries.length);
    const rawSnapshot = history!.rawEntries;
    const projectedSnapshot = history!.projectedEntries;
    const rawTool = rawSnapshot[1].parts[0] as { state: { output: string } };
    const projectedTool = projectedSnapshot[1].parts[0] as { state: { output: string } };
    expect(rawTool.state.output).toBe(originalOutput);
    expect(projectedTool.state.output).not.toBe(originalOutput);
    expect(JSON.stringify(rawSnapshot)).not.toBe(JSON.stringify(projectedSnapshot));
    expect(toolOutputs).toHaveLength(1);
    expect(toolOutputs[0].data).toBe(originalOutput);
  });

  it("content-store failures do not break message transforms", async () => {
    const parent = await tempPath();
    const storagePath = join(parent, "not-a-directory");
    await writeFile(storagePath, "occupied", "utf8");
    const hooks = await CtxPlugin({}, { ctx: { storagePath, recencyGuardTurns: 0 } }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    const output = { messages: [user("u1", "failure-session", "Still run the turn")] };

    await transform({}, output);
    expect(output.messages[0].parts[0].type).toBe("text");
  });

  it("does not commit compression state when mandatory source archival fails", async () => {
    const parent = await tempPath();
    const storagePath = join(parent, "blocked-storage");
    await writeFile(storagePath, "occupied", "utf8");
    const sessionId = "compression-transaction";
    const hooks = await CtxPlugin({}, { ctx: { storagePath, recencyGuardTurns: 0, compressionRecencyRequests: 0 } }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    const output = { messages: [user("u1", sessionId, "First"), user("u2", sessionId, "Second")] };
    await transform({}, output);

    const compress = (hooks.tool as Record<string, unknown>).compress as {
      execute(args: unknown, context: HostToolContext): Promise<{ output: string; metadata?: Record<string, unknown> }>;
    };
    const args = {
      topic: "transaction test",
      content: [{ startId: "u1", endId: "u2", summary: "Exact summary" }],
    };
    const failed = await compress.execute(args, compressionContext(sessionId));
    expect(failed.output).toContain("not committed");

    await rm(storagePath, { force: true });
    await mkdir(storagePath, { recursive: true });
    const succeeded = await compress.execute(args, compressionContext(sessionId));
    expect(succeeded.output).toContain("b1");
    expect(succeeded.metadata).toEqual({ blockIds: ["b1"] });
    const store = new FilesystemContentStore(storagePath);
    const [archived] = await store.list({ sessionId, blockId: "b1", kind: "compression-source-v1" });
    const envelope = JSON.parse(archived?.data ?? "{}") as { entries: HostMessageEntry[] };
    const archivedEntries = envelope.entries;
    expect(archivedEntries.map(entry => entry.info.id)).toEqual(["u1", "u2"]);
    expect((archivedEntries[0].parts[0] as { text: string }).text).toBe("First");
    expect((archivedEntries[1].parts[0] as { text: string }).text).toBe("Second");
  });
});

describe("OpenCode pre-tool routing integration", () => {
  async function routingHook(mode?: "off" | "advise" | "enforce") {
    const storagePath = await tempPath();
    const ctx = mode ? { storagePath, routing: { mode } } : { storagePath };
    const hooks = await CtxPlugin({}, { ctx }) as Record<string, unknown>;
    return hooks["tool.execute.before"] as (
      input: ToolExecuteBeforeInput,
      output: ToolExecuteBeforeOutput
    ) => Promise<void>;
  }

  const input = (tool: string): ToolExecuteBeforeInput => ({
    tool,
    sessionID: "routing-session",
    callID: "call-routing",
  });

  it("defaults routing to off", async () => {
    const hook = await routingHook();
    await hook(input("webfetch"), { args: { url: "https://example.com" } });
  });

  it("advisory mode never denies and does not inject arguments", async () => {
    const hook = await routingHook("advise");
    const output = { args: { url: "https://example.com" } };
    await hook(input("webfetch"), output);
    expect(output.args).toEqual({ url: "https://example.com" });
  });

  it("enforce mode denies only deny outcomes", async () => {
    const hook = await routingHook("enforce");
    await expect(hook(input("webfetch"), { args: { url: "https://example.com" } })).rejects.toThrow("routing denied");
    await hook(input("read"), { args: { filePath: "/large" } });
  });

  it("exempts context-manager tools from enforcement", async () => {
    const hook = await routingHook("enforce");
    await hook(input("compress"), { args: { url: "https://example.com" } });
    await hook(input("ctx-search"), { args: {} });
  });
});
