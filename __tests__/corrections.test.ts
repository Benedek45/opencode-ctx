// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Regression tests for the correction pass:
//   P0.1 finalize ref-tag injection (+ idempotency with the tagging strip)
//   P0.2 nudge delivery via the messages channel
//   P1.3 cost-ROI gate actually gating observation-mask
//   P1.4 percentage threshold resolution scaling with model context limit
//   P1.5 the "low" nudge tier
//   P1-reapply decisions reapply under re-feed (decide/apply split)
//   P2 dedup fires on warm cache when cost-ROI formula clearly favors it

import { describe, it, expect, beforeEach } from "bun:test";
import { resetCounters, makeUserMessage, makeAssistantMessage, makeToolMessage, makeErrorToolMessage, makeLargeOutput } from "./fixtures/messages.js";
import { createInitialState } from "../types/state.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { runFinalize } from "../core/finalize.js";
import { runTagging } from "../core/tagging.js";
import { getNudgeLevel, appendNudgeToLastUser, ESCALATION_STREAK_THRESHOLD } from "../core/nudges.js";
import { resolveThreshold } from "../core/tokens.js";
import { runObservationMask } from "../core/strategies/observationMask.js";
import { runPipeline } from "../core/pipeline.js";
import { applyCompress } from "../core/compress/apply.js";
import { applyDecisions } from "../core/applyDecisions.js";
import { runHardCap } from "../core/strategies/hardCap.js";
import { resolveConfig } from "../core/config.js";
import { estimateContextTokens } from "../core/tokens.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { PLACEHOLDER_DEDUP, PLACEHOLDER_PLAIN_MASK, PLACEHOLDER_STALE_ERROR_INPUT } from "../core/placeholders.js";
import type { CoreConfig } from "../types/config.js";
import type { NeutralMessage, TextPart, ToolPart } from "../types/neutral.js";

function makeConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return { ...buildDefaultConfig("test"), ...overrides };
}

function firstText(msg: NeutralMessage): string {
  const p = msg.parts.find(pp => pp.type === "text") as TextPart | undefined;
  return p?.text ?? "";
}

// ── P0.1 finalize ref-tag injection ───────────────────────────────────────────

describe("P0.1 finalize injects ctx-message-id ref tags", () => {
  beforeEach(() => resetCounters());

  it("prepends the message ref tag to the first text part", () => {
    const msg = makeUserMessage("hello world", { ref: "m0007" });
    const out = runFinalize([msg]);
    const text = firstText(out[0]);
    expect(text).toContain("<ctx-message-id>m0007</ctx-message-id>");
    expect(text).toContain("hello world");
  });

  it("does not tag summary blocks or text-less messages", () => {
    const summary: NeutralMessage = {
      id: "s1", ref: "b1", role: "user", sessionId: "t", createdAt: 1, isSummary: true,
      parts: [{ type: "summary-block", blockId: "b1", text: "summary text" }],
    };
    const out = runFinalize([summary]);
    expect(firstText(out[0])).toBe(""); // no text part, nothing injected
    const block = out[0].parts[0];
    expect(block.type).toBe("summary-block");
  });

  it("is idempotent across a strip/re-inject (re-feed) cycle — no accumulation", () => {
    const state = createInitialState("t");
    const tagged = runTagging([makeUserMessage("hello")], state);
    const finalized1 = runFinalize(tagged);
    const text1 = firstText(finalized1[0]);

    // Simulate the next turn: tagging strips the prior injected tag, finalize re-injects.
    const reTagged = runTagging(finalized1, state);
    const finalized2 = runFinalize(reTagged);
    const text2 = firstText(finalized2[0]);

    expect(text2).toBe(text1);
  });
});

// ── P0.2 nudge delivery via messages channel ──────────────────────────────────

describe("P0.2 appendNudgeToLastUser", () => {
  beforeEach(() => resetCounters());

  it("appends nudge text to the most recent user message only", () => {
    const m0 = makeUserMessage("first");
    const m1 = makeAssistantMessage("reply");
    const m2 = makeUserMessage("latest");
    const out = appendNudgeToLastUser([m0, m1, m2], "[NUDGE]");

    expect(firstText(out[2])).toContain("latest");
    expect(firstText(out[2])).toContain("[NUDGE]");
    // earlier messages are untouched (same references)
    expect(out[0]).toBe(m0);
    expect(out[1]).toBe(m1);
  });

  it("returns the input array unchanged when there is no nudge", () => {
    const msgs = [makeUserMessage("x")];
    expect(appendNudgeToLastUser(msgs, undefined)).toBe(msgs);
  });

  it("reapplies byte-stable text to its anchored user during a tool loop", () => {
    const user = makeUserMessage("request");
    const assistant = makeAssistantMessage("tool call");
    const msgs = [user, assistant];
    expect(appendNudgeToLastUser(msgs, "[NUDGE]")).toBe(msgs);
    const out = appendNudgeToLastUser(msgs, "[NUDGE]", user.id);
    expect(firstText(out[0])).toContain("[NUDGE]");
    expect(firstText(out[1])).not.toContain("[NUDGE]");
  });
});

// ── P1.4 / P1.5 percentage thresholds + low tier ──────────────────────────────

describe("P1.4 percentage threshold resolution", () => {
  it("resolveThreshold: number is absolute, % scales to the context limit", () => {
    expect(resolveThreshold(150000, 200000)).toBe(150000);
    expect(resolveThreshold("15%", 200000)).toBe(30000);
    expect(resolveThreshold("70%", 1000000)).toBe(700000);
  });

  it("nudge ladder scales correctly on a 200k-context model via % thresholds", () => {
    const config = makeConfig({
      modelContextLimit: 200000,
      nudges: {
        lowerThreshold: "25%",      // 50_000
        midSoftNudge: "50%",        // 100_000
        upperThreshold: "70%",      // 140_000
        safetyCap: "80%",           // 160_000
        maskTriggerThreshold: "15%",
      },
    });
    expect(getNudgeLevel(20_000, config)).toBe("none");
    expect(getNudgeLevel(60_000, config)).toBe("low");
    expect(getNudgeLevel(110_000, config)).toBe("mid-soft");
    expect(getNudgeLevel(150_000, config)).toBe("upper");
    expect(getNudgeLevel(170_000, config)).toBe("safety-cap");
  });
});

// ── P1.3 cost-ROI gate actually gates masking ─────────────────────────────────

describe("P1.3 cost-ROI gate gates observation masking", () => {
  beforeEach(() => resetCounters());

  function scenario() {
    // A large recent (protected) text message inflates N_after; one small old
    // read is the only maskable output, so the prune saves little relative to the
    // warm cached prefix it would invalidate.
    const bigText = makeUserMessage("x".repeat(200_000));
    const smallOld = makeToolMessage("read", { path: "/f" }, makeLargeOutput(1200), 1);
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      profile: "code",
      nudges: { ...buildDefaultConfig("test").nudges, maskTriggerThreshold: 0 },
    });
    return { messages: [bigText, smallOld], config };
  }

  it("blocks a marginal mask on a warm cache (R=50, formula fails)", () => {
    const { messages, config } = scenario();
    const state = createInitialState("test");
    state.lastRequestTime = 1000;   // recent → warm (idle 1s << TTL)
    state.lastCacheMiss = false;
    const result = runObservationMask(messages, 20, config, state, "/ws", new CharTokenizer(), 2000);
    expect(result.maskedCount).toBe(0);
    expect(result.offloadedCount).toBe(0);
  });

  it("allows the same mask on a cold cache (override)", () => {
    const { messages, config } = scenario();
    const state = createInitialState("test"); // lastRequestTime = 0 → cold
    const result = runObservationMask(messages, 20, config, state, "/ws", new CharTokenizer(), 2000);
    expect(result.maskedCount).toBeGreaterThan(0);
  });

  it("allows the mask when the gate is disabled", () => {
    const { messages, config } = scenario();
    const disabled = { ...config, costRoi: { enabled: false } };
    const state = createInitialState("test");
    state.lastRequestTime = 1000;
    state.lastCacheMiss = false;
    const result = runObservationMask(messages, 20, disabled, state, "/ws", new CharTokenizer(), 2000);
    expect(result.maskedCount).toBeGreaterThan(0);
  });
});

// ── Token-savings recording ───────────────────────────────────────────────────

describe("token-savings recording", () => {
  beforeEach(() => resetCounters());

  it("records masked TOKENS (not the mask count) in stats", () => {
    const state = createInitialState("t");
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      profile: "code", // plain mask for stateless
      nudges: { ...buildDefaultConfig("t").nudges, maskTriggerThreshold: 0 },
    });
    const msg = makeToolMessage("read", { path: "/f" }, makeLargeOutput(4000), 1);
    const r = runObservationMask([msg], 50, config, state, "/ws", new CharTokenizer(), 1000);
    expect(r.maskedCount).toBe(1);
    // ~1000 tokens for a 4000-char output — proves we record tokens, not the count (1).
    expect(state.stats.totalTokensMasked).toBeGreaterThan(100);
  });

  it("records compressed tokens and rolls them into the grand total", () => {
    const state = createInitialState("t");
    const config = makeConfig();
    const big = makeUserMessage("x".repeat(8000));
    applyCompress([big], "short summary", [big.id], state, config, 1000);
    expect(state.stats.totalCompressRuns).toBe(1);
    expect(state.stats.totalTokensCompressed).toBeGreaterThan(0);
    expect(state.stats.totalTokensSaved).toBe(state.stats.totalTokensCompressed);
  });

  it("pipeline reports per-run and cumulative savings", () => {
    const state = createInitialState("bench");
    state.currentTurn = 50;
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      costRoi: { enabled: false },
      profile: "documents",
      nudges: { ...buildDefaultConfig("bench").nudges, maskTriggerThreshold: 0 },
    });
    const tokenizer = new CharTokenizer();
    const result = runPipeline(
      { messages: [makeToolMessage("read", { path: "/f" }, makeLargeOutput(4000), 1)], state, config, nowMs: 1000 },
      { tokenizer, workspaceDir: "/ws" }
    );
    expect(result.savedThisRun).toBeGreaterThan(0);
    expect(result.cumulativeSaved).toBe(state.stats.totalTokensSaved);
  });

  it("deterministic savings benchmark: long session shrinks, no tool stranded", () => {
    const state = createInitialState("bench");
    state.currentTurn = 50;
    const config = makeConfig({
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      costRoi: { enabled: false },
      profile: "documents", // prefer offload for large stateless outputs
      nudges: { ...buildDefaultConfig("bench").nudges, maskTriggerThreshold: 0 },
    });
    const tokenizer = new CharTokenizer();

    // 8 old large read outputs (distinct paths → no dedup) + one recent user msg.
    const messages: NeutralMessage[] = [];
    for (let i = 1; i <= 8; i++) {
      messages.push(makeToolMessage("read", { path: `/f${i}` }, makeLargeOutput(4000), i));
    }
    messages.push(makeUserMessage("recent question"));

    const inputTokens = estimateContextTokens(messages, tokenizer);
    const result = runPipeline({ messages, state, config, nowMs: 1000 }, { tokenizer, workspaceDir: "/ws" });

    // Measurable reduction.
    expect(result.savedThisRun).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThan(inputTokens);
    expect(state.stats.totalTokensOffloaded).toBeGreaterThan(0);

    // Integrity: no tool call left in a non-completed (stranded) state.
    const stranded = result.messages.some(m =>
      m.parts.some(p => p.type === "tool" && p.status !== "completed")
    );
    expect(stranded).toBeFalsy();
  });
});

// ── Cache-conscious dedup / stale-error ───────────────────────────────────────

describe("cache-conscious dedup/stale-error", () => {
  beforeEach(() => resetCounters());

  function dupSession() {
    // Two identical completed reads (old, dedup-eligible) + a recent user message.
    const m1 = makeToolMessage("read", { path: "/foo" }, makeLargeOutput(3000), 1);
    const m2 = makeToolMessage("read", { path: "/foo" }, makeLargeOutput(3000), 2);
    const recent = makeUserMessage("now");
    return [m1, m2, recent];
  }

  function hasDedup(messages: NeutralMessage[]): boolean {
    return messages.some(m => m.parts.some(p => p.type === "tool" && (p as ToolPart).output === PLACEHOLDER_DEDUP));
  }

  it("skips dedup while the cache is warm (preserves the cached prefix)", () => {
    const state = createInitialState("t");
    state.currentTurn = 50;
    state.lastRequestTime = 1000;     // recent → warm
    state.lastCacheMiss = false;
    const config = makeConfig();      // DeepSeek R=50, costRoi enabled
    const result = runPipeline(
      { messages: dupSession(), state, config, nowMs: 2000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(hasDedup(result.messages)).toBeFalsy();
    expect(result.savedThisRun).toBe(0);
  });

  it("runs dedup after a compress event (rides the compress cache miss)", () => {
    const state = createInitialState("t");
    state.currentTurn = 50;
    state.lastRequestTime = 1000;
    state.lastCacheMiss = false;
    state.stats.totalCompressRuns = 1;
    state.lastPruneCompressRuns = 0;
    const config = makeConfig();
    const result = runPipeline(
      { messages: dupSession(), state, config, nowMs: 2000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(hasDedup(result.messages)).toBeTruthy();
    expect(result.savedThisRun).toBeGreaterThan(0);
    expect(state.lastPruneCompressRuns).toBe(1);
  });

  it("runs dedup after the configured cache-prune TTL is out", () => {
    const state = createInitialState("t");
    state.currentTurn = 50;
    state.lastRequestTime = 1000;
    state.lastCacheMiss = false;
    const config = makeConfig(); // default cachePrune.ttlSeconds = 360 (6 min)
    const result = runPipeline(
      { messages: dupSession(), state, config, nowMs: 1000 + 360 * 1000 + 1 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(hasDedup(result.messages)).toBeTruthy();
    expect(result.savedThisRun).toBeGreaterThan(0);
  });

  it("does not run TTL dedup when cache-prune TTL is disabled", () => {
    const state = createInitialState("t");
    state.currentTurn = 50;
    state.lastRequestTime = 1000;
    state.lastCacheMiss = false;
    const config = makeConfig({ cachePrune: { afterCompress: true, afterTtl: false, ttlSeconds: 360 } });
    const result = runPipeline(
      { messages: dupSession(), state, config, nowMs: 1000 + 360 * 1000 + 1 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(hasDedup(result.messages)).toBeFalsy();
    expect(result.savedThisRun).toBe(0);
  });
});

// ── P2: dedup fires on warm cache when cost-ROI formula clearly favors it ──────

describe("P2: dedup fires on warm cache when cost-ROI formula clearly favors it", () => {
  beforeEach(() => resetCounters());

  function hasDedupP2(messages: NeutralMessage[]): boolean {
    return messages.some(m => m.parts.some(p => p.type === "tool" && (p as ToolPart).output === PLACEHOLDER_DEDUP));
  }

  /**
   * Build a session with a VERY LARGE duplicate (200k chars ≈ 50k tokens each).
   * Formula: nSaved * eTurns > (R-1) * nAfter
   *   nSaved ≈ 50_000, eTurns = 5, R = 50, nAfter ≈ 50_000
   *   LHS = 250_000, RHS = 49 * 50_000 = 2_450_000 → still fails for R=50!
   *
   * To make the formula pass with R=50 we need a very small nAfter relative to
   * nSaved. Use R=2 (a low-R provider) where the formula is much easier to satisfy:
   *   LHS = 50_000 * 5 = 250_000, RHS = 1 * 50_000 = 50_000 → passes.
   */
  function largeDupSession() {
    // Two identical completed reads with a very large output (200k chars ≈ 50k tokens)
    const HUGE = makeLargeOutput(200_000);
    const m1 = makeToolMessage("read", { path: "/huge" }, HUGE, 1);
    const m2 = makeToolMessage("read", { path: "/huge" }, HUGE, 2);
    return [m1, m2];
  }

  it("dedup fires on a warm cache when the cost-ROI formula clearly favors it (R=2)", () => {
    const state = createInitialState("t");
    state.currentTurn = 50;
    state.lastRequestTime = 1000;   // recent → warm (idle 1s << TTL)
    state.lastCacheMiss = false;
    // Use R=2 so the formula is easy to satisfy: nSaved*5 > 1*nAfter
    const config = makeConfig({
      cacheModel: { type: "automatic-free", R: 2, effectiveTtlSeconds: 3600 },
      cachePrune: { afterCompress: false, afterTtl: false, ttlSeconds: 360 },
    });
    const result = runPipeline(
      { messages: largeDupSession(), state, config, nowMs: 2000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    // The formula should pass: nSaved ≈ 50k, eTurns=5, R=2, nAfter ≈ 50k
    // LHS = 250k > RHS = 50k → should prune
    expect(hasDedupP2(result.messages)).toBeTruthy();
    expect(result.savedThisRun).toBeGreaterThan(0);
  });

  it("skips dedup while the cache is warm when the formula fails (R=50, small duplicate)", () => {
    // This is the existing test reproduced here to confirm P2 does NOT regress it.
    // Two identical reads with 3000-char output ≈ 750 tokens each.
    // Formula: 750*5 = 3750 vs (50-1)*~1500 = 73500 → fails → no prune.
    const state = createInitialState("t");
    state.currentTurn = 50;
    state.lastRequestTime = 1000;
    state.lastCacheMiss = false;
    const config = makeConfig({
      cachePrune: { afterCompress: false, afterTtl: false, ttlSeconds: 360 },
    });
    const m1 = makeToolMessage("read", { path: "/foo" }, makeLargeOutput(3000), 1);
    const m2 = makeToolMessage("read", { path: "/foo" }, makeLargeOutput(3000), 2);
    const result = runPipeline(
      { messages: [m1, m2], state, config, nowMs: 2000 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/ws" }
    );
    expect(hasDedupP2(result.messages)).toBeFalsy();
    expect(result.savedThisRun).toBe(0);
  });
});

// ── P1: decisions reapply under re-feed (decide/apply split) ──────────────────

describe("P1: decisions reapply under re-feed", () => {
  beforeEach(() => resetCounters());

  /**
   * Config that forces all pruning to fire on the first turn:
   * costRoi disabled, zero recency guard, zero clearAtLeast, zero minRepruneInterval,
   * maskTriggerThreshold=0 so masking always fires.
   */
  function aggressiveConfig(): CoreConfig {
    return makeConfig({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      profile: "code", // plain mask for stateless (no offload)
      nudges: { ...buildDefaultConfig("t").nudges, maskTriggerThreshold: 0 },
    });
  }

  it("mask decision reapplies on re-feed: second turn output still pruned, savedThisRun=0, no new offload", () => {
    const tokenizer = new CharTokenizer();
    const config = aggressiveConfig();
    const state = createInitialState("t");
    state.currentTurn = 50;

    // Build a session with one old large read (maskable)
    const LARGE = makeLargeOutput(4000);
    const oldRead = makeToolMessage("read", { path: "/f" }, LARGE, 1);
    const recentUser = makeUserMessage("latest question");
    const originalMessages = [oldRead, recentUser];

    // Turn 1: run pipeline with gate open (costRoi disabled → always prune)
    const result1 = runPipeline(
      { messages: originalMessages, state, config, nowMs: 1000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    // Verify turn 1 pruned the read output
    const toolPart1 = result1.messages
      .flatMap(m => m.parts)
      .find(p => p.type === "tool") as ToolPart | undefined;
    expect(toolPart1?.output).toBe(PLACEHOLDER_PLAIN_MASK);
    expect(result1.savedThisRun).toBeGreaterThan(0);

    // Turn 2: re-feed the SAME ORIGINAL (unpruned) messages.
    // Now set the state so the gate would SKIP recompute:
    //   - costRoi enabled, R=50, warm cache, no compress since last prune, no TTL
    const state2 = result1.state;
    state2.lastRequestTime = 2000; // just set by turn 1
    state2.lastCacheMiss = false;
    state2.lastPruneCompressRuns = state2.stats.totalCompressRuns; // no new compress

    const warmConfig = makeConfig({
      // costRoi enabled (default), R=50, warm cache → gate blocks recompute
      cachePrune: { afterCompress: true, afterTtl: false, ttlSeconds: 3600 },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      profile: "code",
      nudges: { ...buildDefaultConfig("t").nudges, maskTriggerThreshold: 0 },
    });

    const result2 = runPipeline(
      { messages: originalMessages, state: state2, config: warmConfig, nowMs: 3000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    // The gate should have blocked recompute (warm cache, R=50, no compress)
    // but applyDecisions should have re-applied the mask decision.
    const toolPart2 = result2.messages
      .flatMap(m => m.parts)
      .find(p => p.type === "tool") as ToolPart | undefined;
    expect(toolPart2?.output).toBe(PLACEHOLDER_PLAIN_MASK);

    // savedThisRun must be 0: no NEW decisions were made this turn
    expect(result2.savedThisRun).toBe(0);

    // No offload requests on re-apply (file was written on turn 1, not re-emitted)
    expect(result2.offloadRequests).toHaveLength(0);
  });

  it("dedup decision reapplies on re-feed: second turn still shows dedup placeholder", () => {
    const tokenizer = new CharTokenizer();
    const state = createInitialState("t");
    state.currentTurn = 50;

    const LARGE = makeLargeOutput(4000);
    const m1 = makeToolMessage("read", { path: "/dup" }, LARGE, 1);
    const m2 = makeToolMessage("read", { path: "/dup" }, LARGE, 2);
    const originalMessages = [m1, m2];

    // Turn 1: cold cache → gate open → dedup fires
    const config1 = makeConfig({
      cachePrune: { afterCompress: false, afterTtl: false, ttlSeconds: 360 },
    });
    // state.lastRequestTime = 0 → cold → gate open
    const result1 = runPipeline(
      { messages: originalMessages, state, config: config1, nowMs: 1000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    const hasDedup1 = result1.messages.some(m =>
      m.parts.some(p => p.type === "tool" && (p as ToolPart).output === PLACEHOLDER_DEDUP)
    );
    expect(hasDedup1).toBeTruthy();
    expect(result1.savedThisRun).toBeGreaterThan(0);

    // Turn 2: warm cache, gate would block recompute
    const state2 = result1.state;
    state2.lastRequestTime = 1000; // set by turn 1
    state2.lastCacheMiss = false;
    state2.lastPruneCompressRuns = state2.stats.totalCompressRuns;

    const config2 = makeConfig({
      cachePrune: { afterCompress: false, afterTtl: false, ttlSeconds: 3600 },
    });

    const result2 = runPipeline(
      { messages: originalMessages, state: state2, config: config2, nowMs: 2000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    // applyDecisions must re-apply the dedup decision
    const hasDedup2 = result2.messages.some(m =>
      m.parts.some(p => p.type === "tool" && (p as ToolPart).output === PLACEHOLDER_DEDUP)
    );
    expect(hasDedup2).toBeTruthy();

    // No new savings (decision was already made on turn 1)
    expect(result2.savedThisRun).toBe(0);
  });

  it("stale-error decision reapplies on re-feed", () => {
    const tokenizer = new CharTokenizer();
    const state = createInitialState("t");
    state.currentTurn = 50;

    // An errored tool call older than 3 turns
    const errorMsg = makeErrorToolMessage("bash", { command: "rm /protected" }, "Error: permission denied", 1);
    const originalMessages = [errorMsg];

    // Turn 1: cold cache → gate open → stale-error fires
    const config1 = makeConfig({
      cachePrune: { afterCompress: false, afterTtl: false, ttlSeconds: 360 },
    });
    const result1 = runPipeline(
      { messages: originalMessages, state, config: config1, nowMs: 1000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    const staleApplied1 = result1.messages.some(m =>
      m.parts.some(p => p.type === "tool" && (p as ToolPart).input === PLACEHOLDER_STALE_ERROR_INPUT)
    );
    expect(staleApplied1).toBeTruthy();
    expect(result1.savedThisRun).toBeGreaterThan(0);

    // Turn 2: warm cache, gate blocks recompute
    const state2 = result1.state;
    state2.lastRequestTime = 1000;
    state2.lastCacheMiss = false;
    state2.lastPruneCompressRuns = state2.stats.totalCompressRuns;

    const config2 = makeConfig({
      cachePrune: { afterCompress: false, afterTtl: false, ttlSeconds: 3600 },
    });

    const result2 = runPipeline(
      { messages: originalMessages, state: state2, config: config2, nowMs: 2000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    // applyDecisions must re-apply the stale-error decision
    const staleApplied2 = result2.messages.some(m =>
      m.parts.some(p => p.type === "tool" && (p as ToolPart).input === PLACEHOLDER_STALE_ERROR_INPUT)
    );
    expect(staleApplied2).toBeTruthy();

    // No new savings
    expect(result2.savedThisRun).toBe(0);
  });

  it("compress survives re-feed: summary block present, source range removed from output", () => {
    const tokenizer = new CharTokenizer();
    const state = createInitialState("t");
    state.currentTurn = 10;

    const m1 = makeUserMessage("first message");
    const m2 = makeAssistantMessage("first reply");
    const m3 = makeUserMessage("second message");
    const originalMessages = [m1, m2, m3];

    // Apply a compress block covering m1 and m2.
    // This writes the compress decision into state (messageIndex, blockRegistry,
    // activeByAnchorMessageId) and returns the compressed message list.
    const afterCompress = applyCompress(
      originalMessages,
      "Compressed summary of first exchange.",
      [m1.id, m2.id],
      state,
      makeConfig(),
      1000
    );

    // Verify applyCompress itself works correctly
    expect(afterCompress.messages.some(m => m.isSummary)).toBeTruthy();
    expect(afterCompress.messages.find(m => m.id === m1.id)?.isIgnored).toBeTruthy();

    // Now simulate re-feed: run pipeline on the ORIGINAL (unpruned) messages
    // with the state that has the compress decision recorded.
    // applyDecisions should re-insert the summary block and mark m1/m2 as ignored,
    // and runFinalize will filter out the ignored messages.
    const config = makeConfig({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
    });

    const result = runPipeline(
      { messages: originalMessages, state, config, nowMs: 2000 },
      { tokenizer, workspaceDir: "/ws" }
    );

    // The summary block should be present in the output (re-inserted by applyDecisions)
    const hasSummary = result.messages.some(m => m.isSummary);
    expect(hasSummary).toBeTruthy();

    // The source messages (m1, m2) should NOT be in the output:
    // applyDecisions marks them isIgnored=true, and runFinalize filters them out.
    const m1Out = result.messages.find(m => m.id === m1.id);
    const m2Out = result.messages.find(m => m.id === m2.id);
    expect(m1Out).toBeUndefined(); // filtered out by runFinalize
    expect(m2Out).toBeUndefined(); // filtered out by runFinalize

    // m3 should still be present in the output (not compressed)
    const m3Out = result.messages.find(m => m.id === m3.id);
    expect(m3Out).toBeDefined();
  });
});

// ── Hard cap: mechanical policy floor ─────────────────────────────────────────

describe("hard cap mechanical floor", () => {
  beforeEach(() => resetCounters());
  const tok = new CharTokenizer();

  it("is a no-op when context is below the cap", () => {
    const state = createInitialState("t");
    const msgs = [makeUserMessage("hi"), makeAssistantMessage("hello")];
    const config = makeConfig({ modelContextLimit: 100_000, hardCap: "92%" });
    const res = runHardCap(msgs, 5, config, state, "/ws", tok, 0);
    expect(res.fired).toBe(false);
    expect(res.droppedCount).toBe(0);
    expect(res.tokensSaved).toBe(0);
    expect(res.messages).toBe(msgs);
  });

  it("force-masks tool outputs to get under the cap even when cost-ROI would suppress it", () => {
    const state = createInitialState("t");
    const reads = [1, 2, 3, 4, 5].map(t =>
      makeToolMessage("read", { path: `/f${t}` }, makeLargeOutput(8000), t)
    );
    const msgs = [...reads, makeUserMessage("now")];
    const current = estimateContextTokens(msgs, tok);
    const hardCap = Math.floor(current / 2);
    // Default DeepSeek cache model (R=50) + costRoi enabled would normally suppress
    // masking; the hard cap must bypass that to avoid an API error.
    const config = makeConfig({ modelContextLimit: 1_000_000, hardCap });
    const res = runHardCap(msgs, 50, config, state, "/ws", tok, 0);
    expect(res.fired).toBe(true);
    expect(res.tokensSaved).toBeGreaterThan(0);
    expect(state.maskDecisions.size).toBeGreaterThan(0);
    expect(state.stats.totalHardCapPasses).toBe(1);
    expect(estimateContextTokens(res.messages, tok)).toBeLessThanOrEqual(hardCap);
  });

  it("Phase 1 tightened recency reaches classified tools, not just recencyGuardTurns fallback (latent-bug regression)", () => {
    // Regression for a bug discovered while wiring nudge escalation: Phase 1
    // previously only overrode `recencyGuardTurns` in its synthetic config, but
    // getRetentionTurns (core/strategies/guards.ts) prefers each tool's fixed
    // per-class retentionTurns (DEFAULT_TOOL_CLASSES: read=5) and only falls
    // back to recencyGuardTurns for UNCLASSIFIED tools. So tightening
    // recencyGuardTurns alone silently did nothing for "read" calls whose age
    // was below their class retention (10) but above the intended tightened
    // window (2) — hardCap's Phase 1 would skip straight to Phase 2's lossy
    // whole-message drops for a case it was documented to handle by masking.
    // buildTightenedRecencyConfig (used by hardCap.ts) now clamps toolClasses
    // too, so these ages (5, well under the class's retentionTurns=10, but over
    // the tightened cap=2) ARE eligible in Phase 1.
    const state = createInitialState("t");
    const reads = [1, 2, 3].map(t =>
      makeToolMessage("read", { path: `/f${t}` }, makeLargeOutput(8000), t)
    );
    // currentTurn=6 -> ages 5, 4, 3: all well under retentionTurns=10 for "read",
    // so NONE would be eligible under a naive recencyGuardTurns-only tightening.
    const msgs = [...reads, makeUserMessage("now")];
    const current = estimateContextTokens(msgs, tok);
    const hardCap = Math.floor(current / 2);
    const config = makeConfig({ modelContextLimit: 1_000_000, hardCap, recencyGuardTurns: 10 });
    const res = runHardCap(msgs, 6, config, state, "/ws", tok, 0);
    expect(res.fired).toBe(true);
    expect(state.maskDecisions.size).toBeGreaterThan(0); // Phase 1 masked something
    expect(state.stats.totalHardCapPasses).toBe(1);
  });

  it("drops the oldest whole messages when there is nothing maskable", () => {
    const state = createInitialState("t");
    // 16 text-only messages (no tool outputs → Phase 1 can't help).
    const msgs: NeutralMessage[] = [];
    for (let i = 0; i < 16; i++) {
      msgs.push(
        i % 2 === 0
          ? makeUserMessage(makeLargeOutput(4000))
          : makeAssistantMessage(makeLargeOutput(4000))
      );
    }
    const current = estimateContextTokens(msgs, tok);
    const hardCap = Math.floor(current / 2);
    const config = makeConfig({ modelContextLimit: 1_000_000, hardCap, recencyGuardTurns: 2 });
    const lastId = msgs[msgs.length - 1].id;
    const res = runHardCap(msgs, 50, config, state, "/ws", tok, 0);
    expect(res.fired).toBe(true);
    expect(res.droppedCount).toBeGreaterThan(0);
    expect(state.hardCapDroppedIds.size).toBe(res.droppedCount);
    // estimateContextTokens excludes isIgnored → reflects the post-drop context.
    expect(estimateContextTokens(res.messages, tok)).toBeLessThanOrEqual(hardCap);
    // the most-recent message is preserved.
    expect(state.hardCapDroppedIds.has(lastId)).toBe(false);
  });

  it("re-applies hard-cap drops under re-feed via applyDecisions", () => {
    const state = createInitialState("t");
    const msgs: NeutralMessage[] = [];
    for (let i = 0; i < 16; i++) {
      msgs.push(
        i % 2 === 0
          ? makeUserMessage(makeLargeOutput(4000))
          : makeAssistantMessage(makeLargeOutput(4000))
      );
    }
    const current = estimateContextTokens(msgs, tok);
    const config = makeConfig({
      modelContextLimit: 1_000_000,
      hardCap: Math.floor(current / 2),
      recencyGuardTurns: 2,
    });
    runHardCap(msgs, 50, config, state, "/ws", tok, 0);
    const droppedIds = [...state.hardCapDroppedIds];
    expect(droppedIds.length).toBeGreaterThan(0);

    // Simulate the host re-feeding the ORIGINAL (un-dropped) messages next turn.
    const reapplied = applyDecisions(msgs, state);
    for (const id of droppedIds) {
      expect(reapplied.find(m => m.id === id)?.isIgnored).toBe(true);
    }
  });

  it("hardCap default + per-provider/model override via resolveConfig", () => {
    expect(resolveConfig("s").hardCap).toBe("92%");
    // model layer (5th arg)
    expect(
      resolveConfig("s", undefined, undefined, undefined, { hardCap: "50%" }).hardCap
    ).toBe("50%");
    // provider layer (4th arg)
    expect(resolveConfig("s", undefined, undefined, { hardCap: 64000 }).hardCap).toBe(64000);
  });
});

// ── Nudge-escalation mechanical masking (pipeline-level) ──────────────────────
// If the model has ignored ESCALATION_STREAK_THRESHOLD consecutive "upper"/
// "safety-cap" nudges (state.nudgeEscalation, set by the PREVIOUS turn's
// runPipeline call), this turn forces an extra observation-mask pass with a
// tightened recency guard (min(recencyGuardTurns, 2)) BEFORE the hard cap —
// recovering headroom mechanically without waiting for the token ceiling, since
// there is no host hook that lets the adapter invoke the model directly.

describe("nudge escalation forces mechanical masking before hard cap", () => {
  beforeEach(() => resetCounters());
  const tok = new CharTokenizer();

  // Two sizeable `read` outputs at turns 7 and 8, with currentTurn=10: ages 3
  // and 2. Under the default recencyGuardTurns=10 both are well within the
  // guard (protected, not masked by the normal cascade). Under the escalation's
  // tightened guard (min(10,2)=2) they become eligible: age 3 >= 2 and age 2
  // is NOT < 2, so both clear the tightened guard.
  function buildMessages(): NeutralMessage[] {
    return [
      makeToolMessage("read", { path: "/a" }, makeLargeOutput(3000), 7),
      makeToolMessage("read", { path: "/b" }, makeLargeOutput(3000), 8),
      makeUserMessage("continue please"),
    ];
  }

  it("forces extra masking when the ignored streak is at the threshold", () => {
    const state = createInitialState("t");
    state.currentTurn = 10;
    state.nudgeEscalation = { ignoredStreak: ESCALATION_STREAK_THRESHOLD, compressRunsAtLastCheck: 0 };
    const config = makeConfig({ recencyGuardTurns: 10 });

    const result = runPipeline(
      { messages: buildMessages(), state, config, nowMs: 0 },
      { tokenizer: tok, workspaceDir: "/ws" }
    );

    expect(result.savedThisRun).toBeGreaterThan(0);
    const maskedEntries = [...state.messageIndex.values()].filter(e => e.masked || e.offloaded);
    expect(maskedEntries.length).toBeGreaterThan(0);
    expect(state.stats.totalMaskingPasses).toBeGreaterThan(0);
    // Context here is tiny relative to modelContextLimit; hard cap must not fire —
    // the savings are attributable specifically to the escalation stage.
    expect(state.stats.totalHardCapPasses).toBe(0);
  });

  it("a guarded model attempt suppresses mechanical escalation and resets the streak", () => {
    const state = createInitialState("t");
    state.currentTurn = 10;
    state.nudgeEscalation = { ignoredStreak: ESCALATION_STREAK_THRESHOLD, compressRunsAtLastCheck: 0,
      attempts: 1, attemptsAtLastCheck: 0, lastAttempt: { turn: 10, outcome: "rejected", codes: ["recent-range"] } };
    const result = runPipeline({ messages: buildMessages(), state, config: makeConfig({ recencyGuardTurns: 10 }), nowMs: 0 },
      { tokenizer: tok, workspaceDir: "/ws" });
    expect(result.savedThisRun).toBe(0);
    expect(state.nudgeEscalation.ignoredStreak).toBe(0);
    expect(state.nudgeEscalation.attemptsAtLastCheck).toBe(1);
  });

  it("control: does NOT force extra masking when the streak is below the threshold", () => {
    const state = createInitialState("t");
    state.currentTurn = 10;
    state.nudgeEscalation = { ignoredStreak: ESCALATION_STREAK_THRESHOLD - 1, compressRunsAtLastCheck: 0 };
    const config = makeConfig({ recencyGuardTurns: 10 });

    const result = runPipeline(
      { messages: buildMessages(), state, config, nowMs: 0 },
      { tokenizer: tok, workspaceDir: "/ws" }
    );

    expect(result.savedThisRun).toBe(0);
    const maskedEntries = [...state.messageIndex.values()].filter(e => e.masked || e.offloaded);
    expect(maskedEntries.length).toBe(0);
  });
});
