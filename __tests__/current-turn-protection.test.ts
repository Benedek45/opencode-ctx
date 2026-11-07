import { beforeEach, describe, expect, it } from "bun:test";
import { buildDefaultConfig } from "../core/defaults.js";
import { applyDecisions } from "../core/applyDecisions.js";
import { runPipeline } from "../core/pipeline.js";
import { buildOffloadPath, referencesOffloadPath } from "../core/paths.js";
import { PLACEHOLDER_PLAIN_MASK } from "../core/placeholders.js";
import { runDedup } from "../core/strategies/dedup.js";
import { isWithinRecencyGuard, isWithinTieredRetention } from "../core/strategies/guards.js";
import { runHardCap } from "../core/strategies/hardCap.js";
import { runNearDupe } from "../core/strategies/nearDupe.js";
import { runObservationMask } from "../core/strategies/observationMask.js";
import { runStaleError } from "../core/strategies/staleError.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { createInitialState } from "../types/state.js";
import type { NeutralMessage, ToolPart } from "../types/neutral.js";
import { makeErrorToolMessage, makeLargeOutput, makeToolMessage, makeUserMessage, resetCounters } from "./fixtures/messages.js";

const tokenizer = new CharTokenizer();
const workspaceDir = "/workspace";
const output = makeLargeOutput(6000);
const part = (message: NeutralMessage): ToolPart => message.parts.find(p => p.type === "tool") as ToolPart;

function zeroRetentionConfig() {
  const config = buildDefaultConfig("test");
  config.recencyGuardTurns = 0;
  config.toolClasses = Object.fromEntries(Object.entries(config.toolClasses).map(([tool, cls]) => [tool, { ...cls, retentionTurns: 0 }]));
  config.costRoi = { enabled: false };
  config.minRepruneInterval = 0;
  config.clearAtLeast = 0;
  config.nudges.maskTriggerThreshold = 0;
  return config;
}

beforeEach(resetCounters);

describe("current user turn is a mechanical pruning safety floor", () => {
  it("protects classified and unclassified tools at zero retention, but not the next turn", () => {
    const config = zeroRetentionConfig();
    for (const tool of ["read", "grep", "Read", "functions.read", "unknown"]) {
      const current = part(makeToolMessage(tool, {}, output, 10));
      expect(isWithinRecencyGuard(current, 10, config)).toBe(true);
      expect(isWithinTieredRetention(current, 10, config)).toBe(true);
      expect(isWithinRecencyGuard(current, 11, config)).toBe(false);
      expect(isWithinTieredRetention(current, 11, config)).toBe(false);
    }
  });

  it("does not exact-dedup, near-dedup, or stale-error prune within the current turn", () => {
    const config = zeroRetentionConfig();
    const state = createInitialState("test");
    const similarOutput = "the quick brown fox jumps over the lazy dog ".repeat(30);
    const messages = [
      makeToolMessage("read", { filePath: "/a" }, similarOutput, 10),
      makeToolMessage("read", { filePath: "/a" }, similarOutput, 10),
    ];
    expect(runDedup(messages, 10, config, state).dedupCount).toBe(0);
    expect(runNearDupe(messages, 10, config, state).nearDupeCount).toBe(0);
    const error = makeErrorToolMessage("grep", { pattern: "needle" }, "failed", 10);
    expect(runStaleError([error], 10, config, state).purgedCount).toBe(0);
    expect(state.dedupDecisions.size + state.nearDupeDecisions.size + state.staleErrorDecisions.size).toBe(0);
    // The floor is not permanent protection; each strategy still works once old.
    expect(runNearDupe(messages, 11, config, state).nearDupeCount).toBe(1);
    expect(runDedup(messages, 11, config, state).dedupCount).toBe(1);
    expect(runStaleError([error], 13, config, state).purgedCount).toBe(1);
  });

  for (const stage of ["cascade", "escalation", "policy-cap", "provider-cap"] as const) {
    for (const profile of ["documents", "code"] as const) {
      it(`keeps newly completed Read/Grep output and same-turn re-feeds intact under ${stage}, ${profile}`, () => {
        const config = zeroRetentionConfig();
        config.profile = profile;
        config.nudges.maskTriggerThreshold = stage === "cascade" ? 0 : 1_000_000;
        if (stage === "policy-cap") config.hardCap = 100;
        if (stage === "provider-cap") {
          config.hardCap = 1_000_000; // Isolate the second, provider-limit pass.
          config.modelContextLimit = 100;
        }
        const state = createInitialState("test");
        state.currentTurn = 10;
        if (stage === "escalation") state.nudgeEscalation = { ignoredStreak: 3, compressRunsAtLastCheck: 0 };
        const messages = [
          makeUserMessage("inspect the files"),
          makeToolMessage("read", { filePath: "/a" }, output, 10),
          makeToolMessage("grep", { pattern: "needle" }, output, 10),
        ];
        part(messages[1]).status = "running";
        delete part(messages[1]).output;
        runPipeline({ messages, state, config, nowMs: 1 }, { tokenizer, workspaceDir });
        part(messages[1]).status = "completed";
        part(messages[1]).output = output;
        const raw = structuredClone(messages);
        for (let refeed = 0; refeed < 2; refeed++) {
          const result = runPipeline({ messages, state, config, nowMs: 2 + refeed }, { tokenizer, workspaceDir });
          for (const source of messages.slice(1)) {
            expect(part(result.messages.find(m => m.id === source.id)!)).toEqual(part(source));
          }
          expect(result.offloadRequests).toHaveLength(0);
          expect(result.savedThisRun).toBe(0);
          expect(state.maskDecisions.size).toBe(0);
          expect(state.hardCapDroppedIds.size).toBe(0);
          expect(state.hasRecordedCacheBust).toBe(false);
          expect(messages).toEqual(raw);
          if (stage === "provider-cap") expect(result.estimatedTokens).toBeGreaterThan(config.modelContextLimit);
        }
      });
    }
  }

  it("whole-message drops respect current tool turns even in a tool-only feed", () => {
    const config = zeroRetentionConfig();
    config.hardCap = 10;
    const state = createInitialState("test");
    const messages = Array.from({ length: 8 }, (_, index) => makeToolMessage("read", { path: `/${index}` }, output, 10));
    const result = runHardCap(messages, 10, config, state, workspaceDir, tokenizer);
    expect(result.droppedCount).toBe(0);
    expect(result.offloadRequests).toHaveLength(0);
    expect(result.underCap).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("the provider emergency backstop can still reclaim old whole messages", () => {
    const config = zeroRetentionConfig();
    config.nudges.maskTriggerThreshold = 1_000_000;
    config.hardCap = 1_000_000;
    config.modelContextLimit = 1000;
    const state = createInitialState("test");
    state.currentTurn = 6;
    const old = makeUserMessage(output);
    const current = makeToolMessage("read", { path: "/current" }, "needed result", 6);
    const messages = [old, ...Array.from({ length: 5 }, () => makeUserMessage("continue")), current];
    const result = runPipeline({ messages, state, config, nowMs: 1 }, { tokenizer, workspaceDir });
    expect(state.hardCapDroppedIds.has(old.id)).toBe(true);
    expect(result.messages.some(m => m.id === old.id)).toBe(false);
    expect(part(result.messages.find(m => m.id === current.id)!)).toEqual(part(current));
    expect(result.estimatedTokens).toBeLessThan(config.modelContextLimit);
  });

  it("does not resurrect persisted decisions when retention changes", () => {
    const config = zeroRetentionConfig();
    config.profile = "code";
    const state = createInitialState("test");
    state.currentTurn = 10;
    const old = makeToolMessage("read", { filePath: "/old" }, output, 9);
    const first = runPipeline({ messages: [old], state, config, nowMs: 1 }, { tokenizer, workspaceDir });
    expect(part(first.messages[0]).output).toBe(PLACEHOLDER_PLAIN_MASK);
    config.toolClasses.read.retentionTurns = 100;
    const current = makeToolMessage("read", { filePath: "/current" }, output, 10);
    const second = runPipeline({ messages: [old, current], state, config, nowMs: 2 }, { tokenizer, workspaceDir });
    expect(part(second.messages[0]).output).toBe(part(first.messages[0]).output);
    expect(part(second.messages[1]).output).toBe(output);
    expect(second.savedThisRun).toBe(0);
    expect(state.maskDecisions.get(part(old).callId)).toBe(PLACEHOLDER_PLAIN_MASK);
    expect(part(old).output).toBe(output);
  });
});

describe("offload rereads never create recursive offload files", () => {
  for (const input of [
    { filePath: "/workspace/.ctx-offload/test/source.txt" },
    { file_path: "./.ctx-offload/test/source.txt", offset: 10, limit: 20 },
    { path: "/workspace/subdir/../.ctx-offload/another-session/source.txt" },
    { filePath: "\\workspace\\.ctx-offload\\test\\source.txt" },
  ]) {
    it(`keeps fresh output then masks without reoffloading ${JSON.stringify(input)}`, () => {
      const config = zeroRetentionConfig();
      const state = createInitialState("test");
      const source = makeToolMessage("read", { filePath: "/source" }, output, 1, { callIdOverride: "source" });
      const offloaded = runObservationMask([source], 10, config, state, workspaceDir, tokenizer);
      expect(offloaded.offloadRequests).toHaveLength(1);
      expect(offloaded.offloadRequests[0].path).toBe(buildOffloadPath(workspaceDir, "test", part(source).callId));
      const reread = makeToolMessage("read", input, output, 10);
      const fresh = runObservationMask([reread], 10, config, state, workspaceDir, tokenizer);
      expect(fresh.offloadRequests).toHaveLength(0);
      expect(part(fresh.messages[0]).output).toBe(output);
      const aged = runObservationMask([reread], 11, config, state, workspaceDir, tokenizer);
      expect(aged.offloadRequests).toHaveLength(0);
      expect(aged.offloadedCount).toBe(0);
      expect(aged.maskedCount).toBe(1);
      expect(part(aged.messages[0]).output).toBe(PLACEHOLDER_PLAIN_MASK);
      expect(part(applyDecisions([reread], state)[0]).output).toBe(PLACEHOLDER_PLAIN_MASK);
      expect(part(reread).output).toBe(output);
    });
  }

  it("does not mistake other workspaces, path-prefix lookalikes, or path text for an offload read", () => {
    for (const filePath of [
      "/elsewhere/.ctx-offload/test/source.txt",
      "/workspace/.ctx-offload-backup/test/source.txt",
      "/workspace/.ctx-offload/../source.txt",
    ]) {
      expect(referencesOffloadPath({ filePath }, workspaceDir)).toBe(false);
      const config = zeroRetentionConfig();
      const result = runObservationMask([makeToolMessage("read", { filePath }, output, 1)], 10, config, createInitialState("test"), workspaceDir, tokenizer);
      expect(result.offloadRequests).toHaveLength(1);
    }
    expect(referencesOffloadPath({ pattern: "/workspace/.ctx-offload/test/source.txt" }, workspaceDir)).toBe(false);
    expect(referencesOffloadPath({ filePath: "C:\\work\\.ctx-offload\\test\\source.txt" }, "C:\\work")).toBe(true);
  });
});
