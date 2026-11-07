// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { describe, expect, it } from "bun:test";
import { InMemoryContentStore } from "../services/contentStore.js";
import type { BlockMetadata } from "../types/state.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
import {
  archiveCompressionSource,
  archiveCompressionSummary,
  loadCompressionSource,
  loadCompressionSummary,
  retrieveCompressionSummaries,
  searchCompressionSummaries,
} from "../adapters/opencode/compression-archive.js";

function entry(id: string, sessionId = "session-a", text = id): HostMessageEntry {
  return {
    info: { id, sessionID: sessionId, role: "user", time: { created: 1 }, agent: "test", model: { providerID: "p", modelID: "m" } },
    parts: [{ id: `${id}-part`, sessionID: sessionId, messageID: id, type: "text", text }],
  };
}

function block(blockId: string, durableSummaryRef?: string): BlockMetadata {
  return { blockId, topic: `topic ${blockId}`, durableSummaryRef } as BlockMetadata;
}

describe("content archive primitives", () => {
  it("reports creation status and UTF-8 byte sizes", async () => {
    const store = new InMemoryContentStore();
    const request = { data: "🙂é", metadata: { sessionId: "s" } };
    const first = await store.writeWithStatus(request);
    const second = await store.writeWithStatus(request);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(first.record.byteSize).toBe(6);
  });

  it("strictly rejects an oversized first search result", async () => {
    const store = new InMemoryContentStore();
    await store.write({ data: `needle ${"🙂".repeat(20)}`, metadata: { sessionId: "s" } });
    const result = await store.search({ text: "needle", maxBytes: 10 });
    expect(result.items).toEqual([]);
    expect(result.truncatedBytes).toBe(true);
    expect(result.totalMatches).toBe(1);
  });

  it("round-trips and verifies source and summary envelopes", async () => {
    const store = new InMemoryContentStore();
    const source = await archiveCompressionSource(store, "session-a", "b1", "alpha", ["m1", "m2"], [entry("m1"), entry("m2")]);
    const summary = await archiveCompressionSummary(store, "session-a", "b1", "alpha", "needle summary");
    expect(source.created).toBe(true);
    expect(summary.created).toBe(true);
    expect((await loadCompressionSource(store, source.record.id, "session-a", "b1", ["m1", "m2"])).map(item => item.info.id)).toEqual(["m1", "m2"]);
    expect(await loadCompressionSummary(store, summary.record.id, "session-a", "b1")).toBe("needle summary");
  });

  it("rejects bad digest, wrong scope, and incomplete sources", async () => {
    const store = new InMemoryContentStore();
    const source = await archiveCompressionSource(store, "session-a", "b1", "alpha", ["m1"], [entry("m1")]);
    const summary = await archiveCompressionSummary(store, "session-a", "b1", "alpha", "summary");
    await expect(loadCompressionSource(store, source.record.id, "wrong", "b1", ["m1"])).rejects.toThrow();
    await expect(loadCompressionSource(store, source.record.id, "session-a", "wrong", ["m1"])).rejects.toThrow();
    await expect(loadCompressionSource(store, source.record.id, "session-a", "b1", ["m1", "missing"])).rejects.toThrow(/message list|incomplete/);
    await expect(loadCompressionSummary(store, summary.record.id, "wrong", "b1")).rejects.toThrow();
    await expect(loadCompressionSummary(store, summary.record.id, "session-a", "wrong")).rejects.toThrow();

    const parsed = JSON.parse(summary.record.data) as Record<string, unknown>;
    parsed.digest = "0".repeat(64);
    const corrupt = await store.write({
      id: "corrupt-summary",
      data: JSON.stringify(parsed),
      metadata: summary.record.metadata,
    });
    await expect(loadCompressionSummary(store, corrupt.id, "session-a", "b1")).rejects.toThrow(/digest/);
  });

  it("accepts complete legacy bare source archives", async () => {
    const store = new InMemoryContentStore();
    const legacy = await store.write({
      data: JSON.stringify([entry("m1")]),
      metadata: { sessionId: "session-a", blockId: "b1", kind: "compression-source", label: "legacy" },
    });
    expect((await loadCompressionSource(store, legacy.id, "session-a", "b1", ["m1"]))[0].info.id).toBe("m1");
  });

  it("searches only current-session summary archives without leaking storage IDs", async () => {
    const store = new InMemoryContentStore();
    const visible = await archiveCompressionSummary(store, "session-a", "b1", "visible", "needle visible");
    await archiveCompressionSummary(store, "session-b", "b2", "hidden", "needle hidden");
    await store.write({ data: "needle unrelated", metadata: { sessionId: "session-a", blockId: "b3", kind: "other" } });
    const result = await searchCompressionSummaries(store, "session-a", "needle", { maxResults: 10, maxBytes: 10_000 });
    expect(result.items.map(item => item.blockId)).toEqual(["b1"]);
    expect(JSON.stringify(result)).not.toContain(visible.record.id);
    expect("record" in result.items[0]).toBe(false);
    expect("id" in result.items[0]).toBe(false);
    expect("data" in result.items[0]).toBe(false);
  });

  it("retrieves only whole summaries within item, byte, and token bounds", async () => {
    const store = new InMemoryContentStore();
    const first = await archiveCompressionSummary(store, "session-a", "b1", "one", "12345678");
    const second = await archiveCompressionSummary(store, "session-a", "b2", "two", "abcdefgh");
    const third = await archiveCompressionSummary(store, "session-a", "b3", "three", "ijklmnop");
    const result = await retrieveCompressionSummaries(store, "session-a", [
      block("b1", first.record.id),
      block("b2", second.record.id),
      block("b3", third.record.id),
      block("b4"),
    ], { maxItems: 2, maxBytes: 16, maxTokens: 4 });
    expect(result.items.map(item => item.summaryText)).toEqual(["12345678", "abcdefgh"]);
    expect(result.omitted).toEqual([
      { blockId: "b3", reason: "item-limit" },
      { blockId: "b4", reason: "missing-reference" },
    ]);
    expect(result.totalBytes).toBe(16);

    const wholeOnly = await retrieveCompressionSummaries(store, "session-a", [block("b1", first.record.id)],
      { maxItems: 1, maxBytes: 7, maxTokens: 100 });
    expect(wholeOnly.items).toEqual([]);
    expect(wholeOnly.omitted).toEqual([{ blockId: "b1", reason: "byte-limit" }]);
  });
});
