// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { describe, expect, it } from "bun:test";

import { createHandoffHostReader } from "../adapters/opencode/handoff-host.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";

const SESSION = "ses_handoff";

function user(id: string, text = id, modelID = "model-a"): HostMessageEntry {
  return {
    info: {
      id,
      sessionID: SESSION,
      role: "user",
      time: { created: Number(id.replace(/\D/g, "")) || 1 },
      agent: "build",
      model: { providerID: "provider-a", modelID },
    },
    parts: [{ id: `${id}-text`, sessionID: SESSION, messageID: id, type: "text", text }],
  };
}

function assistant(
  id: string,
  parentID: string,
  options: { summary?: boolean; finish?: string; completed?: number; error?: unknown } = {},
): HostMessageEntry {
  const created = Number(id.replace(/\D/g, "")) || 2;
  return {
    info: {
      id,
      sessionID: SESSION,
      role: "assistant",
      time: { created, completed: options.completed ?? created + 1 },
      parentID,
      modelID: "model-a",
      providerID: "provider-a",
      mode: "build",
      path: { cwd: "/project", root: "/project" },
      summary: options.summary,
      error: options.error,
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: options.finish ?? "stop",
    },
    parts: [{
      id: `${id}-text`,
      sessionID: SESSION,
      messageID: id,
      type: "text",
      text: id,
      metadata: { provider: { signature: "preserved" } },
    }],
  };
}

function compaction(id: string, tailStartId?: string): HostMessageEntry {
  const entry = user(id, "compact");
  entry.parts = [{
    id: `${id}-compaction`,
    sessionID: SESSION,
    messageID: id,
    type: "compaction",
    auto: true,
    ...(tailStartId ? { tail_start_id: tailStartId } : {}),
  }];
  return entry;
}

interface MockOptions {
  entries?: unknown;
  sessionInfo?: unknown;
  statuses?: unknown;
  config?: unknown;
  configuredProviders?: unknown;
  listedProviders?: unknown;
  omitStatus?: boolean;
  omitContextApis?: boolean;
}

function fixture(options: MockOptions = {}) {
  const calls: Array<{ name: string; options: unknown }> = [];
  const writes: string[] = [];
  const respond = (name: string, data: unknown) => async (callOptions: unknown) => {
    calls.push({ name, options: callOptions });
    return { data, error: undefined, request: {}, response: {} };
  };
  const write = (name: string) => async () => {
    writes.push(name);
    throw new Error("write API must not be called");
  };
  const session: Record<string, unknown> = {
    get: respond("session.get", options.sessionInfo ?? { id: SESSION, directory: "/project" }),
    messages: respond("session.messages", options.entries ?? [user("u1"), assistant("a2", "u1")]),
    prompt: write("session.prompt"),
    update: write("session.update"),
    delete: write("session.delete"),
  };
  if (!options.omitStatus) session.status = respond("session.status", options.statuses ?? {});
  const client: Record<string, unknown> = { session };
  if (!options.omitContextApis) {
    client.config = {
      get: respond("config.get", options.config ?? { model: "provider-a/model-a" }),
      providers: respond("config.providers", options.configuredProviders ?? {
        providers: [{
          id: "provider-a",
          models: { "model-a": { id: "model-a", limit: { context: 200_000, output: 8_000 } } },
        }],
        default: { "provider-a": "model-a" },
      }),
      update: write("config.update"),
    };
    client.provider = {
      list: respond("provider.list", options.listedProviders ?? { all: [], default: {}, connected: [] }),
    };
  }
  return {
    input: { client, directory: "/directory", worktree: "/project" },
    calls,
    writes,
  };
}

function ids(entries: HostMessageEntry[]): string[] {
  return entries.map(entry => entry.info.id);
}

describe("OpenCode handoff host reader", () => {
  it("uses worktree and the exact no-limit V1 read contract", async () => {
    const latest = assistant("a4", "u3");
    const source = [user("u1"), assistant("a2", "u1"), user("u3"), latest];
    const mock = fixture({ entries: source });
    const reader = createHandoffHostReader(mock.input);

    const result = await reader.readHistory(SESSION);

    expect(reader.projectRoot).toBe("/project");
    expect(ids(result)).toEqual(["u1", "a2", "u3", "a4"]);
    expect(result[3]).toBe(latest);
    expect((result[3].parts[0] as Record<string, unknown>).metadata).toEqual({ provider: { signature: "preserved" } });
    expect(mock.calls).toEqual([
      {
        name: "session.get",
        options: { path: { id: SESSION }, query: { directory: "/project" }, throwOnError: true },
      },
      {
        name: "session.messages",
        options: { path: { id: SESSION }, query: { directory: "/project" }, throwOnError: true },
      },
    ]);
    expect(mock.writes).toEqual([]);
  });

  it("mirrors the completed compaction boundary and retained-tail ordering", async () => {
    const entries = [
      user("u1"),
      assistant("a2", "u1"),
      user("u3"),
      assistant("a4", "u3"),
      compaction("u5", "u3"),
      assistant("a6", "u5", { summary: true }),
      user("u7"),
      assistant("a8", "u7"),
    ];
    const reader = createHandoffHostReader(fixture({ entries }).input);
    expect(ids(await reader.readAllHistory(SESSION))).toEqual(["u1", "a2", "u3", "a4", "u5", "a6", "u7", "a8"]);
    expect(ids(await reader.readHistory(SESSION))).toEqual(["u5", "a6", "u3", "a4", "u7", "a8"]);
  });

  it("drops old history for a completed compaction without a retained tail", async () => {
    const entries = [
      user("u1"),
      assistant("a2", "u1"),
      compaction("u3"),
      assistant("a4", "u3", { summary: true }),
      user("u5"),
      assistant("a6", "u5"),
    ];
    const reader = createHandoffHostReader(fixture({ entries }).input);
    expect(ids(await reader.readHistory(SESSION))).toEqual(["u3", "a4", "u5", "a6"]);
  });

  it("does not hide old history for a fresh or failed compaction", async () => {
    const fresh = [
      user("u1"),
      assistant("a2", "u1"),
      compaction("u3"),
      assistant("a4", "u3", { summary: true, finish: "", completed: Number.NaN }),
    ];
    const failed = [
      user("u1"),
      assistant("a2", "u1"),
      compaction("u3"),
      assistant("a4", "u3", { summary: true, error: { name: "APIError" } }),
    ];
    expect(ids(await createHandoffHostReader(fixture({ entries: fresh }).input).readHistory(SESSION)))
      .toEqual(["u1", "a2", "u3", "a4"]);
    expect(ids(await createHandoffHostReader(fixture({ entries: failed }).input).readHistory(SESSION)))
      .toEqual(["u1", "a2", "u3", "a4"]);
  });

  it("uses status map semantics and rejects active states", async () => {
    await createHandoffHostReader(fixture({ statuses: {} }).input).assertIdle(SESSION);
    await createHandoffHostReader(fixture({ statuses: { [SESSION]: { type: "idle" } } }).input).assertIdle(SESSION);
    await expect(createHandoffHostReader(fixture({ statuses: { [SESSION]: { type: "busy" } } }).input).assertIdle(SESSION))
      .rejects.toThrow("is busy");
    await expect(createHandoffHostReader(fixture({ statuses: { [SESSION]: { type: "retry" } } }).input).assertIdle(SESSION))
      .rejects.toThrow("is retry");
  });

  it("falls back to conservative persisted-history idle checks", async () => {
    await createHandoffHostReader(fixture({ omitStatus: true }).input).assertIdle(SESSION);

    const reordered = [
      user("u1"),
      assistant("a2", "u1"),
      user("u3"),
      compaction("u5", "u3"),
      assistant("a6", "u5", { summary: true }),
    ];
    await createHandoffHostReader(fixture({ omitStatus: true, entries: reordered }).input).assertIdle(SESSION);

    const incomplete = assistant("a2", "u1", { finish: "", completed: Number.NaN });
    await expect(createHandoffHostReader(fixture({ omitStatus: true, entries: [user("u1"), incomplete] }).input).assertIdle(SESSION))
      .rejects.toThrow("incomplete latest assistant");

    const running = assistant("a2", "u1");
    running.parts = [{
      id: "tool-running",
      sessionID: SESSION,
      messageID: "a2",
      type: "tool",
      callID: "call-1",
      tool: "bash",
      state: { status: "running", input: {}, time: { start: 1 } },
    }];
    await expect(createHandoffHostReader(fixture({ omitStatus: true, entries: [user("u1"), running] }).input).assertIdle(SESSION))
      .rejects.toThrow("running tool call");
    await expect(createHandoffHostReader(fixture({ omitStatus: true, entries: [user("u1")] }).input).assertIdle(SESSION))
      .rejects.toThrow("ends with a user message");
  });

  it("resolves a persisted session model through configured providers", async () => {
    const mock = fixture({ sessionInfo: {
      id: SESSION,
      directory: "/project",
      model: { providerID: "provider-b", id: "model-b" },
    }, configuredProviders: {
      providers: [{
        id: "provider-b",
        models: { "model-b": { id: "model-b", limit: { context: 123_456, output: 4_096 } } },
      }],
      default: { "provider-b": "model-b" },
    } });
    expect(await createHandoffHostReader(mock.input).getModelContext(SESSION)).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      contextLimit: 123_456,
    });
    expect(mock.calls.map(call => call.name)).toEqual(["session.get", "session.messages", "config.providers"]);
  });

  it("uses the latest user model, then the configured default and provider.list fallback", async () => {
    const latestEntries = [user("u1", "first", "old"), assistant("a2", "u1"), user("u3", "latest", "new")];
    const latest = fixture({ entries: latestEntries, configuredProviders: {
      providers: [{
        id: "provider-a",
        models: { new: { id: "new", limit: { context: 90_000, output: 1_000 } } },
      }],
      default: {},
    } });
    expect(await createHandoffHostReader(latest.input).getModelContext(SESSION)).toEqual({
      providerId: "provider-a",
      modelId: "new",
      contextLimit: 90_000,
    });

    const configured = fixture({
      entries: [],
      config: { model: "provider-c/family/model-c" },
      configuredProviders: { providers: [], default: {} },
      listedProviders: {
        all: [{
          id: "provider-c",
          models: { "family/model-c": { id: "family/model-c", limit: { context: 77_777, output: 2_000 } } },
        }],
        default: {},
        connected: ["provider-c"],
      },
    });
    const reader = createHandoffHostReader(configured.input);
    expect(await reader.getModelContext(SESSION)).toEqual({
      providerId: "provider-c",
      modelId: "family/model-c",
      contextLimit: 77_777,
    });
    expect(await reader.getContextLimit(SESSION)).toBe(77_777);
  });

  it("returns undefined rather than guessing when model metadata is unsupported", async () => {
    const noApis = fixture({ entries: [], omitContextApis: true });
    expect(await createHandoffHostReader(noApis.input).getModelContext(SESSION)).toBeUndefined();
    expect(await createHandoffHostReader(noApis.input).getContextLimit(SESSION)).toBeUndefined();

    const unknown = fixture({ configuredProviders: { providers: [], default: {} }, listedProviders: {
      all: [], default: {}, connected: [],
    } });
    expect(await createHandoffHostReader(unknown.input).getContextLimit(SESSION)).toBeUndefined();
  });

  it("propagates model-context API and shape errors through both accessors", async () => {
    const apiError = fixture();
    (apiError.input.client as any).config.providers = async () => ({
      data: undefined,
      error: { data: { message: "provider catalog unavailable" } },
    });
    await expect(createHandoffHostReader(apiError.input).getModelContext(SESSION))
      .rejects.toThrow(/unavailable.*provider catalog unavailable/);
    await expect(createHandoffHostReader(apiError.input).getContextLimit(SESSION))
      .rejects.toThrow(/unavailable.*provider catalog unavailable/);

    const malformed = fixture({ configuredProviders: { providers: {}, default: {} } });
    await expect(createHandoffHostReader(malformed.input).getModelContext(SESSION))
      .rejects.toThrow(/incompatible.*providers is not an array/);
  });

  it("rejects unavailable methods, SDK errors, and incompatible envelopes explicitly", async () => {
    expect(() => createHandoffHostReader({ client: { session: { get: async () => ({ data: {} }) } }, worktree: "/p" }))
      .toThrow(/unavailable.*session\.messages/);

    const errored = fixture();
    (errored.input.client as any).session.messages = async () => ({
      data: undefined,
      error: { data: { message: "database unavailable" } },
    });
    await expect(createHandoffHostReader(errored.input).readHistory(SESSION))
      .rejects.toThrow(/unavailable.*database unavailable/);

    const direct = fixture();
    (direct.input.client as any).session.messages = async () => [];
    await expect(createHandoffHostReader(direct.input).readHistory(SESSION))
      .rejects.toThrow(/incompatible.*response is not an object/);
  });

  it("rejects malformed, duplicate, and cross-session identities", async () => {
    await expect(createHandoffHostReader(fixture({ entries: [{ parts: [] }] }).input).readHistory(SESSION))
      .rejects.toThrow(/incompatible.*info/);
    await expect(createHandoffHostReader(fixture({ entries: [user("u1"), user("u1")] }).input).readHistory(SESSION))
      .rejects.toThrow("duplicate message id");

    const wrong = user("u1");
    wrong.info.sessionID = "ses_other";
    await expect(createHandoffHostReader(fixture({ entries: [wrong] }).input).readHistory(SESSION))
      .rejects.toThrow("ses_other");

    const duplicateParts = user("u1");
    duplicateParts.parts.push({ ...duplicateParts.parts[0] });
    await expect(createHandoffHostReader(fixture({ entries: [duplicateParts] }).input).readHistory(SESSION))
      .rejects.toThrow("duplicate part id");
  });

  it("rejects histories above the message and observed-data limits", async () => {
    const one = user("u1");
    const tooMany = Array.from({ length: 10_001 }, (_, index) => {
      const entry = structuredClone(one);
      entry.info.id = `u${index}`;
      entry.parts[0].id = `p${index}`;
      entry.parts[0].messageID = entry.info.id;
      return entry;
    });
    await expect(createHandoffHostReader(fixture({ entries: tooMany }).input).readHistory(SESSION))
      .rejects.toThrow("maximum is 10000");

    const large = user("u1");
    (large.info as unknown as Record<string, unknown>).observed = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`field${index}`, "x".repeat(1024 * 1024)]),
    );
    await expect(createHandoffHostReader(fixture({ entries: [large] }).input).readHistory(SESSION))
      .rejects.toThrow("67108864 bytes");
  });

  it("validates the requested session and project root without falling back silently", async () => {
    expect(() => createHandoffHostReader({ client: { session: { get() {}, messages() {} } }, worktree: "relative" }))
      .toThrow(/incompatible.*not absolute/);
    const directoryOnly = fixture();
    delete (directoryOnly.input as { worktree?: string }).worktree;
    expect(createHandoffHostReader(directoryOnly.input).projectRoot).toBe("/directory");

    const wrongSession = fixture({ sessionInfo: { id: "ses_other", directory: "/project" } });
    await expect(createHandoffHostReader(wrongSession.input).readHistory(SESSION))
      .rejects.toThrow(/session\.get returned id.*ses_other/);
  });

  it("never invokes mutating client APIs", async () => {
    const mock = fixture();
    const reader = createHandoffHostReader(mock.input);
    await reader.readAllHistory(SESSION);
    await reader.readHistory(SESSION);
    await reader.assertIdle(SESSION);
    await reader.getModelContext(SESSION);
    await reader.getContextLimit(SESSION);
    expect(mock.writes).toEqual([]);
    expect(mock.calls.map(call => call.name)).toEqual([
      "session.get", "session.messages",
      "session.get", "session.messages",
      "session.get", "session.status",
      "session.get", "session.messages", "config.providers",
      "session.get", "session.messages", "config.providers",
    ]);
  });
});
