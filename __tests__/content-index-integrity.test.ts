// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { afterEach, describe, expect, it } from "bun:test";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { deriveContentId } from "../services/contentStore.js";
import type { ContentRecord } from "../services/contentStore.js";
import { archiveCompressionSource, archiveCompressionSummary } from "../adapters/opencode/compression-archive.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "content-index-integrity-"));
  dirs.push(path);
  await mkdir(join(path, "content-blobs"));
  await writeFile(join(path, "content-index.json"), JSON.stringify({ version: 1, records: {} }));
  return path;
}
const metadata = { sessionId: "integrity-session", kind: "test" };
function record(id = "explicit-id", data = "intact archive") {
  return { id, data, metadata, createdAt: 1, byteSize: Buffer.byteLength(data) };
}
async function index(path: string) { return JSON.parse(await readFile(join(path, "content-index.json"), "utf8")); }
async function blob(path: string, value: ContentRecord = record(), filename = value.id) {
  await writeFile(join(path, "content-blobs", `${filename}.json`), JSON.stringify(value));
}

// A real separate runtime per store: no shared module cache or shared JS maps.
async function childStore(path: string) {
  const script = join(path, "child.ts");
  const module = new URL("../adapters/opencode/content-store.ts", import.meta.url).href;
  const archives = new URL("../adapters/opencode/compression-archive.ts", import.meta.url).href;
  await writeFile(script, `
    import { FilesystemContentStore } from ${JSON.stringify(module)};
    const store = new FilesystemContentStore(process.argv[2]);
    await store.size();
    process.send({ready: true});
    process.on('message', async ({command, id}) => {
      try {
        let result;
        if (command === 'write') result = (await store.writeWithStatus({id, data: id, metadata: {sessionId: 'child'}})).record.id;
        if (command === 'writeMany') result = await store.writeMany(JSON.parse(id).map(id => ({id, data: id, metadata: {sessionId: 'child'}})));
        if (command === 'delete') result = await store.delete(id);
        if (command === 'list') result = (await store.list()).map(r => r.id).sort();
        if (command === 'loadArchives') {
          const { loadCompressionSource, loadCompressionSummary } = await import(${JSON.stringify(archives)});
          const [source, summary] = JSON.parse(id);
          result = {
            source: await loadCompressionSource(store, source, 'session', 'b1', ['message-1']),
            summary: await loadCompressionSummary(store, summary, 'session', 'b1'),
          };
        }
        process.send({result});
      } catch (error) { process.send({error: String(error)}); }
    });
  `);
  const child = fork(script, [path], { execPath: process.execPath, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  let errors = "";
  child.stderr!.on("data", data => { errors += data; });
  function receive(): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`child timeout: ${errors}`)); }, 10_000);
      const message = (value: any) => { cleanup(); value.error ? reject(new Error(value.error)) : resolve(value); };
      const exit = () => { cleanup(); reject(new Error(`child exited: ${errors}`)); };
      const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
      child.once("message", message);
      child.once("exit", exit);
    });
  }
  await receive();
  return async (command: string, id?: string) => {
    const reply = receive();
    child.send({ command, id });
    return (await reply).result;
  };
}

describe("content index integrity", () => {
  it("adopts and persists intact unindexed content-derived and explicit blobs", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await store.size();
    for (const id of ["explicit-id", deriveContentId("intact archive", metadata)]) {
      await blob(path, record(id));
      expect(await store.get(id)).toEqual(record(id));
      expect((await index(path)).records[id].id).toBe(id);
    }
    const existing = await store.writeWithStatus({ id: "explicit-id", data: "do not overwrite", metadata });
    expect(existing.created).toBe(false);
    expect(existing.record.data).toBe("intact archive");
  });

  it("writeWithStatus recovers an unindexed immutable blob rather than overwriting it", async () => {
    const path = await directory();
    await blob(path);
    const result = await new FilesystemContentStore(path).writeWithStatus({ id: "explicit-id", data: "replacement", metadata });
    expect(result.created).toBe(false);
    expect(result.record.data).toBe("intact archive");
  });

  it("never adopts pending, mismatched, malformed, or absent blobs", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await blob(path);
    await writeFile(join(path, "content-blobs", "explicit-id.pending"), "1");
    expect(await store.get("explicit-id")).toBeUndefined();
    await blob(path, record("wrong-id"), "mismatched");
    await expect(store.get("mismatched")).rejects.toThrow("blob id mismatch");
    await writeFile(join(path, "content-blobs", "malformed.json"), JSON.stringify({ id: "malformed", data: "x", metadata: null }));
    await expect(store.get("malformed")).rejects.toThrow("malformed blob");
    const before = await readFile(join(path, "content-index.json"), "utf8");
    const stamp = (await stat(join(path, "content-index.json"))).mtimeMs;
    expect(await store.get("absent")).toBeUndefined();
    expect(await store.get("absent")).toBeUndefined();
    expect(await readFile(join(path, "content-index.json"), "utf8")).toBe(before);
    expect((await stat(join(path, "content-index.json"))).mtimeMs).toBe(stamp);
    expect(Object.keys((await index(path)).records)).toEqual([]);
  });

  it("read failures and corrupt present blobs propagate without deleting metadata", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    const value = await store.write({ id: "unreadable", data: "x", metadata });
    const bp = join(path, "content-blobs", `${value.id}.json`);
    await rm(bp);
    // EISDIR reliably simulates an I/O error even in root-run CI (unlike chmod).
    await mkdir(bp);
    await expect(store.get(value.id)).rejects.toThrow();
    expect((await index(path)).records[value.id]).toBeDefined();
    expect(await store.size()).toBe(1);
    await rm(bp, { recursive: true });
    await writeFile(bp, "{ truncated");
    await expect(store.get(value.id)).rejects.toThrow();
    expect((await index(path)).records[value.id]).toBeDefined();
  });

  it("retries failed recovery publication without deleting the intact orphan blob", async () => {
    const path = await directory();
    await blob(path);
    const store = new FilesystemContentStore(path);
    const internals = store as unknown as { saveIndex: (...args: any[]) => Promise<void> };
    const save = internals.saveIndex;
    internals.saveIndex = async () => { throw new Error("injected repair failure"); };
    await expect(store.get("explicit-id")).rejects.toThrow("injected repair failure");
    expect(await store.size()).toBe(0);
    expect(JSON.parse(await readFile(join(path, "content-blobs", "explicit-id.json"), "utf8"))).toEqual(record());
    internals.saveIndex = save;
    expect(await store.get("explicit-id")).toEqual(record());
    expect((await index(path)).records["explicit-id"]).toBeDefined();
  });

  it("excludes foreign pending publications when merging a changed disk index", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await store.size();
    const pending = record("foreign-pending");
    await blob(path, pending);
    await writeFile(join(path, "content-blobs", "foreign-pending.pending"), "1");
    await writeFile(join(path, "content-index.json"), JSON.stringify({ version: 1, records: {
      [pending.id]: { id: pending.id, ...pending.metadata, createdAt: pending.createdAt, byteSize: pending.byteSize },
    } }));
    await store.write({ id: "committed", data: "x", metadata });
    expect(Object.keys((await index(path)).records)).toEqual(["committed"]);
    expect(await store.get(pending.id)).toBeUndefined();
  });

  it("preserves both real-process publications after both processes warm the same index", async () => {
    for (let iteration = 0; iteration < 4; iteration++) {
      const path = await directory();
      const [a, b] = await Promise.all([childStore(path), childStore(path)]);
      await Promise.all([a("write", "process-a"), b("write", "process-b")]);
      const fresh = await childStore(path);
      expect(await fresh("list")).toEqual(["process-a", "process-b"]);
      expect(Object.keys((await index(path)).records).sort()).toEqual(["process-a", "process-b"]);
    }
  });

  it("does not resurrect another process's deletion from a stale cache", async () => {
    const path = await directory();
    await new FilesystemContentStore(path).write({ id: "deleted", data: "x", metadata });
    const [a, b] = await Promise.all([childStore(path), childStore(path)]);
    await a("delete", "deleted");
    await b("write", "survivor");
    expect(Object.keys((await index(path)).records)).toEqual(["survivor"]);
  });

  it("keeps local pending deletions when merging an on-disk copy containing that id", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await store.write({ id: "deleted", data: "x", metadata });
    const internals = store as unknown as { saveIndex: (...args: any[]) => Promise<void> };
    const save = internals.saveIndex;
    internals.saveIndex = async () => { throw new Error("injected failure"); };
    await expect(store.delete("deleted")).rejects.toThrow("injected failure");
    internals.saveIndex = save;
    const disk = await index(path);
    disk.records.external = { ...disk.records.deleted, id: "external" };
    await writeFile(join(path, "content-index.json"), JSON.stringify(disk));
    await store.write({ id: "new", data: "new", metadata });
    expect(Object.keys((await index(path)).records).sort()).toEqual(["external", "new"]);
  });

  it("recovers dead and abandoned malformed locks", async () => {
    const path = await directory();
    const lock = join(path, "content-index.json.lock");
    await writeFile(lock, JSON.stringify({ pid: 2147483647, timestamp: Date.now() }));
    const store = new FilesystemContentStore(path);
    await store.write({ id: "dead-owner", data: "x", metadata });
    await writeFile(lock, "{ partial lock");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await store.write({ id: "abandoned", data: "x", metadata });
    expect(await store.size()).toBe(2);
  });

  it("waits for a live held lock, even when old, rather than stealing it", async () => {
    const path = await directory();
    const lock = join(path, "content-index.json.lock");
    const contents = JSON.stringify({ pid: process.pid, timestamp: 1 });
    await writeFile(lock, contents);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let done = false;
    const writing = new FilesystemContentStore(path).write({ id: "waited", data: "x", metadata }).then(() => { done = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(done).toBe(false);
    expect(await readFile(lock, "utf8")).toBe(contents);
    await rm(lock);
    await writing;
    expect((await index(path)).records.waited).toBeDefined();
  });

  it("repairs missing source and summary index entries when loading compression archives", async () => {
    const writerPath = await directory();
    const writer = new FilesystemContentStore(writerPath);
    const entries = [{ info: { id: "message-1", sessionID: "session", role: "user" }, parts: [{ type: "text", text: "source" }] }] as HostMessageEntry[];
    const source = await archiveCompressionSource(writer, "session", "b1", "topic", ["message-1"], entries);
    const summary = await archiveCompressionSummary(writer, "session", "b1", "topic", "full summary");
    const damaged = await index(writerPath);
    delete damaged.records[source.record.id];
    delete damaged.records[summary.record.id];
    await writeFile(join(writerPath, "content-index.json"), JSON.stringify(damaged));
    // A new process cannot reuse the writer's shared in-memory index.
    const reader = await childStore(writerPath);
    expect(await reader("loadArchives", JSON.stringify([source.record.id, summary.record.id])))
      .toEqual({ source: entries, summary: "full summary" });
    expect(Object.keys((await index(writerPath)).records).sort()).toEqual([source.record.id, summary.record.id].sort());
  });

  it("merges writeMany with a concurrent real-process writeWithStatus publication", async () => {
    for (let iteration = 0; iteration < 4; iteration++) {
      const path = await directory();
      const [a, b] = await Promise.all([childStore(path), childStore(path)]);
      const ids = ["batch-a", "batch-b", "batch-c"];
      const [batch] = await Promise.all([a("writeMany", JSON.stringify(ids)), b("write", "single")]);
      expect(batch).toEqual(ids.map(id => ({ id, created: true })));
      const fresh = await childStore(path);
      expect(await fresh("list")).toEqual([...ids, "single"]);
      expect(Object.keys((await index(path)).records).sort()).toEqual([...ids, "single"]);
    }
  });

  it("does not publish rolled-back batch upserts on a later merge", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await store.write({ id: "keep", data: "keep", metadata });
    const internals = store as unknown as { saveIndex: (...args: any[]) => Promise<void> };
    const save = internals.saveIndex;
    internals.saveIndex = async () => { throw new Error("batch publish failure"); };
    await expect(store.writeMany(["failed-a", "failed-b"].map(id => ({ id, data: id, metadata }))))
      .rejects.toThrow("batch publish failure");
    internals.saveIndex = save;
    const other = await childStore(path);
    await other("write", "foreign");
    await store.write({ id: "later", data: "later", metadata });
    const fresh = await childStore(path);
    expect(await fresh("list")).toEqual(["foreign", "keep", "later"]);
    expect(Object.keys((await index(path)).records).sort()).toEqual(["foreign", "keep", "later"]);
  });

  it("repairs unindexed batch records with one publication and preserves immutable data", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await blob(path, record("orphan-a"));
    await blob(path, record("orphan-b"));
    const internals = store as unknown as { saveIndex: (...args: any[]) => Promise<void> };
    const save = internals.saveIndex.bind(store);
    let saves = 0;
    internals.saveIndex = async (...args) => { saves++; await save(...args); };
    expect(await store.writeMany(["orphan-a", "orphan-b", "new"].map(id => ({ id, data: "replacement", metadata }))))
      .toEqual([{ id: "orphan-a", created: false }, { id: "orphan-b", created: false }, { id: "new", created: true }]);
    expect(saves).toBe(1);
    expect((await store.get("orphan-a"))?.data).toBe("intact archive");
    expect(Object.keys((await index(path)).records).sort()).toEqual(["new", "orphan-a", "orphan-b"]);
  });

  it("rejects pending batch blobs and rolls back deferred repairs without deleting originals", async () => {
    const path = await directory();
    const store = new FilesystemContentStore(path);
    await blob(path, record("orphan"));
    await blob(path, record("pending"));
    await writeFile(join(path, "content-blobs", "pending.pending"), "1");
    await expect(store.writeMany(["orphan", "new", "pending"].map(id => ({ id, data: "replacement", metadata }))))
      .rejects.toThrow("publication is pending");
    const other = await childStore(path);
    await other("write", "foreign");
    await store.write({ id: "later", data: "later", metadata });
    expect(Object.keys((await index(path)).records).sort()).toEqual(["foreign", "later"]);
    expect(JSON.parse(await readFile(join(path, "content-blobs", "orphan.json"), "utf8"))).toEqual(record("orphan"));
    expect((await store.get("orphan"))?.data).toBe("intact archive");
    expect(await store.get("new")).toBeUndefined();
  });

  describe("stale pending markers left by killed writers", () => {
    const old = new Date(Date.now() - 11 * 60_000);
    async function marker(path: string, id: string, body: string, aged = false) {
      const file = join(path, "content-blobs", `${id}.pending`);
      await writeFile(file, body);
      if (aged) await utimes(file, old, old);
      return file;
    }
    function deadPid(): number {
      return spawnSync(process.execPath, ["-e", ""]).pid!;
    }

    it("batch writes adopt the blob behind an aged legacy marker instead of failing the batch", async () => {
      const path = await directory();
      const store = new FilesystemContentStore(path);
      await blob(path, record("stuck"));
      const file = await marker(path, "stuck", "1", true);
      expect(await store.get("stuck")).toBeUndefined();
      expect(await store.writeMany(["stuck", "new"].map(id => ({ id, data: "replacement", metadata }))))
        .toEqual([{ id: "stuck", created: false }, { id: "new", created: true }]);
      await expect(stat(file)).rejects.toThrow();
      expect((await store.get("stuck"))?.data).toBe("intact archive");
      expect(Object.keys((await index(path)).records).sort()).toEqual(["new", "stuck"]);
    });

    it("single writes reclaim a fresh marker whose writer PID is dead", async () => {
      const path = await directory();
      await blob(path, record("crashed"));
      await marker(path, "crashed", JSON.stringify({ pid: deadPid(), at: Date.now() }));
      const result = await new FilesystemContentStore(path).writeWithStatus({ id: "crashed", data: "replacement", metadata });
      expect(result.created).toBe(false);
      expect(result.record.data).toBe("intact archive");
    });

    it("a reclaimed marker without a blob is followed by a normal fresh write", async () => {
      const path = await directory();
      const store = new FilesystemContentStore(path);
      await marker(path, "lost", "1", true);
      const result = await store.writeWithStatus({ id: "lost", data: "fresh", metadata });
      expect(result.created).toBe(true);
      expect((await store.get("lost"))?.data).toBe("fresh");
      await expect(stat(join(path, "content-blobs", "lost.pending"))).rejects.toThrow();
    });

    it("still rejects a fresh marker held by a live process", async () => {
      const path = await directory();
      const store = new FilesystemContentStore(path);
      await blob(path, record("busy"));
      await marker(path, "busy", JSON.stringify({ pid: process.ppid, at: Date.now() }));
      await expect(store.write({ id: "busy", data: "replacement", metadata })).rejects.toThrow("publication is pending");
      await expect(store.writeMany([{ id: "busy", data: "replacement", metadata }])).rejects.toThrow("publication is pending");
      expect(await store.get("busy")).toBeUndefined();
    });

    it("new markers record the writer PID", async () => {
      const path = await directory();
      const store = new FilesystemContentStore(path);
      let seen: string | undefined;
      const original = (store as unknown as { saveIndex: (...args: unknown[]) => Promise<void> }).saveIndex.bind(store);
      (store as unknown as { saveIndex: (...args: unknown[]) => Promise<void> }).saveIndex = async (...args: unknown[]) => {
        seen = await readFile(join(path, "content-blobs", "observed.pending"), "utf8");
        return original(...args);
      };
      await store.write({ id: "observed", data: "x", metadata });
      expect(JSON.parse(seen!)).toMatchObject({ pid: process.pid });
    });
  });
});
