import { describe, expect, test } from "bun:test";
import type { BlockMetadata } from "../types/state.js";
import type { NeutralMessage } from "../types/neutral.js";
import { createInitialState } from "../types/state.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { resolveConfig } from "../core/config.js";
import { applyDecisions } from "../core/applyDecisions.js";
import { runPipeline } from "../core/pipeline.js";
import {
  activateTemporaryRetrieval,
  applyDirectedTierSelection,
  applyTierDemotions,
  buildColdCatalog,
  expireTemporaryRetrievals,
  planTemporaryRetrieval,
  planDirectedTierSelection,
  planTierDemotions,
  selectActiveRootBlocks,
} from "../core/contextTiers.js";
import { CharTokenizer } from "../services/tokenizer.js";

const tokenizer = new CharTokenizer();

function block(id: string, turn: number, summary = "summary"): BlockMetadata {
  const n = Number(id.slice(1));
  return {
    blockId: id, runId: `r${n}`, mode: "range", topic: `topic-${id}`,
    startRef: `m${n}`, endRef: `m${n}`, anchorMessageId: `m${n}`,
    active: true, deactivatedByUser: false, includedBlockIds: [], consumedBlockIds: [], parentBlockIds: [],
    directMessageIds: [`m${n}`], effectiveMessageIds: [`m${n}`], directToolCallIds: [], effectiveToolCallIds: [],
    sourceTokens: 100, summaryTokens: tokenizer.countTokens(summary), netTokens: 90, summaryText: summary,
    durableSourceRef: `source://${id}`, durableSummaryRef: `summary://${id}`,
    createdAt: turn * 100, updatedAt: turn * 100, updatedAtTurn: turn,
    sourceMessageIds: [`m${n}`], createdAtTurn: turn, tokens: tokenizer.countTokens(summary), consumed: false,
    projectionTier: "warm",
  };
}

function message(id: string, createdAt: number): NeutralMessage {
  return { id, role: "user", sessionId: "s", createdAt, parts: [{ type: "text", text: `source ${id}` }] };
}

describe("context tiers", () => {
  test("merges nested defaults and legacy blocks default warm", () => {
    const config = resolveConfig("s", { contextTiers: { warmMaxAgeTurns: 9 } });
    expect(config.contextTiers.enabled).toBe(true);
    expect(config.contextTiers.warmMaxTokens).toBe("8%");
    expect(config.contextTiers.warmMaxAgeTurns).toBe(9);
    const state = createInitialState("s");
    const legacy = block("b1", 0);
    delete legacy.projectionTier;
    state.blockRegistry.set("b1", legacy);
    expect(planTierDemotions(state, { ...config.contextTiers, warmMaxTokens: 100 }, tokenizer, 1000, 1).blockIds).toEqual([]);
  });

  test("demotes deterministic oldest archive-ready roots until strict cap", () => {
    const state = createInitialState("s");
    for (const value of [block("b3", 2, "cccc"), block("b2", 1, "bbbb"), block("b1", 1, "aaaa")]) state.blockRegistry.set(value.blockId, value);
    const config = { ...buildDefaultConfig("s").contextTiers, warmMaxTokens: 2, warmMaxAgeTurns: 999 };
    const plan = planTierDemotions(state, config, tokenizer, 1000, 10);
    expect(plan.blockIds).toEqual(["b1"]);
    applyTierDemotions(state, plan);
    const warmTokens = selectActiveRootBlocks(state).filter(value => value.projectionTier !== "cold")
      .reduce((sum, value) => sum + tokenizer.countTokens(value.summaryText), 0);
    expect(warmTokens).toBeLessThanOrEqual(2);
  });

  test("age demotes but missing either archive remains warm", () => {
    const state = createInitialState("s");
    const ready = block("b1", 0);
    const missing = block("b2", 0);
    delete missing.durableSummaryRef;
    state.blockRegistry.set("b1", ready);
    state.blockRegistry.set("b2", missing);
    const config = { ...buildDefaultConfig("s").contextTiers, warmMaxTokens: 100, warmMaxAgeTurns: 2 };
    expect(planTierDemotions(state, config, tokenizer, 1000, 2).blockIds).toEqual(["b1"]);
    expect(planTierDemotions(state, config, tokenizer, 1000, 2, false).blockIds).toEqual([]);
  });

  test("model-directed selection promotes and demotes active roots atomically", () => {
    const state = createInitialState("s");
    state.currentTurn = 50;
    const cold = block("b1", 1, "cold summary"); cold.projectionTier = "cold";
    const warm = block("b2", 2, "warm summary");
    state.blockRegistry.set("b1", cold);
    state.blockRegistry.set("b2", warm);
    const config = { ...buildDefaultConfig("s").contextTiers, warmMaxTokens: 100 };
    const planned = planDirectedTierSelection(
      state,
      { promoteBlockIds: ["b1"], demoteBlockIds: ["b2"] },
      config,
      tokenizer,
      1000,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const changed = applyDirectedTierSelection(state, planned.plan);
    expect(changed.changedBlockIds).toEqual(["b2", "b1"]);
    expect(state.blockRegistry.get("b1")?.projectionTier).toBe("warm");
    expect(state.blockRegistry.get("b1")?.updatedAtTurn).toBe(50);
    expect(state.blockRegistry.get("b2")?.projectionTier).toBe("cold");
    expect(changed.cutIds).toContain("__summary___ctx_cold_catalog");
    const agePlan = planTierDemotions(state, { ...config, warmMaxAgeTurns: 40 }, tokenizer, 1000, 51, true);
    expect(agePlan.blockIds).not.toContain("b1");
  });

  test("promotion clears the complete sibling retrieval result lease group", () => {
    const state = createInitialState("s");
    const first = block("b1", 1); first.projectionTier = "cold";
    const sibling = block("b2", 2); sibling.projectionTier = "cold";
    state.blockRegistry.set("b1", first);
    state.blockRegistry.set("b2", sibling);
    state.temporaryRetrievals.set("b1", { blockId: "b1", mode: "summary", activatedAtTurn: 1, expiresAtTurn: 3, tokenCost: 1, messageId: "retrieval-message" });
    state.temporaryRetrievals.set("b2", { blockId: "b2", mode: "summary", activatedAtTurn: 1, expiresAtTurn: 3, tokenCost: 1, messageId: "retrieval-message" });
    const changed = applyDirectedTierSelection(state, { promoteBlockIds: ["b1"], demoteBlockIds: [] });
    expect(state.temporaryRetrievals.size).toBe(0);
    expect(changed.effectiveMessageIds).toContain("retrieval-message");
  });

  test("protects explicit promotions and rejects an over-budget selection", () => {
    const state = createInitialState("s");
    const cold = block("b1", 1, "a summary too large for one token"); cold.projectionTier = "cold";
    state.blockRegistry.set("b1", cold);
    const result = planDirectedTierSelection(
      state,
      { promoteBlockIds: ["b1"] },
      { ...buildDefaultConfig("s").contextTiers, warmMaxTokens: 1 },
      tokenizer,
      1000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("budget");
    expect(state.blockRegistry.get("b1")?.projectionTier).toBe("cold");
  });

  test("advisory warm target never overrides model-authored tier choices", () => {
    const state = createInitialState("s");
    const cold = block("b1", 1, "a summary far above the advisory target"); cold.projectionTier = "cold";
    state.blockRegistry.set("b1", cold);
    const config = { ...buildDefaultConfig("s").contextTiers, warmBudgetMode: "advisory" as const, warmMaxTokens: 1 };
    const directed = planDirectedTierSelection(state, { promoteBlockIds: ["b1"] }, config, tokenizer, 1000);
    expect(directed.ok).toBe(true);
    if (directed.ok) expect(directed.plan).toEqual({ promoteBlockIds: ["b1"], demoteBlockIds: [] });
    cold.projectionTier = "warm";
    expect(planTierDemotions(state, config, tokenizer, 1000, 100, false).blockIds).toEqual([]);
  });

  test("strict warm cap still demotes when automatic age demotion is disabled", () => {
    const state = createInitialState("s");
    state.blockRegistry.set("b1", block("b1", 1, "older warm summary"));
    state.blockRegistry.set("b2", block("b2", 2, "newer warm summary"));
    const config = { ...buildDefaultConfig("s").contextTiers, ageDemotionEnabled: false, warmMaxTokens: 2, warmMaxAgeTurns: 0 };
    const plan = planTierDemotions(state, config, tokenizer, 1000, 100, config.ageDemotionEnabled);
    expect(plan.blockIds).toContain("b1");
  });

  test("catalog is bounded, newest-first, whole-entry only, and excludes consumed children", () => {
    const state = createInitialState("s");
    const child = block("b1", 1);
    child.active = false; child.consumed = true; child.projectionTier = "cold";
    const old = block("b2", 2); old.projectionTier = "cold";
    const recent = block("b3", 3); recent.projectionTier = "cold";
    for (const value of [child, old, recent]) state.blockRegistry.set(value.blockId, value);
    const config = { ...buildDefaultConfig("s").contextTiers, catalogMaxTokens: 30 };
    const catalog = buildColdCatalog([...state.blockRegistry.values()], config, tokenizer, 1000);
    expect(tokenizer.countTokens(catalog.text)).toBeLessThanOrEqual(30);
    expect(catalog.blockIds[0]).toBe("b3");
    expect(catalog.text).not.toContain("b1");
    expect(catalog.text).not.toContain("summary");
  });

  test("cold sources stay suppressed and exactly one catalog replaces summaries", () => {
    const state = createInitialState("s");
    const cold = block("b1", 1); cold.projectionTier = "cold";
    state.blockRegistry.set("b1", cold);
    state.compressionIndex.set("m1", { messageId: "m1", replacedByBlockId: "b1", masked: false, offloaded: false });
    const config = buildDefaultConfig("s");
    const first = applyDecisions([message("m1", 1)], state, { automaticPruning: true, contextTiers: config.contextTiers, tokenizer, modelContextLimit: 10_000 });
    const second = applyDecisions(first, state, { automaticPruning: true, contextTiers: config.contextTiers, tokenizer, modelContextLimit: 10_000 });
    expect(second.filter(value => value.id === "__summary___ctx_cold_catalog")).toHaveLength(1);
    expect(second.some(value => value.id === "__summary_b1" && !value.isIgnored)).toBe(false);
    expect(second.find(value => value.id === "m1")?.isIgnored).toBe(true);
  });

  test("automatic pruning off or tiers disabled restores full cold summary", () => {
    const state = createInitialState("s");
    const cold = block("b1", 1, "FULL SUMMARY"); cold.projectionTier = "cold";
    state.blockRegistry.set("b1", cold);
    state.compressionIndex.set("m1", { messageId: "m1", replacedByBlockId: "b1", masked: false, offloaded: false });
    const config = buildDefaultConfig("s");
    for (const options of [
      { automaticPruning: false, contextTiers: config.contextTiers, tokenizer },
      { automaticPruning: true, contextTiers: { ...config.contextTiers, enabled: false }, tokenizer },
    ]) {
      const projected = applyDecisions([message("m1", 1)], state, options);
      expect(projected.some(value => value.parts.some(part => part.type === "summary-block" && part.text === "FULL SUMMARY"))).toBe(true);
      expect(projected.some(value => value.id === "__summary___ctx_cold_catalog")).toBe(false);
    }
  });

  test("retrieval leases enforce budget, refresh, and exact TTL expiry", () => {
    const state = createInitialState("s");
    const cold = block("b1", 0); cold.projectionTier = "cold";
    state.blockRegistry.set("b1", cold);
    const config = { ...buildDefaultConfig("s").contextTiers, retrievalMaxTokens: 10, retrievalTtlTurns: 2 };
    const first = planTemporaryRetrieval(state, "b1", "exact", 10, config, 1000, 5);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    activateTemporaryRetrieval(state, first.retrieval);
    expect(planTemporaryRetrieval(state, "b1", "summary", 11, config, 1000, 6)).toEqual({ ok: false, reason: "budget-exceeded" });
    const refreshed = planTemporaryRetrieval(state, "b1", "summary", 8, config, 1000, 6);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    activateTemporaryRetrieval(state, refreshed.retrieval);
    expect(expireTemporaryRetrievals(state, 7)).toEqual([]);
    expect(expireTemporaryRetrievals(state, 8).map(value => value.blockId)).toEqual(["b1"]);
  });

  test("pipeline demotes with model compression disabled and arms one rewrite", () => {
    const state = createInitialState("s");
    state.currentTurn = 10;
    state.blockRegistry.set("b1", block("b1", 0));
    const config = buildDefaultConfig("s");
    config.automation.modelCompression = false;
    config.contextTiers.warmMaxTokens = 0;
    config.contextTiers.warmMaxAgeTurns = 999;
    const result = runPipeline(
      { messages: [message("m1", 1)], state, config, nowMs: 1000 },
      { tokenizer, workspaceDir: "/tmp" }
    );
    expect(state.blockRegistry.get("b1")?.projectionTier).toBe("cold");
    expect(state.projectionEditRevision).toBe(1);
    expect(result.messages.some(value => value.id === "__summary___ctx_cold_catalog")).toBe(true);
    expect(result.shouldInjectCompress).toBe(false);
  });
});
