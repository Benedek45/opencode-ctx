// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Adapter-level translation tests: opencode native <-> NeutralMessage round-trip.

import { describe, it, expect } from "bun:test";
import { toNeutral, advanceTurnBasis, applyNeutral, stripForeignProviderMetadata } from "../adapters/opencode/map.js";
import { buildCoreConfig, validateRuntimeConfig } from "../adapters/opencode/config.js";
import type { HostMessageEntry, HostToolState } from "../adapters/opencode/host-types.js";
import type { NeutralMessage } from "../types/neutral.js";
import { AnthropicTokenizer, buildServices } from "../adapters/opencode/services.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { cloneCoreState, createInitialState } from "../types/state.js";
import { expireTemporaryRetrievals } from "../core/contextTiers.js";
import { recordCacheBust } from "../core/budget/costRoi.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

describe("model-dependent tokenizer selection", () => {
  it("auto selects Anthropic for Claude and char for OpenAI", async () => {
    const services = await buildServices("/tmp/ctx-tokenizer-auto-test", "auto");
    expect(services.tokenizerFor("anthropic", "claude-opus-4-6") instanceof AnthropicTokenizer).toBe(true);
    expect(services.tokenizerFor("gateway", "Claude-Sonnet-4-6") instanceof AnthropicTokenizer).toBe(true);
    expect(services.tokenizerFor("openai", "gpt-5.6-sol") instanceof CharTokenizer).toBe(true);
  });

  it("honors explicit tokenizer modes across models", async () => {
    const char = await buildServices("/tmp/ctx-tokenizer-char-test", "char");
    const anthropic = await buildServices("/tmp/ctx-tokenizer-anthropic-test", "anthropic");
    expect(char.tokenizerFor("anthropic", "claude-opus") instanceof CharTokenizer).toBe(true);
    expect(anthropic.tokenizerFor("openai", "gpt-5.6-sol") instanceof AnthropicTokenizer).toBe(true);
  });
});

function makeUserEntry(id: string, sessionID: string, text: string): HostMessageEntry {
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1000 },
      agent: "compliance",
      model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    },
    parts: [
      {
        id: `${id}-p1`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      },
    ],
  };
}

function makeAssistantEntry(
  id: string,
  sessionID: string,
  text: string,
  toolCallId?: string,
  toolOutput?: string
): HostMessageEntry {
  const parts: HostMessageEntry["parts"] = [
    {
      id: `${id}-step`,
      sessionID,
      messageID: id,
      type: "step-start",
    },
    {
      id: `${id}-text`,
      sessionID,
      messageID: id,
      type: "text",
      text,
    },
  ];

  if (toolCallId) {
    const toolState: HostToolState = toolOutput !== undefined
      ? {
          status: "completed",
          input: { filePath: "/workspaces/test/output/report.md" },
          output: toolOutput,
          title: "read",
          time: { start: 1000, end: 1100 },
        }
      : {
          status: "pending",
          input: { filePath: "/workspaces/test/output/report.md" },
          raw: "",
        };

    parts.push({
      id: `${id}-tool`,
      sessionID,
      messageID: id,
      type: "tool",
      callID: toolCallId,
      tool: "read",
      state: toolState,
    });
  }

  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1100, completed: 1200 },
      parentID: "parent-1",
      modelID: "deepseek-v4-flash",
      providerID: "opencode-go",
      mode: "chat",
      path: { cwd: "/workspaces/test", root: "/workspaces/test" },
      summary: false,
      cost: 0.001,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
      finish: "end_turn",
    },
    parts,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("opencode adapter: stripForeignProviderMetadata", () => {
  function toolEntry(id: string, metadata?: unknown): HostMessageEntry {
    const entry = makeAssistantEntry(id, "sess-1", "tool result", "call-1", "output");
    const toolPart = entry.parts.find(p => p.type === "tool") as { metadata?: unknown };
    if (metadata !== undefined) toolPart.metadata = metadata;
    return entry;
  }

  it("strips foreign provider item metadata from tool parts", () => {
    const entries = [toolEntry("msg-1", { openai: { itemId: "fc_abc123" } })];
    const result = stripForeignProviderMetadata(entries, "anthropic");
    const tool = result[0].parts.find(p => p.type === "tool") as { metadata?: unknown };
    expect(tool.metadata).toBeUndefined();
  });

  it("keeps metadata for the current provider namespace", () => {
    const entries = [toolEntry("msg-1", { openai: { itemId: "fc_abc123" } })];
    const result = stripForeignProviderMetadata(entries, "opencode-go");
    const tool = result[0].parts.find(p => p.type === "tool") as { metadata?: unknown };
    expect(tool.metadata).toEqual({ openai: { itemId: "fc_abc123" } });
  });

  it("preserves non-provider metadata keys while removing foreign ones", () => {
    const entries = [toolEntry("msg-1", { openai: { itemId: "fc_abc123" }, custom: { keep: true } })];
    const result = stripForeignProviderMetadata(entries, "anthropic");
    const tool = result[0].parts.find(p => p.type === "tool") as { metadata?: unknown };
    expect(tool.metadata).toEqual({ custom: { keep: true } });
  });

  it("leaves tool parts without metadata untouched", () => {
    const entries = [toolEntry("msg-1", undefined)];
    const result = stripForeignProviderMetadata(entries, "anthropic");
    expect(result).toBe(entries);
  });

  it("strips foreign metadata from reasoning parts too", () => {
    const entry = makeAssistantEntry("msg-1", "sess-1", "ok", "call-1", "out");
    entry.parts.unshift({
      id: "msg-1-reasoning",
      sessionID: "sess-1",
      messageID: "msg-1",
      type: "reasoning",
      text: "think",
      metadata: { openai: { itemId: "rs_abc", reasoningEncryptedContent: "blob" } },
    });
    const result = stripForeignProviderMetadata([entry], "anthropic");
    const reasoning = result[0].parts.find(p => p.type === "reasoning") as { metadata?: unknown };
    expect(reasoning.metadata).toBeUndefined();
  });
});

describe("opencode adapter: toNeutral", () => {
  it("translates a user message with text part", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("msg-1", "sess-1", "Hello, world"),
    ];

    const neutral = toNeutral(entries);

    expect(neutral).toHaveLength(1);
    expect(neutral[0].id).toBe("msg-1");
    expect(neutral[0].role).toBe("user");
    expect(neutral[0].sessionId).toBe("sess-1");
    expect(neutral[0].createdAt).toBe(1000);
    expect(neutral[0].parts).toHaveLength(1);
    expect(neutral[0].parts[0].type).toBe("text");
    if (neutral[0].parts[0].type === "text") {
      expect(neutral[0].parts[0].text).toBe("Hello, world");
    }
  });

  it("translates an assistant message with step-start, text, and tool parts", () => {
    const entries: HostMessageEntry[] = [
      makeAssistantEntry("msg-2", "sess-1", "I will read the file", "call-1", "file content here"),
    ];

    const neutral = toNeutral(entries);

    expect(neutral).toHaveLength(1);
    expect(neutral[0].role).toBe("assistant");

    // step-start, text, tool
    expect(neutral[0].parts).toHaveLength(3);
    expect(neutral[0].parts[0].type).toBe("step-start");
    expect(neutral[0].parts[1].type).toBe("text");
    expect(neutral[0].parts[2].type).toBe("tool");

    const toolPart = neutral[0].parts[2];
    if (toolPart.type === "tool") {
      expect(toolPart.callId).toBe("call-1");
      expect(toolPart.tool).toBe("read");
      expect(toolPart.status).toBe("completed");
      expect(toolPart.output).toBe("file content here");
      expect((toolPart.input as Record<string, unknown>)["filePath"]).toBe("/workspaces/test/output/report.md");
    }
  });

  it("maps assistant token usage including cache fields", () => {
    const entries: HostMessageEntry[] = [
      makeAssistantEntry("msg-3", "sess-1", "response"),
    ];

    const neutral = toNeutral(entries);

    expect(neutral[0].tokens).toBeDefined();
    expect(neutral[0].tokens?.input).toBe(100);
    expect(neutral[0].tokens?.output).toBe(50);
    expect(neutral[0].tokens?.reasoning).toBe(10);
    expect(neutral[0].tokens?.cacheRead).toBe(200);
    expect(neutral[0].tokens?.cacheWrite).toBe(0);
  });

  it("marks native compaction messages as isSummary", () => {
    const entry: HostMessageEntry = {
      info: {
        id: "msg-4",
        sessionID: "sess-1",
        role: "assistant",
        time: { created: 1000 },
        parentID: "p",
        modelID: "deepseek-v4-flash",
        providerID: "opencode-go",
        mode: "chat",
        path: { cwd: "/", root: "/" },
        summary: true,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: "p1", sessionID: "sess-1", messageID: "msg-4", type: "text", text: "summary" },
      ],
    };

    const neutral = toNeutral([entry]);
    expect(neutral[0].isSummary).toBe(true);
  });

  it("marks messages with compaction parts as isSummary", () => {
    const entry: HostMessageEntry = {
      info: {
        id: "msg-5",
        sessionID: "sess-1",
        role: "assistant",
        time: { created: 1000 },
        parentID: "p",
        modelID: "deepseek-v4-flash",
        providerID: "opencode-go",
        mode: "chat",
        path: { cwd: "/", root: "/" },
        summary: false,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: "p1", sessionID: "sess-1", messageID: "msg-5", type: "compaction", auto: true },
      ],
    };

    const neutral = toNeutral([entry]);
    expect(neutral[0].isSummary).toBe(true);
  });

  it("does not include token usage for user messages", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("msg-6", "sess-1", "user text"),
    ];

    const neutral = toNeutral(entries);
    expect(neutral[0].tokens).toBeUndefined();
  });
});

describe("opencode adapter: buildCoreConfig", () => {
  it("applies plugin tool retention and preserves higher-precedence overrides", () => {
    const options = {
      recencyGuardTurns: 5,
      toolClasses: {
        read: { stateless: true, retentionTurns: 5 },
        grep: { stateless: true, retentionTurns: 5 },
        glob: { stateless: true, retentionTurns: 5 },
        list: { stateless: true, retentionTurns: 5 },
      },
      providers: { openai: { toolClasses: { read: { stateless: true, retentionTurns: 6 } } } },
      models: { "gpt-6-astra": { toolClasses: { grep: { stateless: true, retentionTurns: 7 } } } },
    };
    for (const [provider, model] of [["openai", "gpt-6-astra"], ["anthropic", "claude-opus-5"], ["opencode-go", "deepseek-v4-flash"]]) {
      const config = buildCoreConfig("retention", options, 200_000, provider, model);
      expect(config.recencyGuardTurns).toBe(5);
      expect(config.toolClasses.read.retentionTurns).toBe(provider === "openai" ? 6 : 5);
      expect(config.toolClasses.grep.retentionTurns).toBe(model === "gpt-6-astra" ? 7 : 5);
      expect(config.toolClasses.glob.retentionTurns).toBe(5);
      expect(config.toolClasses.list.retentionTurns).toBe(5);
      expect(config.toolClasses.bash.retentionTurns).toBe(5);
    }
    const runtime = { toolClasses: { read: { stateless: true, retentionTurns: 0 } } };
    expect(buildCoreConfig("retention", options, 200_000, "openai", "gpt-6-astra", runtime).toolClasses.read.retentionTurns).toBe(0);
    expect(() => buildCoreConfig("invalid", {
      toolClasses: { read: { stateless: true, retentionTurns: -1 } },
    }, 200_000, "openai", "gpt-6-astra")).toThrow();
  });

  it("applies provider/model cachePrune overrides", () => {
    const config = buildCoreConfig(
      "s1",
      {
        cachePrune: { ttlSeconds: 360 },
        providers: {
          "opencode-go": { cachePrune: { ttlSeconds: 120 } },
        },
        models: {
          "deepseek-v4-flash": { cachePrune: { afterTtl: false } },
        },
      },
      1_000_000,
      "opencode-go",
      "deepseek-v4-flash"
    );

    expect(config.cachePrune.afterCompress).toBe(true);
    expect(config.cachePrune.afterTtl).toBe(false);
    expect(config.cachePrune.ttlSeconds).toBe(120);
  });

  it("merges automation switches and validates dashboard overrides", () => {
    const config = buildCoreConfig(
      "automation",
      { automation: { automaticPruning: false } },
      200_000,
      "test",
      "model",
      { automation: { modelCompression: false } }
    );
    expect(config.automation).toEqual({ automaticPruning: false, modelCompression: false });
    expect(validateRuntimeConfig({
      automation: { automaticPruning: false, modelCompression: false },
    }).automation).toEqual({ automaticPruning: false, modelCompression: false });
    expect(() => validateRuntimeConfig({ automation: { unknown: false } })).toThrow();
    expect(() => buildCoreConfig(
      "invalid-plugin",
      { automation: { automaticPruning: "false" as unknown as boolean } },
      200_000,
      "test",
      "model"
    )).toThrow();
    expect(() => buildCoreConfig(
      "invalid-model",
      { models: { model: { automation: { modelCompression: "off" as unknown as boolean } } } },
      200_000,
      "test",
      "model"
    )).toThrow();
  });
});

describe("opencode adapter: applyNeutral round-trip", () => {
  it("returns the same entries when no mutations are applied", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("msg-1", "sess-1", "Hello"),
      makeAssistantEntry("msg-2", "sess-1", "Hi there"),
    ];

    const neutral = toNeutral(entries);
    const roundTripped = applyNeutral(entries, neutral);

    expect(roundTripped).toHaveLength(2);
    expect(roundTripped[0].info.id).toBe("msg-1");
    expect(roundTripped[1].info.id).toBe("msg-2");
  });

  it("applies tool output mutation (mask replacement) back to the entry", () => {
    const entries: HostMessageEntry[] = [
      makeAssistantEntry("msg-1", "sess-1", "reading file", "call-1", "original output"),
    ];

    const neutral = toNeutral(entries);

    // Simulate the core replacing the tool output with a mask placeholder
    const mutated: NeutralMessage[] = neutral.map(msg => ({
      ...msg,
      parts: msg.parts.map(p => {
        if (p.type === "tool" && p.callId === "call-1") {
          return { ...p, output: "[Tool output masked to save context]" };
        }
        return p;
      }),
    }));

    const result = applyNeutral(entries, mutated);

    expect(result).toHaveLength(1);
    const toolPart = result[0].parts.find(p => p.type === "tool") as {
      type: "tool"; callID: string; state: HostToolState;
    } | undefined;
    expect(toolPart).toBeDefined();
    if (toolPart && toolPart.state.status === "completed") {
      expect(toolPart.state.output).toBe("[Tool output masked to save context]");
    }
  });

  it("omits messages not present in the neutral output (compress range removal)", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("msg-1", "sess-1", "first"),
      makeUserEntry("msg-2", "sess-1", "second"),
      makeUserEntry("msg-3", "sess-1", "third"),
    ];

    const neutral = toNeutral(entries);

    // Simulate compress removing msg-1 and msg-2, replacing with a summary block
    const summaryBlock: NeutralMessage = {
      id: "summary-b1",
      role: "user",
      sessionId: "sess-1",
      createdAt: 1000,
      isSummary: true,
      parts: [{ type: "summary-block", blockId: "b1", text: "Summary of first two messages" }],
    };

    const mutated: NeutralMessage[] = [summaryBlock, neutral[2]];
    const result = applyNeutral(entries, mutated);

    // Should have 2 entries: the synthetic summary + msg-3
    expect(result).toHaveLength(2);
    // First is the synthetic summary entry
    expect(result[0].info.id).toBe("summary-b1");
    expect(result[0].info.role).toBe("user");
    // Second is msg-3
    expect(result[1].info.id).toBe("msg-3");
  });

  it("wraps a string stale-error input placeholder as an object for providers", () => {
    const entries: HostMessageEntry[] = [
      {
        info: {
          id: "msg-1",
          sessionID: "sess-1",
          role: "assistant",
          time: { created: 1000, completed: 1100 },
          parentID: "parent-1",
          modelID: "deepseek-v4-flash",
          providerID: "opencode-go",
          mode: "chat",
          path: { cwd: "/w", root: "/w" },
          summary: false,
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "end_turn",
        },
        parts: [
          {
            id: "msg-1-tool",
            sessionID: "sess-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "npm test" },
              error: "failed",
              time: { start: 1000, end: 1100 },
            } as HostToolState,
          },
        ],
      },
    ];

    const neutral = toNeutral(entries);
    // Simulate the stale-error strategy replacing the input with its string placeholder.
    const mutated: NeutralMessage[] = neutral.map(msg => ({
      ...msg,
      parts: msg.parts.map(p =>
        p.type === "tool" && p.callId === "call-1"
          ? { ...p, input: "[input removed due to failed tool call]" }
          : p
      ),
    }));

    const result = applyNeutral(entries, mutated);
    const toolPart = result[0].parts.find(p => p.type === "tool") as { state: HostToolState } | undefined;
    expect(toolPart).toBeDefined();
    expect(typeof toolPart!.state.input).toBe("object");
    expect(Array.isArray(toolPart!.state.input)).toBe(false);
  });

  it("preserves non-mutated parts unchanged", () => {
    const entries: HostMessageEntry[] = [
      makeAssistantEntry("msg-1", "sess-1", "assistant text", "call-1", "tool output"),
    ];

    const neutral = toNeutral(entries);
    const result = applyNeutral(entries, neutral);

    // Text part should be unchanged
    const textPart = result[0].parts.find(p => p.type === "text") as { type: "text"; text: string } | undefined;
    expect(textPart?.text).toBe("assistant text");
  });
});

describe("opencode adapter: toNeutral + applyNeutral symmetry", () => {
  it("multiple messages round-trip without data loss", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("u1", "sess-1", "question 1"),
      makeAssistantEntry("a1", "sess-1", "answer 1", "c1", "output 1"),
      makeUserEntry("u2", "sess-1", "question 2"),
      makeAssistantEntry("a2", "sess-1", "answer 2"),
    ];

    const neutral = toNeutral(entries);
    const result = applyNeutral(entries, neutral);

    expect(result).toHaveLength(4);
    expect(result.map(e => e.info.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });
});

// ── Fix #3: Turn semantics ────────────────────────────────────────────────────
// toNeutral now assigns `turn = number of user messages seen so far` instead of
// the flat message-array index. This makes retention windows ("keep for N turns")
// mean N conversational back-and-forths regardless of how many tool calls a
// single turn spawns. currentTurn in the adapter is also set to user-message count.

describe("opencode adapter: user-turn-count turn semantics", () => {
  it("shares raw turns with projected/recovery subsets without advancing lifecycle clocks", () => {
    const state = createInitialState("sess-1");
    const users = Array.from({ length: 10 }, (_, i) => makeUserEntry(`u${i + 1}`, "sess-1", "continue"));
    const old = makeAssistantEntry("old", "sess-1", "old", "old-call", "old output");
    const fresh = makeAssistantEntry("fresh", "sess-1", "fresh", "fresh-call", "fresh output");
    const entries = [...users.slice(0, 2), old, ...users.slice(2), fresh];
    advanceTurnBasis(entries, state);
    expect(state.currentTurn).toBe(10);
    const toolTurns = (view: HostMessageEntry[]) => toNeutral(view, state)
      .flatMap(message => message.parts.filter(p => p.type === "tool").map(p => p.turn));
    expect(toolTurns(entries)).toEqual([2, 10]);
    expect(toolTurns([old, fresh])).toEqual([2, 10]);
    const recovered = makeAssistantEntry("recovered", "sess-1", "recovered", "recovered-call", "exact source");
    if (recovered.info.role !== "assistant") throw new Error("fixture role");
    recovered.info.parentID = "u2";
    expect(toolTurns([recovered])).toEqual([2]);
    recovered.info.parentID = "unavailable";
    expect(toolTurns([recovered])).toEqual([10]);

    state.temporaryRetrievals.set("b1", { blockId: "b1", mode: "summary", activatedAtTurn: 10, expiresAtTurn: 12, tokenCost: 1 });
    state.lastMaskingPassTurn = 9;
    recordCacheBust(state, 8);
    const before = cloneCoreState(state);
    toolTurns([fresh]);
    expect(state).toEqual(before); // Tools/dashboard mapping is strictly read-only.
    const cloned = cloneCoreState(state);
    cloned.turnBasis!.messageTurns[0][1] = 999;
    expect(state.turnBasis!.messageTurns[0][1]).toBe(1);

    advanceTurnBasis([users[9], fresh], state);
    expect(state.currentTurn).toBe(10);
    expect(expireTemporaryRetrievals(state, state.currentTurn)).toHaveLength(0);
    const nextUsers = [makeUserEntry("u11", "sess-1", "next"), makeUserEntry("u12", "sess-1", "next again")];
    advanceTurnBasis([users[9], fresh, ...nextUsers], state);
    expect(state.currentTurn).toBe(12); // Two visible new turns, not one request.
    expect(expireTemporaryRetrievals(state, state.currentTurn)).toHaveLength(1);
    expect(state.lastMaskingPassTurn).toBe(9);
    expect(state.lastCacheBustTurn).toBe(8);
    recordCacheBust(state, state.currentTurn);
    expect(state.eTurnsEstimate).toBeCloseTo(4.7, 8);
  });

  it("excludes synthetic users and retains the latest anchor across partial and empty feeds", () => {
    const state = createInitialState("sess-1");
    const first = makeUserEntry("u1", "sess-1", "first");
    const latest = makeUserEntry("u2", "sess-1", "latest");
    const summaries = ["__summary_b1", "__summary_catalog", "__manual_insert"].map(id => makeUserEntry(id, "sess-1", "synthetic"));
    const compression = makeUserEntry("compression", "sess-1", "compress");
    if (compression.info.role !== "user") throw new Error("fixture role");
    compression.info.agent = "ctx-compress";
    advanceTurnBasis([first, latest, ...summaries, compression], state);
    expect(state.currentTurn).toBe(2);
    advanceTurnBasis([first], state); // Known older partial feed is not a new turn.
    expect(state.currentTurn).toBe(2);
    expect(state.turnBasis!.latestUserId).toBe("u2");
    advanceTurnBasis([], state);
    expect(state.turnBasis!.messageTurns).toEqual([["u2", 2]]);
    advanceTurnBasis([latest], state);
    expect(state.currentTurn).toBe(2);
    advanceTurnBasis([makeUserEntry("disjoint", "sess-1", "new tail")], state);
    expect(state.currentTurn).toBe(3);
    expect(state.turnBasis!.messageTurns).toEqual([["disjoint", 3]]);
  });

  it("tool parts in the first assistant get turn=1 (after 1 user message)", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("u1", "sess-1", "question"),
      makeAssistantEntry("a1", "sess-1", "answer", "call-1", "output"),
    ];

    const neutral = toNeutral(entries);
    const toolPart = neutral[1].parts.find(p => p.type === "tool");
    expect(toolPart?.type).toBe("tool");
    if (toolPart?.type === "tool") {
      expect(toolPart.turn).toBe(1); // 1 user message seen before this assistant
    }
  });

  it("tool parts in the second assistant get turn=2 (after 2 user messages)", () => {
    const entries: HostMessageEntry[] = [
      makeUserEntry("u1", "sess-1", "q1"),
      makeAssistantEntry("a1", "sess-1", "a1", "call-1", "out1"),
      makeUserEntry("u2", "sess-1", "q2"),
      makeAssistantEntry("a2", "sess-1", "a2", "call-2", "out2"),
    ];

    const neutral = toNeutral(entries);
    const tp1 = neutral[1].parts.find(p => p.type === "tool");
    const tp2 = neutral[3].parts.find(p => p.type === "tool");

    expect(tp1?.type === "tool" && tp1.turn).toBe(1);
    expect(tp2?.type === "tool" && tp2.turn).toBe(2);
  });

  it("multiple tool calls in the same assistant share the same turn", () => {
    // Build an assistant entry with two tool calls
    const id = "a1";
    const sessionID = "sess-1";
    const entry: HostMessageEntry = {
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created: 1100, completed: 1200 },
        parentID: "parent-1",
        modelID: "deepseek-v4-flash",
        providerID: "opencode-go",
        mode: "chat",
        path: { cwd: "/", root: "/" },
        summary: false,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: `${id}-tool1`, sessionID, messageID: id, type: "tool", callID: "c1", tool: "read",
          state: { status: "completed", input: { filePath: "/a" }, output: "a", title: "read", time: { start: 0, end: 0 } } },
        { id: `${id}-tool2`, sessionID, messageID: id, type: "tool", callID: "c2", tool: "read",
          state: { status: "completed", input: { filePath: "/b" }, output: "b", title: "read", time: { start: 0, end: 0 } } },
      ],
    };

    const entries: HostMessageEntry[] = [
      makeUserEntry("u1", sessionID, "do two reads"),
      entry,
    ];

    const neutral = toNeutral(entries);
    const toolParts = neutral[1].parts.filter(p => p.type === "tool");
    expect(toolParts).toHaveLength(2);
    // Both tools in the same assistant should have the same user-turn count
    expect(toolParts[0].type === "tool" && toolParts[0].turn).toBe(1);
    expect(toolParts[1].type === "tool" && toolParts[1].turn).toBe(1);
  });
});
