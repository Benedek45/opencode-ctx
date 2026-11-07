import { describe, expect, it } from "bun:test";
import type { NeutralMessage, ToolPart } from "../types/neutral.js";
import { cloneCoreState, createInitialState } from "../types/state.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { applyDecisions } from "../core/applyDecisions.js";
import { runStateGc } from "../core/stateGc.js";
import {
  applyCompressionBatch,
  planCompressionBatch,
  type CompressionRequest,
} from "../core/compress/transaction.js";
import {
  activateCompressionBlock,
  deactivateCompressionBlock,
  recompressCompressionBlock,
} from "../core/compress/reversible.js";
import type { Tokenizer } from "../services/tokenizer.js";

function textMessage(id: string, role: "user" | "assistant", text: string): NeutralMessage {
  return { id, ref: id, role, sessionId: "s", createdAt: 1, parts: [{ type: "text", text }] };
}

function toolMessage(id: string, tool: string, input: unknown, output: string): NeutralMessage {
  const part: ToolPart = { type: "tool", callId: `c-${id}`, tool, status: "completed", input, output, turn: 1 };
  return { id, ref: id, role: "assistant", sessionId: "s", createdAt: 1, parts: [part] };
}

const lengthTokenizer: Tokenizer = { countTokens: text => text.length };

function config() {
  const value = buildDefaultConfig("s");
  value.recencyGuardTurns = 0;
  value.compressionRecencyRequests = 0;
  value.summarization.preserveUserMessages = false;
  return value;
}

function request(overrides: Partial<CompressionRequest> = {}): CompressionRequest {
  return {
    mode: "range",
    topic: "topic",
    content: "source content",
    summary: "S",
    startRef: "m1",
    endRef: "m2",
    ...overrides,
  };
}

describe("compression recency uses the whole conversation", () => {
  function history(): NeutralMessage[] {
    return Array.from({ length: 8 }, (_, index) => index + 1).flatMap(turn => [
      textMessage(`u${turn}`, "user", `Question ${turn}. `.repeat(10)),
      textMessage(`a${turn}`, "assistant", `Answer ${turn}. `.repeat(10)),
    ]);
  }

  function setup() {
    const state = createInitialState("s");
    state.currentTurn = 8;
    const cfg = config();
    cfg.compressionRecencyRequests = 5;
    return { state, config: cfg, messages: history(), tokenizer: lengthTokenizer };
  }

  it("compresses an old non-tail range without changing or compressing the recent tail", () => {
    const input = setup();
    const before = cloneCoreState(input.state);
    const result = applyCompressionBatch({
      ...input, nowMs: 100,
      requests: [request({ startRef: "u1", endRef: "a1" })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.blockRegistry.get(result.blockIds[0])!.effectiveMessageIds).toEqual(["u1", "a1"]);
    expect(result.messages.find(message => message.id === "a8")).toEqual(input.messages.at(-1));
    expect(input.state).toEqual(before);
  });

  it("allows old single messages and the exact guard boundary but rejects recent user/assistant targets", () => {
    for (const [ref, allowed] of [["u1", true], ["a1", true], ["u3", true], ["a3", true],
      ["u4", true], ["a4", false], ["u8", false], ["a8", false]] as const) {
      const result = planCompressionBatch({
        ...setup(), requests: [request({ mode: "message", messageRef: ref })],
      });
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.errors.map(error => error.code)).toContain("recent-range");
    }
  });

  it("rejects ranges crossing the five-request boundary and mixed batches atomically", () => {
    const input = setup();
    for (const requests of [
      [request({ startRef: "u3", endRef: "a4" })],
      [request({ startRef: "u1", endRef: "a1" }), request({ mode: "message", messageRef: "a8" })],
    ]) {
      const before = cloneCoreState(input.state);
      const result = applyCompressionBatch({ ...input, nowMs: 100, requests });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map(error => error.code)).toEqual(["recent-range"]);
      expect(input.state).toEqual(before);
    }
  });

  it("uses the containing message request age, not an explicit recent tool turn", () => {
    const input = setup();
    const tool = toolMessage("a1", "read", { path: "source.ts" }, "source ".repeat(30));
    (tool.parts[0] as ToolPart).turn = input.state.currentTurn;
    input.messages[1] = tool;
    const result = planCompressionBatch({
      ...input, requests: [request({ mode: "message", messageRef: "a1" })],
    });
    expect(result.ok).toBe(true);
  });

  it("counts real assistant/tool-loop requests even within one user turn", () => {
    const input = setup();
    for (let i = 0; i < 8; i++) {
      input.messages.push(
        textMessage(`loop${i}`, "assistant", "Still processing the same turn."),
        { ...textMessage(`summary${i}`, "user", "Summary"), isSummary: true },
        { ...textMessage(`replacement${i}`, "user", "Manual"), isManualReplacement: true },
        textMessage(`__summary_${i}`, "user", "Catalog"),
        textMessage(`__manual_${i}`, "user", "Inserted"),
        textMessage(`__ctx_import_${i}`, "user", "Imported history"),
      );
    }
    const result = planCompressionBatch({
      ...input, requests: [request({ mode: "message", messageRef: "a4" })],
    });
    expect(result.ok).toBe(true);
  });

  it("does not substitute known raw-feed turns for missing requests in partial feeds", () => {
    const input = setup();
    input.state.currentTurn = 100;
    input.state.turnBasis = { latestUserId: "u8", messageTurns: [["a1", 20], ["a4", 99], ["u8", 100], ["a8", 100]] };
    input.messages = input.messages.filter(message => ["a1", "a4", "u8", "a8"].includes(message.id));
    for (const [ref, allowed] of [["a1", false], ["a4", false], ["a8", false]] as const) {
      const result = planCompressionBatch({
        ...input, requests: [request({ mode: "message", messageRef: ref })],
      });
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.errors.map(error => error.code)).toEqual(["recent-range"]);
    }
  });

  it("keeps a zero guard disabled rather than introducing a new compression policy", () => {
    const input = setup();
    input.config.compressionRecencyRequests = 0;
    const result = planCompressionBatch({
      ...input, requests: [request({ mode: "message", messageRef: "a8" })],
    });
    expect(result.ok).toBe(true);
  });

  it("ages imported historical records only from subsequent real requests", () => {
    const input = setup();
    input.state.importedContext = { version: 1, seedRef: "seed", bundleDigest: "digest", importedAtTurn: 8 };
    input.messages = [
      textMessage("__ctx_import_old", "user", "Historical material. ".repeat(20)),
      textMessage("u8", "user", "Current request"),
    ];
    for (const [requests, allowed] of [[0, false], [4, false], [5, true]] as const) {
      input.messages = input.messages.slice(0, 2).concat(Array.from({ length: requests }, (_, i) => textMessage(`new${i}`, "assistant", "Evidence")));
      const result = planCompressionBatch({
        ...input, requests: [request({ mode: "message", messageRef: "__ctx_import_old" })],
      });
      expect(result.ok).toBe(allowed);
      if (!result.ok) expect(result.errors.map(error => error.code)).toEqual(["recent-range"]);
    }
  });
});

describe("advanced compression transactions", () => {
  it("prevalidates the complete batch atomically and rejects overlaps", () => {
    const state = createInitialState("s");
    const messages = [textMessage("m1", "assistant", "a".repeat(30)), textMessage("m2", "assistant", "b".repeat(30)), textMessage("m3", "assistant", "c".repeat(30))];
    const before = cloneCoreState(state);
    const result = applyCompressionBatch({
      messages,
      state,
      config: config(),
      tokenizer: lengthTokenizer,
      nowMs: 10,
      requests: [request(), request({ startRef: "m2", endRef: "m3", topic: "other" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.code === "overlap")).toBe(true);
    expect(state.nextBlockId).toBe(before.nextBlockId);
    expect(state.blockRegistry.size).toBe(0);
  });

  it("returns structured missing, reversed, empty-field, and recent-range errors", () => {
    const state = createInitialState("s");
    state.currentTurn = 5;
    const cfg = config();
    cfg.compressionRecencyRequests = 2;
    const messages = [textMessage("m1", "user", "old"), textMessage("m2", "assistant", "new")];
    const result = planCompressionBatch({
      messages,
      state,
      config: cfg,
      tokenizer: lengthTokenizer,
      requests: [
        request({ topic: "", startRef: "missing" }),
        request({ startRef: "m2", endRef: "m1" }),
        request({ mode: "message", messageRef: "m2" }),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map(error => error.code);
      expect(codes).toContain("empty-field");
      expect(codes).toContain("missing-target");
      expect(codes).toContain("reversed-range");
      expect(codes).toContain("recent-range");
    }
  });

  it("explains a stale ref by naming the block that absorbed it", () => {
    const state = createInitialState("s");
    state.messageIds.byRef.set("m1", "m1");
    state.messageIds.byRef.set("m2", "m2");
    const messages = [
      textMessage("m1", "user", "a".repeat(60)),
      textMessage("m2", "assistant", "b".repeat(60)),
      textMessage("m3", "assistant", "c".repeat(60)),
    ];
    const applied = applyCompressionBatch({
      messages,
      state,
      config: config(),
      tokenizer: lengthTokenizer,
      nowMs: 10,
      requests: [request({ startRef: "m1", endRef: "m2", summary: "summary of m1 and m2" })],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // m1/m2 are now folded into b1; the projection only keeps the summary block
    // and m3. Re-targeting m1 must explain that instead of reporting a bare
    // "ref was not found".
    const projection = applied.messages.filter(message => !message.isIgnored);
    const again = planCompressionBatch({
      messages: projection,
      state: applied.state,
      config: config(),
      tokenizer: lengthTokenizer,
      requests: [request({ startRef: "m1", endRef: "m3" })],
    });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      const missing = again.errors.find(error => error.code === "missing-target");
      expect(missing).toBeDefined();
      expect(missing!.message).toContain("already compressed into block b1");
      expect(missing!.message).toContain("current refs span");
    }
  });

  it("supports per-message mode and injected token accounting", () => {
    const state = createInitialState("s");
    const messages = [textMessage("m1", "assistant", "x".repeat(40))];
    const result = applyCompressionBatch({
      messages,
      state,
      config: config(),
      tokenizer: lengthTokenizer,
      nowMs: 50,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined, summary: "tiny" })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const block = result.state.blockRegistry.get(result.blockIds[0])!;
    expect(block.mode).toBe("message");
    expect(block.sourceTokens).toBe(40);
    expect(block.summaryTokens).toBe(4);
    expect(block.netTokens).toBe(36);
    expect(state.blockRegistry.size).toBe(0);
  });

  it("builds nested graph edges and covers effective original sources", () => {
    const source = toolMessage("m1", "read", { path: "/tmp/a" }, "output ".repeat(20));
    const first = applyCompressionBatch({
      messages: [source], state: createInitialState("s"), config: config(), tokenizer: lengthTokenizer, nowMs: 10,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined, summary: "child" })],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const childId = first.blockIds[0];
    const second = applyCompressionBatch({
      messages: first.messages, state: first.state, config: config(), tokenizer: lengthTokenizer, nowMs: 20,
      requests: [request({ mode: "message", messageRef: childId, startRef: undefined, endRef: undefined, summary: "P" })],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const parentId = second.blockIds[0];
    const parent = second.state.blockRegistry.get(parentId)!;
    const child = second.state.blockRegistry.get(childId)!;
    expect(parent.includedBlockIds).toEqual([childId]);
    expect(parent.effectiveMessageIds).toEqual(["m1"]);
    expect(parent.summaryText).toContain("child");
    expect(child.parentBlockIds).toEqual([parentId]);
    expect(child.active).toBe(false);
    expect(activateCompressionBlock(second.state, childId)).toBeNull();
    const reapplied = applyDecisions([source], second.state);
    expect(reapplied.some(message => message.id === `__summary_${parentId}`)).toBe(true);
    expect(reapplied.find(message => message.id === "m1")?.isIgnored).toBe(true);
  });

  it("does not duplicate a summary when projected context is re-fed", () => {
    const source = textMessage("m1", "assistant", "source ".repeat(40));
    const compressed = applyCompressionBatch({
      messages: [source], state: createInitialState("s"), config: config(), tokenizer: lengthTokenizer, nowMs: 1,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined, summary: "summary" })],
    });
    expect(compressed.ok).toBe(true);
    if (!compressed.ok) return;
    const blockId = compressed.blockIds[0];
    const firstProjection = applyDecisions(compressed.messages, compressed.state);
    const secondProjection = applyDecisions(firstProjection, compressed.state);
    expect(secondProjection.filter(message => message.id === `__summary_${blockId}`)).toHaveLength(1);
  });

  it("expands selected block placeholders and rejects references outside the target", () => {
    const first = applyCompressionBatch({
      messages: [textMessage("m1", "assistant", "source ".repeat(40))],
      state: createInitialState("s"),
      config: config(),
      tokenizer: lengthTokenizer,
      nowMs: 1,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined, summary: "CHILD FACTS" })],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const childId = first.blockIds[0];
    const expanded = applyCompressionBatch({
      messages: first.messages,
      state: first.state,
      config: config(),
      tokenizer: lengthTokenizer,
      nowMs: 2,
      requests: [request({ mode: "message", messageRef: childId, startRef: undefined, endRef: undefined, summary: `Parent keeps (${childId}) exactly.` })],
    });
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const parentSummary = expanded.state.blockRegistry.get(expanded.blockIds[0])!.summaryText;
    expect(parentSummary).toContain("CHILD FACTS");
    expect(parentSummary).not.toContain(`(${childId})`);

    const invalid = planCompressionBatch({
      messages: [textMessage("m2", "assistant", "source ".repeat(40))],
      state: first.state,
      config: config(),
      tokenizer: lengthTokenizer,
      requests: [request({ mode: "message", messageRef: "m2", startRef: undefined, endRef: undefined, summary: "Unknown (b999)" })],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.some(error => error.code === "invalid-block-reference")).toBe(true);
  });

  it("appends protected user, tool, tag, and path content verbatim", () => {
    const cfg = config();
    cfg.summarization.preserveUserMessages = true;
    cfg.summarization.protectedToolGlobs = ["bash"];
    cfg.summarization.protectedFilePathGlobs = ["*/secret.txt"];
    const messages: NeutralMessage[] = [
      textMessage("m1", "user", "USER VERBATIM <protect>TAG VERBATIM</protect>"),
      toolMessage("m2", "bash", { command: "safe" }, "TOOL VERBATIM"),
      toolMessage("m3", "read", { options: { filePath: "/repo/secret.txt" } }, "PATH VERBATIM"),
      textMessage("m4", "assistant", "compressible ".repeat(100)),
    ];
    const result = applyCompressionBatch({ messages, state: createInitialState("s"), config: cfg, tokenizer: lengthTokenizer, nowMs: 1, requests: [request({ endRef: "m4" })] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const summary = result.state.blockRegistry.get(result.blockIds[0])!.summaryText;
    expect(summary).toContain("USER VERBATIM <protect>TAG VERBATIM</protect>");
    expect(summary).toContain("<protect>TAG VERBATIM</protect>");
    expect(summary).toContain("TOOL VERBATIM");
    expect(summary).toContain("PATH VERBATIM");
  });

  it("enforces minimum net savings after protected content is appended", () => {
    const cfg = config();
    cfg.summarization.preserveUserMessages = true;
    cfg.summarization.minNetSavingsTokens = 1;
    const result = planCompressionBatch({
      messages: [textMessage("m1", "user", "verbatim")], state: createInitialState("s"), config: cfg, tokenizer: lengthTokenizer,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.code === "insufficient-savings")).toBe(true);
  });

  it("deep clones maps, sets, and nested block metadata", () => {
    const applied = applyCompressionBatch({
      messages: [textMessage("m1", "assistant", "long source")], state: createInitialState("s"), config: config(), tokenizer: lengthTokenizer, nowMs: 1,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined })],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const clone = cloneCoreState(applied.state);
    const id = applied.blockIds[0];
    clone.blockRegistry.get(id)!.effectiveMessageIds.push("mutated");
    clone.compressionIndex!.clear();
    clone.dedupDecisions.add("new");
    expect(applied.state.blockRegistry.get(id)!.effectiveMessageIds).toEqual(["m1"]);
    expect(applied.state.compressionIndex!.size).toBe(1);
    expect(applied.state.dedupDecisions.size).toBe(0);
  });

  it("survives two re-feed GC turns without mixing compression and call indexes", () => {
    const source = toolMessage("m1", "read", { path: "/a" }, "large output".repeat(10));
    const applied = applyCompressionBatch({
      messages: [source], state: createInitialState("s"), config: config(), tokenizer: lengthTokenizer, nowMs: 1,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined })],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    applied.state.messageIndex.set("stale-call", { messageId: "m1", masked: true, offloaded: false });
    runStateGc([source], applied.state);
    runStateGc([], applied.state);
    expect(applied.state.messageIndex.size).toBe(0);
    expect(applied.state.compressionIndex!.has("m1")).toBe(true);
    expect(applied.state.blockRegistry.size).toBe(1);
    expect(applyDecisions([source], applied.state).some(message => message.isSummary)).toBe(true);
  });

  it("deactivates, reactivates, and prepares recompression without source messages", () => {
    const applied = applyCompressionBatch({
      messages: [textMessage("m1", "assistant", "source text")], state: createInitialState("s"), config: config(), tokenizer: lengthTokenizer, nowMs: 1,
      requests: [request({ mode: "message", messageRef: "m1", startRef: undefined, endRef: undefined, durableSourceRef: "store://b1" })],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const id = applied.blockIds[0];
    const deactivated = deactivateCompressionBlock(applied.state, id)!;
    expect(deactivated.state.blockRegistry.get(id)!.active).toBe(false);
    expect(applied.state.blockRegistry.get(id)!.active).toBe(true);
    const activated = activateCompressionBlock(deactivated.state, id)!;
    expect(activated.state.blockRegistry.get(id)!.active).toBe(true);
    const recompress = recompressCompressionBlock(activated.state, id)!;
    expect(recompress.effectiveMessageIds).toEqual(["m1"]);
    expect(recompress.durableSourceRef).toBe("store://b1");
    expect(recompress.state.blockRegistry.get(id)!.active).toBe(false);
  });
});
