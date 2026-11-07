// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Migration contract: unchanged v1 snapshots acquire disposable .json.summary
// sidecars. Old snapshots are parsed serially once per file generation, not once
// per dashboard poll/instance. Only lightweight metadata is cached; selection
// still loads the exact snapshot. Missing token metrics are not guessed.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemContentStore, type SessionHistorySnapshot } from "../adapters/opencode/content-store.js";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
import { contentHash } from "../services/contentStore.js";
import { createInitialState } from "../types/state.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "ctx-lazy-list-"));
  directories.push(directory);
  const store = new FilesystemContentStore(directory);
  await store.ensureDir();
  return { directory, store };
}

function entry(sessionID: string, text: string): HostMessageEntry {
  return {
    info: { id: `${sessionID}-user`, sessionID, role: "user", time: { created: 1 },
      agent: "build", model: { providerID: "test", modelID: "test-model" } },
    parts: [{ type: "text", id: `${sessionID}-text`, sessionID, messageID: `${sessionID}-user`, text }],
  };
}

function snapshot(sessionId: string, updatedAt = 1): SessionHistorySnapshot {
  return {
    version: 1, sessionId, updatedAt, stateVersion: "0:7:1:1:0",
    rawEntries: [entry(sessionId, "  A   useful title  ")],
    projectedEntries: [entry(sessionId, "Exact projected bytes, not a rebuilt projection")],
    summary: { revision: 7, tokenCount: 1234 },
  };
}

function snapshotPath(directory: string, sessionId: string): string {
  const readable = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
  return join(directory, "session-snapshots", `${readable}-${contentHash(sessionId)}.json`);
}

function metadataCache(store: FilesystemContentStore): Map<string, unknown> {
  // Simulate a process restart without adding a production test-only export.
  return (store as unknown as { shared: { historyMetadata: Map<string, unknown> } }).shared.historyMetadata;
}

async function countHistoryParses(run: () => Promise<void>): Promise<number> {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = (text, reviver) => {
    if (text.includes('"rawEntries":')) count++;
    return parse(text, reviver);
  };
  try { await run(); } finally { JSON.parse = parse; }
  return count;
}

describe("lightweight session history metadata", () => {
  it("records only an unambiguous exact assistant cwd and migrates malformed ownership metadata once", async () => {
    const { directory, store } = await setup();
    await expect(store.saveSessionHistory({ ...snapshot("invalid-workspace"), summary: { workspace: "relative-owner" } }))
      .rejects.toThrow("normalized absolute directory");
    expect(await store.loadSessionHistory("invalid-workspace")).toBeUndefined();
    const history = snapshot("workspace-owner");
    const cwd = join(directory, "project");
    const assistant = (id: string, path: string): HostMessageEntry => ({
      info: { id, sessionID: history.sessionId, role: "assistant", time: { created: 2, completed: 3 },
        parentID: history.rawEntries[0].info.id, providerID: "test", modelID: "model", mode: "build",
        path: { cwd: path, root: directory }, cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" },
      parts: [{ type: "text", id: `${id}-text`, sessionID: history.sessionId, messageID: id, text: "response" }],
    });
    history.rawEntries.push(assistant("a1", cwd), assistant("a2", cwd));
    await store.saveSessionHistory(history);
    expect((await store.listSessionHistories())[0].workspace).toBe(cwd);
    const path = snapshotPath(directory, history.sessionId);
    const metadata = JSON.parse(await readFile(`${path}.summary`, "utf8"));
    metadata.summary.workspace = "relative-unsafe-owner";
    await writeFile(`${path}.summary`, JSON.stringify(metadata));
    metadataCache(store).clear();
    expect(await countHistoryParses(async () => {
      expect((await store.listSessionHistories())[0].workspace).toBe(cwd);
      expect((await store.listSessionHistories())[0].workspace).toBe(cwd);
    })).toBe(1);
    history.rawEntries.push(assistant("a3", join(directory, "other-project")));
    await store.saveSessionHistory(history);
    expect((await store.listSessionHistories())[0].workspace).toBeUndefined();
    history.rawEntries.pop();
    history.summary = { revision: 7, workspace: join(directory, "other-project") };
    await store.saveSessionHistory(history);
    expect((await store.listSessionHistories())[0].workspace).toBeUndefined();
  });
  it("bounds large source titles without changing UTF-16 truncation or exact history", async () => {
    const { store } = await setup();
    const history = snapshot("large-title");
    const text = "x".repeat(79) + "\ud83d\ude00" + "y".repeat(100_000);
    history.rawEntries = [entry(history.sessionId, text)];
    await store.saveSessionHistory(history);
    const [summary] = await store.listSessionHistories();
    expect(summary.title).toBe(text.slice(0, 80));
    expect(summary.title).toHaveLength(80);
    expect(await store.loadSessionHistory(history.sessionId)).toEqual(history);
  });

  it("publishes private summaries and lists after a cold metadata cache without parsing histories", async () => {
    const { directory, store } = await setup();
    const history = snapshot("new-session");
    await store.saveSessionHistory(history);
    const path = snapshotPath(directory, history.sessionId);
    const sidecar = JSON.parse(await readFile(`${path}.summary`, "utf8"));
    expect(sidecar.version).toBe(1);
    expect(sidecar.summary).toEqual({ sessionId: history.sessionId, title: "A useful title",
      revision: 7, messageCount: 1, tokenCount: 1234, updatedAt: 1 });
    expect(sidecar.rawEntries).toBeUndefined();
    expect(JSON.stringify([...metadataCache(store).values()])).not.toContain("Exact projected bytes");
    expect(JSON.stringify([...metadataCache(store).values()])).not.toContain("rawEntries");
    if (process.platform !== "win32") {
      expect((await stat(`${path}.summary`)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, "session-snapshots"))).mode & 0o777).toBe(0o700);
    }
    metadataCache(store).clear();
    expect(await countHistoryParses(async () => {
      expect(await new FilesystemContentStore(directory).listSessionHistories()).toEqual([sidecar.summary]);
      expect(await store.listSessionHistories()).toEqual([sidecar.summary]);
    })).toBe(0);
    expect(await store.loadSessionHistory(history.sessionId)).toEqual(history);
  });

  it("migrates both legacy filename forms once across concurrent instances, preserving identity and unknown metrics", async () => {
    const { directory, store } = await setup();
    const old = snapshot("old/session");
    delete old.stateVersion;
    delete old.summary;
    const oldPath = join(directory, "session-snapshots", "old_session.json");
    await writeFile(oldPath, JSON.stringify(old));
    const hashed = snapshot("hashed-legacy", 2);
    delete hashed.summary;
    await writeFile(snapshotPath(directory, hashed.sessionId), JSON.stringify(hashed));
    let revisionLoads = 0;
    const resolveRevision = async (id: string) => { expect(id).toBe(old.sessionId); revisionLoads++; return 9; };
    expect(await countHistoryParses(async () => {
      const lists = await Promise.all(Array.from({ length: 14 }, () =>
        new FilesystemContentStore(directory).listSessionHistories(resolveRevision)));
      for (const list of lists) {
        expect(list.map(s => s.sessionId)).toEqual([hashed.sessionId, old.sessionId]);
        expect(list[1].revision).toBe(9);
        expect(list[0].revision).toBe(7);
        expect(list[1].title).toBe("A useful title");
        expect(list[1].messageCount).toBe(1);
        expect(list[1].tokenCount).toBeUndefined();
      }
    })).toBe(2);
    expect(revisionLoads).toBe(1);
    metadataCache(store).clear();
    expect(await countHistoryParses(async () => { await store.listSessionHistories(resolveRevision); })).toBe(0);
    expect(revisionLoads).toBe(1);
    expect(await store.loadSessionHistory(old.sessionId)).toEqual(old);
    expect(await store.loadSessionHistory("old?session")).toBeUndefined();
  });

  it("deduplicates canonical/legacy paths consistently with selection and never guesses IDs from filenames", async () => {
    const { directory, store } = await setup();
    for (const id of ["a/b", "a?b", "a_b", "x".repeat(160), "x".repeat(160) + "!"]) {
      await store.saveSessionHistory(snapshot(id));
    }
    await writeFile(join(directory, "session-snapshots", "a_b.json"), JSON.stringify(snapshot("a/b", 999)));
    await writeFile(join(directory, "session-snapshots", "wrong-name.json"), JSON.stringify(snapshot("unselectable")));
    const list = await store.listSessionHistories();
    expect(list).toHaveLength(5);
    expect(new Set(list.map(s => s.sessionId)).size).toBe(5);
    expect(list.find(s => s.sessionId === "a/b")?.updatedAt).toBe(1);
    expect((await store.loadSessionHistory("a/b"))?.updatedAt).toBe(1);
    expect(list.some(s => s.sessionId === "unselectable")).toBe(false);
  });

  it("rejects stale/corrupt/misidentified sidecars, caches bad snapshots, and forgets deleted files", async () => {
    const { directory, store } = await setup();
    const first = snapshot("changed", 1);
    await store.saveSessionHistory(first);
    const path = snapshotPath(directory, first.sessionId);
    const replacement = snapshot(first.sessionId, 2);
    replacement.projectedEntries.push(entry(first.sessionId, "Second projected message"));
    await writeFile(`${path}.new`, JSON.stringify(replacement));
    await rename(`${path}.new`, path);
    expect(await countHistoryParses(async () => {
      const list = await store.listSessionHistories();
      expect(list[0].updatedAt).toBe(2);
      expect(list[0].messageCount).toBe(2);
    })).toBe(1);
    const sidecar = JSON.parse(await readFile(`${path}.summary`, "utf8"));
    sidecar.summary.sessionId = "wrong-session";
    await writeFile(`${path}.summary`, JSON.stringify(sidecar));
    metadataCache(store).clear();
    expect(await countHistoryParses(async () => {
      expect((await store.listSessionHistories())[0].sessionId).toBe(first.sessionId);
    })).toBe(1);
    await writeFile(`${path}.summary`, "broken metadata");
    metadataCache(store).clear();
    expect(await countHistoryParses(async () => { await store.listSessionHistories(); })).toBe(1);
    await writeFile(path, '{"rawEntries": malformed');
    expect(await countHistoryParses(async () => {
      expect(await store.listSessionHistories()).toEqual([]);
      expect(await store.listSessionHistories()).toEqual([]);
    })).toBe(1);
    await rm(path);
    expect(await store.listSessionHistories()).toEqual([]);
    expect(metadataCache(store).size).toBe(0);
  });

  it("does not lose exact history when metadata publication fails and does not repeatedly parse the fallback", async () => {
    const { directory, store } = await setup();
    const history = snapshot("metadata-failure");
    const path = snapshotPath(directory, history.sessionId);
    await mkdir(`${path}.summary`); // Force metadata rename to fail after snapshot commit.
    await store.saveSessionHistory(history);
    expect(await store.loadSessionHistory(history.sessionId)).toEqual(history);
    metadataCache(store).clear();
    expect(await countHistoryParses(async () => {
      expect((await store.listSessionHistories())[0].revision).toBe(7);
      expect((await new FilesystemContentStore(directory).listSessionHistories())[0].revision).toBe(7);
    })).toBe(1);
    expect((await readdir(join(directory, "session-snapshots"))).some(file => file.endsWith(".tmp"))).toBe(false);
  });

  it("does not publish metadata for failed snapshots and keeps concurrent writes/listings consistent", async () => {
    const { directory, store } = await setup();
    const bad = snapshot("failed-write");
    const badPath = snapshotPath(directory, bad.sessionId);
    await mkdir(badPath);
    await expect(store.saveSessionHistory(bad)).rejects.toThrow();
    expect(metadataCache(store).has(badPath)).toBe(false);
    await expect(stat(`${badPath}.summary`)).rejects.toThrow();
    const other = new FilesystemContentStore(directory);
    await Promise.all([
      store.saveSessionHistory(snapshot("serialized", 1)),
      other.listSessionHistories(),
      other.saveSessionHistory(snapshot("serialized", 2)),
    ]);
    expect((await store.listSessionHistories()).find(s => s.sessionId === "serialized")?.updatedAt).toBe(2);
    expect((await store.loadSessionHistory("serialized"))?.updatedAt).toBe(2);
  });
});

describe("lazy dashboard session loading", () => {
  it("listing cold chats never loads their histories/state or retains live sessions; selection loads once and restores exact bytes", async () => {
    const { directory, store } = await setup();
    const persistence = new FilePersistence(directory);
    for (let i = 0; i < 8; i++) {
      const history = snapshot(`cold-${i}`, i);
      const state = createInitialState(history.sessionId);
      state.controlRevision = 7;
      history.stateVersion = [state.stats.totalTurns, state.controlRevision, state.nextBlockId,
        state.nextRunId, state.projectionEditRevision ?? 0].join(":");
      await persistence.save(history.sessionId, state);
      await store.saveSessionHistory(history);
    }
    await store.saveSessionHistory(snapshot("deleted-after-listing", 99));
    metadataCache(store).clear();
    let historyLoads = 0;
    let stateLoads = 0;
    const loadHistory = FilesystemContentStore.prototype.loadSessionHistory;
    const loadState = FilePersistence.prototype.load;
    FilesystemContentStore.prototype.loadSessionHistory = async function (id) {
      historyLoads++;
      return loadHistory.call(this, id);
    };
    FilePersistence.prototype.load = async function (id) {
      stateLoads++;
      return loadState.call(this, id);
    };
    try {
      await CtxPlugin({}, { ctx: { storagePath: directory, controlServer: { enabled: true, port: 0, openBrowser: false } } });
      const html = await readFile(join(directory, "ctx-control.html"), "utf8");
      const url = new URL(JSON.parse(html.match(/location\.replace\((".*")\)/)![1]));
      const headers = { Authorization: `Bearer ${url.hash.replace(/^#token=/, "")}` };
      const list = async () => {
        const response = await fetch(`${url.origin}/api/sessions`, { headers });
        expect(response.status).toBe(200);
        return (await response.json() as { data: Array<{ sessionId: string; revision: number; tokenCount?: number }> }).data;
      };
      expect(await countHistoryParses(async () => {
        const summaries = await list();
        expect(summaries).toHaveLength(9);
        expect(summaries[0].sessionId).toBe("deleted-after-listing");
        expect(summaries[1].revision).toBe(7);
        expect(summaries[1].tokenCount).toBe(1234);
        await list();
      })).toBe(0);
      expect(historyLoads).toBe(0);
      expect(stateLoads).toBe(0);
      await rm(snapshotPath(directory, "deleted-after-listing"));
      expect(await list()).toHaveLength(8); // It was not inserted into the live map.
      const detail = await fetch(`${url.origin}/api/sessions/cold-3`, { headers });
      expect(detail.status).toBe(200);
      const selected = (await detail.json() as { data: { revision: number; rawHostHistory: Array<{ parts: unknown }>; projectedContext: Array<{ parts: unknown }> } }).data;
      expect(selected.revision).toBe(7);
      expect(selected.rawHostHistory[0].parts).toEqual(snapshot("cold-3").rawEntries[0].parts);
      expect(selected.projectedContext[0].parts).toEqual(snapshot("cold-3").projectedEntries[0].parts);
      expect(historyLoads).toBe(1);
      expect(stateLoads).toBe(1);
      await list();
      expect(historyLoads).toBe(1);
      expect(stateLoads).toBe(1);
      const legacy = snapshot("legacy-revision", 100);
      delete legacy.stateVersion;
      delete legacy.summary;
      const legacyState = createInitialState(legacy.sessionId);
      legacyState.controlRevision = 11;
      await persistence.save(legacy.sessionId, legacyState);
      await store.saveSessionHistory(legacy);
      const legacySummary = (await list()).find(s => s.sessionId === legacy.sessionId)!;
      expect(legacySummary.revision).toBe(11);
      expect(legacySummary.tokenCount).toBeUndefined();
      expect(stateLoads).toBe(2); // One-time legacy revision lookup, not hydration.
      expect(historyLoads).toBe(1);
      await list();
      expect(stateLoads).toBe(2);
      await rm(snapshotPath(directory, legacy.sessionId));
      await rm(snapshotPath(directory, "cold-3"));
      const remaining = await list();
      expect(remaining.some(s => s.sessionId === legacy.sessionId)).toBe(false);
      expect(remaining.some(s => s.sessionId === "cold-3")).toBe(true); // Only the selected chat is live.
    } finally {
      FilesystemContentStore.prototype.loadSessionHistory = loadHistory;
      FilePersistence.prototype.load = loadState;
    }
  });
});

describe("queued plugin history ownership", () => {
  it("awaits owned history serialization before a same-session follow-up transform", async () => {
    const { directory, store } = await setup();
    const sessionId = "owned-history";
    const persistence = new FilePersistence(directory);
    const state = createInitialState(sessionId);
    state.controlRevision = 7;
    await persistence.save(sessionId, state);
    const hooks = await CtxPlugin({}, { ctx: { storagePath: directory, tokenizer: "char",
      controlServer: { enabled: false }, automation: { automaticPruning: false, modelCompression: false } } });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID: string }, output: { messages: HostMessageEntry[] },
    ) => Promise<void>;
    const shared = (store as unknown as { shared: { historyChain: Promise<void> } }).shared;
    let releaseHistory!: () => void;
    const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
    shared.historyChain = shared.historyChain.then(() => historyGate);
    let notifySaveQueued!: () => void;
    const saveQueued = new Promise<void>(resolve => { notifySaveQueued = resolve; });
    const saveHistory = FilesystemContentStore.prototype.saveSessionHistory;
    const saved: SessionHistorySnapshot[] = [];
    FilesystemContentStore.prototype.saveSessionHistory = async function (history) {
      const pending = saveHistory.call(this, history);
      if (history.sessionId === sessionId) notifySaveQueued();
      await pending;
      if (history.sessionId === sessionId) saved.push((await this.loadSessionHistory(sessionId))!);
    };
    const workspaceRoot = process.env.WORKSPACES_ROOT;
    process.env.WORKSPACES_ROOT = directory;
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      const hostEntry = entry(sessionId, "First owned input");
      const expectedRaw = structuredClone([hostEntry]);
      const output = { messages: [hostEntry] };
      let firstFinished = false;
      first = transform({ sessionID: sessionId }, output).then(() => { firstFinished = true; });
      await Promise.race([saveQueued, first.then(() => { throw new Error("Transform returned before queuing history"); })]);
      const expectedProjected = structuredClone(output.messages);
      expect(expectedProjected).not.toEqual(expectedRaw);

      // Mutate both the original host objects and the emitted projection while
      // another store instance's shared history queue still owns the save gate.
      hostEntry.info.time.created = 999;
      (hostEntry.parts[0] as { text: string }).text = "Mutated original input";
      (output.messages[0].parts[0] as { text: string }).text = "Mutated emitted projection";
      output.messages.push(entry(sessionId, "Later host-only message"));
      const followUp = { messages: [entry(sessionId, "Second owned input")] };
      const expectedSecondRaw = structuredClone(followUp.messages);
      second = transform({ sessionID: sessionId }, followUp);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(firstFinished).toBe(false);
      expect(followUp.messages).toEqual(expectedSecondRaw);
      expect((await persistence.load(sessionId))?.stats.totalTurns).toBe(1);
      expect(await store.loadSessionHistory(sessionId)).toBeUndefined();

      releaseHistory();
      await Promise.all([first, second]);
      expect(saved).toHaveLength(2);
      expect(saved[0].rawEntries).toEqual(expectedRaw);
      expect(saved[0].projectedEntries).toEqual(expectedProjected);
      expect(saved[0].summary?.revision).toBe(7);
      expect(saved[0].stateVersion?.split(":").slice(0, 2)).toEqual(["1", "7"]);
      expect(saved[1].rawEntries).toEqual(expectedSecondRaw);
      expect(saved[1].projectedEntries).toEqual(followUp.messages);
      expect(saved[1].summary?.revision).toBe(7);
      expect(saved[1].stateVersion?.split(":").slice(0, 2)).toEqual(["2", "7"]);
      expect(await store.loadSessionHistory(sessionId)).toEqual(saved[1]);
      expect((await persistence.load(sessionId))?.stats.totalTurns).toBe(2);
    } finally {
      releaseHistory();
      await Promise.allSettled([first, second]);
      FilesystemContentStore.prototype.saveSessionHistory = saveHistory;
      if (workspaceRoot === undefined) delete process.env.WORKSPACES_ROOT;
      else process.env.WORKSPACES_ROOT = workspaceRoot;
    }
  });
});
