// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import type {
  HostMessageEntry,
  HostToolContext,
  MessagesTransformOutput,
} from "../adapters/opencode/host-types.js";

function user(sessionID: string, id: string, created: number, text: string): HostMessageEntry {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
    },
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
  };
}

function assistant(sessionID: string, id: string, created: number, text: string): HostMessageEntry {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created, completed: created + 1 },
      parentID: "parent",
      modelID: "test-model",
      providerID: "test",
      mode: "chat",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 50, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [{ id: `${id}-text`, sessionID, messageID: id, type: "text", text }],
  };
}

function toolAssistant(
  sessionID: string,
  id: string,
  created: number,
  callID: string,
  output: string
): HostMessageEntry {
  const entry = assistant(sessionID, id, created, "");
  entry.parts = [{
    id: `${id}-tool`,
    sessionID,
    messageID: id,
    type: "tool",
    callID,
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "/workspace/shared.txt" },
      output,
      title: "Read shared file",
      time: { start: created, end: created + 1 },
    },
  }];
  return entry;
}

function context(sessionID: string, messageID: string): HostToolContext {
  return {
    sessionID,
    messageID,
    agent: "build",
    directory: "/workspace",
    worktree: "/workspace",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function textFromParts(parts: HostMessageEntry["parts"]): string {
  return parts
    .filter(part => part.type === "text")
    .map(part => (part as { text: string }).text)
    .join("\n");
}

describe("real OpenCode control plane", () => {
  it("exposes raw/projected history and persists projection overrides", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-control-live-"));
    const sessionID = "control-live-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        nudges: { lowerThreshold: 1, midSoftNudge: 2, upperThreshold: 1_000_000, safetyCap: "99%", maskTriggerThreshold: 1_000_000 },
        summarization: { minSavingsTokens: 0 },
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    }) as Record<string, unknown>;

    const entries = [
      user(sessionID, "raw-u1", 1, "Keep the raw requirement"),
      assistant(sessionID, "raw-a1", 2, "Implementation evidence"),
      assistant(sessionID, "raw-a2", 3, "Current answer"),
      user(sessionID, "raw-u2", 4, "Continue"),
    ];
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    const transformed: MessagesTransformOutput = { messages: structuredClone(entries) };
    await transform({}, transformed);

    const command = hooks["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: HostMessageEntry["parts"] }
    ) => Promise<void>;
    const commandOutput = { parts: [{ id: "template", sessionID, messageID: "command", type: "text", text: "Show the context control URL" }] as HostMessageEntry["parts"] };
    await expect(command({ command: "ctx-ui", sessionID, arguments: "" }, commandOutput)).rejects.toThrow(/no model response required/);
    expect(commandOutput.parts).toEqual([]);
    const bootstrapPath = join(storagePath, "ctx-control-all-chats.html");
    const bootstrapHtml = await readFile(bootstrapPath, "utf8");
    const encodedUrl = bootstrapHtml.match(/location\.replace\((".*")\)/)![1];
    const uiUrl = new URL(JSON.parse(encodedUrl));
    const token = uiUrl.hash.replace(/^#token=/, "");
    const headers = { Authorization: `Bearer ${token}` };

    const detailResponse = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json() as { data: Record<string, unknown> }).data;
    expect((detail.rawHostHistory as unknown[]).length).toBe(4);
    expect((detail.projectedContext as unknown[]).length).toBe(4);
    expect(detail.stats).toBeDefined();

    const revision = detail.revision as number;
    const overrideResponse = await fetch(
      `${uiUrl.origin}/api/sessions/${sessionID}/overrides/raw-u1`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ revision, override: { mode: "exclude" } }),
      }
    );
    expect(overrideResponse.status).toBe(200);
    const overridden = (await overrideResponse.json() as { data: Record<string, unknown> }).data;
    const projectedIds = (overridden.projectedContext as Array<{ id: string }>).map(item => item.id);
    expect(projectedIds).not.toContain("raw-u1");

    const settingsResponse = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/settings`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: overridden.revision,
        settings: { recencyGuardTurns: 1, hardCap: "85%" },
      }),
    });
    expect(settingsResponse.status).toBe(200);
    const settingsSnapshot = (await settingsResponse.json() as { data: Record<string, any> }).data;
    expect(settingsSnapshot.settings).toEqual({ recencyGuardTurns: 1, hardCap: "85%" });
    expect(settingsSnapshot.effectiveSettings.profile).toBe("documents");

    const refed: MessagesTransformOutput = { messages: structuredClone(entries) };
    await transform({}, refed);
    expect(refed.messages.some(entry => entry.info.id === "raw-u1")).toBe(false);
    const projectedUser = refed.messages.find(entry => entry.info.id === "raw-u2")!;
    expect(textFromParts(projectedUser.parts)).toContain("[Context management:");

    // A new plugin instance must retain the exact persisted projection (including
    // transient nudge text), rather than reconstructing a merely equivalent view.
    await CtxPlugin({}, {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        nudges: { lowerThreshold: 1, midSoftNudge: 2, upperThreshold: 1_000_000, safetyCap: "99%", maskTriggerThreshold: 1_000_000 },
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    });
    const restartedHtml = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const restartedUrl = new URL(JSON.parse(restartedHtml.match(/location\.replace\((".*")\)/)![1]));
    const restartedHeaders = { Authorization: `Bearer ${restartedUrl.hash.replace(/^#token=/, "")}` };
    const restartedDetail = await fetch(`${restartedUrl.origin}/api/sessions/${sessionID}`, { headers: restartedHeaders });
    expect(restartedDetail.status).toBe(200);
    const restartedData = (await restartedDetail.json() as { data: Record<string, any> }).data;
    const restartedUser = restartedData.projectedContext.find((entry: { id: string }) => entry.id === "raw-u2");
    expect(restartedUser.parts[0].text).toContain("[Context management:");
  });

  it("saves a batch once and uses it at the next request, with the new message appended", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-batch-edit-"));
    const sessionID = "batch-edit-session";
    const options = {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        // Keep every nudge silent so assertions see only the edited projection.
        nudges: { lowerThreshold: 1_000_000, midSoftNudge: 1_000_000, upperThreshold: 1_000_000, safetyCap: "99%", maskTriggerThreshold: 1_000_000 },
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    };
    const hooks = await CtxPlugin({}, options) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;

    const history = [
      user(sessionID, "batch-u1", 1, "Stale requirement that should stop being sent"),
      assistant(sessionID, "batch-a1", 2, "Very long original evidence " + "z".repeat(400)),
      user(sessionID, "batch-u2", 3, "Continue"),
      assistant(sessionID, "batch-a2", 4, "Current answer"),
    ];
    await transform({}, { messages: structuredClone(history) });

    const bootstrap = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const uiUrl = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1]));
    const headers = { Authorization: `Bearer ${uiUrl.hash.replace(/^#token=/, "")}`, "Content-Type": "application/json" };
    const detail = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as { data: Record<string, any> };

    // One save carries the whole staged batch, so it costs one revision.
    const saved = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: detail.data.revision,
        edits: [
          { messageId: "batch-u1", override: { mode: "exclude" } },
          { messageId: "batch-a1", override: { mode: "replace", text: "Condensed evidence." } },
        ],
      }),
    });
    expect(saved.status).toBe(200);
    const batch = (await saved.json() as { data: Record<string, any> }).data;
    expect(batch.revision).toBe(detail.data.revision + 1);
    expect(batch.pendingProjectionEdit).toBe(true);
    const projectedIds = batch.projectedContext.map((entry: { id: string }) => entry.id);
    expect(projectedIds).not.toContain("batch-u1");
    expect(projectedIds).toContain("__manual_batch-a1");

    // Next request: the host re-feeds full history plus a brand new user message.
    const next: MessagesTransformOutput = {
      messages: structuredClone([...history, user(sessionID, "batch-u3", 5, "New question after editing")]),
    };
    await transform({}, next);
    const nextIds = next.messages.map(entry => entry.info.id);
    expect(nextIds).not.toContain("batch-u1");
    expect(nextIds).not.toContain("batch-a1");
    expect(nextIds).toContain("__manual_batch-a1");
    const replacement = next.messages.find(entry => entry.info.id === "__manual_batch-a1")!;
    expect(textFromParts(replacement.parts)).toContain("Condensed evidence.");
    // The new message is appended after the overridden history.
    expect(nextIds[nextIds.length - 1]).toBe("batch-u3");
    expect(textFromParts(next.messages[next.messages.length - 1].parts)).toContain("New question after editing");

    // Delivered exactly once: the projection is byte-stable from here on.
    const after = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as { data: Record<string, any> };
    expect(after.data.pendingProjectionEdit).toBe(false);
    expect(after.data.projectedContext.map((entry: { id: string }) => entry.id)).toContain("__manual_batch-a1");
  });

  it("rejects edits that could not take effect or would duplicate compressed context", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-edit-guard-"));
    const sessionID = "edit-guard-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        summarization: { minSavingsTokens: 0 },
        compressionRecencyRequests: 0,
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    }) as Record<string, any>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    const history = [
      user(sessionID, "guard-u1", 1, "Early requirement " + "x".repeat(400)),
      assistant(sessionID, "guard-a1", 2, "Early evidence " + "y".repeat(400)),
      user(sessionID, "guard-u2", 3, "Continue"),
      assistant(sessionID, "guard-a2", 4, "Current answer"),
    ];
    await transform({}, { messages: structuredClone(history) });
    const compressed = await hooks.tool.compress.execute(
      {
        topic: "Early work",
        content: [{ startId: "m0001", endId: "m0002", summary: "Early requirement completed." }],
      },
      context(sessionID, "guard-compress")
    ) as { output: string };
    const blockId = compressed.output.match(/\bb\d+\b/)![0];

    const bootstrap = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const uiUrl = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1]));
    const headers = { Authorization: `Bearer ${uiUrl.hash.replace(/^#token=/, "")}`, "Content-Type": "application/json" };
    const detail = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as { data: Record<string, any> };
    const revision = detail.data.revision as number;
    const post = (edits: unknown) => fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision, edits }),
    });

    // Keeping a compressed source would send the original and its summary together.
    const compressedKeep = await post([{ messageId: "guard-u1", override: { mode: "keep" } }]);
    expect(compressedKeep.status).toBe(400);
    expect((await compressedKeep.json() as any).error.message).toContain(blockId);

    // A generated replacement id can never be re-applied, so it is refused.
    const syntheticTarget = await post([{ messageId: "__manual_guard-a2", override: { mode: "exclude" } }]);
    expect(syntheticTarget.status).toBe(400);

    // Resetting an unknown id would silently consume a revision.
    const unknownReset = await post([{ messageId: "guard-does-not-exist", override: null }]);
    expect(unknownReset.status).toBe(404);

    // None of the rejected batches changed anything.
    const after = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as { data: Record<string, any> };
    expect(after.data.revision).toBe(revision);
    expect(after.data.overrides).toEqual({});

    // Excluding a compressed source is still allowed: it is already not sent.
    const excluded = await post([{ messageId: "guard-u1", override: { mode: "exclude" } }]);
    expect(excluded.status).toBe(200);
  });

  it("keeps the role of a replaced assistant message", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-replace-role-"));
    const sessionID = "replace-role-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        nudges: { lowerThreshold: 1_000_000, midSoftNudge: 1_000_000, upperThreshold: 1_000_000, safetyCap: "99%", maskTriggerThreshold: 1_000_000 },
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    const history = [
      user(sessionID, "role-u1", 1, "Explain the failure"),
      assistant(sessionID, "role-a1", 2, "Long original explanation " + "q".repeat(300)),
      user(sessionID, "role-u2", 3, "Continue"),
    ];
    await transform({}, { messages: structuredClone(history) });

    const bootstrap = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const uiUrl = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1]));
    const headers = { Authorization: `Bearer ${uiUrl.hash.replace(/^#token=/, "")}`, "Content-Type": "application/json" };
    const detail = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as { data: Record<string, any> };
    const saved = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: detail.data.revision,
        edits: [{ messageId: "role-a1", override: { mode: "replace", text: "Short explanation." } }],
      }),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as { data: Record<string, any> };
    expect(savedBody.data.projectedContext.map((entry: { id: string }) => entry.id)).toContain("__manual_role-a1");
    // Reset estimates start from the server-derived automatic projection, not
    // from the already-replaced projected history.
    expect(savedBody.data.automaticProjectedContext.map((entry: { id: string }) => entry.id)).toContain("role-a1");
    expect(savedBody.data.automaticProjectedContext.map((entry: { id: string }) => entry.id)).not.toContain("__manual_role-a1");

    const next: MessagesTransformOutput = { messages: structuredClone(history) };
    await transform({}, next);
    const replacement = next.messages.find(entry => entry.info.id === "__manual_role-a1")!;
    // An assistant turn stays an assistant turn; only its text changes.
    expect(replacement.info.role).toBe("assistant");
    expect(textFromParts(replacement.parts)).toContain("Short explanation.");
    // plugin-authored text reports no provider usage.
    expect((replacement.info as { tokens?: { input: number } }).tokens?.input).toBe(0);

    const reset = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: savedBody.data.revision,
        edits: [{ messageId: "role-a1", override: null }],
      }),
    });
    expect(reset.status).toBe(200);
    const resetBody = await reset.json() as { data: Record<string, any> };
    expect(resetBody.data.projectedContext.map((entry: { id: string }) => entry.id)).toContain("role-a1");
    expect(resetBody.data.projectedContext.map((entry: { id: string }) => entry.id)).not.toContain("__manual_role-a1");
  });

  it("only permits resetting an override whose source has left host history", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-stale-override-"));
    const sessionID = "stale-override-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    const original = [
      user(sessionID, "stale-u1", 1, "Old instruction"),
      assistant(sessionID, "stale-a1", 2, "Old response"),
      user(sessionID, "stale-u2", 3, "Current instruction"),
    ];
    await transform({}, { messages: structuredClone(original) });
    const bootstrap = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const uiUrl = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1]));
    const headers = { Authorization: `Bearer ${uiUrl.hash.replace(/^#token=/, "")}`, "Content-Type": "application/json" };
    const detail = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as { data: Record<string, any> };
    const excluded = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: detail.data.revision,
        edits: [{ messageId: "stale-u1", override: { mode: "exclude" } }],
      }),
    });
    expect(excluded.status).toBe(200);
    const excludedBody = await excluded.json() as { data: Record<string, any> };

    // Simulate native host compaction dropping the overridden source.
    await transform({}, { messages: structuredClone(original.slice(1)) });
    const replaceStale = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: excludedBody.data.revision,
        edits: [{ messageId: "stale-u1", override: { mode: "replace", text: "inert" } }],
      }),
    });
    expect(replaceStale.status).toBe(404);

    const resetStale = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/projection`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        revision: excludedBody.data.revision,
        edits: [{ messageId: "stale-u1", override: null }],
      }),
    });
    expect(resetStale.status).toBe(200);
  });

  it("opens a general dashboard where the chat can be selected", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-chat-url-"));
    const sessionID = "chat-url-session";
    const hooks = await CtxPlugin({}, {
      ctx: { storagePath, recencyGuardTurns: 0, controlServer: { enabled: true, port: 0, openBrowser: false } },
    }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    await transform({}, {
      messages: [
        user(sessionID, "url-u1", 1, "Fix the login redirect bug"),
        assistant(sessionID, "url-a1", 2, "Investigating"),
      ],
    });

    const command = hooks["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: HostMessageEntry["parts"] }
    ) => Promise<void>;
    const output = { parts: [{ id: "template", sessionID, messageID: "command", type: "text", text: "Show the context control URL" }] as HostMessageEntry["parts"] };
    await expect(command({ command: "ctx-ui", sessionID, arguments: "" }, output)).rejects.toThrow(/no model response required/);
    // Opening the dashboard is a local side effect and emits no model-facing
    // command message or credential.
    expect(output.parts).toEqual([]);
    const bootstrapPath = join(storagePath, "ctx-control-all-chats.html");
    const url = new URL(JSON.parse((await readFile(bootstrapPath, "utf8")).match(/location\.replace\((".*")\)/)![1]));
    // The general dashboard uses the base nonce host; the selector chooses a chat.
    expect(url.hostname.startsWith("ctx-")).toBe(true);
    expect(url.hostname.endsWith(".localhost")).toBe(true);
    expect(url.searchParams.has("chat")).toBe(false);
    expect(/^#token=[a-f0-9]{64}$/.test(url.hash)).toBe(true);

    const detail = await fetch(`${url.origin}/api/sessions/${sessionID}`, {
      headers: { Authorization: `Bearer ${url.hash.replace(/^#token=/, "")}` },
    });
    expect(detail.status).toBe(200);
  });

  it("hydrates durable originals after host compaction and keeps them restored", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-durable-live-"));
    const sessionID = "durable-live-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        summarization: { minSavingsTokens: 0 },
        compressionRecencyRequests: 0,
      },
    }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    const allEntries = [
      user(sessionID, "durable-u1", 1, "Original requirement " + "x".repeat(400)),
      assistant(sessionID, "durable-a1", 2, "Original result " + "y".repeat(400)),
      user(sessionID, "durable-u2", 3, "Current request"),
      assistant(sessionID, "durable-a2", 4, "Current result"),
    ];
    const first: MessagesTransformOutput = { messages: structuredClone(allEntries) };
    await transform({}, first);

    const compress = (hooks.tool as Record<string, { execute: Function }>).compress;
    const compressed = await compress.execute(
      {
        topic: "Durable originals",
        content: [{ startId: "m0001", endId: "m0002", summary: "Early requirement completed." }],
      },
      context(sessionID, "compress-call")
    ) as { output: string };
    const blockId = compressed.output.match(/\bb\d+\b/)![0];

    // Simulate host compaction dropping the original source messages.
    const compacted = allEntries.slice(2);
    await transform({}, { messages: structuredClone(compacted) });

    const command = hooks["command.execute.before"] as (
      input: { command: string; sessionID: string; arguments: string },
      output: { parts: HostMessageEntry["parts"] }
    ) => Promise<void>;
    await command(
      { command: "ctx-decompress", sessionID, arguments: blockId },
      { parts: [] }
    );

    // The next host re-feed is still compacted; context-manager must rehydrate the archive.
    const afterRestore: MessagesTransformOutput = { messages: structuredClone(compacted) };
    await transform({}, afterRestore);
    expect(afterRestore.messages.some(entry => entry.info.id === "durable-u1")).toBe(true);
    expect(afterRestore.messages.some(entry => entry.info.id === "durable-a1")).toBe(true);
    expect(afterRestore.messages.some(entry => entry.info.id === `__summary_${blockId}`)).toBe(false);
  });

  it("shares live session state across plugin instances using the same storage root", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-shared-instance-state-"));
    const sessionID = "shared-instance-session";
    const options = {
      ctx: {
        storagePath,
        recencyGuardTurns: 0,
        summarization: { minSavingsTokens: 0 },
        compressionRecencyRequests: 0,
      },
    };
    const firstHooks = await CtxPlugin({}, options) as Record<string, any>;
    const secondHooks = await CtxPlugin({}, options) as Record<string, any>;
    const entries = [
      user(sessionID, "shared-u1", 1, "Requirement " + "x".repeat(400)),
      assistant(sessionID, "shared-a1", 2, "Result " + "y".repeat(400)),
      user(sessionID, "shared-u2", 3, "Continue"),
      assistant(sessionID, "shared-a2", 4, "Current"),
    ];
    const firstTransform = firstHooks["experimental.chat.messages.transform"] as Function;
    const secondTransform = secondHooks["experimental.chat.messages.transform"] as Function;

    // Initialize both instances before mutating through the first one.
    await firstTransform({}, { messages: structuredClone(entries) });
    await secondTransform({}, { messages: structuredClone(entries) });
    const compressed = await firstHooks.tool.compress.execute(
      {
        topic: "Shared state",
        content: [{ startId: "m0001", endId: "m0002", summary: "Requirement completed." }],
      },
      context(sessionID, "shared-compress")
    ) as { output: string };
    const blockId = compressed.output.match(/\bb\d+\b/)![0];

    // A later transform through the already-live second instance must not
    // replace the compression graph with its formerly cached state.
    await secondTransform({}, { messages: structuredClone(entries) });
    const persisted = await new FilePersistence(storagePath).load(sessionID);
    expect(persisted?.blockRegistry.has(blockId)).toBe(true);
    expect(persisted?.stats.totalTurns).toBe(3);
  });

  it("turns automatic pruning off immediately and restores persisted mechanical decisions", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-automation-off-"));
    const sessionID = "automation-off-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        costRoi: { enabled: false },
        recencyGuardTurns: 0,
        hardCap: 1_000_000,
        nudges: {
          lowerThreshold: 1_000_000,
          midSoftNudge: 1_000_000,
          upperThreshold: 1_000_000,
          safetyCap: "99%",
          maskTriggerThreshold: 1_000_000,
        },
        controlServer: { enabled: true, port: 0, openBrowser: false },
      },
    }) as Record<string, any>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>, output: MessagesTransformOutput
    ) => Promise<void>;
    const originalOutput = "exact reasoning-adjacent tool evidence ".repeat(120);
    const history = [
      user(sessionID, "auto-u1", 1, "Start"),
      toolAssistant(sessionID, "auto-a1", 2, "auto-call-1", originalOutput),
      user(sessionID, "auto-u2", 3, "two"),
      user(sessionID, "auto-u3", 4, "three"),
      user(sessionID, "auto-u4", 5, "four"),
      user(sessionID, "auto-u5", 6, "five"),
      user(sessionID, "auto-u6", 7, "six"),
      user(sessionID, "auto-u7", 8, "seven"),
      toolAssistant(sessionID, "auto-a2", 9, "auto-call-2", originalOutput),
    ];
    const first: MessagesTransformOutput = { messages: structuredClone(history) };
    await transform({}, first);
    const firstOld = first.messages.find(entry => entry.info.id === "auto-a1")!;
    const firstOutput = (firstOld.parts.find(part => part.type === "tool") as any).state.output;
    expect(firstOutput).not.toBe(originalOutput);

    const bootstrap = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const uiUrl = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1]));
    const headers = {
      Authorization: `Bearer ${uiUrl.hash.replace(/^#token=/, "")}`,
      "Content-Type": "application/json",
    };
    const detail = await (await fetch(`${uiUrl.origin}/api/sessions/${sessionID}`, { headers })).json() as {
      data: Record<string, any>;
    };
    const changed = await fetch(`${uiUrl.origin}/api/sessions/${sessionID}/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        revision: detail.data.revision,
        settings: { automation: { automaticPruning: false } },
      }),
    });
    expect(changed.status).toBe(200);
    const changedBody = await changed.json() as { data: Record<string, any> };
    expect(changedBody.data.pendingProjectionEdit).toBe(true);
    const restored = changedBody.data.projectedContext.find((entry: { id: string }) => entry.id === "auto-a1");
    expect(restored.parts.find((part: { type: string }) => part.type === "tool").state.output).toBe(originalOutput);

    const next: MessagesTransformOutput = { messages: structuredClone(history) };
    await transform({}, next);
    const nextOld = next.messages.find(entry => entry.info.id === "auto-a1")!;
    expect((nextOld.parts.find(part => part.type === "tool") as any).state.output).toBe(originalOutput);
  });

  it("rejects model-called compression when modelCompression is off", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-model-compression-off-"));
    const sessionID = "model-compression-off-session";
    const hooks = await CtxPlugin({}, {
      ctx: {
        storagePath,
        automation: { modelCompression: false },
        recencyGuardTurns: 0,
      },
    }) as Record<string, any>;
    await hooks["experimental.chat.messages.transform"]({}, {
      messages: [
        user(sessionID, "disabled-u1", 1, "Old requirement"),
        assistant(sessionID, "disabled-a1", 2, "Old result"),
        user(sessionID, "disabled-u2", 3, "Continue"),
      ],
    });

    const rangeResult = await hooks.tool.compress.execute({
      topic: "Disabled",
      content: [{ startId: "m0001", endId: "m0002", summary: "Must not apply" }],
    }, context(sessionID, "disabled-range"));
    const messageResult = await hooks.tool.compress_message.execute({
      topic: "Disabled",
      content: [{ messageId: "m0001", topic: "Disabled", summary: "Must not apply" }],
    }, context(sessionID, "disabled-message"));
    expect(rangeResult.output).toContain("disabled by automation.modelCompression");
    expect(messageResult.output).toContain("disabled by automation.modelCompression");

    await hooks.event({
      event: {
        type: "message.part.updated",
        properties: { part: { type: "tool", tool: "compress", sessionID } },
      },
    });

    const commandOutput = { parts: [] as HostMessageEntry["parts"] };
    await hooks["command.execute.before"](
      { command: "ctx-compress", sessionID, arguments: "" },
      commandOutput
    );
    expect(textFromParts(commandOutput.parts)).toContain("disabled by automation.modelCompression");
    // Persist after the rejected tool event; disabled compression must not leave
    // timing metadata that looks like a successful compression run.
    await hooks["experimental.chat.messages.transform"]({}, {
      messages: [
        user(sessionID, "disabled-u1", 1, "Old requirement"),
        assistant(sessionID, "disabled-a1", 2, "Old result"),
        user(sessionID, "disabled-u2", 3, "Continue"),
      ],
    });
    const persisted = await new FilePersistence(storagePath).load(sessionID);
    expect(persisted?.blockRegistry.size).toBe(0);
    expect(persisted?.compressionTiming.lastCompressMs).toBeUndefined();
  });
});
