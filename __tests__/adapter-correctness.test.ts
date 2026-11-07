// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeOffloadRequests, restoreFailedOffloadOutputs } from "../adapters/opencode/offload-writer.js";
import { applyManualOverrides } from "../core/manualOverrides.js";
import { runHardCap } from "../core/strategies/hardCap.js";
import { buildOffloadPath } from "../core/paths.js";
import { resolveConfig } from "../core/config.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { NoopLogger } from "../services/logger.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import { runPipeline } from "../core/pipeline.js";
import { createInitialState } from "../types/state.js";
import type { NeutralMessage } from "../types/neutral.js";

describe("adapter correctness boundaries", () => {
  it("sanitizes host IDs used in offload paths", () => {
    const path = buildOffloadPath("/workspace", "../../session", "../call/../../secret");
    expect(path).toBe("/workspace/.ctx-offload/.._.._session/.._call_.._.._secret.txt");
    expect(path.includes("/../")).toBe(false);
    expect(buildOffloadPath("/workspace", "..", ".")).toBe("/workspace/.ctx-offload/__/_.txt");
  });

  it("rolls back a failed offload and restores the exact inline output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-offload-failure-"));
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "file", "utf8");
    const state = createInitialState("offload-failure");
    state.maskDecisions.set("call-1", "pointer");
    state.messageIndex.set("call-1", { messageId: "m1", masked: false, offloaded: true });
    state.stats.totalTokensOffloaded = 250;
    state.stats.totalTokensSaved = 250;

    const raw: NeutralMessage[] = [{
      id: "m1",
      role: "assistant",
      sessionId: state.sessionId,
      createdAt: 1,
      parts: [{ type: "tool", callId: "call-1", tool: "read", status: "completed", input: {}, output: "ORIGINAL" }],
    }];
    const projected: NeutralMessage[] = [{
      ...raw[0],
      parts: [{ type: "tool", callId: "call-1", tool: "read", status: "completed", input: {}, output: "pointer" }],
    }];
    const failed = await materializeOffloadRequests([{
      callId: "call-1",
      path: join(blocker, "output.txt"),
      content: "ORIGINAL",
      tokens: 250,
    }], state, new NoopLogger());
    const restored = restoreFailedOffloadOutputs(projected, raw, failed);

    expect(failed.has("call-1")).toBe(true);
    expect(state.maskDecisions.has("call-1")).toBe(false);
    expect(state.messageIndex.has("call-1")).toBe(false);
    expect(state.stats.totalTokensOffloaded).toBe(0);
    expect((restored[0].parts[0] as { output?: string }).output).toBe("ORIGINAL");
  });

  it("manual keep restores an exact raw message after automatic masking", () => {
    const state = createInitialState("manual-keep");
    state.manualOverrides.set("m1", { mode: "keep" });
    const original: NeutralMessage = {
      id: "m1",
      role: "assistant",
      sessionId: state.sessionId,
      createdAt: 1,
      parts: [{ type: "tool", callId: "call-1", tool: "read", status: "completed", input: {}, output: "EXACT RAW" }],
    };
    const masked: NeutralMessage = {
      ...original,
      isIgnored: true,
      parts: [{ type: "tool", callId: "call-1", tool: "read", status: "completed", input: {}, output: "[masked]" }],
    };
    const result = applyManualOverrides([masked], state, [original]);
    expect(result[0].isIgnored).toBe(false);
    expect((result[0].parts[0] as { output?: string }).output).toBe("EXACT RAW");
  });

  it("reports when protected/recent content makes the hard cap impossible", () => {
    const state = createInitialState("hard-cap-impossible");
    const config = resolveConfig(state.sessionId, {
      hardCap: 10,
      modelContextLimit: 100,
      recencyGuardTurns: 10,
    });
    const messages: NeutralMessage[] = [{
      id: "recent-user",
      role: "user",
      sessionId: state.sessionId,
      createdAt: 1,
      parts: [{ type: "text", text: "x".repeat(1000) }],
    }];
    const result = runHardCap(messages, 1, config, state, "/tmp", new CharTokenizer());
    expect(result.underCap).toBe(false);
    expect(result.remainingTokens).toBeGreaterThan(10);
    expect(result.droppedCount).toBe(0);
  });

  it("protects recent user turns even when each turn contains several assistant messages", () => {
    const state = createInitialState("hard-cap-user-turns");
    const config = resolveConfig(state.sessionId, {
      hardCap: 300,
      modelContextLimit: 10_000,
      recencyGuardTurns: 4,
    });
    const messages: NeutralMessage[] = [];
    for (let turn = 1; turn <= 8; turn++) {
      messages.push({ id: `u${turn}`, role: "user", sessionId: state.sessionId, createdAt: turn * 10, parts: [{ type: "text", text: `user ${turn} ${"x".repeat(120)}` }] });
      for (let step = 1; step <= 3; step++) {
        messages.push({ id: `a${turn}-${step}`, role: "assistant", sessionId: state.sessionId, createdAt: turn * 10 + step, parts: [{ type: "text", text: `assistant ${"y".repeat(120)}` }] });
      }
    }
    runHardCap(messages, 8, config, state, "/tmp", new CharTokenizer());
    for (const recentUser of ["u5", "u6", "u7", "u8"]) {
      expect(state.hardCapDroppedIds.has(recentUser)).toBe(false);
    }
  });

  it("keeps sanitized state-file collisions isolated and private", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-state-keys-"));
    const persistence = new FilePersistence(dir);
    const first = createInitialState("a/b");
    const second = createInitialState("a?b");
    first.currentTurn = 11;
    second.currentTurn = 22;
    await persistence.save(first.sessionId, first);
    await persistence.save(second.sessionId, second);
    expect((await persistence.load(first.sessionId))?.currentTurn).toBe(11);
    expect((await persistence.load(second.sessionId))?.currentTurn).toBe(22);
  });

  it("re-applies the provider cap after a manual keep restores large content", () => {
    const state = createInitialState("manual-provider-cap");
    state.currentTurn = 7;
    state.manualOverrides.set("old-tool", { mode: "keep" });
    const config = resolveConfig(state.sessionId, {
      modelContextLimit: 500,
      hardCap: 350,
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      costRoi: { enabled: false },
      nudges: { maskTriggerThreshold: 0 },
    });
    const messages: NeutralMessage[] = [{
      id: "old-tool", role: "assistant", sessionId: state.sessionId, createdAt: 1,
      parts: [{ type: "tool", callId: "large-read", tool: "read", status: "completed", input: {}, output: "x".repeat(10_000), turn: 1 }],
    }];
    for (let turn = 2; turn <= 7; turn++) {
      messages.push({ id: `u${turn}`, role: "user", sessionId: state.sessionId, createdAt: turn, parts: [{ type: "text", text: `turn ${turn}` }] });
    }
    const result = runPipeline(
      { messages, state, config, nowMs: 10 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/tmp" }
    );
    expect(result.estimatedTokens).toBeLessThanOrEqual(500);
  });

  it("advances the pipeline generation on every projected transform", () => {
    const state = createInitialState("pipeline-generation");
    const config = resolveConfig(state.sessionId, {
      modelContextLimit: 10_000,
      nudges: { maskTriggerThreshold: 10_000 },
    });
    const messages: NeutralMessage[] = [{
      id: "u1",
      role: "user",
      sessionId: state.sessionId,
      createdAt: 1,
      parts: [{ type: "text", text: "hello" }],
    }];
    runPipeline(
      { messages, state, config, nowMs: 1 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/tmp" }
    );
    runPipeline(
      { messages, state, config, nowMs: 2 },
      { tokenizer: new CharTokenizer(), workspaceDir: "/tmp" }
    );
    expect(state.stats.totalTurns).toBe(2);
  });
});
