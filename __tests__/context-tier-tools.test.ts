// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { describe, expect, it } from "bun:test";
import {
  buildCompressTool,
  buildCompressMessageTool,
  buildCompressionArchiveReleaseTool,
  buildCompressionArchiveRetrieveTool,
  buildCompressionArchiveSearchTool,
  buildContextTierUpdateTool,
  type CompressToolDeps,
} from "../adapters/opencode/tool.js";
import {
  archiveCompressionSource,
  archiveCompressionSummary,
  buildRetrievalToolOutput,
  loadCompressionSource,
  loadCompressionSummary,
} from "../adapters/opencode/compression-archive.js";
import type { HostMessageEntry, HostToolContext } from "../adapters/opencode/host-types.js";
import { buildDefaultConfig } from "../core/defaults.js";
import type { CoreConfig } from "../types/config.js";
import { InMemoryContentStore } from "../services/contentStore.js";
import type { Persistence } from "../services/persistence.js";
import { CharTokenizer } from "../services/tokenizer.js";
import type { BlockMetadata, CoreState } from "../types/state.js";
import { createInitialState } from "../types/state.js";

function entry(id: string, sessionId = "s", text = id): HostMessageEntry {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: 1 },
      agent: "test",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ id: `${id}-text`, sessionID: sessionId, messageID: id, type: "text", text }],
  };
}

function context(sessionID = "s"): HostToolContext {
  return {
    sessionID,
    messageID: "tool-message",
    agent: "test",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

function block(blockId: string, overrides: Partial<BlockMetadata> = {}): BlockMetadata {
  return {
    blockId,
    runId: "r1",
    mode: "range",
    topic: `topic ${blockId}`,
    startRef: "m1",
    endRef: "m1",
    anchorMessageId: "m1",
    active: true,
    deactivatedByUser: false,
    includedBlockIds: [],
    consumedBlockIds: [],
    parentBlockIds: [],
    directMessageIds: ["m1"],
    effectiveMessageIds: ["m1"],
    directToolCallIds: [],
    effectiveToolCallIds: [],
    sourceTokens: 10,
    summaryTokens: 2,
    netTokens: 8,
    summaryText: "summary",
    projectionTier: "cold",
    createdAt: 1,
    updatedAt: 1,
    updatedAtTurn: 1,
    sourceMessageIds: ["m1"],
    createdAtTurn: 1,
    tokens: 2,
    consumed: false,
    ...overrides,
  };
}

function harness(options: {
  sessionId?: string;
  state?: CoreState;
  entries?: HostMessageEntry[];
  store?: InMemoryContentStore;
  persistence?: Persistence;
  includeStore?: boolean;
  config?: CoreConfig;
} = {}) {
  const sessionId = options.sessionId ?? "s";
  let state = options.state ?? createInitialState(sessionId);
  state.currentTurn = Math.max(state.currentTurn, 20);
  let projected = options.entries ?? [
    entry("m1", sessionId, `first ${"a".repeat(1_000)}`),
    entry("m2", sessionId, `second ${"b".repeat(1_000)}`),
  ];
  const raw = structuredClone(projected);
  const store = options.store ?? new InMemoryContentStore();
  const saved: CoreState[] = [];
  const persistence = options.persistence ?? {
    load: async () => undefined,
    save: async (_sessionId: string, candidate: CoreState) => { saved.push(candidate); },
  };
  const defaultConfig = options.config ?? buildDefaultConfig(sessionId);
  defaultConfig.recencyGuardTurns = 0;
  defaultConfig.compressionRecencyRequests = 0;
  const deps: CompressToolDeps = {
    getState: id => id === sessionId ? state : undefined,
    setState: (_id, next) => { state = next; },
    getConfig: id => id === sessionId ? defaultConfig : undefined,
    getProjectedEntries: id => id === sessionId ? projected : undefined,
    getRawEntries: id => id === sessionId ? raw : undefined,
    setProjectedEntries: (_id, next) => { projected = next; },
    contentStore: options.includeStore === false ? undefined : store,
    persistence,
    tokenizer: new CharTokenizer(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    runExclusive: async (_id, task) => task(),
  };
  return { deps, store, saved, getState: () => state, getProjected: () => projected };
}

describe("compression transaction dual archives", () => {
  it("exposes model-directed tier fields on both compression tools", () => {
    const h = harness();
    for (const tool of [buildCompressTool(h.deps), buildCompressMessageTool(h.deps)]) {
      expect(tool.args.promoteBlockIds.uniqueItems).toBe(true);
      expect(tool.args.demoteBlockIds.uniqueItems).toBe(true);
    }
  });

  it("archives and verifies exact source plus summary before publishing refs", async () => {
    const h = harness();
    const result = await buildCompressTool(h.deps).execute({
      topic: "dual archive",
      content: [{ startId: "m1", endId: "m2", summary: "complete historical summary" }],
    }, context()) as { output: string; metadata?: Record<string, unknown> };

    expect(result.output).toContain("b1");
    expect(result.output).toContain("Projected history:");
    expect(result.output).toContain("target <=");
    expect(result.output).toContain("Advisory target reached.");
    expect(JSON.stringify(result.metadata)).not.toContain("contentId");
    const savedBlock = h.getState().blockRegistry.get("b1")!;
    expect(savedBlock.durableSourceRef).toBeDefined();
    expect(savedBlock.durableSummaryRef).toBeDefined();
    expect((await loadCompressionSource(h.store, savedBlock.durableSourceRef!, "s", "b1", ["m1", "m2"]))
      .map(item => item.info.id)).toEqual(["m1", "m2"]);
    expect(await loadCompressionSummary(h.store, savedBlock.durableSummaryRef!, "s", "b1"))
      .toBe("complete historical summary");
  });

  it("rejects before persistence when no content store exists", async () => {
    const h = harness({ includeStore: false });
    const result = await buildCompressTool(h.deps).execute({
      topic: "no store",
      content: [{ startId: "m1", endId: "m2", summary: "summary" }],
    }, context()) as { output: string };
    expect(result.output).toContain("required");
    expect(h.saved).toHaveLength(0);
    expect(h.getState().blockRegistry.size).toBe(0);
  });

  it("on persistence failure deletes only archives newly created by the transaction", async () => {
    const store = new InMemoryContentStore();
    const existing = await archiveCompressionSource(store, "s", "b1", "dual archive", ["m1", "m2"],
      [entry("m1", "s", `first ${"a".repeat(1_000)}`), entry("m2", "s", `second ${"b".repeat(1_000)}`)]);
    const persistence: Persistence = {
      load: async () => undefined,
      save: async () => { throw new Error("disk full"); },
    };
    const h = harness({ store, persistence });
    const result = await buildCompressTool(h.deps).execute({
      topic: "dual archive",
      content: [{ startId: "m1", endId: "m2", summary: "new summary" }],
    }, context()) as { output: string };

    expect(result.output).toContain("not committed");
    expect(await store.get(existing.record.id)).toBeDefined();
    expect((await store.list({ sessionId: "s" })).map(record => record.metadata.kind))
      .toEqual(["compression-source-v1"]);
    expect(h.getState().blockRegistry.size).toBe(0);
  });

  it("commits directed COLD to WARM promotion with compression in one state save", async () => {
    const state = createInitialState("s");
    state.currentTurn = 20;
    const existing = block("b1", { effectiveMessageIds: ["m1"], directMessageIds: ["m1"], sourceMessageIds: ["m1"] });
    const store = new InMemoryContentStore();
    const source = await archiveCompressionSource(store, "s", "b1", existing.topic, ["m1"], [entry("m1", "s", `first ${"a".repeat(1_000)}`)]);
    const summary = await archiveCompressionSummary(store, "s", "b1", existing.topic, existing.summaryText);
    existing.durableSourceRef = source.record.id;
    existing.durableSummaryRef = summary.record.id;
    state.blockRegistry.set("b1", existing);
    state.nextBlockId = 2;
    state.temporaryRetrievals.set("b1", {
      blockId: "b1", mode: "summary", activatedAtTurn: 19, expiresAtTurn: 22,
      tokenCost: 2, messageId: "retrieval-message",
    });
    const retrievalOutput = buildRetrievalToolOutput([{ blockId: "b1", topic: existing.topic, summaryText: "SECRET RETRIEVED SUMMARY" }], []);
    const retrievalEntry: HostMessageEntry = {
      info: {
        id: "retrieval-message", sessionID: "s", role: "assistant", parentID: "m2",
        modelID: "m", providerID: "p", mode: "chat",
        path: { cwd: "/tmp", root: "/tmp" }, time: { created: 1, completed: 2 },
        summary: false, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "tool-calls",
      },
      parts: [{
        id: "retrieval-tool", sessionID: "s", messageID: "retrieval-message", type: "tool",
        callID: "retrieve-call", tool: "ctx_archive_retrieve",
        state: { status: "completed", input: { blockIds: ["b1"] }, output: retrievalOutput, title: "retrieve", time: { start: 1, end: 2 } },
      }],
    };
    const h = harness({ state, store, entries: [
      entry("m1", "s", `first ${"a".repeat(1_000)}`),
      entry("m2", "s", `second ${"b".repeat(1_000)}`),
      retrievalEntry,
    ] });

    const result = await buildCompressTool(h.deps).execute({
      topic: "new work",
      content: [{ startId: "m2", endId: "m2", summary: "new summary" }],
      promoteBlockIds: ["b1"],
    }, context()) as { output: string };

    expect(result.output).toContain("Tier changes: b1");
    expect(h.saved).toHaveLength(1);
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("warm");
    expect(h.getState().projectionEditRevision).toBe(1);
    expect(JSON.stringify(h.getProjected())).toContain("summary");
    expect(JSON.stringify(h.getProjected())).not.toContain("SECRET RETRIEVED SUMMARY");
    expect(JSON.stringify(h.getProjected())).toContain("retrieval expired or released");
  });

  it("enforces the strict WARM cap immediately without directed arguments", async () => {
    const config = buildDefaultConfig("s");
    config.recencyGuardTurns = 0;
    config.modelContextLimit = 100;
    config.contextTiers.warmMaxTokens = 1;
    config.contextTiers.catalogMaxTokens = 100;
    const h = harness({ config });
    const result = await buildCompressTool(h.deps).execute({
      topic: "large summary",
      content: [{ startId: "m1", endId: "m2", summary: "summary that cannot remain warm" }],
    }, context()) as { output: string };

    expect(result.output).toContain("Tier changes: b1");
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("cold");
    expect(JSON.stringify(h.getProjected())).toContain("Cold context catalog");
  });

  it("rejects directed tiers when automatic tier projection is disabled", async () => {
    const state = createInitialState("s");
    const existing = block("b1");
    state.blockRegistry.set("b1", existing);
    state.nextBlockId = 2;
    const config = buildDefaultConfig("s");
    config.automation.automaticPruning = false;
    const h = harness({ state, config });
    const result = await buildCompressTool(h.deps).execute({
      topic: "disabled tiers",
      content: [{ startId: "m2", endId: "m2", summary: "new summary" }],
      promoteBlockIds: ["b1"],
    }, context()) as { output: string };

    expect(result.output).toContain("tier projection is disabled");
    expect(h.saved).toHaveLength(0);
    expect(h.getState().blockRegistry.size).toBe(1);
  });

  it("uses calibrated tokens for promotion budget validation", async () => {
    const state = createInitialState("s");
    state.tokenCalibration = { ratio: 2, sampleCount: 1 };
    const existing = block("b1", { summaryText: "123456789012345678901234", summaryTokens: 6, tokens: 6 });
    const store = new InMemoryContentStore();
    const source = await archiveCompressionSource(store, "s", "b1", existing.topic, ["m1"], [entry("m1", "s")]);
    const summary = await archiveCompressionSummary(store, "s", "b1", existing.topic, existing.summaryText);
    existing.durableSourceRef = source.record.id;
    existing.durableSummaryRef = summary.record.id;
    state.blockRegistry.set("b1", existing);
    state.nextBlockId = 2;
    const config = buildDefaultConfig("s");
    config.modelContextLimit = 100;
    config.contextTiers.warmMaxTokens = 10;
    const h = harness({ state, store, config });
    const result = await buildCompressTool(h.deps).execute({
      topic: "calibrated budget",
      content: [{ startId: "m2", endId: "m2", summary: "x" }],
      promoteBlockIds: ["b1"],
    }, context()) as { output: string };

    expect(result.output).toContain("selected WARM summaries require");
    expect(h.saved).toHaveLength(0);
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("cold");
  });
});

describe("model-facing context archive tools", () => {
  it("searches only the current session and exposes no content IDs", async () => {
    const h = harness();
    const own = await archiveCompressionSummary(h.store, "s", "b1", "own topic", "needle in current session");
    await archiveCompressionSummary(h.store, "other", "b2", "secret topic", "needle in other session");
    const result = await buildCompressionArchiveSearchTool(h.deps).execute({ query: "needle", limit: 99 }, context()) as {
      output: string;
      metadata?: Record<string, unknown>;
    };
    expect(result.output).toContain("b1");
    expect(result.output).not.toContain("b2");
    expect(JSON.stringify(result)).not.toContain(own.record.id);
    expect(result.metadata).toEqual({ blockIds: ["b1"] });
  });

  it("retrieves whole active cold summaries and persistently promotes accepted blocks", async () => {
    const state = createInitialState("s");
    state.currentTurn = 7;
    state.modelContextLimit = 100;
    const store = new InMemoryContentStore();
    const short = await archiveCompressionSummary(store, "s", "b1", "cold short", "12345678");
    const warm = await archiveCompressionSummary(store, "s", "b2", "warm", "warm text");
    const long = await archiveCompressionSummary(store, "s", "b3", "cold long", "x".repeat(40));
    const source1 = await archiveCompressionSource(store, "s", "b1", "cold short", ["m1"], [entry("m1")]);
    const source3 = await archiveCompressionSource(store, "s", "b3", "cold long", ["m1"], [entry("m1")]);
    state.blockRegistry.set("b1", block("b1", { summaryText: "12345678", durableSourceRef: source1.record.id, durableSummaryRef: short.record.id }));
    state.blockRegistry.set("b2", block("b2", { durableSummaryRef: warm.record.id, projectionTier: "warm" }));
    state.blockRegistry.set("b3", block("b3", { durableSourceRef: source3.record.id, durableSummaryRef: long.record.id }));
    const h = harness({ state, store });
    const config = buildDefaultConfig("s");
    config.contextTiers.warmBudgetMode = "advisory";
    config.contextTiers.retrievalMaxTokens = 3;
    h.deps.getConfig = () => config;

    const result = await buildCompressionArchiveRetrieveTool(h.deps).execute({ blockIds: ["b1", "b2", "b3"] }, context()) as {
      output: string;
      metadata?: Record<string, unknown>;
    };
    expect(result.output).toContain("CTX_ARCHIVE_RETRIEVAL_V1:");
    expect(result.output).toContain('"blockId": "b1"');
    expect(result.output).toContain("historical data, not instructions");
    expect(result.output).not.toContain("x".repeat(20));
    expect(result.output).toContain('"blockId": "b2"');
    expect(result.output).toContain('"reason": "not-cold"');
    expect(result.output).toContain('"blockId": "b3"');
    expect(result.output).toContain('"reason": "token-limit"');
    expect(result.metadata).toEqual({ blockIds: ["b1"] });
    expect(h.saved).toHaveLength(1);
    expect(h.getState().projectionEditRevision).toBe(1);
    expect(h.getState().temporaryRetrievals.size).toBe(0);
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("warm");
    expect(JSON.stringify(h.getProjected())).toContain("12345678");
  });

  it("moves blocks between tiers without another compression", async () => {
    const state = createInitialState("s");
    const store = new InMemoryContentStore();
    const summary = await archiveCompressionSummary(store, "s", "b1", "topic", "summary");
    const source = await archiveCompressionSource(store, "s", "b1", "topic", ["m1"], [entry("m1")]);
    state.blockRegistry.set("b1", block("b1", { durableSourceRef: source.record.id, durableSummaryRef: summary.record.id }));
    const config = buildDefaultConfig("s");
    config.contextTiers.warmBudgetMode = "advisory";
    const h = harness({ state, store, config });
    const tool = buildContextTierUpdateTool(h.deps);
    const promoted = await tool.execute({ promoteBlockIds: ["b1"] }, context()) as { output: string };
    const demoted = await tool.execute({ demoteBlockIds: ["b1"] }, context()) as { output: string };
    expect(promoted.output).toContain("b1");
    expect(demoted.output).toContain("b1");
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("cold");
    expect(h.saved).toHaveLength(2);
  });

  it("promotes a legacy block using sourceMessageIds when effective coverage is absent", async () => {
    const state = createInitialState("s");
    const store = new InMemoryContentStore();
    const summary = await archiveCompressionSummary(store, "s", "b1", "topic", "summary");
    const source = await archiveCompressionSource(store, "s", "b1", "topic", ["m1"], [entry("m1")]);
    const legacy = block("b1", { durableSourceRef: source.record.id, durableSummaryRef: summary.record.id });
    const legacyRecord = legacy as unknown as { effectiveMessageIds?: string[] };
    delete legacyRecord.effectiveMessageIds;
    state.blockRegistry.set("b1", legacy);
    const config = buildDefaultConfig("s");
    config.contextTiers.warmBudgetMode = "advisory";
    const h = harness({ state, store, config });
    const result = await buildContextTierUpdateTool(h.deps).execute({ promoteBlockIds: ["b1"] }, context()) as { output: string };
    expect(result.output).toContain("b1");
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("warm");
  });

  it("rejects tier promotion when the verified archive disagrees with block state", async () => {
    const state = createInitialState("s");
    const store = new InMemoryContentStore();
    const summary = await archiveCompressionSummary(store, "s", "b1", "topic", "archived summary");
    const source = await archiveCompressionSource(store, "s", "b1", "topic", ["m1"], [entry("m1")]);
    state.blockRegistry.set("b1", block("b1", {
      summaryText: "different state summary",
      durableSourceRef: source.record.id,
      durableSummaryRef: summary.record.id,
    }));
    const config = buildDefaultConfig("s");
    config.contextTiers.warmBudgetMode = "advisory";
    const h = harness({ state, store, config });
    const result = await buildContextTierUpdateTool(h.deps).execute({ promoteBlockIds: ["b1"] }, context()) as { output: string };
    expect(result.output).toContain("failed to verify");
    expect(h.saved).toHaveLength(0);
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("cold");
  });

  it("rejects compression-coupled promotion on a mismatched summary archive", async () => {
    const state = createInitialState("s");
    const store = new InMemoryContentStore();
    const summary = await archiveCompressionSummary(store, "s", "b1", "topic", "archived summary");
    const source = await archiveCompressionSource(store, "s", "b1", "topic", ["m1"], [entry("m1")]);
    state.blockRegistry.set("b1", block("b1", {
      summaryText: "different state summary",
      durableSourceRef: source.record.id,
      durableSummaryRef: summary.record.id,
    }));
    state.nextBlockId = 2;
    const config = buildDefaultConfig("s");
    config.contextTiers.warmBudgetMode = "advisory";
    const h = harness({ state, store, config });
    const result = await buildCompressTool(h.deps).execute({
      topic: "new work",
      content: [{ startId: "m2", endId: "m2", summary: "new summary" }],
      promoteBlockIds: ["b1"],
    }, context()) as { output: string };
    expect(result.output).toContain("failed to verify directed tier archives");
    expect(h.saved).toHaveLength(0);
    expect(h.getState().blockRegistry.size).toBe(1);
  });

  it("uses calibrated tokens for advisory retrieval response safety", async () => {
    const state = createInitialState("s");
    state.tokenCalibration = { ratio: 2, sampleCount: 1 };
    const store = new InMemoryContentStore();
    const summaryText = "123456789012";
    const summary = await archiveCompressionSummary(store, "s", "b1", "topic", summaryText);
    const source = await archiveCompressionSource(store, "s", "b1", "topic", ["m1"], [entry("m1")]);
    state.blockRegistry.set("b1", block("b1", { summaryText, durableSourceRef: source.record.id, durableSummaryRef: summary.record.id }));
    const config = buildDefaultConfig("s");
    config.modelContextLimit = 100;
    config.contextTiers.warmBudgetMode = "advisory";
    config.contextTiers.retrievalMaxTokens = 4;
    const h = harness({ state, store, config });
    const result = await buildCompressionArchiveRetrieveTool(h.deps).execute({ blockIds: ["b1"] }, context()) as { output: string };
    expect(result.output).toContain("token-limit");
    expect(h.saved).toHaveLength(0);
    expect(h.getState().blockRegistry.get("b1")?.projectionTier).toBe("cold");
  });

  it("releases selected or all leases idempotently without deleting archives", async () => {
    const state = createInitialState("s");
    state.temporaryRetrievals.set("b1", { blockId: "b1", mode: "summary", activatedAtTurn: 1, expiresAtTurn: 3, tokenCost: 2 });
    state.temporaryRetrievals.set("b2", { blockId: "b2", mode: "summary", activatedAtTurn: 1, expiresAtTurn: 3, tokenCost: 2 });
    const store = new InMemoryContentStore();
    const archive = await archiveCompressionSummary(store, "s", "b1", "topic", "summary");
    const h = harness({ state, store });
    const tool = buildCompressionArchiveReleaseTool(h.deps);

    const first = await tool.execute({ blockIds: ["b1"] }, context()) as { output: string };
    const second = await tool.execute({ blockIds: ["b1"] }, context()) as { output: string };
    const all = await tool.execute({}, context()) as { output: string };
    expect(first.output).toContain("b1");
    expect(second.output).toContain("No matching");
    expect(all.output).toContain("b2");
    expect(h.getState().temporaryRetrievals.size).toBe(0);
    expect(h.getState().projectionEditRevision).toBe(2);
    expect(await store.get(archive.record.id)).toBeDefined();
    expect(h.saved).toHaveLength(3);
  });
});
