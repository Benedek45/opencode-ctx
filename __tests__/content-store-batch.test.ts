// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Batched content-store writes: one shared-index publication per batch.

import { describe, it, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";

const meta = (label: string) => ({ sessionId: "s1", source: "opencode", kind: "history-message", label });

describe("FilesystemContentStore.writeMany", () => {
  it("publishes every new record with one index write and skips existing ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-batch-"));
    try {
      const store = new FilesystemContentStore(dir);
      await store.write({ id: "message-a", data: "a", metadata: meta("a") });

      const store2 = new FilesystemContentStore(dir);
      const saves: number[] = [];
      const original = (store2 as unknown as { saveIndex: (index: unknown, publishedIds?: readonly string[]) => Promise<void> }).saveIndex.bind(store2);
      (store2 as unknown as { saveIndex: (index: unknown, publishedIds?: readonly string[]) => Promise<void> }).saveIndex = async (index, publishedIds) => {
        saves.push(1);
        await original(index, publishedIds);
      };

      const requests = Array.from({ length: 200 }, (_, i) => ({ id: `message-${i}`, data: `payload ${i}`, metadata: meta(String(i)) }));
      const results = await store2.writeMany([{ id: "message-a", data: "a", metadata: meta("a") }, ...requests, requests[0]]);

      expect(saves.length).toBe(1);
      expect(results[0]).toEqual({ id: "message-a", created: false });
      expect(results.slice(1, 201).every(result => result.created)).toBe(true);
      expect(results[201]).toEqual({ id: "message-0", created: false });
      expect((await store2.get("message-199"))?.data).toBe("payload 199");

      const index = JSON.parse(await readFile(join(dir, "content-index.json"), "utf8"));
      expect(Object.keys(index.records).length).toBe(201);
      const leftovers = (await readdir(join(dir, "content-blobs"))).filter(name => !name.endsWith(".json"));
      expect(leftovers).toEqual([]);

      // A fresh process sees the batch through the persisted index.
      const reopened = new FilesystemContentStore(join(dir));
      expect((await reopened.get("message-42"))?.data).toBe("payload 42");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back every blob of the batch when the index publication fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-batch-fail-"));
    try {
      const store = new FilesystemContentStore(dir);
      await store.write({ id: "message-keep", data: "keep", metadata: meta("keep") });
      (store as unknown as { saveIndex: () => Promise<void> }).saveIndex = async () => {
        throw new Error("disk full");
      };
      await expect(store.writeMany([
        { id: "message-x", data: "x", metadata: meta("x") },
        { id: "message-y", data: "y", metadata: meta("y") },
      ])).rejects.toThrow("disk full");

      expect(await store.get("message-x")).toBeUndefined();
      expect((await store.get("message-keep"))?.data).toBe("keep");
      const files = await readdir(join(dir, "content-blobs"));
      expect(files.some(name => name.includes("message-x") || name.includes("message-y"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
