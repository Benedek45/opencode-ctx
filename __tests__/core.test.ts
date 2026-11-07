// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Core unit tests covering all required test cases from IMPLEMENTATION-SPEC §12.

import { describe, it, expect, beforeEach } from "bun:test";
import { resetCounters, makeUserMessage, makeAssistantMessage, makeToolMessage, makeErrorToolMessage, makeLargeOutput } from "./fixtures/messages.js";
import { createInitialState } from "../types/state.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { runDedup } from "../core/strategies/dedup.js";
import { runStaleError } from "../core/strategies/staleError.js";
import { runNearDupe, estimateNearDupeSavings, simhash64, hammingDistance64 } from "../core/strategies/nearDupe.js";
import { runObservationMask } from "../core/strategies/observationMask.js";
import { evaluateCostRoi, isColdCache, recordCacheBust, cachePruneAllowed } from "../core/budget/costRoi.js";
import { runTagging, stripHallucinatedTags, formatRef } from "../core/tagging.js";
import { applyCompress } from "../core/compress/apply.js";
import { decompressBlock } from "../core/compress/reversible.js";
import { selectCompressRange, findStableVolatileBoundary } from "../core/compress/execute.js";
import { resolveConfig } from "../core/config.js";
import {
  getNudgeLevel,
  buildNudgeText,
  shouldInjectCompress,
  updateNudgeEscalation,
  shouldForceMechanicalEscalation,
  ESCALATION_STREAK_THRESHOLD,
  resolveCompressionTarget,
  buildContextStatusText,
} from "../core/nudges.js";
import { computeEffectiveBudget, estimateContextTokens, estimateMessageTokens, parseSafetyCapFraction, resolveSafetyCap } from "../core/tokens.js";
import { PLACEHOLDER_DEDUP, PLACEHOLDER_STALE_ERROR_INPUT, PLACEHOLDER_PLAIN_MASK, PLACEHOLDER_NEAR_DUPE } from "../core/placeholders.js";
import { buildTightenedRecencyConfig, getRetentionTurns } from "../core/strategies/guards.js";
import { CACHE_MODEL_ANTHROPIC, CACHE_MODEL_DEEPSEEK, CACHE_MODEL_OPENAI } from "../core/defaults.js";
import { CharTokenizer, CalibratedTokenizer } from "../services/tokenizer.js";
import { FakeClock } from "../services/clock.js";
import { runStateGc } from "../core/stateGc.js";
import {
  hasPendingProjectionRewrite,
  markProjectionRewriteApplied,
  recordProjectionEdit,
} from "../core/projectionEdits.js";
import { runPipeline } from "../core/pipeline.js";
import { runHardCap } from "../core/strategies/hardCap.js";
import type { NeutralMessage, ToolPart } from "../types/neutral.js";
import type { CoreConfig } from "../types/config.js";
import type { CoreState } from "../types/state.js";
import type { TelemetryEvent } from "../types/telemetry.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeState(sessionId = "test"): CoreState {
  return createInitialState(sessionId);
}

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return { ...buildDefaultConfig("test"), ...overrides };
}

// ── 1. Cascade ordering ───────────────────────────────────────────────────────

describe("cascade ordering", () => {
  beforeEach(() => resetCounters());

  it("dedup runs before staleError (dedup placeholder is not re-processed by staleError)", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;

    // Two identical completed tool calls
    const msg1 = makeToolMessage("read", { path: "/foo" }, "content of foo", 1);
    const msg2 = makeToolMessage("read", { path: "/foo" }, "content of foo", 2);

    const dedupResult = runDedup([msg1, msg2], turn, config, state);
    // Earlier occurrence should be deduped
    const part0 = dedupResult.messages[0].parts[0] as ToolPart;
    const part1 = dedupResult.messages[1].parts[0] as ToolPart;
    expect(part0.output).toBe(PLACEHOLDER_DEDUP);
    expect(part1.output).toBe("content of foo"); // last occurrence kept
  });
});

// ── Token estimation ─────────────────────────────────────────────────────────

describe("token estimation", () => {
  it("estimates message content, not provider per-turn usage metadata", () => {
    const tokenizer = new CharTokenizer();
    const msg: NeutralMessage = {
      id: "m-token-usage",
      role: "assistant",
      sessionId: "test",
      createdAt: 1,
      parts: [{ type: "text", text: "short reply" }],
      tokens: {
        input: 120_000,
        output: 200,
        reasoning: 5_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };

    expect(estimateMessageTokens(msg, tokenizer)).toBe(
      tokenizer.countTokens("short reply")
    );
    expect(estimateContextTokens([msg], tokenizer)).toBe(
      tokenizer.countTokens("short reply")
    );
  });
});

// ── 2. Recency guard ──────────────────────────────────────────────────────────

describe("recency guard", () => {
  beforeEach(() => resetCounters());

  it("tool calls within recencyGuardTurns are not masked", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 10,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const currentTurn = 15;

    // Tool call at turn 10: age = 5, within guard (5 < 10)
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(3000), 10);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    const part = result.messages[0].parts[0] as ToolPart;
    expect(part.output).not.toBe(PLACEHOLDER_PLAIN_MASK);
    expect(result.maskedCount).toBe(0);
  });

  it("tool calls outside recencyGuardTurns are eligible for masking", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 10,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "code", // use plain mask for stateless
    });
    const currentTurn = 25;

    // Tool call at turn 5: age = 20, outside guard (20 >= 10)
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(3000), 5);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount + result.offloadedCount).toBeGreaterThan(0);
  });
});

// ── 3. Off-by-one: recency guard boundary ─────────────────────────────────────

describe("recency guard off-by-one", () => {
  beforeEach(() => resetCounters());

  it("turn exactly at boundary (age == recencyGuardTurns) is eligible", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 10,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "code",
    });
    const currentTurn = 20;
    // age = 20 - 10 = 10, NOT < 10, so eligible
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(3000), 10);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount + result.offloadedCount).toBeGreaterThan(0);
  });

  it("turn one inside boundary (age == recencyGuardTurns - 1) is protected", () => {
    const state = makeState();
    // Explicitly set read's retentionTurns to match the recencyGuardTurns under
    // test (10). The per-class value overrides recencyGuardTurns in
    // getRetentionTurns, so we must set them consistently to test the boundary.
    const config = makeConfig({
      recencyGuardTurns: 10,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      toolClasses: { ...buildDefaultConfig("test").toolClasses, read: { stateless: true, retentionTurns: 10 } },
    });
    const currentTurn = 20;
    // age = 20 - 11 = 9, 9 < 10, protected
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(3000), 11);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
    expect(result.offloadedCount).toBe(0);
  });
});

// ── 4. Offload pointer format ─────────────────────────────────────────────────

describe("offload pointer", () => {
  beforeEach(() => resetCounters());

  it("offload pointer contains path and preview", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "documents",
    });
    const currentTurn = 20;
    const output = makeLargeOutput(5000);
    const msg = makeToolMessage("read", { path: "/big.txt" }, output, 1);

    const result = runObservationMask([msg], currentTurn, config, state, "/workspace");
    const part = result.messages[0].parts[0] as ToolPart;
    expect(part.output).toContain("offloaded to save context");
    expect(part.output).toContain("/workspace/.ctx-offload/test/");
    expect(part.output).toContain("Preview");
    expect(result.offloadRequests.length).toBeGreaterThan(0);
  });
});

// ── 5. clearAtLeast guard ─────────────────────────────────────────────────────

describe("clearAtLeast guard", () => {
  beforeEach(() => resetCounters());

  it("skips masking pass when total recoverable < clearAtLeast", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 10000, // very high
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const currentTurn = 20;
    // Small output: ~100 chars = ~25 tokens, well below clearAtLeast
    const msg = makeToolMessage("read", { path: "/f" }, "small output", 1);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
    expect(result.offloadedCount).toBe(0);
  });

  it("uses net savings after placeholder cost for clearAtLeast", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 23,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const msg = makeToolMessage("read", { path: "/f" }, "x".repeat(100), 1);
    const result = runObservationMask([msg], 20, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
    expect(result.tokensSaved).toBe(0);
  });
});

// ── 6. Orphan-pair safety ─────────────────────────────────────────────────────

describe("orphan-pair safety", () => {
  beforeEach(() => resetCounters());

  it("pending tool calls are never masked", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const currentTurn = 20;
    const msg: NeutralMessage = {
      id: "m0001",
      role: "assistant",
      sessionId: "test",
      createdAt: Date.now(),
      parts: [{
        type: "tool",
        callId: "call_pending",
        tool: "read",
        status: "pending",
        input: { path: "/f" },
        turn: 1,
      }],
    };
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
  });
});

// ── 7. Compress range resolution ─────────────────────────────────────────────

describe("compress range resolution", () => {
  beforeEach(() => resetCounters());

  it("selectCompressRange returns messages before the stable/volatile boundary", () => {
    const state = makeState();
    const messages: NeutralMessage[] = [
      makeUserMessage("msg 1"),
      makeAssistantMessage("msg 2"),
      makeToolMessage("read", {}, "output", 1),
      makeUserMessage("recent msg"),
    ];
    // Assign turns to tool parts
    (messages[2].parts[0] as ToolPart).turn = 1;

    const range = selectCompressRange(messages, state, 1);
    // One real assistant request follows the first assistant; the tool is age zero.
    expect(range).toEqual(messages.slice(0, 2).map(message => message.id));
  });
});

// ── 8. Nested block consumption ───────────────────────────────────────────────

describe("nested block consumption", () => {
  beforeEach(() => resetCounters());

  it("full restructure consolidates existing summary blocks", () => {
    const state = makeState();
    state.fullRestructureTriggered = true;
    const config = makeConfig({ summarization: { appendOnly: false } });

    const msg1 = makeUserMessage("original message");
    const messages: NeutralMessage[] = [msg1];

    // First compress
    const r1 = applyCompress(messages, "Summary 1", [msg1.id], state, config, 1000);
    // Second compress (full restructure) should consolidate
    const summaryMsg = r1.messages.find(m => m.isSummary)!;
    const r2 = applyCompress(r1.messages, "Summary 2", [summaryMsg.id], state, config, 2000);

    // The new summary should contain both summaries
    const newSummary = r2.messages.find(m => m.isSummary && m.id !== summaryMsg.id);
    expect(newSummary).toBeDefined();
    const part = newSummary!.parts[0];
    expect(part.type).toBe("summary-block");
    if (part.type === "summary-block") {
      expect(part.text).toContain("Summary 1");
      expect(part.text).toContain("Summary 2");
    }
  });
});

// ── 9. Decompress / recompress ────────────────────────────────────────────────

describe("decompress / recompress", () => {
  beforeEach(() => resetCounters());

  it("decompressBlock restores source messages", () => {
    const state = makeState();
    const config = makeConfig();
    const msg1 = makeUserMessage("hello");
    const msg2 = makeAssistantMessage("world");

    const { messages: compressed, blockId } = applyCompress(
      [msg1, msg2], "summary", [msg1.id, msg2.id], state, config, 1000
    );

    const result = decompressBlock(compressed, blockId, state);
    expect(result).not.toBeNull();
    const restored = result!.messages.filter(m => !m.isIgnored && !m.isSummary);
    expect(restored.map(m => m.id)).toContain(msg1.id);
    expect(restored.map(m => m.id)).toContain(msg2.id);
  });
});

// ── 10. %-threshold resolution ────────────────────────────────────────────────

describe("%-threshold resolution", () => {
  it("parseSafetyCapFraction parses percentage strings", () => {
    expect(parseSafetyCapFraction("80%")).toBeCloseTo(0.8);
    expect(parseSafetyCapFraction("75%")).toBeCloseTo(0.75);
    expect(parseSafetyCapFraction("100%")).toBeCloseTo(1.0);
    expect(parseSafetyCapFraction("invalid")).toBeCloseTo(0.8); // fallback
  });

  it("computeEffectiveBudget applies safety cap and subtracts system tokens", () => {
    const budget = computeEffectiveBudget(1_000_000, "80%", 10_000);
    expect(budget).toBe(790_000);
  });

  it("resolveSafetyCap takes the earlier of a percentage and a headroom margin", () => {
    // 95% of 325k is 308,750; 30k headroom is 295,000 -> margin wins.
    expect(resolveSafetyCap("95%:30000", 325_000)).toBe(295_000);
    // On a huge window 95% is below the margin.
    expect(resolveSafetyCap("95%:30000", 1_000_000)).toBe(950_000);
    // Plain percentage still works.
    expect(resolveSafetyCap("80%", 1_000_000)).toBe(800_000);
    // Absolute number passes through.
    expect(resolveSafetyCap(250_000, 1_000_000)).toBe(250_000);
  });

  it("computeEffectiveBudget honours the headroom-margin form", () => {
    expect(computeEffectiveBudget(325_000, "95%:30000", 0)).toBe(295_000);
  });
});

// ── 11. Small-window clamping ─────────────────────────────────────────────────

describe("small-window clamping", () => {
  it("computeEffectiveBudget clamps to at least 1000", () => {
    const budget = computeEffectiveBudget(1000, "80%", 900);
    expect(budget).toBeGreaterThanOrEqual(1000);
  });
});

// ── 12. Per-model / per-provider precedence ───────────────────────────────────

describe("config precedence", () => {
  it("model config overrides provider config overrides plugin config", () => {
    const plugin = { recencyGuardTurns: 5 };
    const provider = { recencyGuardTurns: 8 };
    const model = { recencyGuardTurns: 12 };

    const config = resolveConfig("test", plugin, undefined, provider, model);
    expect(config.recencyGuardTurns).toBe(12);
  });

  it("runtime config has highest precedence", () => {
    const plugin = { recencyGuardTurns: 5 };
    const runtime = { recencyGuardTurns: 99 };

    const config = resolveConfig("test", plugin, undefined, undefined, undefined, runtime);
    expect(config.recencyGuardTurns).toBe(99);
  });

  it("nested cacheModel fields are merged independently", () => {
    const plugin = { cacheModel: { R: 20 } };
    const model = { cacheModel: { effectiveTtlSeconds: 999 } };

    const config = resolveConfig("test", plugin, undefined, undefined, model);
    expect(config.cacheModel.R).toBe(20);
    expect(config.cacheModel.effectiveTtlSeconds).toBe(999);
  });

  it("nested cachePrune fields are provider/model configurable", () => {
    const provider = { cachePrune: { ttlSeconds: 120 } };
    const model = { cachePrune: { afterTtl: false } };

    const config = resolveConfig("test", undefined, undefined, provider, model);
    expect(config.cachePrune.afterCompress).toBe(true);
    expect(config.cachePrune.afterTtl).toBe(false);
    expect(config.cachePrune.ttlSeconds).toBe(120);
  });
});

// ── 13. No-hardstop ───────────────────────────────────────────────────────────

describe("no-hardstop", () => {
  it("pipeline does not throw when token count exceeds model limit", () => {
    // The pipeline should never throw — it just nudges
    const config = makeConfig({ modelContextLimit: 100 });
    const level = getNudgeLevel(200, config);
    expect(["none", "mid-soft", "upper", "safety-cap"]).toContain(level);
  });
});

// ── 14. minRepruneInterval ────────────────────────────────────────────────────

describe("minRepruneInterval", () => {
  beforeEach(() => resetCounters());

  it("skips masking pass if last pass was too recent", () => {
    const state = makeState();
    state.lastMaskingPassTurn = 18; // recent
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 3,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const currentTurn = 20; // 20 - 18 = 2 < 3

    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(5000), 1);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
    expect(result.offloadedCount).toBe(0);
  });

  it("allows masking pass after minRepruneInterval turns", () => {
    const state = makeState();
    state.lastMaskingPassTurn = 15;
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 3,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "code",
    });
    const currentTurn = 20; // 20 - 15 = 5 >= 3

    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(5000), 1);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount + result.offloadedCount).toBeGreaterThan(0);
  });
});

// ── 15. Cache-TTL heuristic ───────────────────────────────────────────────────

describe("cache-TTL heuristic", () => {
  it("isColdCache returns true when idle > TTL", () => {
    const clock = new FakeClock(0);
    clock.advance(4000 * 1000); // 4000 seconds
    const cold = isColdCache(0, clock.now(), CACHE_MODEL_DEEPSEEK, false);
    expect(cold).toBe(true); // 4000 > 3600
  });

  it("isColdCache returns false when idle < TTL", () => {
    const lastRequest = 1000 * 1000; // 1000s ago
    const now = 1000 * 1000 + 100 * 1000; // 100s later
    const cold = isColdCache(lastRequest, now, CACHE_MODEL_DEEPSEEK, false);
    expect(cold).toBe(false); // 100 < 3600
  });

  it("isColdCache returns true on prior cache miss", () => {
    const cold = isColdCache(Date.now(), Date.now(), CACHE_MODEL_DEEPSEEK, true);
    expect(cold).toBe(true);
  });
});

// ── 16. Profile-driven eligibility ───────────────────────────────────────────

describe("profile-driven eligibility", () => {
  beforeEach(() => resetCounters());

  it("documents profile prefers offload for large stateless outputs", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "documents",
    });
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(5000), 1);
    const result = runObservationMask([msg], 20, config, state, "/ws");
    expect(result.offloadedCount).toBeGreaterThan(0);
  });

  it("code profile uses plain mask for stateless outputs", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "code",
    });
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(5000), 1);
    const result = runObservationMask([msg], 20, config, state, "/ws");
    const part = result.messages[0].parts[0] as ToolPart;
    expect(part.output).toBe(PLACEHOLDER_PLAIN_MASK);
  });
});

// ── 17. Structured-summary DATA NEEDED rule ───────────────────────────────────

describe("structured-summary DATA NEEDED rule", () => {
  it("compress prompt template contains DATA NEEDED instruction", async () => {
    const { buildCompressPrompt } = await import("../core/compress/prompt.js");
    const { system } = buildCompressPrompt([]);
    expect(system).toContain("[DATA NEEDED");
  });
});

// ── 18. Monotonic masking ─────────────────────────────────────────────────────

describe("monotonic masking", () => {
  beforeEach(() => resetCounters());

  it("once masked, a tool call stays masked on subsequent passes", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "code",
    });
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(5000), 1);

    // First pass
    const r1 = runObservationMask([msg], 20, config, state, "/ws");
    expect(r1.maskedCount).toBeGreaterThan(0);

    // Second pass: already masked, should not re-mask
    const r2 = runObservationMask(r1.messages, 21, config, state, "/ws");
    expect(r2.maskedCount).toBe(0);
  });
});

// ── 19. Cost-ROI gate: warm reject ───────────────────────────────────────────

describe("Cost-ROI gate", () => {
  it("warm reject: formula fails, no cold/quality override", () => {
    const result = evaluateCostRoi({
      nSaved: 100,
      eTurns: 1,
      nAfter: 10000,
      activeTokens: 100000,
      cacheModel: CACHE_MODEL_DEEPSEEK, // R=50
      isColdCache: false,
      isQualityTrigger: false,
      enabled: true,
      clearAtLeast: 50,
    });
    // 100 * 1 = 100 vs (50-1) * 10000 = 490000 → reject
    expect(result.shouldPrune).toBe(false);
  });

  it("cold cache override: always pass", () => {
    const result = evaluateCostRoi({
      nSaved: 100,
      eTurns: 1,
      nAfter: 10000,
      activeTokens: 100000,
      cacheModel: CACHE_MODEL_DEEPSEEK,
      isColdCache: true,
      isQualityTrigger: false,
      enabled: true,
      clearAtLeast: 50,
    });
    expect(result.shouldPrune).toBe(true);
    expect(result.reason).toContain("cold cache");
  });

  it("quality trigger override: always pass", () => {
    const result = evaluateCostRoi({
      nSaved: 100,
      eTurns: 1,
      nAfter: 10000,
      activeTokens: 500000,
      cacheModel: CACHE_MODEL_DEEPSEEK,
      isColdCache: false,
      isQualityTrigger: true,
      enabled: true,
      clearAtLeast: 50,
    });
    expect(result.shouldPrune).toBe(true);
    expect(result.reason).toContain("quality trigger");
  });

  it("R=1 override: always pass", () => {
    const result = evaluateCostRoi({
      nSaved: 100,
      eTurns: 1,
      nAfter: 10000,
      activeTokens: 100000,
      cacheModel: { ...CACHE_MODEL_DEEPSEEK, R: 1 },
      isColdCache: false,
      isQualityTrigger: false,
      enabled: true,
      clearAtLeast: 50,
    });
    expect(result.shouldPrune).toBe(true);
    expect(result.reason).toContain("R=1");
  });

  it("clearAtLeast floor: reject if nSaved < clearAtLeast", () => {
    const result = evaluateCostRoi({
      nSaved: 100,
      eTurns: 100,
      nAfter: 100,
      activeTokens: 100000,
      cacheModel: CACHE_MODEL_DEEPSEEK,
      isColdCache: false,
      isQualityTrigger: false,
      enabled: true,
      clearAtLeast: 5000, // much higher than nSaved
    });
    expect(result.shouldPrune).toBe(false);
    expect(result.reason).toContain("clearAtLeast");
  });
});

// ── 20. Stateful mask ─────────────────────────────────────────────────────────

describe("stateful mask", () => {
  beforeEach(() => resetCounters());

  it("stateful tool output is condensed with tail lines", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "documents", // documents uses stateful mask for stateful tools
    });
    const output = `${Array.from({ length: 100 }, (_, index) => `verbose build line ${index}`).join("\n")}\nexit code: 0\nDone`;
    const msg: NeutralMessage = {
      id: "m0001",
      role: "assistant",
      sessionId: "test",
      createdAt: Date.now(),
      parts: [{
        type: "tool",
        callId: "call_bash_1",
        tool: "bash",
        status: "completed",
        input: "echo hello",
        output,
        turn: 1,
      }],
    };
    const result = runObservationMask([msg], 20, config, state, "/ws");
    const part = result.messages[0].parts[0] as ToolPart;
    expect(part.output).toContain("condensed to save context");
    expect(part.output).toContain("Exit code:");
  });
});

// ── 21. Stateless offload ─────────────────────────────────────────────────────

describe("stateless offload", () => {
  beforeEach(() => resetCounters());

  it("stateless tool with large output is offloaded in documents profile", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 5,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "documents",
    });
    const msg = makeToolMessage("webfetch", { url: "https://example.com" }, makeLargeOutput(5000), 1);
    const result = runObservationMask([msg], 20, config, state, "/ws");
    expect(result.offloadedCount).toBeGreaterThan(0);
    expect(result.offloadRequests.length).toBeGreaterThan(0);
  });
});

// ── 22. Tiered recency ────────────────────────────────────────────────────────

describe("tiered recency", () => {
  beforeEach(() => resetCounters());

  it("glob tool has shorter retention than read tool", () => {
    const config = makeConfig();
    // glob: retentionTurns=2, read: retentionTurns=5 (user-turn units)
    expect(config.toolClasses["glob"].retentionTurns).toBe(2);
    expect(config.toolClasses["read"].retentionTurns).toBe(5);
  });

  it("glob output is eligible for masking after 3 turns", () => {
    const state = makeState();
    const config = makeConfig({
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
      profile: "code",
    });
    const currentTurn = 10;
    // glob at turn 6: age = 4, retentionTurns = 3, 4 >= 3 → eligible
    const msg = makeToolMessage("glob", { pattern: "**/*.ts" }, makeLargeOutput(3000), 6);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount + result.offloadedCount).toBeGreaterThan(0);
  });

  it("read output is NOT eligible after 3 turns (retentionTurns=10)", () => {
    const state = makeState();
    const config = makeConfig({
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const currentTurn = 10;
    // read at turn 7: age = 3, retentionTurns = 10, 3 < 10 → protected
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(3000), 7);
    const result = runObservationMask([msg], currentTurn, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
    expect(result.offloadedCount).toBe(0);
  });
});

// ── 23. Append-only delta block ───────────────────────────────────────────────

describe("append-only delta block", () => {
  beforeEach(() => resetCounters());

  it("earlier summary block text is byte-identical after a second compress", () => {
    const state = makeState();
    const config = makeConfig({ summarization: { appendOnly: true } });

    const msg1 = makeUserMessage("first message");
    const msg2 = makeAssistantMessage("first reply");

    // First compress
    const r1 = applyCompress([msg1, msg2], "Summary A", [msg1.id, msg2.id], state, config, 1000);
    const block1 = r1.messages.find(m => m.isSummary)!;
    const block1Text = (block1.parts[0] as { type: "summary-block"; text: string }).text;

    // Add new messages
    const msg3 = makeUserMessage("second message");
    const msg4 = makeAssistantMessage("second reply");
    const allMessages = [...r1.messages, msg3, msg4];

    // Second compress (append-only: should NOT touch block1)
    const r2 = applyCompress(allMessages, "Summary B", [msg3.id, msg4.id], state, config, 2000);

    // Find block1 in r2 messages
    const block1InR2 = r2.messages.find(m => m.id === block1.id);
    if (block1InR2) {
      const textInR2 = (block1InR2.parts[0] as { type: "summary-block"; text: string }).text;
      expect(textInR2).toBe(block1Text); // byte-identical
    }
    // There should be a new block2
    const block2 = r2.messages.find(m => m.isSummary && m.id !== block1.id);
    expect(block2).toBeDefined();
  });
});

// ── 24. Consolidation on full restructure ─────────────────────────────────────

describe("consolidation on full restructure", () => {
  beforeEach(() => resetCounters());

  it("full restructure merges existing summary blocks", () => {
    const state = makeState();
    state.fullRestructureTriggered = true;
    const config = makeConfig({ summarization: { appendOnly: false } });

    const msg1 = makeUserMessage("msg1");
    const r1 = applyCompress([msg1], "Block A", [msg1.id], state, config, 1000);

    const summaryMsg = r1.messages.find(m => m.isSummary)!;
    const r2 = applyCompress(r1.messages, "Block B", [summaryMsg.id], state, config, 2000);

    const newBlock = r2.messages.find(m => m.isSummary && m.id !== summaryMsg.id);
    expect(newBlock).toBeDefined();
    const text = (newBlock!.parts[0] as { type: "summary-block"; text: string }).text;
    expect(text).toContain("Block A");
    expect(text).toContain("Block B");
  });
});

// ── 25. appendOnly=false ──────────────────────────────────────────────────────

describe("appendOnly=false", () => {
  beforeEach(() => resetCounters());

  it("with appendOnly=false, compress includes existing block content", () => {
    const state = makeState();
    const config = makeConfig({ summarization: { appendOnly: false } });

    const msg1 = makeUserMessage("original");
    const r1 = applyCompress([msg1], "First summary", [msg1.id], state, config, 1000);

    const summaryMsg = r1.messages.find(m => m.isSummary)!;
    const r2 = applyCompress(r1.messages, "Second summary", [summaryMsg.id], state, config, 2000);

    const newBlock = r2.messages.find(m => m.isSummary && m.id !== summaryMsg.id);
    expect(newBlock).toBeDefined();
    const text = (newBlock!.parts[0] as { type: "summary-block"; text: string }).text;
    expect(text).toContain("First summary");
    expect(text).toContain("Second summary");
  });
});

// ── 26. Tagging idempotency ───────────────────────────────────────────────────

describe("tagging idempotency", () => {
  beforeEach(() => resetCounters());

  it("running tagging twice assigns the same ref", () => {
    const state = makeState();
    const msg = makeUserMessage("hello");

    const r1 = runTagging([msg], state);
    const ref1 = r1[0].ref;

    const r2 = runTagging(r1, state);
    const ref2 = r2[0].ref;

    expect(ref1).toBe(ref2);
  });

  it("formatRef produces zero-padded 4-digit refs", () => {
    expect(formatRef(1)).toBe("m0001");
    expect(formatRef(42)).toBe("m0042");
    expect(formatRef(1000)).toBe("m1000");
  });
});

// ── 27. Hallucination strip ───────────────────────────────────────────────────

describe("hallucination strip", () => {
  it("strips ctx-message-id tags from text", () => {
    const text = "Hello <ctx-message-id>m0001</ctx-message-id> world";
    const stripped = stripHallucinatedTags(text);
    expect(stripped).not.toContain("m0001");
    expect(stripped).toContain("Hello");
    expect(stripped).toContain("world");
  });

  it("strips tags with attributes", () => {
    const text = "Before <ctx-message-id class=\"x\">injected</ctx-message-id> after";
    const stripped = stripHallucinatedTags(text);
    expect(stripped).not.toContain("injected");
  });

  it("strips ref tags written under an earlier prefix but keeps mismatched pairs", () => {
    expect(stripHallucinatedTags("a <old-message-id>m0007</old-message-id>\nb")).toBe("a b");
    expect(stripHallucinatedTags("keep <x-message-id>m1</y-message-id> text"))
      .toBe("keep <x-message-id>m1</y-message-id> text");
  });
});

// ── 28. Dedup: keeps last occurrence ─────────────────────────────────────────

describe("dedup keeps last occurrence", () => {
  beforeEach(() => resetCounters());

  it("dedup keeps the last occurrence and removes earlier ones", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;

    const msg1 = makeToolMessage("read", { path: "/same" }, "output A", 1);
    const msg2 = makeToolMessage("read", { path: "/same" }, "output A", 2);
    const msg3 = makeToolMessage("read", { path: "/same" }, "output A", 3);

    const result = runDedup([msg1, msg2, msg3], turn, config, state);
    const parts = result.messages.map(m => (m.parts[0] as ToolPart).output);
    // Only the last should be kept
    expect(parts[0]).toBe(PLACEHOLDER_DEDUP);
    expect(parts[1]).toBe(PLACEHOLDER_DEDUP);
    expect(parts[2]).toBe("output A");
  });
});

// ── 29. StaleError: keeps error output, removes input ────────────────────────

describe("staleError", () => {
  beforeEach(() => resetCounters());

  it("keeps error output but replaces input with placeholder", () => {
    const state = makeState();
    const config = makeConfig();
    const currentTurn = 10;

    const msg = makeErrorToolMessage("bash", "rm -rf /important", "Error: permission denied", 1);
    const result = runStaleError([msg], currentTurn, config, state);
    const part = result.messages[0].parts[0] as ToolPart;
    expect(part.input).toBe(PLACEHOLDER_STALE_ERROR_INPUT);
    expect(part.output).toBe("Error: permission denied"); // kept
  });

  it("does not purge recent error tool calls", () => {
    const state = makeState();
    const config = makeConfig();
    const currentTurn = 4;

    const msg = makeErrorToolMessage("bash", "some command", "Error: oops", 3);
    const result = runStaleError([msg], currentTurn, config, state);
    const part = result.messages[0].parts[0] as ToolPart;
    expect(part.input).toBe("some command"); // not purged (age = 1 < 3)
  });
});

// ── 30. Nudge levels ─────────────────────────────────────────────────────────

describe("nudge levels", () => {
  it("returns none below lowerThreshold", () => {
    const config = makeConfig();
    expect(getNudgeLevel(100_000, config)).toBe("none");
  });

  it("returns mid-soft between midSoftNudge and upperThreshold", () => {
    const config = makeConfig();
    expect(getNudgeLevel(300_000, config)).toBe("mid-soft");
  });

  it("returns upper at upperThreshold", () => {
    const config = makeConfig();
    expect(getNudgeLevel(400_000, config)).toBe("upper");
  });

  it("shouldInjectCompress is true at upper and safety-cap", () => {
    expect(shouldInjectCompress("upper")).toBe(true);
    expect(shouldInjectCompress("safety-cap")).toBe(true);
    expect(shouldInjectCompress("mid-soft")).toBe(false);
    expect(shouldInjectCompress("none")).toBe(false);
  });
});

// ── 31. Always-protected tools ────────────────────────────────────────────────

describe("always-protected tools", () => {
  beforeEach(() => resetCounters());

  it("task tool is never masked", () => {
    const state = makeState();
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    const msg = makeToolMessage("task", { prompt: "do something" }, makeLargeOutput(5000), 1);
    const result = runObservationMask([msg], 20, config, state, "/ws");
    expect(result.maskedCount).toBe(0);
    expect(result.offloadedCount).toBe(0);
  });
});

// ── 32. CostRoi gate disabled ─────────────────────────────────────────────────

describe("CostRoi gate disabled", () => {
  it("always passes when enabled=false", () => {
    const result = evaluateCostRoi({
      nSaved: 1,
      eTurns: 1,
      nAfter: 1_000_000,
      activeTokens: 100_000,
      cacheModel: CACHE_MODEL_DEEPSEEK,
      isColdCache: false,
      isQualityTrigger: false,
      enabled: false,
      clearAtLeast: 0,
    });
    expect(result.shouldPrune).toBe(true);
  });
});

// ── 33. Near-duplicate dedup (SimHash) ────────────────────────────────────────
// Industry precedent: Charikar's SimHash (Manku/Jain/Sarma, "Detecting
// Near-Duplicates for Web Crawling", WWW 2007) — 64-bit fingerprints compared
// by Hamming distance, zero model calls. Scoped to stateless tool classes only.

describe("near-duplicate dedup (SimHash)", () => {
  beforeEach(() => resetCounters());

  /** Build realistic multi-line text so word-shingles vary meaningfully. */
  function makeParagraph(lines: number, suffix = ""): string {
    const body = Array.from(
      { length: lines },
      (_, i) => `line ${i}: some repeated content about the module configuration and default values here`
    ).join("\n");
    return body + suffix;
  }

  it("collapses a near-identical re-read of the same stateless tool, keeping the most recent", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;

    const base = makeParagraph(40); // ~3400 chars, well above the min-size gate
    const nearIdentical = makeParagraph(40, "\none extra trailing line with a minor addition at the end");

    const msg1 = makeToolMessage("read", { path: "/f" }, base, 1);
    const msg2 = makeToolMessage("read", { path: "/f" }, nearIdentical, 2);

    const result = runNearDupe([msg1, msg2], turn, config, state);
    const outputs = result.messages.map(m => (m.parts[0] as ToolPart).output);
    expect(outputs[0]).toBe(PLACEHOLDER_NEAR_DUPE);
    expect(outputs[1]).toBe(nearIdentical); // most recent kept, matching dedup.ts semantics
    expect(result.nearDupeCount).toBe(1);
    expect(state.nearDupeDecisions.size).toBe(1);
  });

  it("does NOT collapse stateful tool outputs even when near-identical (bash/test)", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;

    const base = makeParagraph(40);
    const nearIdentical = makeParagraph(40, "\nDIFFERENT EXIT STATUS LINE");

    const msg1 = makeToolMessage("bash", { cmd: "run" }, base, 1);
    const msg2 = makeToolMessage("bash", { cmd: "run" }, nearIdentical, 2);

    const result = runNearDupe([msg1, msg2], turn, config, state);
    expect(result.nearDupeCount).toBe(0);
    const outputs = result.messages.map(m => (m.parts[0] as ToolPart).output);
    expect(outputs[0]).toBe(base);
    expect(outputs[1]).toBe(nearIdentical);
  });

  it("does not touch outputs below the minimum-size gate (short strings collide by chance)", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;

    const msg1 = makeToolMessage("read", { path: "/f" }, "short output", 1);
    const msg2 = makeToolMessage("read", { path: "/f" }, "short output too", 2);

    const result = runNearDupe([msg1, msg2], turn, config, state);
    expect(result.nearDupeCount).toBe(0);
  });

  it("respects tiered retention: near-duplicate calls within the window are not collapsed", () => {
    const state = makeState();
    const config = makeConfig(); // read retentionTurns=10 by default
    const turn = 5; // both calls (turns 1, 2) are within the 10-turn retention window

    const base = makeParagraph(40);
    const msg1 = makeToolMessage("read", { path: "/f" }, base, 1);
    const msg2 = makeToolMessage("read", { path: "/f" }, makeParagraph(40, "\nextra"), 2);

    const result = runNearDupe([msg1, msg2], turn, config, state);
    expect(result.nearDupeCount).toBe(0);
  });

  it("skips a callId already handled by exact-match dedup", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;
    const base = makeParagraph(40);

    const msg1 = makeToolMessage("read", { path: "/f" }, base, 1);
    const msg2 = makeToolMessage("read", { path: "/f" }, makeParagraph(40, "\nextra"), 2);
    const callId1 = (msg1.parts[0] as ToolPart).callId;
    state.dedupDecisions.add(callId1); // simulate exact-dedup already deciding this callId

    const result = runNearDupe([msg1, msg2], turn, config, state);
    expect(result.nearDupeCount).toBe(0);
  });

  it("simhash64 is deterministic; hammingDistance64 is 0 for identical text and >0 for unrelated text", () => {
    const a = simhash64("the quick brown fox jumps over the lazy dog repeatedly and often");
    const b = simhash64("the quick brown fox jumps over the lazy dog repeatedly and often");
    expect(a).toBe(b);
    expect(hammingDistance64(a, b)).toBe(0);

    const c = simhash64("completely unrelated text discussing an entirely different topic altogether");
    expect(hammingDistance64(a, c)).toBeGreaterThan(0);
  });

  it("estimateNearDupeSavings is a pure read: does not mutate state.nearDupeDecisions", () => {
    const state = makeState();
    const config = makeConfig();
    const turn = 20;
    const base = makeParagraph(40);
    const msg1 = makeToolMessage("read", { path: "/f" }, base, 1);
    const msg2 = makeToolMessage("read", { path: "/f" }, makeParagraph(40, "\nextra"), 2);

    const estimated = estimateNearDupeSavings([msg1, msg2], turn, config, state);
    expect(estimated).toBeGreaterThan(0);
    expect(state.nearDupeDecisions.size).toBe(0); // unchanged — pure estimate, no side effects
  });
});

// ── 34. Adaptive E_turns estimate (Cost-ROI) ──────────────────────────────────
// Replaces the previously hardcoded `eTurns = 5` constant in buildCostRoiInput
// with an EWMA of the observed turn-gap between cache-busting events.

describe("adaptive E_turns estimate (Cost-ROI)", () => {
  it("cold start: eTurnsEstimate defaults to 5 (the prior hardcoded constant)", () => {
    const state = makeState();
    expect(state.eTurnsEstimate).toBe(5);
  });

  it("the first recorded bust only seeds lastCacheBustTurn; the estimate is unchanged", () => {
    const state = makeState();
    recordCacheBust(state, 10);
    expect(state.lastCacheBustTurn).toBe(10);
    expect(state.eTurnsEstimate).toBe(5);
  });

  it("folds the observed turn-gap into the EWMA on subsequent busts", () => {
    const state = makeState();
    recordCacheBust(state, 10); // seed, no gap yet
    recordCacheBust(state, 12); // gap = 2 -> 0.3*2 + 0.7*5 = 4.1
    expect(state.eTurnsEstimate).toBeCloseTo(4.1, 5);
    recordCacheBust(state, 14); // gap = 2 -> 0.3*2 + 0.7*4.1 = 3.47
    expect(state.eTurnsEstimate).toBeCloseTo(3.47, 5);
  });

  it("clamps an outlier gap to 30 turns before folding it in", () => {
    const state = makeState();
    recordCacheBust(state, 1);
    recordCacheBust(state, 1000); // gap = 999, clamped to 30 -> 0.3*30 + 0.7*5 = 12.5
    expect(state.eTurnsEstimate).toBeCloseTo(12.5, 5);
  });

  it("cachePruneAllowed's P2 formula path uses the adaptive estimate, not a fixed constant", () => {
    const config = makeConfig({
      cacheModel: { type: "automatic-free", R: 2, effectiveTtlSeconds: 3600 },
      clearAtLeast: 0, // isolate the R/eTurns/nAfter formula from the unrelated clearAtLeast floor
    });
    const activeTokens = 130;
    const candidateSavings = 30; // nAfter = 100 -> formula: 30*eTurns > (2-1)*100 = 100

    const highEstimate = makeState();
    highEstimate.lastRequestTime = 900;
    highEstimate.lastCacheMiss = false;
    // eTurnsEstimate defaults to 5 (cold-start prior): 30*5=150 > 100 -> prune
    expect(cachePruneAllowed(config, highEstimate, 1000, activeTokens, candidateSavings)).toBe(true);

    const lowEstimate = makeState();
    lowEstimate.lastRequestTime = 900;
    lowEstimate.lastCacheMiss = false;
    lowEstimate.eTurnsEstimate = 1; // session has observed a low bust cadence
    // 30*1=30 <= 100 -> reject; the SAME candidateSavings now fails the formula
    // purely because the adaptive estimate is lower, proving it is actually wired in.
    expect(cachePruneAllowed(config, lowEstimate, 1000, activeTokens, candidateSavings)).toBe(false);
  });
});

// ── 35. Nudge escalation ───────────────────────────────────────────────────────

describe("nudge escalation", () => {
  it("streak increments on consecutive urgent (upper/safety-cap) turns with no compress run", () => {
    let esc = { ignoredStreak: 0, compressRunsAtLastCheck: 0 };
    esc = updateNudgeEscalation("upper", 0, esc);
    expect(esc.ignoredStreak).toBe(1);
    esc = updateNudgeEscalation("upper", 0, esc);
    expect(esc.ignoredStreak).toBe(2);
    esc = updateNudgeEscalation("safety-cap", 0, esc);
    expect(esc.ignoredStreak).toBe(3);
  });

  it("resets the streak once totalCompressRuns increases (model complied)", () => {
    const esc = updateNudgeEscalation("upper", 1, { ignoredStreak: 2, compressRunsAtLastCheck: 0 });
    expect(esc.ignoredStreak).toBe(0);
    expect(esc.compressRunsAtLastCheck).toBe(1);
  });

  it("resets the streak once the level drops below upper", () => {
    const esc = updateNudgeEscalation("mid-soft", 0, { ignoredStreak: 3, compressRunsAtLastCheck: 0 });
    expect(esc.ignoredStreak).toBe(0);
  });

  it("shouldForceMechanicalEscalation fires at (and past) the streak threshold, not before", () => {
    expect(
      shouldForceMechanicalEscalation({ ignoredStreak: ESCALATION_STREAK_THRESHOLD - 1, compressRunsAtLastCheck: 0 })
    ).toBe(false);
    expect(
      shouldForceMechanicalEscalation({ ignoredStreak: ESCALATION_STREAK_THRESHOLD, compressRunsAtLastCheck: 0 })
    ).toBe(true);
  });

  it("buildNudgeText escalates wording once the streak crosses the threshold", () => {
    const base = buildNudgeText("upper", 420_000, 500_000, 0);
    const escalated = buildNudgeText("upper", 420_000, 500_000, ESCALATION_STREAK_THRESHOLD);
    expect(base).not.toContain("consecutive turn");
    expect(escalated).toContain(`${ESCALATION_STREAK_THRESHOLD}th consecutive turn`);
  });
});

// ── 36. buildTightenedRecencyConfig ────────────────────────────────────────────
// Regression coverage for a latent bug found while wiring escalation: tightening
// recencyGuardTurns alone does not reach tool-classified calls (read/bash/etc.),
// since getRetentionTurns prefers each tool's fixed per-class retentionTurns.

describe("buildTightenedRecencyConfig", () => {
  it("clamps recencyGuardTurns AND every tool class's retentionTurns to maxTurns", () => {
    const config = makeConfig({ recencyGuardTurns: 10 });
    expect(getRetentionTurns("read", config)).toBe(5); // per-class default (user-turn units), unaffected by recencyGuardTurns
    expect(getRetentionTurns("unclassified-tool", config)).toBe(10); // falls back to recencyGuardTurns

    const tightened = buildTightenedRecencyConfig(config, 2);
    expect(tightened.recencyGuardTurns).toBe(2);
    expect(getRetentionTurns("read", tightened)).toBe(2); // now reachable (was 5, clamped to 2)
    expect(getRetentionTurns("glob", tightened)).toBe(2); // was 2, stays 2
    expect(getRetentionTurns("unclassified-tool", tightened)).toBe(2);
  });

  it("does not raise retention for classes already below maxTurns", () => {
    const config = makeConfig({ recencyGuardTurns: 10 }); // glob retentionTurns=2 by default (user-turn units)
    const tightened = buildTightenedRecencyConfig(config, 5);
    expect(getRetentionTurns("glob", tightened)).toBe(2); // min(2,5) = 2, unchanged
  });
});

// ── 37. Fix #4: Profile precedence ────────────────────────────────────────────
// Profiles used to be applied POST-merge, silently clobbering explicit per-model
// or per-provider overrides (e.g. "code" profile's recencyGuardTurns:8 would
// win over an explicit model-level recencyGuardTurns:25). Fixed: profiles are
// now a defaults layer applied BEFORE the explicit layers.

describe("profile precedence: explicit overrides win over profile defaults", () => {
  it("explicit recencyGuardTurns overrides the code profile default", () => {
    // "code" profile sets recencyGuardTurns=8; explicit model layer sets 25.
    // The explicit value should win.
    const config = resolveConfig(
      "s",
      undefined, undefined, undefined,
      { profile: "code", recencyGuardTurns: 25 }
    );
    expect(config.recencyGuardTurns).toBe(25);
  });

  it("profile default applies when no explicit override is given", () => {
    const config = resolveConfig("s", { profile: "code" });
    expect(config.recencyGuardTurns).toBe(8); // code profile default
  });

  it("runtime layer wins over model layer profile", () => {
    const config = resolveConfig(
      "s",
      undefined, undefined, undefined,
      { profile: "code" },
      { profile: "balanced" }
    );
    expect(config.profile).toBe("balanced");
  });
});

// ── 38. Fix #2: Token calibration ─────────────────────────────────────────────

describe("token calibration and model-visible request metrics", () => {
  it("presents compression targets as advisory rather than mandatory", () => {
    const text = buildContextStatusText({
      modelKey: "openai\u0000gpt-5.6-sol",
      currentTokens: 210_799,
      previousTokens: 210_002,
      addedTokens: 797,
      targetTokens: 150_000,
      tokensToRemove: 60_799,
    }, true);
    expect(text).toContain("advisory compression target <=150,000");
    expect(text).toContain("not a mandatory rule");
    expect(text).not.toContain("until the target is reached");
  });

  it("CalibratedTokenizer scales base estimates by the given ratio", () => {
    const base = new CharTokenizer();
    const cal = new CalibratedTokenizer(base, 2.0); // 2× correction
    const text = "a".repeat(400); // CharTokenizer = 100 tokens
    expect(base.countTokens(text)).toBe(100);
    expect(cal.countTokens(text)).toBe(200); // 100 * 2 = 200
  });

  it("CalibratedTokenizer ratio=1.0 is a no-op (initial state)", () => {
    const base = new CharTokenizer();
    const cal = new CalibratedTokenizer(base, 1.0);
    const text = "hello world";
    expect(cal.countTokens(text)).toBe(base.countTokens(text));
  });

  it("pipeline applies adapter-associated calibration without consuming unmatched usage", () => {
    resetCounters();
    const state = createInitialState("t");
    expect(state.tokenCalibration).toEqual({ ratio: 1.0, sampleCount: 0 });
    state.tokenCalibration = { ratio: 2, sampleCount: 1, modelKey: "openai\u0000gpt" };
    const userMsg = makeUserMessage("hello");
    const assistantMsg = makeAssistantMessage("world");
    (assistantMsg as NeutralMessage).tokens = { input: 500, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const config = makeConfig({
      automation: { automaticPruning: false, modelCompression: true },
      costRoi: { enabled: false },
      clearAtLeast: 0,
      minRepruneInterval: 0,
    });
    const tok = new CharTokenizer();
    const first = runPipeline(
      { messages: [userMsg, assistantMsg], state, config, nowMs: 1000 },
      { tokenizer: tok, workspaceDir: "/ws" }
    );
    expect(first.estimatedTokens).toBeGreaterThan(0);
    expect(state.tokenCalibration.sampleCount).toBe(1);
    expect(state.tokenCalibration.ratio).toBe(2);
    expect(first.contextMetrics.addedTokens).toBeUndefined();
    expect(first.contextStatusText).toContain("change unavailable");

    const second = runPipeline(
      { messages: [userMsg, assistantMsg, makeUserMessage("additional text")], state, config, nowMs: 2000 },
      { tokenizer: tok, workspaceDir: "/ws" }
    );
    expect(second.contextMetrics.previousTokens).toBe(first.estimatedTokens);
    expect(second.contextMetrics.addedTokens).toBe(second.estimatedTokens - first.estimatedTokens);
    expect(second.contextStatusText).toContain("since prior request");
    expect(second.contextStatusText).toContain("advisory compression target");
  });

  it("injects a fixed-point status whose count includes finalized ref tags", () => {
    resetCounters();
    const state = createInitialState("status-fixed-point");
    state.contextTokenMetrics.modelKey = "openai\u0000gpt-5.6-sol";
    const config = makeConfig({
      modelContextLimit: 10_000,
      automation: { automaticPruning: true, modelCompression: true },
      costRoi: { enabled: false },
      clearAtLeast: 0,
      minRepruneInterval: 0,
    });
    const result = runPipeline(
      {
        messages: [makeUserMessage("first request"), makeAssistantMessage("answer"), makeUserMessage("next request")],
        state,
        config,
        nowMs: 1_000,
        injectContextStatus: true,
      },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" },
    );
    const visible = result.messages.at(-1)?.parts.find(part => part.type === "text");
    const text = visible?.type === "text" ? visible.text : "";
    const reported = /model-specific estimate: ~([\d,]+) tokens/.exec(text)?.[1];
    expect(reported).toBeDefined();
    expect(Number(reported!.replaceAll(",", ""))).toBe(result.estimatedTokens);
    expect(result.contextMetrics.currentTokens).toBe(result.estimatedTokens);
    expect(text).toContain("<ctx-message-id>");
  });

  it("reserves finalized tags and status text inside the provider limit", () => {
    resetCounters();
    const state = createInitialState("status-cap");
    state.contextTokenMetrics.modelKey = "openai\u0000gpt";
    const config = makeConfig({
      modelContextLimit: 500,
      hardCap: "100%",
      recencyGuardTurns: 0,
      automation: { automaticPruning: true, modelCompression: true },
      costRoi: { enabled: false },
      clearAtLeast: 0,
      minRepruneInterval: 0,
    });
    const messages = Array.from({ length: 10 }, (_, index) =>
      makeUserMessage(`${index}:` + "x".repeat(200))
    );
    const result = runPipeline(
      { messages, state, config, nowMs: 1_000, injectContextStatus: true },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" },
    );
    expect(result.estimatedTokens).toBeLessThanOrEqual(config.modelContextLimit);
    expect(result.messages.some(message => message.parts.some(
      part => part.type === "text" && part.text.includes("Context status"),
    ))).toBe(true);
  });

  it("omits status injection when protected content cannot fit the provider cap", () => {
    resetCounters();
    const state = createInitialState("status-impossible-cap");
    state.nudgeEscalation = { ignoredStreak: 2, compressRunsAtLastCheck: 0 };
    const config = makeConfig({
      modelContextLimit: 100,
      hardCap: "100%",
      recencyGuardTurns: 0,
      automation: { automaticPruning: true, modelCompression: true },
      costRoi: { enabled: false },
      clearAtLeast: 0,
      minRepruneInterval: 0,
    });
    const messages = Array.from({ length: 4 }, (_, index) =>
      makeUserMessage(`${index}:` + "x".repeat(400))
    );
    const result = runPipeline(
      { messages, state, config, nowMs: 1_000, injectContextStatus: true },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" },
    );
    expect(result.estimatedTokens).toBeGreaterThan(config.modelContextLimit);
    expect(result.messages.some(message => message.parts.some(
      part => part.type === "text" && part.text.includes("Context status"),
    ))).toBe(false);
    expect(result.contextStatusText).toBe("");
    expect(result.nudgeText).toBeUndefined();
    expect(result.shouldInjectCompress).toBe(false);
    expect(state.nudgeEscalation.ignoredStreak).toBe(2);
  });

  it("clamps the compression target below the earliest mandatory ceiling", () => {
    const config = makeConfig({
      modelContextLimit: 100_000,
      hardCap: "92%",
      nudges: {
        ...makeConfig().nudges,
        lowerThreshold: 150_000,
        safetyCap: "80%",
      },
    });
    expect(resolveCompressionTarget(config)).toBe(60_000);
  });
});

// ── 39. Fix #8: hardCap Phase 2 drop order ────────────────────────────────────

describe("hardCap Phase 2 drop order: tool-only messages before user text", () => {
  beforeEach(() => resetCounters());

  it("drops tool-only assistant messages before pure user-text messages", () => {
    const tok = new CharTokenizer();
    const state = createInitialState("t");

    // Layout: [tool(0), user(1), tool(2), user(3), recent×4]
    // keepRecent = max(recencyGuardTurns=0, 4) = 4 → cutoff = 4 (indices 0-3 are candidates)
    //
    // Pre-mark both tool calls as already-masked in messageIndex so Phase 1 is
    // a no-op (observationMask skips already-masked callIds). The message CONTENT
    // still has the large output, so estimated tokens still exceed the hardCap
    // and Phase 2 must fire to drop whole messages.
    //
    // After Phase 2 with priority sorting: tool(0) and tool(2) get priority=0
    // (tool-only) and are dropped first; user(1) and user(3) get priority=2 and
    // are not needed once the two tools bring context under the cap.
    const LARGE = makeLargeOutput(1000); // ~250 tokens each
    const t0 = makeToolMessage("read", { path: "/f0" }, LARGE, 0);
    const u1 = makeUserMessage("question 1");
    const t2 = makeToolMessage("read", { path: "/f2" }, LARGE, 2);
    const u3 = makeUserMessage("question 3");
    const recent = [makeUserMessage("r"), makeUserMessage("r"), makeUserMessage("r"), makeUserMessage("r")];

    for (const m of [t0, t2]) {
      const tp = m.parts.find(p => p.type === "tool") as ToolPart;
      if (tp) state.messageIndex.set(tp.callId, { messageId: m.id, masked: true, offloaded: false });
    }

    const messages = [t0, u1, t2, u3, ...recent];
    state.currentTurn = 10;

    // hardCap=20 absolute tokens: total ≈ 540, dropping both tools (≈530) gets under.
    // With old (oldest-first) order: tool(0), user(1), tool(2) → user dropped before tool(2).
    // With new (priority) order: tool(0), tool(2) → no user message ever dropped.
    const config = makeConfig({
      hardCap: 20,
      modelContextLimit: 1_000_000,
      recencyGuardTurns: 0,
    });

    runHardCap(messages, 10, config, state, "/ws", tok, 0);

    // Both tool-only messages should be in the drop set
    expect(state.hardCapDroppedIds.has(t0.id)).toBe(true);
    expect(state.hardCapDroppedIds.has(t2.id)).toBe(true);
    // User messages should NOT be dropped (tools were sufficient)
    expect(state.hardCapDroppedIds.has(u1.id)).toBe(false);
    expect(state.hardCapDroppedIds.has(u3.id)).toBe(false);
  });
});

// ── 40. Fix #5: State GC ─────────────────────────────────────────────────────

describe("state GC: prunes orphaned decision entries", () => {
  beforeEach(() => resetCounters());

  it("removes maskDecisions for callIds no longer in any message", () => {
    const state = createInitialState("t");
    state.maskDecisions.set("gone-call-1", "some-placeholder");
    state.maskDecisions.set("gone-call-2", "other-placeholder");

    const liveMsg = makeToolMessage("read", { path: "/f" }, "output", 1);
    const liveCallId = (liveMsg.parts.find(p => p.type === "tool") as ToolPart).callId;

    state.maskDecisions.set(liveCallId, "placeholder-for-live-call");

    runStateGc([liveMsg], state);

    // Gone calls pruned; live call kept
    expect(state.maskDecisions.has("gone-call-1")).toBe(false);
    expect(state.maskDecisions.has("gone-call-2")).toBe(false);
    expect(state.maskDecisions.has(liveCallId)).toBe(true);
  });

  it("removes messageIndex entries for callIds no longer present", () => {
    const state = createInitialState("t");
    state.messageIndex.set("stale-call", { messageId: "old-msg", masked: true, offloaded: false });

    const liveMsg = makeToolMessage("bash", { cmd: "ls" }, "output", 1);
    const liveCallId = (liveMsg.parts.find(p => p.type === "tool") as ToolPart).callId;
    state.messageIndex.set(liveCallId, { messageId: liveMsg.id, masked: false, offloaded: false });

    runStateGc([liveMsg], state);

    expect(state.messageIndex.has("stale-call")).toBe(false);
    expect(state.messageIndex.has(liveCallId)).toBe(true);
  });

  it("keeps hardCapDroppedIds for messages still in the array (isIgnored)", () => {
    const state = createInitialState("t");
    const msg = makeToolMessage("read", { path: "/x" }, "output", 1);
    state.hardCapDroppedIds.add(msg.id); // drop decision for this message
    const ignoredMsg = { ...msg, isIgnored: true };

    // Message is still in the array (as ignored) — keep the drop decision
    runStateGc([ignoredMsg], state);
    expect(state.hardCapDroppedIds.has(msg.id)).toBe(true);

    // Once the message is truly gone from the array, prune it
    runStateGc([], state);
    expect(state.hardCapDroppedIds.has(msg.id)).toBe(false);
  });
});

// ── 41. Fix #7: Telemetry ────────────────────────────────────────────────────

describe("telemetry events emitted via PipelineServices callback", () => {
  beforeEach(() => resetCounters());

  it("emits dedup events when dedup decides a callId (new decision only)", () => {
    const state = createInitialState("t");
    state.currentTurn = 20;
    const LARGE = makeLargeOutput(2000);
    const m1 = makeToolMessage("read", { path: "/f" }, LARGE, 1);
    const m2 = makeToolMessage("read", { path: "/f" }, LARGE, 2);

    const events: TelemetryEvent[] = [];
    const config = makeConfig({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { ...buildDefaultConfig("t").nudges, maskTriggerThreshold: 999999 },
    });

    runPipeline(
      { messages: [m1, m2], state, config, nowMs: 0 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws", telemetry: e => events.push(e) }
    );

    const dedupEvents = events.filter(e => e.type === "dedup");
    expect(dedupEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("emits mask events when observationMask fires", () => {
    const state = createInitialState("t");
    state.currentTurn = 20;
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(3000), 1);

    const events: TelemetryEvent[] = [];
    const config = makeConfig({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      profile: "code",
      nudges: { ...buildDefaultConfig("t").nudges, maskTriggerThreshold: 0 },
    });

    runPipeline(
      { messages: [msg], state, config, nowMs: 0 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws", telemetry: e => events.push(e) }
    );

    const maskEvents = events.filter(e => e.type === "mask" || e.type === "offload");
    expect(maskEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("always emits a pipeline-complete event at the end", () => {
    const state = createInitialState("t");
    const config = makeConfig();

    const events: TelemetryEvent[] = [];
    runPipeline(
      { messages: [makeUserMessage("hi")], state, config, nowMs: 0 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws", telemetry: e => events.push(e) }
    );

    const completeEvents = events.filter(e => e.type === "pipeline-complete");
    expect(completeEvents).toHaveLength(1);
  });
});

// ── 42. Fix #1: Summarizer port / compressRequests ───────────────────────────

describe("compressRequests emitted on nudge-escalation path", () => {
  beforeEach(() => resetCounters());

  it("pipeline emits compressRequests when escalation streak is at threshold", () => {
    const state = createInitialState("t");
    state.currentTurn = 10;
    state.nudgeEscalation = { ignoredStreak: ESCALATION_STREAK_THRESHOLD, compressRunsAtLastCheck: 0 };

    // Tool-turn age is not compression age. Supply three real requests after
    // the old output, matching the request-based transaction validator.
    const old = makeToolMessage("read", { path: "/doc" }, makeLargeOutput(3000), 1);
    const recent = makeUserMessage("continue");
    const requests = [1, 2, 3].map(i => ({ ...old, id: `request-${i}`, ref: undefined,
      parts: [{ type: "text" as const, text: "continued reasoning" }] }));

    // Keep the candidate visible so this test isolates request formation,
    // rather than the independent mechanical masking fallback.
    const config = makeConfig({ recencyGuardTurns: 5, automation: { automaticPruning: false, modelCompression: true } });
    const result = runPipeline(
      { messages: [old, ...requests, recent], state, config, nowMs: 0 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );

    // The escalation path emits a compress request for the stable range
    expect(result.compressRequests.length).toBeGreaterThanOrEqual(1);
    expect(result.compressRequests[0].messageIds.length).toBeGreaterThan(0);
    expect(result.compressRequests[0].topic).toBe("escalation");
    expect(result.compressRequests[0].messageIds).toEqual([old.id]);
    expect(result.compressRequests[0].startRef).toBeDefined();
  });

  it("does not emit requests based only on old tool turns", () => {
    const state = createInitialState("t");
    state.currentTurn = 10;
    state.nudgeEscalation = { ignoredStreak: ESCALATION_STREAK_THRESHOLD, compressRunsAtLastCheck: 0 };
    const old = makeToolMessage("read", { path: "/doc" }, makeLargeOutput(3000), 1);
    const result = runPipeline({ messages: [old, makeUserMessage("continue")], state,
      config: makeConfig({ automation: { automaticPruning: false, modelCompression: true } }), nowMs: 0 },
    { tokenizer: new CharTokenizer(), workspaceDir: "/ws" });
    expect(result.compressRequests).toHaveLength(0);
  });

  it("no compressRequests when escalation streak is below threshold", () => {
    const state = createInitialState("t");
    state.currentTurn = 10;
    state.nudgeEscalation = { ignoredStreak: ESCALATION_STREAK_THRESHOLD - 1, compressRunsAtLastCheck: 0 };

    const config = makeConfig({ recencyGuardTurns: 5 });
    const result = runPipeline(
      { messages: [makeUserMessage("hi")], state, config, nowMs: 0 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );

    expect(result.compressRequests).toHaveLength(0);
  });
});

// ── 43. Cache-aware dashboard projection edits ────────────────────────────────

describe("projection edits are cache-coalesced", () => {
  beforeEach(() => resetCounters());

  const warmConfig = () => makeConfig({ cacheModel: CACHE_MODEL_DEEPSEEK, recencyGuardTurns: 2 });

  it("a pending edit is treated as an unavoidable prefix rewrite by the prune gate", () => {
    const state = makeState();
    state.lastRequestTime = 1_000;
    state.lastCacheMiss = false;
    const config = warmConfig();

    // Warm cache, small candidate savings: normally not worth busting.
    expect(cachePruneAllowed(config, state, 2_000, 100_000, 100)).toBe(false);

    state.projectionEditRevision = 1;
    expect(cachePruneAllowed(config, state, 2_000, 100_000, 100)).toBe(true);

    // Once delivered, the prefix is byte-stable again and the gate re-engages.
    state.projectionEditAppliedRevision = 1;
    expect(cachePruneAllowed(config, state, 2_000, 100_000, 100)).toBe(false);
  });

  it("deferred dedup rides the edit's invalidation instead of causing a second one", () => {
    const build = () => {
      const state = makeState();
      state.currentTurn = 20;
      state.lastRequestTime = 1_000;
      state.lastCacheMiss = false;
      const duplicate = makeLargeOutput(4_000);
      const messages = [
        makeToolMessage("read", { path: "/doc" }, duplicate, 1, { createdAt: 1 }),
        makeToolMessage("read", { path: "/doc" }, duplicate, 2, { createdAt: 2 }),
        // Substantial protected tail: the cached prefix left after deduping is
        // large, so the warm-cache penalty genuinely outweighs the savings.
        makeUserMessage(makeLargeOutput(200_000), { createdAt: 3 }),
      ];
      return { state, messages };
    };
    const config = makeConfig({
      cacheModel: CACHE_MODEL_DEEPSEEK,
      recencyGuardTurns: 2,
      // Keep masking out of the picture so dedup is the only observable pass.
      nudges: { ...warmConfig().nudges, maskTriggerThreshold: 10_000_000 },
    });

    const warm = build();
    runPipeline(
      { messages: warm.messages, state: warm.state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(warm.state.dedupDecisions.size).toBe(0);

    const edited = build();
    edited.state.projectionEditRevision = 1;
    runPipeline(
      { messages: edited.messages, state: edited.state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(edited.state.dedupDecisions.size).toBe(1);
  });

  it("reports the rewritten prefix but leaves acknowledgement to the delivery boundary", () => {
    const state = makeState();
    state.currentTurn = 7;
    state.lastRequestTime = 1_000;
    state.lastCacheMiss = false;
    state.lastCacheBustTurn = 0;
    const stale = makeUserMessage("early requirement", { createdAt: 1 });
    const middle = makeAssistantMessage("evidence", { createdAt: 2 });
    const recent = makeUserMessage("continue", { createdAt: 3 });
    state.manualOverrides.set(stale.id, { mode: "exclude" });
    recordProjectionEdit(state, [stale.id]);

    const config = warmConfig();
    const first = runPipeline(
      { messages: [stale, middle, recent], state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );

    expect(first.messages.some(m => m.id === stale.id)).toBe(false);
    expect(first.projectionEdit?.editedMessages).toBe(1);
    // Everything at or after the edited position is re-sent as a cache write.
    expect(first.projectionEdit?.rewrittenTokens).toBeGreaterThan(0);
    // Not acknowledged yet: a turn that dies before delivery must retry the edit.
    expect(state.projectionEditAppliedRevision).toBe(0);
    expect(hasPendingProjectionRewrite(state)).toBe(true);

    // The adapter acknowledges once the host holds the messages.
    markProjectionRewriteApplied(state);
    recordCacheBust(state, state.currentTurn);
    expect(state.lastCacheBustTurn).toBe(7);
    expect(state.projectionEditPendingIds).toEqual([]);

    // The override stays in force, but is not charged again on later turns.
    const second = runPipeline(
      { messages: [stale, middle, recent], state, config, nowMs: 3_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(second.messages.some(m => m.id === stale.id)).toBe(false);
    expect(second.projectionEdit).toBeUndefined();
  });

  it("counts one cache bust per request even when several passes rewrite the prefix", () => {
    const state = makeState();
    state.currentTurn = 4;
    state.lastCacheBustTurn = 2;
    const before = state.eTurnsEstimate;

    recordCacheBust(state, 4);
    const afterFirst = state.eTurnsEstimate;
    expect(afterFirst).not.toBe(before);

    // A second pass in the same turn invalidates nothing further.
    recordCacheBust(state, 4);
    expect(state.eTurnsEstimate).toBe(afterFirst);
    expect(state.lastCacheBustTurn).toBe(4);
  });

  it("does not charge a cache bust when the gate passes but nothing is pruned", () => {
    const state = makeState();
    state.currentTurn = 9;
    // Cold cache opens the gate; the conversation has nothing to dedup.
    state.lastRequestTime = 0;
    const config = warmConfig();
    runPipeline(
      { messages: [makeUserMessage("only message", { createdAt: 1 })], state, config, nowMs: 1_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(state.lastCacheBustTurn).toBe(0);
  });

  it("does not charge byte-stable dedup decision reapplication as a new cache bust", () => {
    const state = makeState();
    state.currentTurn = 10;
    state.hasRecordedCacheBust = true;
    state.lastCacheBustTurn = 4;
    const output = makeLargeOutput(4_000);
    const older = makeToolMessage("read", { path: "/same" }, output, 1, { createdAt: 1 });
    const newer = makeToolMessage("read", { path: "/same" }, output, 2, { createdAt: 2 });
    const olderCall = older.parts.find(part => part.type === "tool") as ToolPart;
    state.dedupDecisions.add(olderCall.callId);
    const estimateBefore = state.eTurnsEstimate;
    const config = makeConfig({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      nudges: { ...warmConfig().nudges, maskTriggerThreshold: 10_000_000 },
    });

    runPipeline(
      { messages: [older, newer], state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );

    expect(state.lastCacheBustTurn).toBe(4);
    expect(state.eTurnsEstimate).toBe(estimateBefore);
  });

  it("records and coalesces a real cache bust at turn zero", () => {
    const state = makeState();
    recordCacheBust(state, 0);
    expect(state.hasRecordedCacheBust).toBe(true);
    expect(state.lastCacheBustTurn).toBe(0);
    recordCacheBust(state, 0);
    expect(state.eTurnsEstimate).toBe(5);
    recordCacheBust(state, 2);
    expect(state.eTurnsEstimate).toBeCloseTo(4.1, 5);
  });

  it("uses stable message position when edited messages share a timestamp", () => {
    const state = makeState();
    state.currentTurn = 3;
    const before = makeUserMessage("unchanged before", { createdAt: 1 });
    const edited = makeAssistantMessage("remove this", { createdAt: 1 });
    const after = makeUserMessage("rewritten suffix", { createdAt: 1 });
    state.manualOverrides.set(edited.id, { mode: "exclude" });
    recordProjectionEdit(state, [edited.id]);
    const config = makeConfig({
      nudges: { ...warmConfig().nudges, maskTriggerThreshold: 10_000_000 },
      hardCap: 1_000_000,
    });

    const result = runPipeline(
      { messages: [before, edited, after], state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );

    const finalizedAfter = result.messages.find(message => message.id === after.id)!;
    expect(result.projectionEdit?.editedMessages).toBe(1);
    expect(result.projectionEdit?.rewrittenTokens).toBe(
      estimateMessageTokens(finalizedAfter, new CharTokenizer())
    );
  });

  it("includes a reactivated block summary inserted before its source in rewrite cost", () => {
    const state = makeState();
    state.currentTurn = 2;
    const source = makeUserMessage("source material", { createdAt: 1 });
    const config = makeConfig({
      nudges: { ...warmConfig().nudges, maskTriggerThreshold: 10_000_000 },
      hardCap: 1_000_000,
    });
    const compressed = applyCompress(
      [source],
      "reactivated summary with meaningful content",
      [source.id],
      state,
      config,
      1_000
    );
    recordProjectionEdit(state, [source.id], [`__summary_${compressed.blockId}`]);

    const result = runPipeline(
      { messages: [{ ...source, isIgnored: false }], state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );

    const summary = result.messages.find(message => message.id === `__summary_${compressed.blockId}`)!;
    expect(summary).toBeDefined();
    expect(result.projectionEdit?.editedMessages).toBe(1);
    expect(result.projectionEdit?.rewrittenTokens).toBe(
      estimateMessageTokens(summary, new CharTokenizer())
    );
  });
});

describe("automation master switches", () => {
  beforeEach(() => resetCounters());

  it("automaticPruning off restores persisted mechanical decisions and skips hard caps", () => {
    const state = makeState();
    state.currentTurn = 20;
    const originalOutput = makeLargeOutput(4_000);
    const toolMessage = makeToolMessage(
      "read",
      { path: "/reasoning-safe" },
      originalOutput,
      1,
      { createdAt: 1 }
    );
    const toolPart = toolMessage.parts.find(part => part.type === "tool") as ToolPart;
    state.dedupDecisions.add(toolPart.callId);
    state.maskDecisions.set(toolPart.callId, PLACEHOLDER_PLAIN_MASK);
    state.hardCapDroppedIds.add(toolMessage.id);
    const config = makeConfig({
      automation: { automaticPruning: false, modelCompression: true },
      hardCap: 1,
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
    });

    const result = runPipeline(
      { messages: [toolMessage], state, config, nowMs: 1_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    const output = (result.messages[0].parts.find(part => part.type === "tool") as ToolPart).output;
    expect(output).toBe(originalOutput);
    expect(result.messages.map(message => message.id)).toContain(toolMessage.id);
    expect(result.savedThisRun).toBe(0);
    expect(result.offloadRequests).toHaveLength(0);
    // Off is a projection policy, not destructive state deletion; turning it
    // back on can deterministically reapply the prior decisions.
    expect(state.dedupDecisions.has(toolPart.callId)).toBe(true);
    expect(state.hardCapDroppedIds.has(toolMessage.id)).toBe(true);
  });

  it("automaticPruning off still keeps active reversible compression blocks", () => {
    const state = makeState();
    state.currentTurn = 4;
    const source = makeUserMessage("reasoning-bearing source", { createdAt: 1 });
    const config = makeConfig({
      automation: { automaticPruning: false, modelCompression: true },
      hardCap: 1,
    });
    const compressed = applyCompress([source], "existing summary", [source.id], state, config, 1_000);

    const result = runPipeline(
      { messages: [{ ...source, isIgnored: false }], state, config, nowMs: 2_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(result.messages.map(message => message.id)).toContain(`__summary_${compressed.blockId}`);
    expect(result.messages.map(message => message.id)).not.toContain(source.id);
  });

  it("modelCompression off suppresses nudges, tool injection, and escalation requests", () => {
    const state = makeState();
    state.currentTurn = 10;
    state.nudgeEscalation.ignoredStreak = ESCALATION_STREAK_THRESHOLD;
    const config = makeConfig({
      automation: { automaticPruning: false, modelCompression: false },
      modelContextLimit: 1_000,
      nudges: {
        lowerThreshold: 1,
        midSoftNudge: 2,
        upperThreshold: 3,
        safetyCap: "10%",
        maskTriggerThreshold: 1,
      },
    });
    const result = runPipeline(
      { messages: [makeUserMessage(makeLargeOutput(5_000))], state, config, nowMs: 1_000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(result.nudgeText).toBeUndefined();
    expect(result.shouldInjectCompress).toBe(false);
    expect(result.compressRequests).toHaveLength(0);
    expect(state.nudgeEscalation.ignoredStreak).toBe(0);
  });
});
