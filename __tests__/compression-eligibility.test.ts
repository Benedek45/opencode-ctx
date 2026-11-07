import { describe, expect, it } from "bun:test";
import type { NeutralMessage, ToolPart } from "../types/neutral.js";
import type { BlockMetadata } from "../types/state.js";
import { cloneCoreState, createInitialState } from "../types/state.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { planCompressionCandidates } from "../core/compress/eligibility.js";
import { compressionRequestAges, planCompressionBatch } from "../core/compress/transaction.js";
import type { Tokenizer } from "../services/tokenizer.js";

const tokenizer: Tokenizer = { countTokens: text => text.length };
function message(id: string, role: NeutralMessage["role"] = "assistant", text = "Evidence. ".repeat(40)): NeutralMessage {
  return { id, ref: id, role, sessionId: "s", createdAt: 0, parts: [{ type: "text", text }] };
}
function tool(id: string, overrides: Partial<ToolPart> = {}): NeutralMessage {
  return { ...message(id), parts: [{ type: "tool", callId: `call-${id}`, tool: "read",
    status: "completed", input: "file", output: "Evidence. ".repeat(40), ...overrides }] };
}
function setup(guard = 5) {
  const state = createInitialState("s");
  state.currentTurn = 8;
  const config = buildDefaultConfig("s");
  config.compressionRecencyRequests = guard;
  const messages = Array.from({ length: 8 }, (_, i) => i + 1).flatMap(i => [message(`u${i}`, "user"), message(`a${i}`)]);
  return { state, config, messages, tokenizer };
}
function verify(input: ReturnType<typeof setup>) {
  const report = planCompressionCandidates(input.messages, input.state, input.config, tokenizer);
  const result = planCompressionBatch({ ...input, requests: report.candidates.map(candidate => ({
    mode: "range", topic: "Evidence", summary: "S", startRef: candidate.startRef, endRef: candidate.endRef,
  })) });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.plans.map(plan => plan.directMessageIds)).toEqual(report.candidates.map(candidate => candidate.messageIds));
  return report;
}
function addBlock(input: ReturnType<typeof setup>): NeutralMessage {
  const block: BlockMetadata = {
    blockId: "b1", runId: "r1", mode: "range", topic: "Old evidence", startRef: "old1", endRef: "old2",
    anchorMessageId: "raw-old", active: true, deactivatedByUser: false, includedBlockIds: [], consumedBlockIds: [],
    parentBlockIds: [], directMessageIds: ["raw-old"], effectiveMessageIds: ["raw-old"], directToolCallIds: [],
    effectiveToolCallIds: [], sourceTokens: 10000, summaryTokens: 100, netTokens: 9900,
    summaryText: "Historical evidence. ".repeat(10), durableSourceRef: "source", durableSummaryRef: "summary",
    createdAt: 0, updatedAt: 0, updatedAtTurn: 1, sourceMessageIds: ["raw-old"], createdAtTurn: 1,
    tokens: 100, consumed: false,
  };
  input.state.blockRegistry.set("b1", block);
  input.state.activeByAnchorMessageId.set(block.anchorMessageId, block.blockId);
  return { ...message("__summary_b1"), ref: "b1", isSummary: true,
    parts: [{ type: "summary-block", blockId: "b1", text: block.summaryText }] };
}

describe("pure compression candidate eligibility", () => {
  it("suggests the old prefix through the exact guard boundary, with matching preflight", () => {
    const input = setup();
    const report = verify(input);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0].messageIds).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "u4"]);
    expect(report.candidates[0].startRef).toBe("u1");
    expect(report.candidates[0].endRef).toBe("u4");
    expect(report.eligibleTokens).toBe(7 * 400);
    expect(report.protectedTokens).toBe(9 * 400);
    expect(report.requestsUntilEligible).toBe(1);
  });

  it("does not re-age a selection or tick the request clock for synthetic records", () => {
    const input = setup();
    const before = verify(input).candidates;
    for (let i = 0; i < 100; i++) input.messages.push(tool(`__loop${i}`),
      { ...message(`summary${i}`, "user"), isSummary: true },
      { ...message(`manual${i}`, "user"), isManualReplacement: true },
      message(`__summary_${i}`, "user"), message(`__manual_${i}`, "user"), message(`__ctx_import_${i}`, "user"));
    expect(verify(input).candidates).toEqual(before);
    expect(input.state.currentTurn).toBe(8);
  });

  it("ignores known raw turns and explicit tool turns when calculating request ages", () => {
    const input = setup(2);
    input.state.currentTurn = 100;
    input.state.turnBasis = { latestUserId: "current", messageTurns: [["old", 20], ["tool", 20], ["old2", 20], ["current", 100]] };
    input.messages = [message("old"), tool("tool", { turn: 99 }), message("old2"), message("current", "user")];
    const report = verify(input);
    expect(report.candidates.map(candidate => candidate.messageIds)).toEqual([["old"]]);
    expect(report.requestsUntilEligible).toBe(1);
    input.messages[1] = tool("tool", { turn: 95 });
    expect(verify(input).candidates[0].messageIds).toEqual(["old"]);
  });

  it("ages huge current-turn histories by model requests", () => {
    const input = setup();
    input.messages = [message("current", "user"), ...Array.from({ length: 2000 }, (_, i) => tool(`tool${i}`, { turn: 8 }))];
    const report = verify(input);
    expect(report.candidates).toHaveLength(1);
    expect(report.eligibleTokens).toBeGreaterThan(100000);
    expect(report.protectedTokens).toBe(5 * 404);
    expect(report.requestsUntilEligible).toBe(1);
  });

  it("keeps zero recency disabled just like transactional preflight", () => {
    const input = setup(0);
    expect(verify(input).candidates[0].messageIds).toEqual(input.messages.map(m => m.id));
  });

  it("splits at instructions, ref-less/manual/ignored parts, and unsafe tool lifecycles", () => {
    const input = setup(0);
    input.messages = [message("old"), message("system", "system"), message("old2"),
      { ...message("no-ref"), ref: undefined }, message("old3"),
      { ...message("manual"), isManualReplacement: true }, message("old4"),
      tool("pending", { status: "pending" }), message("old5"), tool("running", { status: "running" }),
      message("old6"), tool("compress", { tool: "compress" }), message("old7"),
      { ...message("ignored"), isIgnored: true }, message("old8")];
    const report = verify(input);
    expect(report.candidates.map(c => c.messageIds)).toEqual([["old"], ["old2"], ["old3"]]);
    expect(report.eligibleTokens).toBe(8 * 400);
    expect(report.candidates).toHaveLength(3);
  });

  it("rejects ambiguous/stale boundary refs, covered originals and duplicated calls", () => {
    const input = setup(0);
    input.state.compressionIndex.set("covered", { messageId: "covered", replacedByBlockId: "b1", masked: false, offloaded: false });
    input.messages = [message("old"), { ...message("alias"), ref: "old" }, message("covered"),
      tool("dup1", { callId: "same" }), tool("dup2", { callId: "same", status: "running" }), message("after")];
    expect(verify(input).candidates.map(c => c.messageIds)).toEqual([["old"], ["after"]]);
    input.messages = [{ ...message("missing"), ref: undefined }];
    input.state.messageIds.byRef.set("m0001", "missing");
    expect(verify(input).candidates).toEqual([]);
  });

  it("resolves durable active summary roots using b refs, but never suggests summary-only no-op ranges", () => {
    const input = setup(0);
    const summary = addBlock(input);
    input.messages = [summary];
    const report = verify(input);
    // The validator preserves included summaries verbatim: a summary alone
    // cannot shrink the visible projection, regardless of hidden source size.
    expect(report.candidates).toEqual([]);
    expect(report.reason).toBe("insufficient-estimate");
    expect(report.eligibleTokens).toBe(210); // Never count the hidden 10k-token originals as visible.
    input.messages.push(message("next"));
    expect(verify(input).candidates[0].messageIds).toEqual([summary.id, "next"]);
  });

  it("blocks missing archives, consumed/inactive/non-root summaries and cold catalog records", () => {
    for (const overrides of [{ durableSourceRef: undefined }, { durableSummaryRef: undefined },
      { consumed: true }, { active: false }, { parentBlockIds: ["b2"] }, { deactivatedByUser: true }]) {
      const input = setup(0);
      const summary = addBlock(input);
      Object.assign(input.state.blockRegistry.get("b1")!, overrides);
      input.messages = [summary, message("after")];
      expect(verify(input).candidates[0].messageIds).toEqual(["after"]);
    }
    const input = setup(0);
    input.messages = [{ ...message("__summary___ctx_cold_catalog"), isSummary: true, ref: "__ctx_cold_catalog",
      parts: [{ type: "summary-block", blockId: "__ctx_cold_catalog", text: "b1: historical evidence" }] }, message("after")];
    expect(verify(input).candidates[0].messageIds).toEqual(["after"]);
  });

  it("excludes covered originals even with a stale index and overlapping graph roots", () => {
    const input = setup(0);
    const summary = addBlock(input);
    input.messages = [message("before"), summary, message("raw-old"), message("after")];
    expect(verify(input).candidates.map(c => c.messageIds)).toEqual([["before", summary.id], ["after"]]);
    const first = input.state.blockRegistry.get("b1")!;
    input.state.blockRegistry.set("b2", { ...first, blockId: "b2", anchorMessageId: "other" });
    input.state.activeByAnchorMessageId.set("other", "b2");
    expect(verify(input).candidates.map(c => c.messageIds)).toEqual([["before"], ["after"]]);
  });

  it("uses real requests after import and never the imported turn", () => {
    const input = setup();
    input.state.importedContext = { version: 1, seedRef: "seed", bundleDigest: "digest", importedAtTurn: 8 };
    input.messages = [message("__ctx_import_old", "user"), message("u8", "user")];
    expect(verify(input).candidates).toEqual([]);
    input.state.currentTurn = 13;
    expect(verify(input).candidates).toEqual([]);
    input.messages.push(...Array.from({ length: 5 }, (_, i) => message(`request${i}`)));
    expect(verify(input).candidates[0].messageIds).toEqual(["__ctx_import_old", "u8"]);
  });

  it("accounts for verbatim protected facts and savings minimum without promising savings", () => {
    const input = setup(0);
    input.config.summarization.preserveUserMessages = true;
    input.messages = [message("only-user", "user")];
    expect(verify(input).reason).toBe("insufficient-estimate");
    expect(verify(input).eligibleTokens).toBe(400);
    input.messages.push(message("answer"));
    expect(verify(input).candidates).toHaveLength(1);
    input.config.summarization.minNetSavingsTokens = 400;
    expect(verify(input).candidates).toEqual([]);
    input.config.summarization.minNetSavingsTokens = 0;
    input.config.summarization.protectedToolGlobs = ["read"];
    input.messages = [tool("protected")];
    expect(verify(input).reason).toBe("insufficient-estimate");
    input.messages = [message("tag", "assistant", "<protect>fact</protect>"), message("outside", "assistant", "x".repeat(200))];
    expect(verify(input).candidates).toHaveLength(1);
  });

  it("returns owned output and leaves frozen input/config and state unchanged", () => {
    const input = setup();
    const before = cloneCoreState(input.state);
    const copy = structuredClone(input.messages);
    for (const m of input.messages) { m.parts.forEach(Object.freeze); Object.freeze(m.parts); Object.freeze(m); }
    Object.freeze(input.messages);
    Object.freeze(input.config.summarization);
    Object.freeze(input.config);
    const report = verify(input);
    report.candidates[0].messageIds.push("mutation");
    expect(input.messages).toEqual(copy);
    expect(input.state).toEqual(before);
    expect(compressionRequestAges(input.messages).get("a3")).toBe(5);
  });

  it("reports empty and disabled contexts without candidates", () => {
    const input = setup();
    input.messages = [];
    expect(verify(input).reason).toBe("noeligible");
    input.messages = setup().messages;
    input.config.automation.modelCompression = false;
    expect(verify(input).reason).toBe("compression-disabled");
    expect(verify(input).eligibleTokens).toBe(0);
  });
});
