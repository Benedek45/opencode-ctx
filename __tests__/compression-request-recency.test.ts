import { describe, expect, it } from "bun:test";
import { buildDefaultConfig } from "../core/defaults.js";
import { compressionRequestAges, planCompressionBatch } from "../core/compress/transaction.js";
import { planCompressionCandidates } from "../core/compress/eligibility.js";
import { findStableVolatileBoundary, selectCompressRange } from "../core/compress/execute.js";
import { buildCompressionGuidance } from "../core/nudges.js";
import { runPipeline } from "../core/pipeline.js";
import { buildCoreConfig, validateRuntimeConfig, type CtxPluginOptions } from "../adapters/opencode/config.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { createInitialState } from "../types/state.js";
import type { NeutralMessage, ToolPart } from "../types/neutral.js";

const tokenizer = new CharTokenizer();
const message = (id: string, role: NeutralMessage["role"] = "assistant"): NeutralMessage => ({
  id, ref: id, role, sessionId: "s", createdAt: 0,
  parts: [{ type: "text", text: "Substantial evidence. ".repeat(100) }],
});
function setup(requests = 10) {
  const state = createInitialState("s");
  state.currentTurn = 1;
  const config = buildDefaultConfig("s");
  const messages = [message("u1", "user"), ...Array.from({ length: requests }, (_, i) => message(`a${i}`))];
  return { messages, state, config, tokenizer };
}
function preflight(input: ReturnType<typeof setup>, start: string, end = start) {
  return planCompressionBatch({ ...input, requests: [{ mode: "range", startRef: start, endRef: end,
    topic: "Evidence", summary: "Evidence retained." }] });
}

describe("model-driven compression request recency", () => {
  it("defaults to three requests and permits old ranges within one user prompt", () => {
    const input = setup();
    expect(input.config.compressionRecencyRequests).toBe(3);
    expect(preflight(input, "u1", "a6").ok).toBe(true);
    for (const ref of ["a7", "a8", "a9"]) {
      const result = preflight(input, ref);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.map(error => error.code)).toContain("recent-range");
        expect(result.errors.find(error => error.code === "recent-range")!.message).toContain("last 3 model requests");
      }
    }
    expect(preflight(input, "a6", "a7").ok).toBe(false);
  });

  it("accepts age N, rejects N-1, and applies the same rule to message mode and slash boundaries", () => {
    const input = setup(4);
    const ages = compressionRequestAges(input.messages);
    expect(ages.get("a0")).toBe(3);
    expect(ages.get("a1")).toBe(2);
    expect(preflight(input, "a0").ok).toBe(true);
    expect(preflight(input, "a1").ok).toBe(false);
    for (const [ref, ok] of [["a0", true], ["a1", false]] as const) {
      const result = planCompressionBatch({ ...input, requests: [{ mode: "message", messageRef: ref,
        topic: "Evidence", summary: "Evidence retained." }] });
      expect(result.ok).toBe(ok);
    }
    expect(findStableVolatileBoundary(input.messages, 3)).toBe(2);
    expect(selectCompressRange(input.messages, input.state, 3)).toEqual(["u1", "a0"]);
  });

  it("does not count synthetic summaries, catalogs, manual replacements, imports or other synthetic IDs", () => {
    const input = setup(3);
    input.messages.push(
      { ...message("summary"), isSummary: true },
      { ...message("manual"), isManualReplacement: true },
      ...["__summary_b1", "__manual_a", "__ctx_import_a", "__ctx_cold_catalog", "__other"].map(id => message(id)),
    );
    expect(compressionRequestAges(input.messages).get("a0")).toBe(2);
    expect(preflight(input, "a0").ok).toBe(false);
    input.messages.push(message("real"));
    expect(preflight(input, "a0").ok).toBe(true);
  });

  it("disables only compression recency at zero, including the latest assistant", () => {
    const input = setup(1);
    input.config.compressionRecencyRequests = 0;
    expect(preflight(input, "a0").ok).toBe(true);
    expect(findStableVolatileBoundary(input.messages, 0)).toBe(input.messages.length);
    expect(planCompressionCandidates(input.messages, input.state, input.config, tokenizer).candidates[0].messageIds)
      .toEqual(["u1", "a0"]);
  });

  it("keeps the in-flight compress assistant at age zero", () => {
    const input = setup(10);
    input.messages.at(-1)!.parts = [{ type: "tool", tool: "compress", callId: "in-flight",
      status: "running", input: {}, turn: 1 }];
    expect(compressionRequestAges(input.messages).get("a9")).toBe(0);
    const result = preflight(input, "a9");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map(error => error.code)).toContain("recent-range");
    expect(planCompressionCandidates(input.messages, input.state, input.config, tokenizer).candidates[0].messageIds)
      .not.toContain("a9");
  });

  it("uses containing-message age for tool targets while preserving mechanical turn retention", () => {
    const input = setup();
    input.config.recencyGuardTurns = 50;
    // An unclassified tool exercises the mechanical recencyGuardTurns fallback.
    const part: ToolPart = { type: "tool", tool: "unclassified", callId: "recent-tool", status: "completed",
      input: {}, output: "Evidence ".repeat(1000), turn: 1 };
    input.messages[1].parts = [part];
    expect(preflight(input, "a0").ok).toBe(true);
    input.config.costRoi.enabled = false;
    input.config.clearAtLeast = 0;
    input.config.minRepruneInterval = 0;
    input.config.nudges.maskTriggerThreshold = 0;
    input.state.currentTurn = 2; // Age one: protected by 50, not merely the current-turn floor.
    const result = runPipeline({ ...input, nowMs: 1 }, { tokenizer, workspaceDir: "/workspace" });
    expect(input.state.maskDecisions.size).toBe(0);
    expect(result.offloadRequests).toHaveLength(0);
    expect((result.messages.find(m => m.id === "a0")!.parts[0] as ToolPart).output).toBe(part.output);
  });

  it("reports a request-based wait in eligibility and nudge guidance", () => {
    const input = setup(2);
    const report = planCompressionCandidates(input.messages, input.state, input.config, tokenizer);
    expect(report.candidates).toEqual([]);
    expect(report.requestsUntilEligible).toBe(1); // user has age two
    expect(buildCompressionGuidance(report)).toContain("after ~1 more requests");
    expect(buildCompressionGuidance(report)).not.toContain("user turn");
    input.messages.push(message("a2"));
    expect(planCompressionCandidates(input.messages, input.state, input.config, tokenizer).candidates[0].messageIds)
      .toEqual(["u1"]);
  });

  it("does not use persisted turn/import coordinates to age messages", () => {
    const input = setup(1);
    input.state.currentTurn = 100;
    input.state.turnBasis = { latestUserId: "u1", messageTurns: [["u1", 1], ["a0", 1]] };
    input.state.importedContext = { version: 1, seedRef: "seed", bundleDigest: "digest", importedAtTurn: 1 };
    input.messages.unshift(message("__ctx_import_old"));
    expect(preflight(input, "a0").ok).toBe(false);
    expect(preflight(input, "__ctx_import_old").ok).toBe(false);
  });

  it("accepts non-negative safe integers at every adapter config layer with normal precedence", () => {
    const config = buildCoreConfig("s", { compressionRecencyRequests: 1,
      providers: { p: { compressionRecencyRequests: 2 } }, models: { m: { compressionRecencyRequests: 4 } } },
    100000, "p", "m", { compressionRecencyRequests: 6 });
    expect(config.compressionRecencyRequests).toBe(6);
    for (const value of [0, 3, Number.MAX_SAFE_INTEGER]) {
      expect(validateRuntimeConfig({ compressionRecencyRequests: value }).compressionRecencyRequests).toBe(value);
      expect(buildCoreConfig("s", { compressionRecencyRequests: value }, 100000, "p", "m").compressionRecencyRequests).toBe(value);
    }
  });

  it("rejects invalid plugin, provider, model and runtime request counts without coercion", () => {
    for (const value of [-1, 1.5, "3", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, true]) {
      expect(() => validateRuntimeConfig({ compressionRecencyRequests: value })).toThrow();
      for (const options of [
        { compressionRecencyRequests: value },
        { providers: { p: { compressionRecencyRequests: value } } },
        { models: { m: { compressionRecencyRequests: value } } },
      ]) {
        expect(() => buildCoreConfig("s", options as CtxPluginOptions, 100000, "p", "m")).toThrow();
      }
      expect(() => buildCoreConfig("s", {}, 100000, "p", "m",
        { compressionRecencyRequests: value } as never)).toThrow();
    }
  });
});
