import { describe, expect, it } from "bun:test";
import { applyDecisions } from "../core/applyDecisions.js";
import { applyCompressionBatch } from "../core/compress/transaction.js";
import { activateCompressionBlock, deactivateCompressionBlock } from "../core/compress/reversible.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { runPipeline } from "../core/pipeline.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { createInitialState } from "../types/state.js";
import type { CoreState } from "../types/state.js";
import type { NeutralMessage, TokenUsage, ToolPart } from "../types/neutral.js";

const tokenizer = new CharTokenizer();
const workspaceDir = "/workspace";
const configFor = () => {
  const config = buildDefaultConfig("visible-projection");
  config.costRoi.enabled = false;
  config.recencyGuardTurns = 0;
  config.compressionRecencyRequests = 0;
  config.toolClasses = Object.fromEntries(Object.entries(config.toolClasses).map(([name, tool]) =>
    [name, { ...tool, retentionTurns: 0 }]));
  config.clearAtLeast = 0;
  config.minRepruneInterval = 0;
  config.nudges.maskTriggerThreshold = 1000;
  config.contextTiers.ageDemotionEnabled = false;
  config.contextTiers.warmBudgetMode = "advisory";
  return config;
};
const tool = (id: string, output: string, input = id): NeutralMessage => ({
  id, sessionId: "visible-projection", role: "assistant", createdAt: Number(id.replace(/\D/g, "")) || 1,
  parts: [{ type: "tool", callId: `${id}-call`, tool: "read", status: "completed", input: { filePath: input }, output, turn: 1 }],
});
const user = (id: string): NeutralMessage => ({
  id, sessionId: "visible-projection", role: "user", createdAt: 100,
  parts: [{ type: "text", text: "continue" }],
});
const usage = (input: number, cacheRead: number, cacheWrite = 0): TokenUsage =>
  ({ input, cacheRead, cacheWrite, output: 0, reasoning: 0 });
const run = (messages: NeutralMessage[], state: CoreState, config = configFor(), nowMs = 1000) =>
  runPipeline({ messages, state, config, nowMs }, { tokenizer, workspaceDir });
const outputOf = (message: NeutralMessage) => (message.parts[0] as ToolPart).output;

describe("provider cache signal", () => {
  it("uses the latest valid assistant INPUT sample across zero stubs and nonassistant usage", () => {
    const state = createInitialState("visible-projection");
    const config = configFor();
    config.automation.automaticPruning = false;
    const warm: NeutralMessage = { ...tool("a1", "done"), tokens: usage(100, 1000) };
    const zero: NeutralMessage = { ...tool("a2", "pending"), tokens: usage(0, 0) };
    const fakeUser = { ...user("u1"), tokens: usage(100, 0) };
    expect(run([warm], state, config).state.lastCacheMiss).toBe(false);
    const first = run([warm, zero, fakeUser], state, config);
    expect(first.state.lastCacheMiss).toBe(false);
    expect(run([warm, zero, fakeUser], state, config).state.lastCacheMiss).toBe(false);
    const cold = { ...tool("a3", "done"), tokens: usage(0, 0, 150) };
    expect(run([warm, zero, fakeUser, cold], state, config).state.lastCacheMiss).toBe(true);
    expect(run([zero, fakeUser], state, config).state.lastCacheMiss).toBe(true);
  });

  it("does not treat old-model usage as current after an adapter-marked switch", () => {
    const state = createInitialState("visible-projection");
    const config = configFor();
    config.automation.automaticPruning = false;
    state.contextTokenMetrics.modelKey = "new-provider/new-model";
    const foreign = { ...tool("a1", "old"), tokens: usage(100, 0) };
    run([foreign], state, config);
    expect(state.lastCacheMiss).toBe(false);
    const current = { ...tool("a2", "current"), tokens: usage(0, 200) };
    state.contextTokenMetrics.consumedCalibrationAssistantIds = [current.id];
    run([foreign, current], state, config);
    expect(state.lastCacheMiss).toBe(false);
    state.contextTokenMetrics.consumedCalibrationAssistantIds = [...state.contextTokenMetrics.consumedCalibrationAssistantIds, foreign.id];
    run([foreign, current], state, config);
    expect(state.lastCacheMiss).toBe(false);
  });
});

describe("cascade uses the automatic visible projection", () => {
  it("does not use hidden source tokens to authorize warm-cache age demotion", () => {
    const config = configFor();
    config.costRoi.enabled = true;
    config.cacheModel.R = 10;
    config.cachePrune.afterCompress = false;
    config.contextTiers.ageDemotionEnabled = true;
    config.contextTiers.warmMaxAgeTurns = 40;
    config.nudges.upperThreshold = 200;
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    const raw = [tool("a1", "x".repeat(20_000)), user("u1")];
    const compressed = applyCompressionBatch({ messages: raw, state, config, tokenizer, nowMs: 1,
      requests: [{ mode: "message", messageRef: "a1", topic: "old", summary: "short" }] });
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const block = compressed.state.blockRegistry.get("b1")!;
    block.durableSourceRef = "verified-source";
    block.durableSummaryRef = "verified-summary";
    compressed.state.currentTurn = 80;
    compressed.state.lastRequestTime = 9_000;
    compressed.state.lastCacheMiss = false;
    const first = run(raw, compressed.state, config, 10_000);
    expect(block.projectionTier).toBe("warm");
    expect(first.state.hasRecordedCacheBust).toBe(false);
    expect(first.messages.map(message => message.id)).toEqual(["__summary_b1", "u1"]);

    // Real visible pressure still permits age demotion on this warm cache.
    run([...raw.slice(0, 1), tool("a2", "y".repeat(2_000)), raw[1]], compressed.state, config, 10_001);
    expect(block.projectionTier).toBe("cold");
  });

  it("ignores a compressed 20k Read during budgets, offload, telemetry and repeat feeds", () => {
    const config = configFor();
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    const raw = [tool("a1", "x".repeat(20_000)), user("u1")];
    const exact = structuredClone(raw);
    const compressed = applyCompressionBatch({ messages: raw, state, config, tokenizer, nowMs: 1,
      requests: [{ mode: "message", messageRef: "a1", topic: "old", summary: "short" }] });
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const events: string[] = [];
    const services = { tokenizer, workspaceDir, telemetry: (event: { type: string }) => { events.push(event.type); } };
    for (let n = 0; n < 2; n++) {
      const result = runPipeline({ messages: raw, state: compressed.state, config, nowMs: 1000 + n }, services);
      expect(result.state.maskDecisions.size).toBe(0);
      expect(result.offloadRequests).toHaveLength(0);
      expect(result.savedThisRun).toBe(0);
      expect(result.state.hasRecordedCacheBust).toBe(false);
      expect(result.messages.map(message => message.id)).toEqual(["__summary_b1", "u1"]);
      expect(result.estimatedTokens).toBeLessThan(100);
      expect(events.filter(type => type === "mask" || type === "offload")).toHaveLength(0);
    }
    expect(raw).toEqual(exact);
    expect(outputOf(raw[0])).toBe("x".repeat(20_000));
  });

  it("does not mask unrelated visible calls when only hidden content exceeds the trigger", () => {
    const config = configFor();
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    const raw = [tool("a1", "x".repeat(20_000)), tool("a2", "y".repeat(1200)), user("u1")];
    const compressed = applyCompressionBatch({ messages: raw, state, config, tokenizer, nowMs: 1,
      requests: [{ mode: "message", messageRef: "a1", topic: "old", summary: "short" }] });
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const result = run(raw, compressed.state, config);
    expect(result.offloadRequests).toHaveLength(0);
    expect(result.state.maskDecisions.size).toBe(0);
    expect(outputOf(result.messages.find(message => message.id === "a2")!)).toBe("y".repeat(1200));
    expect(result.estimatedTokens).toBeLessThan(config.nudges.maskTriggerThreshold as number);
  });

  it("still prunes visible duplicates and reapplies their decision byte-stably", () => {
    const config = configFor();
    config.nudges.maskTriggerThreshold = 100_000;
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    const raw = [
      tool("a1", "x".repeat(20_000)),
      tool("a2", "same result".repeat(30), "/shared"),
      tool("a3", "same result".repeat(30), "/shared"),
      user("u1"),
    ];
    const compressed = applyCompressionBatch({ messages: raw, state, config, tokenizer, nowMs: 1,
      requests: [{ mode: "message", messageRef: "a1", topic: "old", summary: "short" }] });
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const first = run(raw, compressed.state, config);
    expect(first.state.dedupDecisions.has("a2-call")).toBe(true);
    expect(first.state.dedupDecisions.has("a1-call")).toBe(false);
    expect(first.messages.some(message => message.id === "a1")).toBe(false);
    const second = run(raw, first.state, config);
    expect(second.messages).toEqual(first.messages);
    expect(second.savedThisRun).toBe(0);
    expect(outputOf(raw[1])).toBe("same result".repeat(30));
  });

  it("does not count an already masked visible output as another new prefix rewrite", () => {
    const config = configFor();
    config.nudges.maskTriggerThreshold = 100_000;
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    state.maskDecisions.set("a1-call", "[cached pointer]");
    state.messageIndex.set("a1-call", { messageId: "a1", masked: true, offloaded: false });
    const raw = [tool("a1", "x".repeat(20_000), "/shared"), tool("a2", "new output", "/shared"), user("u1")];
    const events: string[] = [];
    const result = runPipeline({ messages: raw, state, config, nowMs: 1000 }, {
      tokenizer, workspaceDir, telemetry: event => { events.push(event.type); },
    });
    expect(result.state.dedupDecisions.size).toBe(0);
    expect(result.state.hasRecordedCacheBust).toBe(false);
    expect(result.savedThisRun).toBe(0);
    expect(events.includes("dedup")).toBe(false);
    expect(outputOf(result.messages.find(message => message.id === "a1")!)).toBe("[cached pointer]");
  });

  it("preserves old hidden decisions through GC and restores exact source after deactivation", () => {
    const config = configFor();
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    const raw = [tool("a1", "x".repeat(20_000)), user("u1")];
    state.maskDecisions.set("a1-call", "[earlier mask]");
    state.messageIndex.set("a1-call", { messageId: "a1", masked: true, offloaded: false });
    const compressed = applyCompressionBatch({ messages: raw, state, config, tokenizer, nowMs: 1,
      requests: [{ mode: "message", messageRef: "a1", topic: "old", summary: "short" }] });
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    run(raw, compressed.state, config);
    expect(compressed.state.maskDecisions.get("a1-call")).toBe("[earlier mask]");
    expect(compressed.state.messageIndex.has("a1-call")).toBe(true);
    const inactive = deactivateCompressionBlock(compressed.state, "b1")!;
    // A manual keep exposes exact raw content even when an earlier mask persists.
    inactive.state.manualOverrides.set("a1", { mode: "keep" });
    const restored = run(raw, inactive.state, config);
    expect(outputOf(restored.messages.find(message => message.id === "a1")!)).toBe("x".repeat(20_000));
    expect(raw[0].parts[0]).toEqual(tool("a1", "x".repeat(20_000)).parts[0]);
    expect(inactive.state.maskDecisions.has("a1-call")).toBe(false);
    inactive.state.manualOverrides.delete("a1");
    const active = activateCompressionBlock(inactive.state, "b1")!;
    const rehidden = run(raw, active.state, config);
    expect(rehidden.messages.map(message => message.id)).toEqual(["__summary_b1", "u1"]);
  });

  it("uses active nested parent coverage and a cold catalog, not stale index entries", () => {
    const config = configFor();
    const state = createInitialState("visible-projection");
    state.currentTurn = 30;
    const raw = [tool("a1", "x".repeat(20_000)), user("u1")];
    const child = applyCompressionBatch({ messages: raw, state, config, tokenizer, nowMs: 1,
      requests: [{ mode: "message", messageRef: "a1", topic: "child", summary: "child summary" }] });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    const parent = applyCompressionBatch({ messages: child.messages, state: child.state, config, tokenizer, nowMs: 2,
      requests: [{ mode: "message", messageRef: "b1", topic: "parent", summary: "parent summary" }] });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    parent.state.blockRegistry.get("b2")!.projectionTier = "cold";
    // A stale child index must not decide visibility; graph roots are authoritative.
    parent.state.compressionIndex = child.state.compressionIndex;
    const cold = run(raw, parent.state, config);
    expect(cold.state.maskDecisions.size).toBe(0);
    expect(cold.offloadRequests).toHaveLength(0);
    expect(cold.messages.some(message => message.id === "a1" || message.id === "__summary_b1" || message.id === "__summary_b2")).toBe(false);
    expect(cold.messages.some(message => message.id === "__summary___ctx_cold_catalog")).toBe(true);
    const exposedChild = deactivateCompressionBlock(parent.state, "b2")!;
    const warm = run(raw, exposedChild.state, config);
    expect(warm.messages.map(message => message.id)).toEqual(["__summary_b1", "u1"]);
    expect(warm.state.maskDecisions.size).toBe(0);
    const restored = deactivateCompressionBlock(exposedChild.state, "b1")!;
    restored.state.compressionIndex = parent.state.compressionIndex;
    const visible = applyDecisions(raw, restored.state, { tokenizer, contextTiers: config.contextTiers });
    expect(visible.find(message => message.id === "a1")?.isIgnored).not.toBe(true);
  });
});
