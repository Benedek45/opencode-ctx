// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { describe, expect, it } from "bun:test";
import { buildCompressTool, buildCompressMessageTool, buildCompressionStatusTool, commitWorkerCompression, type CompressToolDeps } from "../adapters/opencode/tool.js";
import { createInitialState } from "../types/state.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { InMemoryContentStore } from "../services/contentStore.js";
import type { HostMessageEntry, HostToolContext } from "../adapters/opencode/host-types.js";

const context = { sessionID: "status" } as HostToolContext;
const sourceMarker = "SOURCE_TEXT_MUST_NOT_LEAK";
function fixture() {
  let state = createInitialState("status");
  state.currentTurn = 10;
  const config = buildDefaultConfig("status");
  config.compressionRecencyRequests = 0;
  const entries: HostMessageEntry[] = ["a", "b"].map((id, index) => {
    state.messageIds.byRawId.set(id, `m000${index + 1}`);
    state.messageIds.byRef.set(`m000${index + 1}`, id);
    return {
      info: { id, sessionID: "status", role: "user", time: { created: index }, agent: "test", model: { providerID: "p", modelID: "m" } },
      parts: [{ id: `${id}-text`, sessionID: "status", messageID: id, type: "text", text: `${sourceMarker} ${"detail ".repeat(800)}` }],
    };
  });
  let projected = entries;
  let saves = 0;
  const deps: CompressToolDeps = {
    getState: () => state, setState: (_id, next) => { state = next; },
    getConfig: () => config, getProjectedEntries: () => projected, getRawEntries: () => entries,
    setProjectedEntries: (_id, next) => { projected = next; },
    contentStore: new InMemoryContentStore(), tokenizer: new CharTokenizer(),
    persistence: { async load() { return undefined; }, async save() { saves++; } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    runExclusive: async (_id, task) => task(),
  };
  return { deps, config, state: () => state, saves: () => saves };
}
const range = { topic: "Explore", content: [{ startId: "m0001", endId: "m0002", summary: "Explored the initial details." }] };
const object = (result: unknown) => result as { output: string; metadata?: Record<string, any> };

describe("compression status and model attempts", () => {
  it("revalidates workers after archive I/O and rolls back cancellation without a save or model attempt", async () => {
    for (const throws of [false, true]) {
      const fx = fixture();
      const original = fx.state();
      let checked = false;
      const result = await commitWorkerCompression(fx.deps, "status", range, "", async () => {
        checked = true;
        expect((await fx.deps.contentStore!.list()).length).toBe(2);
        if (throws) throw new Error("parent status unavailable");
        return false;
      });
      expect(checked).toBe(true);
      expect(result.committed).toBe(false);
      expect(result.codes).toEqual([throws ? "persist-failed" : "stale-worker"]);
      expect(fx.state()).toBe(original);
      expect(fx.state().nudgeEscalation.attempts).toBeUndefined();
      expect(fx.saves()).toBe(0);
      expect(await fx.deps.contentStore!.list()).toEqual([]);
    }
  });

  it("reports only refs, counts and token estimates without source text or mutation", async () => {
    const fx = fixture();
    const before = fx.state();
    const result = object(await buildCompressionStatusTool(fx.deps).execute({}, context));
    expect(result.metadata?.candidates).toEqual([{ startRef: "m0001", endRef: "m0002", messageCount: 2,
      sourceTokens: result.metadata?.eligibleTokens }]);
    expect(JSON.stringify(result)).not.toContain(sourceMarker);
    expect(result.output).toContain("ctx_compression_status");
    expect(fx.state()).toBe(before);
    expect(fx.saves()).toBe(0);
  });

  it("reports request waits rather than inventing a user-turn deadline", async () => {
    const fx = fixture();
    fx.config.compressionRecencyRequests = 3;
    const result = object(await buildCompressionStatusTool(fx.deps).execute({}, context));
    expect(result.metadata?.candidates).toEqual([]);
    expect(result.metadata?.requestsUntilEligible).toBe(3);
    expect(result.metadata?.reason).toBe("protectedcontent");
    expect(result.metadata?.nextEligibleUserTurn).toBeUndefined();
    expect(fx.state().nudgeEscalation.attempts).toBeUndefined();
  });

  it("counts rejected range and individual-message attempts and appends fresh guidance", async () => {
    const fx = fixture();
    const reversed = object(await buildCompressTool(fx.deps).execute({ topic: "x", content: [
      { startId: "m0002", endId: "m0001", summary: "x" },
    ] }, context));
    expect(reversed.output).toContain("reversed-range");
    expect(reversed.output).toContain("Age/structure-eligible candidates:");
    const missing = object(await buildCompressMessageTool(fx.deps).execute({ content: [
      { messageId: "unknown", topic: "x", summary: "x" },
    ] }, context));
    expect(missing.output).toContain("ctx_compression_status");
    expect(fx.state().nudgeEscalation.attempts).toBe(2);
    expect(fx.state().nudgeEscalation.lastAttempt?.outcome).toBe("rejected");
    expect(fx.state().blockRegistry.size).toBe(0);
    expect(fx.saves()).toBe(0);
  });

  it("counts post-validation failures without making a durable rejection write", async () => {
    const fx = fixture();
    fx.deps.persistence.save = async () => { throw new Error("test persistence unavailable"); };
    const result = object(await buildCompressTool(fx.deps).execute(range, context));
    expect(result.output).toContain("failed to persist state");
    expect(result.output).toContain("Age/structure-eligible candidates:");
    expect(fx.state().nudgeEscalation.attempts).toBe(1);
    expect(fx.state().nudgeEscalation.lastAttempt).toEqual({ turn: 10, outcome: "failed", codes: ["persist-failed"] });
    expect(fx.state().blockRegistry.size).toBe(0);
    expect(await fx.deps.contentStore!.list()).toEqual([]);
  });

  it("a recent-range rejection refreshes the no-candidate explanation and wait", async () => {
    const fx = fixture();
    fx.config.compressionRecencyRequests = 3;
    const result = object(await buildCompressTool(fx.deps).execute(range, context));
    expect(result.output).toContain("recent-range");
    expect(result.output).toContain("No eligible compression range");
    expect(result.output).toContain("~3 more requests");
    expect(fx.state().nudgeEscalation.attempts).toBe(1);
    expect(fx.saves()).toBe(0);
    const status = object(await buildCompressionStatusTool(fx.deps).execute({}, context));
    expect(status.output).toContain("Last unsuccessful compression attempt (user turn 10): rejected");
    expect(JSON.stringify(status)).not.toContain(sourceMarker);
  });

  it("insufficient savings is an attempted compression, not ignored guidance", async () => {
    const fx = fixture();
    const result = object(await buildCompressTool(fx.deps).execute({ ...range, content: [
      { ...range.content[0], summary: "padding ".repeat(4000) },
    ] }, context));
    expect(result.output).toContain("insufficient-savings");
    expect(fx.state().nudgeEscalation.lastAttempt?.codes).toContain("insufficient-savings");
    expect(fx.state().nudgeEscalation.attempts).toBe(1);
    expect(fx.saves()).toBe(0);
  });

  it("does not count schema-only calls or disabled operations as guarded attempts", async () => {
    const fx = fixture();
    await buildCompressTool(fx.deps).execute({ topic: "x", content: [] }, context);
    fx.config.automation.modelCompression = false;
    const disabled = object(await buildCompressTool(fx.deps).execute(range, context));
    expect(disabled.output).toContain("disabled");
    expect(fx.state().nudgeEscalation.attempts).toBeUndefined();
    expect(fx.saves()).toBe(0);
    const status = object(await buildCompressionStatusTool(fx.deps).execute({}, context));
    expect(status.metadata?.reason).toBe("compression-disabled");
  });

  it("successful compression uses the normal durable commit without unsuccessful-attempt bookkeeping", async () => {
    const fx = fixture();
    const result = object(await buildCompressTool(fx.deps).execute(range, context));
    expect(result.output).toContain("Compressed 1 target(s)");
    expect(fx.saves()).toBe(1);
    expect(fx.state().blockRegistry.size).toBe(1);
    expect(fx.state().nudgeEscalation.attempts).toBeUndefined();
  });
});
