// Regression: model-supplied compress arguments with missing fields must be
// rejected as validation errors, never crash with a TypeError ("value.trim").
import { describe, expect, it } from "bun:test";
import { planCompressionBatch, type CompressionRequest } from "../core/compress/transaction.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { createInitialState } from "../types/state.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { buildCompressTool, buildCompressMessageTool } from "../adapters/opencode/tool.js";

const tokenizer = new CharTokenizer();
const outputOf = (result: unknown): string =>
  typeof result === "string" ? result : (result as { output: string }).output;

function message(id: string, ref: string) {
  return {
    id, ref, role: "assistant" as const, sessionId: "args", createdAt: 1,
    parts: [{ type: "text" as const, text: "x".repeat(2_000) }],
  };
}

function plan(requests: Array<Partial<CompressionRequest>>) {
  const config = buildDefaultConfig("args");
  config.recencyGuardTurns = 0;
  config.compressionRecencyRequests = 0;
  return planCompressionBatch({
    messages: [message("a", "m0001"), message("b", "m0002")],
    requests: requests as CompressionRequest[],
    state: createInitialState("args"),
    config,
    tokenizer,
  });
}

describe("compression argument validation", () => {
  it("rejects a missing topic or summary without throwing", () => {
    for (const request of [
      { mode: "range", summary: "short", startRef: "m0001", endRef: "m0002" },
      { mode: "range", topic: "t", startRef: "m0001", endRef: "m0002" },
      { mode: "message", messageRef: "m0001" },
    ] as Array<Partial<CompressionRequest>>) {
      const result = plan([request]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.some(error => error.code === "missing-field")).toBe(true);
    }
  });

  it("still reports empty strings as empty-field", () => {
    const result = plan([{ mode: "range", topic: "  ", summary: "short", startRef: "m0001", endRef: "m0002" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map(error => error.code)).toContain("empty-field");
  });

  it("accepts a valid range", () => {
    expect(plan([{ mode: "range", topic: "t", summary: "short", startRef: "m0001", endRef: "m0002" }]).ok).toBe(true);
  });
});

describe("compress tool argument handling", () => {
  // The tools must reject before touching session data; fail loudly if they reach it.
  const deps = new Proxy({}, {
    get: (_target, key) => key === "runExclusive"
      ? (_session: string, fn: () => unknown) => fn()
      : (key === "getState" || key === "getConfig" || key === "getProjectedEntries" || key === "getRawEntries")
        ? () => undefined
        : () => { throw new Error(`unexpected dependency use: ${String(key)}`); },
  }) as never;
  const context = { sessionID: "args" } as never;

  it("range compress without a top-level topic returns a result instead of throwing", async () => {
    const tool = buildCompressTool(deps);
    const result = await tool.execute({ content: [{ startId: "m0001", endId: "m0002", summary: "s" }] } as never, context);
    expect(typeof outputOf(result)).toBe("string");
  });

  it("missing content array is rejected for both tools", async () => {
    const withState = new Proxy({}, {
      get: (_target, key) => key === "runExclusive"
        ? (_session: string, fn: () => unknown) => fn()
        : key === "getState" ? () => createInitialState("args")
          : key === "getConfig" ? () => buildDefaultConfig("args")
            : (key === "getProjectedEntries" || key === "getRawEntries") ? () => []
              : () => { throw new Error(`unexpected dependency use: ${String(key)}`); },
    }) as never;
    const range = await buildCompressTool(withState).execute({ topic: "t" } as never, context);
    const single = await buildCompressMessageTool(withState).execute({ topic: "t", content: [] } as never, context);
    expect(outputOf(range)).toContain('requires a non-empty "content" array');
    expect(outputOf(single)).toContain('requires a non-empty "content" array');
  });
});
