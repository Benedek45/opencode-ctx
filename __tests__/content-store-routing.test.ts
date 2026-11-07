// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Tests for content store (services + filesystem adapter) and routing classifier.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm, unlink, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  InMemoryContentStore,
  contentHash,
  deriveContentId,
} from "../services/contentStore.js";
import type {
  ContentMetadata,
  ContentRecord,
  ContentWriteRequest,
} from "../services/contentStore.js";

import { FilesystemContentStore } from "../adapters/opencode/content-store.js";

import { classifyTool } from "../core/routing.js";

// ══════════════════════════════════════════════════════════════════════════
//  services/contentStore.ts — InMemoryContentStore
// ══════════════════════════════════════════════════════════════════════════

describe("InMemoryContentStore", () => {
  let store: InMemoryContentStore;

  const meta = (overrides: Partial<ContentMetadata> = {}): ContentMetadata => ({
    sessionId: "sess-test",
    projectId: "proj-a",
    source: "bash",
    kind: "output",
    ...overrides,
  });

  beforeEach(() => {
    store = new InMemoryContentStore();
  });

  // ── 1. Content immutability under same label ───────────────────────

  it("does not overwrite content with a repeated label (label is not identity)", async () => {
    const req1: ContentWriteRequest = { data: "first version", metadata: meta({ label: "my-label" }) };
    const req2: ContentWriteRequest = { data: "second version", metadata: meta({ label: "my-label" }) };

    const r1 = await store.write(req1);
    const r2 = await store.write(req2);

    expect(r1.id).not.toBe(r2.id);
    expect(r1.data).toBe("first version");
    expect(r2.data).toBe("second version");

    const g1 = await store.get(r1.id);
    const g2 = await store.get(r2.id);
    expect(g1?.data).toBe("first version");
    expect(g2?.data).toBe("second version");
    expect(await store.size()).toBe(2);
  });

  // ── 2. Hash stability ─────────────────────────────────────────────

  it("produces stable hashes for the same input", () => {
    const h1 = deriveContentId("hello world", meta());
    const h2 = deriveContentId("hello world", meta());
    expect(h1).toBe(h2);
  });

  it("different content produces different hashes", () => {
    const h1 = deriveContentId("hello world", meta());
    const h2 = deriveContentId("goodbye world", meta());
    expect(h1).not.toBe(h2);
  });

  it("metadata changes produce different hashes", () => {
    const h1 = deriveContentId("data", meta({ sessionId: "sess-a" }));
    const h2 = deriveContentId("data", meta({ sessionId: "sess-b" }));
    expect(h1).not.toBe(h2);
  });

  it("contentHash is deterministic (same string -> same result)", () => {
    expect(contentHash("")).toBe(contentHash(""));
    expect(contentHash("abc123")).toBe(contentHash("abc123"));
    expect(contentHash("a".repeat(1000))).toBe(contentHash("a".repeat(1000)));
  });

  // ── 3. Round-trip write / get / delete ────────────────────────────

  it("write then get returns identical record", async () => {
    const r = await store.write({ data: "round-trip data", metadata: meta() });
    const g = await store.get(r.id);
    expect(g).toBeDefined();
    expect(g!.id).toBe(r.id);
    expect(g!.data).toBe("round-trip data");
    expect(g!.byteSize).toBe(15);
    expect(g!.metadata.sessionId).toBe("sess-test");
  });

  it("get for non-existent id returns undefined", async () => {
    const g = await store.get("nonexistent-id");
    expect(g).toBeUndefined();
  });

  it("delete returns true and removes the record", async () => {
    const r = await store.write({ data: "delete-me", metadata: meta() });
    expect(await store.delete(r.id)).toBe(true);
    expect(await store.get(r.id)).toBeUndefined();
    expect(await store.size()).toBe(0);
  });

  it("delete for non-existent returns false", async () => {
    expect(await store.delete("no-such-id")).toBe(false);
  });

  it("supplied explicit ID is respected", async () => {
    const r = await store.write({ data: "explicit", metadata: meta(), id: "my-custom-id" });
    expect(r.id).toBe("my-custom-id");
    const g = await store.get("my-custom-id");
    expect(g?.data).toBe("explicit");
  });

  it("supplied explicit ID is idempotent (same ID, same data)", async () => {
    const req: ContentWriteRequest = { data: "same", metadata: meta(), id: "dup-id" };
    const r1 = await store.write(req);
    const r2 = await store.write(req);
    expect(r1.id).toBe(r2.id);
    expect(r1.createdAt).toBe(r2.createdAt);
    expect(await store.size()).toBe(1);
  });

  // ── 4. Metadata filtering in list ─────────────────────────────────

  it("list filters by sessionId", async () => {
    await store.write({ data: "a", metadata: meta({ sessionId: "s1" }) });
    await store.write({ data: "b", metadata: meta({ sessionId: "s2" }) });
    await store.write({ data: "c", metadata: meta({ sessionId: "s1" }) });

    const s1 = await store.list({ sessionId: "s1" });
    expect(s1).toHaveLength(2);
    const s2 = await store.list({ sessionId: "s2" });
    expect(s2).toHaveLength(1);
  });

  it("list filters by source + kind", async () => {
    await store.write({ data: "a", metadata: meta({ source: "bash", kind: "output" }) });
    await store.write({ data: "b", metadata: meta({ source: "read", kind: "output" }) });
    await store.write({ data: "c", metadata: meta({ source: "bash", kind: "error" }) });

    const bashOutputs = await store.list({ source: "bash", kind: "output" });
    expect(bashOutputs).toHaveLength(1);
  });

  it("list with undefined filter returns all", async () => {
    await store.write({ data: "a", metadata: meta() });
    await store.write({ data: "b", metadata: meta() });
    expect(await store.list()).toHaveLength(2);
  });

  // ── 5. Deterministic ranking ──────────────────────────────────────

  it("search ranks exact-match document higher", async () => {
    await store.write({ data: "the quick brown fox jumps", metadata: meta() });
    await store.write({ data: "foxes are quick but dogs are loyal", metadata: meta() });

    const results = await store.search({ text: "quick brown fox" });
    expect(results.items.length).toBeGreaterThanOrEqual(2);
    expect(results.items[0].score).toBeGreaterThan(results.items[1].score);
    expect(results.items[0].record.data).toBe("the quick brown fox jumps");
  });

  it("search with exact phrase gets bonus", async () => {
    await store.write({ data: "hello world this is a test", metadata: meta() });
    await store.write({ data: "world hello something else entirely", metadata: meta() });

    const results = await store.search({ text: "hello world" });
    expect(results.items[0].record.data).toBe("hello world this is a test");
  });

  it("search with metadata filter scopes results", async () => {
    await store.write({ data: "needle in haystack", metadata: meta({ kind: "output", source: "bash" }) });
    await store.write({ data: "needle not here", metadata: meta({ kind: "error", source: "read" }) });

    const r = await store.search({ text: "needle", filters: { kind: "output" } });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].record.data).toBe("needle in haystack");
  });

  it("search returns snippets around first match", async () => {
    const long = "one two three four five six seven eight nine ten";
    await store.write({ data: long, metadata: meta() });

    const r = await store.search({ text: "four", snippetMaxChars: 30 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].snippet).toBeDefined();
    expect(r.items[0].snippet!.match).toContain("four");
  });

  // ── 6. Result caps ────────────────────────────────────────────────

  it("search maxResults caps item count", async () => {
    for (let i = 0; i < 10; i++) {
      await store.write({ data: "matching content " + i, metadata: meta() });
    }
    const r = await store.search({ text: "matching", maxResults: 3 });
    expect(r.items).toHaveLength(3);
    expect(r.truncatedResults).toBe(true);
  });

  it("search maxBytes caps total data size", async () => {
    await store.write({ data: "x".repeat(500), metadata: meta() });
    await store.write({ data: "y".repeat(200), metadata: meta() });
    await store.write({ data: "z", metadata: meta() });

    const r = await store.search({ text: "x", maxBytes: 300 });
    expect(r.items.length).toBeLessThanOrEqual(1);
    expect(r.totalMatches).toBeGreaterThanOrEqual(1);
  });

  it("search with empty text returns empty but does not crash", async () => {
    await store.write({ data: "some data", metadata: meta() });
    const r = await store.search({ text: "" });
    expect(r.items).toHaveLength(0);
    expect(r.totalMatches).toBe(0);
  });

  it("clear removes all records", async () => {
    await store.write({ data: "a", metadata: meta() });
    await store.write({ data: "b", metadata: meta() });
    await store.clear();
    expect(await store.size()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  adapters/opencode/content-store.ts — FilesystemContentStore
// ══════════════════════════════════════════════════════════════════════════

describe("FilesystemContentStore", () => {
  let tmpDir: string;
  let store: FilesystemContentStore;

  const meta = (overrides: Partial<ContentMetadata> = {}): ContentMetadata => ({
    sessionId: "sess-fs",
    source: "bash",
    kind: "output",
    ...overrides,
  });

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ctx-content-fs-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    store = new FilesystemContentStore(tmpDir);
    await store.ensureDir();
    await store.clear();
  });

  it("atomic round-trip: write then get returns identical record", async () => {
    const r = await store.write({ data: "fs round-trip", metadata: meta() });
    const g = await store.get(r.id);
    expect(g).toBeDefined();
    expect(g!.id).toBe(r.id);
    expect(g!.data).toBe("fs round-trip");
    expect(g!.byteSize).toBe(13);
  });

  it("write is atomic across fresh store instances", async () => {
    const r0 = await store.write({ data: "atomic data", metadata: meta() });
    const fresh = new FilesystemContentStore(tmpDir);
    const g = await fresh.get(r0.id);
    expect(g?.data).toBe("atomic data");
  });

  it("retains only metadata and coordination state after writes and index rebuilds", async () => {
    const record = await store.write({ data: "payload-not-for-shared-cache", metadata: meta() });
    const shared = (store as unknown as { shared: Record<string, unknown> }).shared;
    for (const rebuild of [false, true]) {
      if (rebuild) await store.rescan();
      expect(Object.keys(shared).sort()).toEqual([
        "contentWriteChain", "historyChain", "historyMetadata", "indexCache", "indexLoadPromise", "indexStamp", "indexWriteChain",
        "pendingDeletions", "pendingUpserts",
      ]);
      expect(JSON.stringify(shared.indexCache)).not.toContain(record.data);
      expect(JSON.stringify([...(shared.pendingUpserts as Map<string, unknown>).values()])).not.toContain(record.data);
      expect(JSON.stringify([...(shared.historyMetadata as Map<string, unknown>).values()])).not.toContain(record.data);
      expect((await store.get(record.id))?.data).toBe(record.data);
    }
  });

  it("rolls back durable blob publication when saving the index fails", async () => {
    const existing = await store.write({ data: "keep existing", metadata: meta() });
    const internals = store as unknown as { saveIndex: (index: unknown) => Promise<void> };
    const saveIndex = internals.saveIndex;
    internals.saveIndex = async () => { throw new Error("injected index publication failure"); };
    try {
      await expect(store.write({ id: "failed-publication", data: "never publish", metadata: meta() }))
        .rejects.toThrow("injected index publication failure");
    } finally {
      internals.saveIndex = saveIndex;
    }
    expect(await store.get("failed-publication")).toBeUndefined();
    await expect(stat(join(tmpDir, "content-blobs", "failed-publication.json"))).rejects.toThrow();
    await expect(stat(join(tmpDir, "content-blobs", "failed-publication.pending"))).rejects.toThrow();
    const index = JSON.parse(await readFile(join(tmpDir, "content-index.json"), "utf8"));
    expect(Object.keys(index.records)).toEqual([existing.id]);
    await store.rescan();
    expect(await store.get("failed-publication")).toBeUndefined();
    expect((await store.get(existing.id))?.data).toBe("keep existing");
    expect((await store.search({ text: "never publish" })).items).toEqual([]);
  });

  it("retains every concurrent write while the index is initially cold", async () => {
    const concurrentDir = await mkdtemp(join(tmpdir(), "ctx-content-concurrent-"));
    try {
      const concurrent = new FilesystemContentStore(concurrentDir);
      await Promise.all(Array.from({ length: 20 }, (_, index) =>
        concurrent.write({ data: `record ${index}`, metadata: meta({ sessionId: `s${index}` }) })
      ));
      expect(await concurrent.size()).toBe(20);
      expect(await new FilesystemContentStore(concurrentDir).size()).toBe(20);
    } finally {
      await rm(concurrentDir, { recursive: true, force: true });
    }
  });

  it("retains concurrent cold writes from separate instances sharing one directory", async () => {
    const concurrentDir = await mkdtemp(join(tmpdir(), "ctx-content-multi-instance-"));
    try {
      const instances = Array.from(
        { length: 20 },
        () => new FilesystemContentStore(concurrentDir)
      );
      await Promise.all(instances.map((instance, index) =>
        instance.write({ data: `instance record ${index}`, metadata: meta({ sessionId: `multi-${index}` }) })
      ));
      expect(await new FilesystemContentStore(concurrentDir).size()).toBe(20);
    } finally {
      await rm(concurrentDir, { recursive: true, force: true });
    }
  });

  it("corrupt index recovers by scanning blob sidecars", async () => {
    const r = await store.write({ data: "recover me", metadata: meta() });
    const r2 = await store.write({ data: "second record", metadata: meta() });

    // Wipe index file
    try { await unlink(join(tmpDir, "content-index.json")); } catch { /* ok */ }

    const recovered = new FilesystemContentStore(tmpDir);
    const g = await recovered.get(r.id);
    expect(g).toBeDefined();
    expect(g!.data).toBe("recover me");
    expect(await recovered.size()).toBe(2);
  });

  it("corrupt index file contents triggers recovery", async () => {
    const r = await store.write({ data: "third record", metadata: meta() });
    try { await unlink(join(tmpDir, "content-index.json")); } catch { /* ok */ }
    await writeFile(join(tmpDir, "content-index.json"), "garbage {{{ not json", "utf8");

    const corrupted = new FilesystemContentStore(tmpDir);
    const g = await corrupted.get(r.id);
    expect(g).toBeDefined();
    expect(g!.data).toBe("third record");
    expect(await corrupted.size()).toBe(1);
  });

  it("path traversal in id is rejected", async () => {
    try {
      await store.write({ data: "traverse", metadata: meta(), id: "../etc/passwd" });
      expect(false).toBe(true);
    } catch (e) {
      expect((e as Error).message).toContain("path traversal");
    }

    try {
      await store.write({ data: "traverse2", metadata: meta(), id: "bad\0id" });
      expect(false).toBe(true);
    } catch (e) {
      expect((e as Error).message).toContain("path traversal");
    }
  });

  it("list returns all records in sorted order", async () => {
    await store.write({ data: "first", metadata: meta({ sessionId: "s1" }) });
    await new Promise(r => setTimeout(r, 5));
    await store.write({ data: "second", metadata: meta({ sessionId: "s2" }) });

    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all[0].data).toBe("first");
    expect(all[1].data).toBe("second");
  });

  it("list with filter returns matching records", async () => {
    await store.write({ data: "bash output", metadata: meta({ source: "bash", kind: "output" }) });
    await store.write({ data: "read output", metadata: meta({ source: "read", kind: "output" }) });

    const bashItems = await store.list({ source: "bash" });
    expect(bashItems).toHaveLength(1);
    expect(bashItems[0].data).toBe("bash output");
  });

  it("delete removes from index and blob", async () => {
    const r = await store.write({ data: "delete me", metadata: meta() });
    expect(await store.delete(r.id)).toBe(true);
    expect(await store.size()).toBe(0);
    expect(await store.get(r.id)).toBeUndefined();

    const blobPath = join(tmpDir, "content-blobs", r.id + ".json");
    try {
      await stat(blobPath);
      expect(false).toBe(true); // should not reach
    } catch {
      // Expected — file not found
    }
  });

  it("deleteUnreferenced removes only non-active IDs", async () => {
    const r1 = await store.write({ data: "keep me", metadata: meta() });
    const r2 = await store.write({ data: "remove me", metadata: meta() });
    const r3 = await store.write({ data: "keep me too", metadata: meta() });

    const removed = await store.deleteUnreferenced(new Set([r1.id, r3.id]));
    expect(removed).toBe(1);
    expect(await store.get(r1.id)).toBeDefined();
    expect(await store.get(r2.id)).toBeUndefined();
    expect(await store.get(r3.id)).toBeDefined();
    expect(await store.size()).toBe(2);
  });

  it("history snapshot save/load round-trip", async () => {
    await store.write({ data: "snap1", metadata: meta({ sessionId: "s-snap" }) });
    await store.write({ data: "snap2", metadata: meta({ sessionId: "s-snap" }) });

    const snapDir = await mkdtemp(join(tmpdir(), "ctx-snap-test-"));
    const snapFile = join(snapDir, "snapshot.json");
    try {
      await store.saveSnapshot(snapFile);
      const raw = await readFile(snapFile, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.records).toHaveLength(2);

      const freshDir = await mkdtemp(join(tmpdir(), "ctx-fresh-"));
      const fresh = new FilesystemContentStore(freshDir);
      await fresh.ensureDir();

      const added = await fresh.loadSnapshot(snapFile);
      expect(added).toBe(2);
      expect(await fresh.size()).toBe(2);
      expect(await fresh.get(parsed.records[0].id)).toBeDefined();

      // Load again — should not duplicate (immutability)
      const added2 = await fresh.loadSnapshot(snapFile);
      expect(added2).toBe(0);
    } finally {
      await rm(snapDir, { recursive: true, force: true });
    }
  });

  it("keeps colliding sanitized session IDs in separate snapshots", async () => {
    const first = { version: 1 as const, sessionId: "a/b", rawEntries: [], projectedEntries: [], updatedAt: 1 };
    const second = { version: 1 as const, sessionId: "a?b", rawEntries: [], projectedEntries: [], updatedAt: 2 };
    await store.saveSessionHistory(first);
    await store.saveSessionHistory(second);
    expect((await store.loadSessionHistory("a/b"))?.updatedAt).toBe(1);
    expect((await store.loadSessionHistory("a?b"))?.updatedAt).toBe(2);
  });

  it("writes archive files with owner-only permissions on POSIX", async () => {
    if (process.platform === "win32") return;
    const record = await store.write({ data: "private", metadata: meta() });
    const blobMode = (await stat(join(tmpDir, "content-blobs", `${record.id}.json`))).mode & 0o777;
    const indexMode = (await stat(join(tmpDir, "content-index.json"))).mode & 0o777;
    expect(blobMode).toBe(0o600);
    expect(indexMode).toBe(0o600);
  });

  it("search yields deterministic scores", async () => {
    await store.write({ data: "python is great for data science", metadata: meta() });
    await store.write({ data: "javascript is great for web apps", metadata: meta() });

    const r1 = await store.search({ text: "python data" });
    const r2 = await store.search({ text: "python data" });
    expect(r1.items).toHaveLength(r2.items.length);
    if (r1.items.length > 0) {
      expect(r1.items[0].score).toBe(r2.items[0].score);
    }
  });

  it("filters every metadata field before reading blobs, including undefined and absent filters", async () => {
    const metadata: ContentMetadata = {
      sessionId: "session-a", projectId: "project-a", kind: "compression-summary-v1",
      source: "opencode-compress", blockId: "b1", callId: "call-a", label: "summary-a",
    };
    const records = [await store.write({ data: "needle summary", metadata })];
    for (const key of Object.keys(metadata) as (keyof ContentMetadata)[]) {
      records.push(await store.write({ data: "needle unrelated", metadata: { ...metadata, [key]: "other" } }));
    }
    const internals = store as unknown as { readBlob: (id: string) => Promise<ContentRecord | undefined> };
    const readBlob = internals.readBlob;
    const readIds: string[] = [];
    internals.readBlob = async id => {
      readIds.push(id);
      return readBlob.call(store, id);
    };
    try {
      for (const filters of [metadata, { ...metadata, label: undefined }, { sessionId: "missing" }, {}, undefined]) {
        readIds.length = 0;
        const expectedIds = records.filter(record => Object.entries(filters ?? {}).every(
          ([key, value]) => value === undefined || record.metadata[key as keyof ContentMetadata] === value,
        )).map(record => record.id);
        const result = await store.search({ text: "needle", filters });
        expect(readIds).toEqual(expectedIds);
        expect(result.totalMatches).toBe(expectedIds.length);
      }
    } finally {
      internals.readBlob = readBlob;
    }
  });

  it("preserves scoped ranking and output limits using authoritative blobs after rescan and deletion", async () => {
    const reference = new InMemoryContentStore();
    const requests = [
      { data: "needle summary exact phrase", metadata: meta({ kind: "compression-summary-v1" }) },
      { data: "summary with a needle elsewhere", metadata: meta({ kind: "compression-summary-v1" }) },
      { data: "needle summary unrelated session", metadata: meta({ sessionId: "other", kind: "compression-summary-v1" }) },
      { data: "needle summary raw source", metadata: meta({ kind: "compression-source-v1" }) },
    ];
    for (const request of requests) {
      const record = await store.write(request);
      await reference.write({ ...request, id: record.id });
    }
    const removed = await store.write({ data: "needle summary removed", metadata: requests[0].metadata });
    await store.delete(removed.id);
    await store.rescan();
    const fresh = new FilesystemContentStore(tmpDir);
    for (const limits of [{}, { maxResults: 1 }, { maxBytes: 1 }, { maxBytes: 35, snippetMaxChars: 12 }]) {
      const query = { text: "needle summary", filters: { sessionId: "sess-fs", kind: "compression-summary-v1" }, ...limits };
      const actual = await fresh.search(query);
      const expected = await reference.search(query);
      expect(actual.items.map(({ record, score, snippet }) => ({ id: record.id, score, snippet })))
        .toEqual(expected.items.map(({ record, score, snippet }) => ({ id: record.id, score, snippet })));
      expect(actual.totalMatches).toBe(expected.totalMatches);
      expect(actual.truncatedBytes).toBe(expected.truncatedBytes);
      expect(actual.truncatedResults).toBe(expected.truncatedResults);
    }
  });

  it("isolates concurrent searches across instances sharing one directory", async () => {
    const concurrentDir = await mkdtemp(join(tmpdir(), "ctx-content-search-concurrent-"));
    try {
      const writer = new FilesystemContentStore(concurrentDir);
      await Promise.all(Array.from({ length: 30 }, (_, index) =>
        writer.write({
          data: `shared archive record unique-term-${index} common-history`,
          metadata: meta({ sessionId: `search-${index}` }),
        })
      ));

      const searches = Array.from({ length: 30 }, () => new FilesystemContentStore(concurrentDir));
      const results = await Promise.all(searches.map((instance, index) =>
        instance.search({ text: `unique term ${index}`, maxResults: 50 })
      ));

      results.forEach((result, index) => {
        expect(result.items.some(item => item.record.metadata.sessionId === `search-${index}`)).toBe(true);
      });
    } finally {
      await rm(concurrentDir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  core/routing.ts — Tool risk classifier
// ══════════════════════════════════════════════════════════════════════════

describe("classifyTool", () => {
  // ── WebFetch / curl / wget ────────────────────────────────────────

  it("denies WebFetch tool", () => {
    const r = classifyTool("WebFetch", { url: "https://example.com" });
    expect(r.outcome).toBe("deny");
    expect(r.risk).toBeGreaterThan(0.9);
  });

  it("denies web_fetch tool", () => {
    const r = classifyTool("web_fetch", { url: "https://example.com" });
    expect(r.outcome).toBe("deny");
  });

  it("denies web_search tool", () => {
    const r = classifyTool("web_search", { query: "test" });
    expect(r.outcome).toBe("deny");
  });

  it("denies curl to stdout", () => {
    const r = classifyTool("bash", { command: "curl https://example.com/api" });
    expect(r.outcome).toBe("deny");
    expect(r.risk).toBeGreaterThanOrEqual(0.9);
  });

  it("allows curl -o file", () => {
    const r = classifyTool("bash", { command: "curl -o output.json https://example.com/api" });
    expect(r.outcome).toBe("allow");
  });

  it("allows curl -O (remote filename)", () => {
    const r = classifyTool("bash", { command: "curl -O https://example.com/file.zip" });
    expect(r.outcome).toBe("allow");
  });

  it("denies wget to stdout", () => {
    const r = classifyTool("bash", { command: "wget https://example.com/file" });
    expect(r.outcome).toBe("deny");
  });

  it("allows wget -O file", () => {
    const r = classifyTool("bash", { command: "wget -O data.csv https://example.com/data.csv" });
    expect(r.outcome).toBe("allow");
  });

  // ── Bounded shell commands ────────────────────────────────────────

  const BOUNDED_ALLOW: Array<[string, string]> = [
    ["ls", "ls"],
    ["ls flags", "ls -la"],
    ["pwd", "pwd"],
    ["echo", "echo hello"],
    ["date", "date"],
    ["stat", "stat /tmp"],
    ["wc", "wc file.txt"],
    ["whoami", "whoami"],
    ["id", "id"],
    ["uname", "uname -a"],
    ["hostname", "hostname"],
    ["which", "which node"],
    ["type", "type ls"],
    ["command -v", "command -v node"],
    ["true", "true"],
    ["false", "false"],
    ["df", "df -h"],
    ["du", "du -sh /tmp"],
    ["ps", "ps aux"],
    ["env", "env"],
    ["git status", "git status"],
    ["git diff", "git diff --stat"],
  ];

  for (const [label, cmd] of BOUNDED_ALLOW) {
    it("allows bounded command: " + label, () => {
      const r = classifyTool("bash", { command: cmd });
      expect(r.outcome).toBe("allow");
      expect(r.risk).toBeLessThan(0.3);
    });
  }

  // ── head / tail ───────────────────────────────────────────────────

  it("allows head -n", () => {
    const r = classifyTool("bash", { command: "head -n 10 file.txt" });
    expect(r.outcome).toBe("allow");
  });

  it("advises head without -n", () => {
    const r = classifyTool("bash", { command: "head file.txt" });
    expect(r.outcome).toBe("advise");
  });

  it("allows tail -n", () => {
    const r = classifyTool("bash", { command: "tail -n 20 log.txt" });
    expect(r.outcome).toBe("allow");
  });

  it("advises tail without -n", () => {
    const r = classifyTool("bash", { command: "tail log.txt" });
    expect(r.outcome).toBe("advise");
  });

  // ── cat ───────────────────────────────────────────────────────────

  it("allows cat with file argument", () => {
    const r = classifyTool("bash", { command: "cat file.txt" });
    expect(r.outcome).toBe("allow");
  });

  it("denies cat without file argument (stdin mode)", () => {
    const r = classifyTool("bash", { command: "cat" });
    expect(r.outcome).toBe("deny");
  });

  it("denies cat with only flags", () => {
    const r = classifyTool("bash", { command: "cat -n" });
    expect(r.outcome).toBe("deny");
  });

  // ── find / locate ────────────────────────────────────────────────

  it("advises find", () => {
    const r = classifyTool("bash", { command: "find / -name '*.txt'" });
    expect(r.outcome).toBe("advise");
  });

  it("advises locate", () => {
    const r = classifyTool("bash", { command: "locate something" });
    expect(r.outcome).toBe("advise");
  });

  // ── dd ────────────────────────────────────────────────────────────

  it("denies dd without count", () => {
    const r = classifyTool("bash", { command: "dd if=/dev/zero" });
    expect(r.outcome).toBe("deny");
  });

  it("allows dd with count=", () => {
    const r = classifyTool("bash", { command: "dd if=/dev/zero of=/dev/null count=100" });
    expect(r.outcome).toBe("allow");
  });

  // ── yes ───────────────────────────────────────────────────────────

  it("denies yes", () => {
    const r = classifyTool("bash", { command: "yes" });
    expect(r.outcome).toBe("deny");
    expect(r.risk).toBeGreaterThan(0.9);
  });

  // ── Git commands ──────────────────────────────────────────────────

  it("allows git status", () => {
    const r = classifyTool("bash", { command: "git status" });
    expect(r.outcome).toBe("allow");
  });

  it("allows git log with -N cap", () => {
    const r = classifyTool("bash", { command: "git log --oneline -5" });
    expect(r.outcome).toBe("allow");
  });

  it("advises git clone", () => {
    const r = classifyTool("bash", { command: "git clone https://example.com/repo" });
    expect(r.outcome).toBe("advise");
  });

  // ── Grep / ripgrep ───────────────────────────────────────────────

  it("allows grep on single file", () => {
    const r = classifyTool("grep", { pattern: "foo", path: "file.txt" });
    expect(r.outcome).toBe("allow");
  });

  it("advises recursive grep", () => {
    const r = classifyTool("grep", { pattern: "foo", path: "src/", recursive: true });
    expect(r.outcome).toBe("advise");
  });

  // ── External MCP tools ────────────────────────────────────────────

  it("advises external MCP tool (name contains dot)", () => {
    const r = classifyTool("github.com_create-issue", { repo: "org/repo" });
    expect(r.outcome).toBe("advise");
    expect(r.risk).toBeGreaterThanOrEqual(0.6);
  });

  it("advises external MCP tool (path-like name)", () => {
    const r = classifyTool("filesystem/readFile", { path: "/etc" });
    expect(r.outcome).toBe("advise");
  });

  // ── Unknown tool ──────────────────────────────────────────────────

  it("advises completely unknown tool (conservative default)", () => {
    const r = classifyTool("some_mystery_tool", { param: "value" });
    expect(r.outcome).toBe("advise");
    expect(r.risk).toBeGreaterThanOrEqual(0.5);
  });

  // ── read tool ────────────────────────────────────────────────────

  it("allows read with explicit limit", () => {
    const r = classifyTool("read", { filePath: "/foo", limit: 1000 });
    expect(r.outcome).toBe("allow");
  });

  it("allows read with maxResults", () => {
    const r = classifyTool("read", { filePath: "/foo", maxResults: 50 });
    expect(r.outcome).toBe("allow");
  });

  it("advises read without limit", () => {
    const r = classifyTool("read", { filePath: "/foo" });
    expect(r.outcome).toBe("advise");
    expect(r.suggestedAlternative).toContain("limit");
  });

  // ── Known bounded tools ──────────────────────────────────────────

  it("allows glob tool", () => {
    const r = classifyTool("glob", { pattern: "**/*.ts" });
    expect(r.outcome).toBe("allow");
  });

  it("allows write tool", () => {
    const r = classifyTool("write", { path: "output.txt", content: "data" });
    expect(r.outcome).toBe("allow");
  });

  it("allows edit tool", () => {
    const r = classifyTool("edit", { filePath: "file.txt", oldStr: "foo", newStr: "bar" });
    expect(r.outcome).toBe("allow");
  });

  // ── Stream processors ────────────────────────────────────────────

  it("advises awk", () => {
    const r = classifyTool("bash", { command: "awk '{print $1}' /var/log/syslog" });
    expect(r.outcome).toBe("advise");
  });

  it("advises sed", () => {
    const r = classifyTool("bash", { command: "sed 's/foo/bar/g' hugefile.txt" });
    expect(r.outcome).toBe("advise");
  });

  it("advises jq", () => {
    const r = classifyTool("bash", { command: "jq '.' huge.json" });
    expect(r.outcome).toBe("advise");
  });

  // ── Wrapper commands ─────────────────────────────────────────────

  it("strips sudo and classifies inner command", () => {
    const r = classifyTool("bash", { command: "sudo ls /root" });
    expect(r.outcome).toBe("allow");
  });

  it("strips timeout and classifies inner command", () => {
    const r = classifyTool("bash", { command: "timeout 10 cat hugefile.txt" });
    expect(r.outcome).toBe("allow"); // cat with file -> allow
  });

  // ── String args ──────────────────────────────────────────────────

  it("handles string-only args", () => {
    const r = classifyTool("bash", "ls -la");
    expect(r.outcome).toBe("allow");
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it("handles empty command gracefully", () => {
    const r = classifyTool("bash", { command: "" });
    expect(r.outcome).toBe("allow");
    expect(r.risk).toBe(0);
  });

  it("handles missing command field", () => {
    const r = classifyTool("bash", {});
    expect(r.outcome).toBe("advise");
  });

  it("advises make", () => {
    const r = classifyTool("bash", { command: "make build" });
    expect(r.outcome).toBe("advise");
  });

  it("advises npm install", () => {
    const r = classifyTool("bash", { command: "npm install" });
    expect(r.outcome).toBe("advise");
  });
});
