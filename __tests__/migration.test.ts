// MIT License - see LICENSE

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  importUpstreamSession,
  planUpstreamSessionImport,
  upstreamSidecarPath,
} from "../migration/importer.js";
import { loadCompressionSource, loadCompressionSummary } from "../adapters/opencode/compression-archive.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
import { InMemoryContentStore } from "../services/contentStore.js";
import type { Persistence } from "../services/persistence.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { createInitialState } from "../types/state.js";

const SESSION = "ses_import_fixture";

function entry(id: string, role: "user" | "assistant", created: number, text: string): HostMessageEntry {
  if (role === "user") {
    return {
      info: {
        id,
        sessionID: SESSION,
        role,
        time: { created },
        agent: "test",
        model: { providerID: "p", modelID: "m" },
      },
      parts: [{ id: `${id}-text`, sessionID: SESSION, messageID: id, type: "text", text }],
    };
  }
  return {
    info: {
      id,
      sessionID: SESSION,
      role,
      time: { created, completed: created + 1 },
      parentID: "u1",
      modelID: "m",
      providerID: "p",
      mode: "test",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: `${id}-text`, sessionID: SESSION, messageID: id, type: "text", text }],
  };
}

function fixture(): any {
  return {
    manualMode: false,
    prune: {
      tools: { old_call: 12 },
      messages: {
        byMessageId: {
          u1: { tokenCount: 40, allBlockIds: [1, 2], activeBlockIds: [2] },
          a1: { tokenCount: 60, allBlockIds: [1, 2], activeBlockIds: [2] },
          u2: { tokenCount: 80, allBlockIds: [2], activeBlockIds: [2] },
        },
        blocksById: {
          "1": {
            blockId: 1,
            runId: 1,
            active: false,
            deactivatedByUser: false,
            compressedTokens: 100,
            summaryTokens: 10,
            durationMs: 1,
            mode: "range",
            topic: "first phase",
            startId: "m0001",
            endId: "m0002",
            anchorMessageId: "u1",
            compressMessageId: "compress-1",
            includedBlockIds: [],
            consumedBlockIds: [],
            parentBlockIds: [2],
            directMessageIds: ["u1", "a1"],
            directToolIds: [],
            effectiveMessageIds: ["u1", "a1"],
            effectiveToolIds: [],
            createdAt: 10,
            summary: "summary one",
          },
          "2": {
            blockId: 2,
            runId: 2,
            active: true,
            deactivatedByUser: false,
            compressedTokens: 80,
            summaryTokens: 20,
            durationMs: 1,
            mode: "range",
            topic: "combined phase",
            startId: "b1",
            endId: "m0003",
            anchorMessageId: "u1",
            compressMessageId: "compress-2",
            includedBlockIds: [1],
            consumedBlockIds: [1],
            parentBlockIds: [],
            directMessageIds: ["u2"],
            directToolIds: [],
            effectiveMessageIds: ["u1", "a1", "u2"],
            effectiveToolIds: [],
            createdAt: 30,
            summary: "summary two preserves first phase",
          },
        },
        activeBlockIds: [2],
        activeByAnchorMessageId: { u1: 2 },
        nextBlockId: 3,
        nextRunId: 3,
      },
    },
    nudges: { contextLimitAnchors: [] },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 172 },
    lastUpdated: "2026-01-01T00:00:00.000Z",
  };
}

function history(): HostMessageEntry[] {
  return [
    entry("u1", "user", 1, "first request"),
    entry("a1", "assistant", 2, "first answer"),
    entry("u2", "user", 20, "second request"),
  ];
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    upstreamState: fixture(),
    currentState: createInitialState(SESSION),
    hostEntries: history(),
    tokenizer: new CharTokenizer(),
    ...overrides,
  };
}

describe("upstream DCP session import", () => {
  it("maps a nested graph without writing during planning", () => {
    const plan = planUpstreamSessionImport(input());
    expect(plan.blocks).toHaveLength(2);
    expect(plan.activeBlockIds).toEqual(["b2"]);
    expect(plan.skippedPrunedTools).toBe(1);
    expect(plan.nextState.nextBlockId).toBe(3);
    expect(plan.nextState.nextRunId).toBe(3);
    expect(plan.nextState.blockRegistry.get("b1")?.consumed).toBe(true);
    expect(plan.nextState.blockRegistry.get("b1")?.parentBlockIds).toEqual(["b2"]);
    expect(plan.nextState.blockRegistry.get("b2")?.includedBlockIds).toEqual(["b1"]);
    expect(plan.nextState.blockRegistry.get("b2")?.sourceTokens).toBe(180);
    expect(plan.nextState.blockRegistry.get("b2")?.netTokens).toBe(160);
    expect(plan.nextState.compressionIndex.get("u1")?.replacedByBlockId).toBe("b2");
    expect(plan.nextState.stats.totalCompressRuns).toBe(2);
    expect(plan.nextState.stats.totalTokensCompressed).toBe(160);
  });

  it("dry-run creates no archives and persists no state", async () => {
    const store = new InMemoryContentStore();
    let saves = 0;
    const persistence: Persistence = { load: async () => undefined, save: async () => { saves++; } };
    const result = await importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: true });
    expect(result.report.dryRun).toBe(true);
    expect(await store.size()).toBe(0);
    expect(saves).toBe(0);
  });

  it("confirmed import writes and verifies dual archives before one state save", async () => {
    const store = new InMemoryContentStore();
    const saved = [] as ReturnType<typeof createInitialState>[];
    const persistence: Persistence = { load: async () => undefined, save: async (_id, state) => { saved.push(state); } };
    const result = await importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: false });
    expect(result.report.archivedSources).toBe(2);
    expect(result.report.archivedSummaries).toBe(2);
    expect(await store.size()).toBe(4);
    expect(saved).toHaveLength(1);
    const parent = result.state.blockRegistry.get("b2")!;
    expect(parent.durableSourceRef).toBeDefined();
    expect(parent.durableSummaryRef).toBeDefined();
    expect(await loadCompressionSummary(store, parent.durableSummaryRef!, SESSION, "b2")).toBe(parent.summaryText);
    expect((await loadCompressionSource(store, parent.durableSourceRef!, SESSION, "b2", parent.effectiveMessageIds)).map(item => item.info.id))
      .toEqual(["u1", "a1", "u2"]);
  });

  it("is idempotent when the same verified graph is already imported", async () => {
    const store = new InMemoryContentStore();
    let saves = 0;
    const persistence: Persistence = { load: async () => undefined, save: async () => { saves++; } };
    const first = await importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: false });
    const size = await store.size();
    const second = await importUpstreamSession({ ...input({ currentState: first.state }), contentStore: store, persistence, dryRun: false });
    expect(second.report.alreadyImported).toBe(true);
    expect(await store.size()).toBe(size);
    expect(saves).toBe(1);
  });

  it("repairs derived indexes on an idempotent confirmed retry", async () => {
    const store = new InMemoryContentStore();
    let saves = 0;
    const persistence: Persistence = { load: async () => undefined, save: async () => { saves++; } };
    const first = await importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: false });
    first.state.compressionIndex.clear();
    first.state.activeByAnchorMessageId.clear();
    const second = await importUpstreamSession({ ...input({ currentState: first.state }), contentStore: store, persistence, dryRun: false });
    expect(second.report.alreadyImported).toBe(true);
    expect(second.report.stateRepaired).toBe(true);
    expect(second.state.compressionIndex.get("u1")?.replacedByBlockId).toBe("b2");
    expect(second.state.activeByAnchorMessageId.get("u1")).toBe("b2");
    expect(second.state.projectionEditRevision).toBe(first.state.projectionEditRevision + 1);
    expect(saves).toBe(2);
  });

  it("rejects an idempotent retry when an imported archive is missing", async () => {
    const store = new InMemoryContentStore();
    const persistence: Persistence = { load: async () => undefined, save: async () => {} };
    const first = await importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: false });
    const ref = first.state.blockRegistry.get("b1")!.durableSummaryRef!;
    await store.delete(ref);
    await expect(importUpstreamSession({
      ...input({ currentState: first.state }),
      contentStore: store,
      persistence,
      dryRun: false,
    })).rejects.toThrow("archive is missing");
  });

  it("rejects compacted history with missing exact sources", () => {
    expect(() => planUpstreamSessionImport(input({ hostEntries: history().filter(item => item.info.id !== "a1") })))
      .toThrow("exact source message reference(s) are unavailable");
  });

  it("can preserve a legacy summary without claiming missing sources are recoverable", async () => {
    const store = new InMemoryContentStore();
    const persistence: Persistence = { load: async () => undefined, save: async () => {} };
    const result = await importUpstreamSession({
      ...input({ hostEntries: history().filter(item => item.info.id !== "a1") }),
      contentStore: store,
      persistence,
      dryRun: false,
      allowIncompleteSources: true,
    });
    expect(result.report.incompleteSourceBlocks).toBe(2);
    expect(result.report.archivedSources).toBe(0);
    expect(result.report.archivedSummaries).toBe(2);
    expect(result.state.blockRegistry.get("b2")?.durableSourceRef).toBeUndefined();
    expect(result.state.blockRegistry.get("b2")?.durableSummaryRef).toBeDefined();
  });

  it("accepts upstream effective coverage that safely contains additional indexed messages", () => {
    const upstream = fixture();
    upstream.prune.messages.blocksById["1"].effectiveMessageIds.push("u2");
    upstream.prune.messages.byMessageId.u2.allBlockIds = [1, 2];
    const plan = planUpstreamSessionImport(input({ upstreamState: upstream }));
    expect(plan.nextState.blockRegistry.get("b1")?.effectiveMessageIds).toContain("u2");
  });

  it("preserves indexed upstream active overlap when anchors remain distinct", () => {
    const upstream = fixture();
    const first = upstream.prune.messages.blocksById["1"];
    const parent = upstream.prune.messages.blocksById["2"];
    first.active = true;
    first.parentBlockIds = [];
    first.anchorMessageId = "a1";
    parent.includedBlockIds = [];
    parent.consumedBlockIds = [];
    parent.directMessageIds = ["u1", "a1", "u2"];
    upstream.prune.messages.byMessageId.u1.activeBlockIds = [1, 2];
    upstream.prune.messages.byMessageId.a1.activeBlockIds = [1, 2];
    upstream.prune.messages.activeBlockIds = [1, 2];
    upstream.prune.messages.activeByAnchorMessageId = { a1: 1, u1: 2 };
    const plan = planUpstreamSessionImport(input({ upstreamState: upstream }));
    expect(plan.activeBlockIds).toEqual(["b1", "b2"]);
    expect(plan.nextState.compressionIndex.get("u1")?.replacedByBlockId).toBeDefined();
  });

  it("repairs an empty upstream active-anchor derived index", () => {
    const upstream = fixture();
    upstream.prune.messages.activeByAnchorMessageId = {};
    const plan = planUpstreamSessionImport(input({ upstreamState: upstream }));
    expect(plan.nextState.activeByAnchorMessageId.get("u1")).toBe("b2");
  });

  it("rejects duplicate or cross-session host history", () => {
    expect(() => planUpstreamSessionImport(input({ hostEntries: [...history(), history()[0]] }))).toThrow("duplicate message ids");
    const wrong = history();
    wrong[0] = structuredClone(wrong[0]);
    wrong[0].info.sessionID = "another-session";
    expect(() => planUpstreamSessionImport(input({ hostEntries: wrong }))).toThrow("another session");
  });

  it("rejects malformed graph references", () => {
    const malformed = fixture();
    malformed.prune.messages.blocksById["1"].parentBlockIds = [99];
    expect(() => planUpstreamSessionImport(input({ upstreamState: malformed }))).toThrow("references missing b99");
  });

  it("rejects graph cycles, overlapping active roots, and inconsistent indexes", () => {
    const cycle = fixture();
    cycle.prune.messages.blocksById["1"].includedBlockIds = [2];
    cycle.prune.messages.blocksById["1"].consumedBlockIds = [2];
    cycle.prune.messages.blocksById["2"].parentBlockIds = [1];
    expect(() => planUpstreamSessionImport(input({ upstreamState: cycle }))).toThrow("cycle");

    const overlap = fixture();
    overlap.prune.messages.blocksById["1"].active = true;
    overlap.prune.messages.blocksById["1"].parentBlockIds = [];
    overlap.prune.messages.blocksById["2"].includedBlockIds = [];
    overlap.prune.messages.blocksById["2"].consumedBlockIds = [];
    overlap.prune.messages.blocksById["2"].directMessageIds = ["u1", "a1", "u2"];
    overlap.prune.messages.activeBlockIds = [1, 2];
    overlap.prune.messages.activeByAnchorMessageId = { u1: 2 };
    expect(() => planUpstreamSessionImport(input({ upstreamState: overlap }))).toThrow(/message coverage index|share an anchor|overlap/);

    const inconsistent = fixture();
    inconsistent.prune.messages.activeBlockIds = [];
    expect(() => planUpstreamSessionImport(input({ upstreamState: inconsistent }))).toThrow("active block index");

    const badCoverage = fixture();
    badCoverage.prune.messages.blocksById["2"].effectiveMessageIds = ["u1", "a1"];
    expect(() => planUpstreamSessionImport(input({ upstreamState: badCoverage }))).toThrow("effective message coverage");

    const badMessageIndex = fixture();
    badMessageIndex.prune.messages.byMessageId.u1.activeBlockIds = [];
    expect(() => planUpstreamSessionImport(input({ upstreamState: badMessageIndex }))).toThrow("message coverage index");

    const badAnchor = fixture();
    badAnchor.prune.messages.blocksById["2"].anchorMessageId = "not-covered";
    badAnchor.prune.messages.activeByAnchorMessageId = { "not-covered": 2 };
    expect(() => planUpstreamSessionImport(input({ upstreamState: badAnchor }))).toThrow("anchor is outside");
  });

  it("rejects a changed upstream graph instead of treating it as idempotent", async () => {
    const store = new InMemoryContentStore();
    const persistence: Persistence = { load: async () => undefined, save: async () => {} };
    const first = await importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: false });
    const changed = fixture();
    changed.prune.messages.blocksById["2"].topic = "changed topic";
    expect(() => planUpstreamSessionImport(input({ currentState: first.state, upstreamState: changed })))
      .toThrow("different compression graph");
  });

  it("rolls back newly created archives when persistence fails", async () => {
    const store = new InMemoryContentStore();
    const persistence: Persistence = {
      load: async () => undefined,
      save: async () => { throw new Error("state write failed"); },
    };
    await expect(importUpstreamSession({ ...input(), contentStore: store, persistence, dryRun: false })).rejects.toThrow("state write failed");
    expect(await store.size()).toBe(0);
  });

  it("builds the canonical original sidecar path without touching it", () => {
    expect(upstreamSidecarPath(SESSION, "/data")).toBe(`/data/opencode/storage/plugin/dcp/${SESSION}.json`);
    expect(() => upstreamSidecarPath("../escape", "/data")).toThrow("invalid session id");
  });
});

describe("offline migration CLI (real Node SQLite, synthetic data)", () => {
  let temp: string;
  let compiled: string;
  const roots: string[] = [];
  beforeAll(() => {
    temp = realpathSync(mkdtempSync(join(tmpdir(), "ctx-migration-tests-")));
    compiled = join(temp, "compiled");
    execFileSync("node", ["node_modules/typescript/lib/tsc.js", "-p", "tsconfig.build.json", "--outDir", compiled], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 120000, stdio: "pipe" });
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
  });
  afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

  function setup(native = false): string {
    const home = mkdtempSync(join(temp, "home-"));
    roots.push(home);
    const dir = join(home, "opencode", "storage", "plugin", "dcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION}.json`), JSON.stringify(fixture()));
    const script = `
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]);
      const entries=JSON.parse(process.argv[2]);
      if(process.argv[3]==='native') {
        db.exec('CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,seq INTEGER,type TEXT,data TEXT,time_created INTEGER); CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,data TEXT)');
        db.prepare('INSERT INTO session_v2 VALUES(?,?)').run('${SESSION}','/workspace');
        entries.forEach((entry,i)=>{
          const data=entry.info.role==='user'?{text:entry.parts[0].text,time:entry.info.time}:{model:{id:'m',providerID:'p'},time:entry.info.time,content:[{type:'text',text:'inline tail'}]};
          db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run(entry.info.id,'${SESSION}',i,entry.info.role,JSON.stringify(data),i);
          if(entry.info.role==='assistant') db.prepare('INSERT INTO session_part VALUES(?,?,?,?)').run(entry.info.id,'${SESSION}',0,JSON.stringify({type:'text',text:entry.parts[0].text}));
        });
      } else {
        db.exec('CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
        db.prepare('INSERT INTO session VALUES(?,?)').run('${SESSION}','/workspace');
        entries.forEach(entry=>{
          const {id,sessionID,...data}=entry.info;
          db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(id,sessionID,entry.info.time.created,JSON.stringify(data));
          entry.parts.forEach(part=>{const {id,messageID,sessionID,...data}=part; db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run(id,messageID,sessionID,0,JSON.stringify(data));});
        });
        db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('a1-aaa','a1','${SESSION}',999,JSON.stringify({type:'text',text:'ID ordered first'}));
      }
      db.close();`;
    execFileSync("node", ["--input-type=module", "-e", script, join(home, "opencode", "opencode.db"), JSON.stringify(history()), native ? "native" : "legacy"]);
    return home;
  }
  function cli(home: string, ...args: string[]): any {
    const result = spawnSync("node", [join(compiled, "migration", "cli.js"), "--data-home", home, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  }
  function node(script: string, ...args: string[]): any {
    return JSON.parse(execFileSync("node", ["--input-type=module", "-e", script, ...args], { encoding: "utf8" }));
  }
  function inventory(path: string): string {
    return JSON.stringify(readdirSync(path, { recursive: true }).map(name => {
      const full = join(path, String(name));
      return [name, statSync(full).isFile() ? readFileSync(full).toString("base64") : "directory"];
    }));
  }
  it("dry-run writes nothing, and reports ready plus skipped sessions", () => {
    const home = setup();
    writeFileSync(join(home, "opencode/storage/plugin/dcp/ses_bad.json"), "{}");
    const before = inventory(home);
    const report = cli(home);
    expect(report.sessions.map((item: any) => item.status)).toEqual(["skipped", "ready"]);
    expect(report.sessions[0].reason).toContain("session not found");
    expect(inventory(home)).toBe(before);
  });
  it("apply backs up before writing, verifies four archives and projects summaries; retry is idempotent", () => {
    const home = setup();
    const dbBefore = readFileSync(join(home, "opencode/opencode.db"));
    const sourceBefore = readFileSync(join(home, `opencode/storage/plugin/dcp/${SESSION}.json`));
    const report = cli(home, "--apply", "--allow-running-opencode");
    expect(report.sessions[0].status).toBe("imported");
    expect(report.sessions[0].archivedSources).toBe(2);
    expect(report.sessions[0].archivedSummaries).toBe(2);
    expect(statSync(report.backup).mode & 0o777).toBe(0o700);
    expect(statSync(join(report.backup, "manifest.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(report.backup, "manifest.json"), "utf8")).targets.every((target: any) => !target.existed)).toBe(true);
    expect(readFileSync(join(home, "opencode/opencode.db"))).toEqual(dbBefore);
    expect(readFileSync(join(home, `opencode/storage/plugin/dcp/${SESSION}.json`))).toEqual(sourceBefore);
    const checked = node(`
      import {FilePersistence} from '${compiled}/adapters/opencode/services.js';
      import {FilesystemContentStore} from '${compiled}/adapters/opencode/content-store.js';
      import {loadCompressionSource,loadCompressionSummary} from '${compiled}/adapters/opencode/compression-archive.js';
      import {OfflineHistory} from '${compiled}/migration/history.js';
      import {applyDecisions} from '${compiled}/core/applyDecisions.js';
      import {toNeutral} from '${compiled}/adapters/opencode/map.js';
      const storage=process.argv[1];const state=await new FilePersistence(storage).load('${SESSION}');
      const store=new FilesystemContentStore(storage);let verified=0;let parts=[];
      for(const block of state.blockRegistry.values()) {
        const entries=await loadCompressionSource(store,block.durableSourceRef,'${SESSION}',block.blockId,block.effectiveMessageIds);
        parts=entries.find(e=>e.info.id==='a1').parts;
        await loadCompressionSummary(store,block.durableSummaryRef,'${SESSION}',block.blockId);verified+=2;
      }
      const reader=new OfflineHistory(process.argv[2]);
      const projected=applyDecisions(toNeutral(reader.read('${SESSION}').entries),state);reader.close();
      console.log(JSON.stringify({verified,firstPart:parts[0].text,summary:projected.some(m=>m.parts.some(p=>p.type==='summary-block')),hidden:projected.filter(m=>m.isIgnored).length}));
    `, join(home, "opencode/storage"), join(home, "opencode/opencode.db"));
    expect(checked.verified).toBe(4);
    expect(checked.firstPart).toBe("ID ordered first");
    expect(checked.summary).toBe(true);
    expect(checked.hidden).toBe(3);
    const states = inventory(join(home, "opencode/storage/ctx"));
    const retry = cli(home, "--apply", "--allow-running-opencode");
    expect(retry.sessions[0].status).toBe("already-imported");
    expect(inventory(join(home, "opencode/storage/ctx"))).toBe(states);
    expect(JSON.parse(readFileSync(join(retry.backup, "manifest.json"), "utf8")).targets.find((item: any) => item.path === "ctx").existed).toBe(true);
  });
  it("hydrates native split ordinal parts before inline content", () => {
    const home = setup(true);
    const report = cli(home, "--apply", "--allow-running-opencode");
    expect(report.sessions[0].schema).toBe("native-v2-seq");
    expect(report.sessions[0].status).toBe("imported");
    const mapped = node(`import {OfflineHistory} from '${compiled}/migration/history.js';const db=new OfflineHistory(process.argv[1]);console.log(JSON.stringify(db.read('${SESSION}').entries[1].parts.map(p=>p.text)));db.close();`, join(home, "opencode/opencode.db"));
    expect(mapped).toEqual(["first answer", "inline tail"]);
  });
  it("refuses running OpenCode but excludes known non-writing processes", () => {
    const home = setup();
    const checked = node(`
      import {migrate,parseProcesses} from '${compiled}/migration/cli.js';
      let refused=false;try {await migrate(['--data-home',process.argv[1],'--apply'],{processes:()=> '42 /opt/bin/opencode-cli serve'});}catch(e){refused=e.message.includes('OpenCode is running');}
      console.log(JSON.stringify({refused,excluded:parseProcesses('43 /app/chrome_crashpad_handler\\n44 /app/OpenCode Stats.command\\n45 node /workspace/opencode/migration/cli.js').length}));
    `, home);
    expect(checked).toEqual({ refused: true, excluded: 0 });
    expect(readdirSync(join(home, "opencode/storage"))).toEqual(["plugin"]);
  });
  it("rejects symlink input paths before opening the database", () => {
    const home = setup();
    const link = join(temp, `link-${roots.length}`);
    symlinkSync(home, link);
    const result = spawnSync("node", [join(compiled, "migration/cli.js"), "--data-home", link], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symlink path refused");
  });
  it("runs through a package-bin symlink rather than silently doing nothing", () => {
    const bin = join(temp, "ctx-migrate");
    symlinkSync(join(compiled, "migration/cli.js"), bin);
    const output = execFileSync("node", [bin, "--help"], { encoding: "utf8" });
    expect(output).toContain("Offline DCP v3 migration");
  });
  it("rejects unknown native schema instead of falling back to stale legacy rows", () => {
    const home = setup();
    execFileSync("node", ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE session_message(id TEXT)');db.close();", join(home, "opencode/opencode.db")]);
    const result = spawnSync("node", [join(compiled, "migration/cli.js"), "--data-home", home], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported database schema");
  });
  it("skips missing sources by default and explicitly preserves summary-only WARM roots", () => {
    const home = setup();
    execFileSync("node", ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec(\"DELETE FROM part WHERE message_id='a1'; DELETE FROM message WHERE id='a1'\");db.close();", join(home, "opencode/opencode.db")]);
    const preview = cli(home);
    expect(preview.sessions[0].status).toBe("skipped");
    expect(preview.sessions[0].reason).toContain("exact source");
    const report = cli(home, "--apply", "--allow-running-opencode", "--allow-incomplete-sources");
    expect(report.sessions[0].status).toBe("imported");
    expect(report.sessions[0].incompleteSourceBlocks).toBe(2);
    expect(report.sessions[0].archivedSources).toBe(0);
    expect(report.sessions[0].archivedSummaries).toBe(2);
    const blocks = node(`import {FilePersistence} from '${compiled}/adapters/opencode/services.js';const state=await new FilePersistence(process.argv[1]).load('${SESSION}');console.log(JSON.stringify([...state.blockRegistry.values()].map(b=>({source:!!b.durableSourceRef,summary:!!b.durableSummaryRef,tier:b.projectionTier}))));`, join(home, "opencode/storage"));
    expect(blocks).toEqual([{ source: false, summary: true, tier: "warm" }, { source: false, summary: true, tier: "warm" }]);
  });
  it("skips externalized native text instead of archiving an invented string", () => {
    const home = setup(true);
    execFileSync("node", ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.prepare('UPDATE session_part SET data=?').run(JSON.stringify({type:'text',text:{hash:'missing-blob'}}));db.close();", join(home, "opencode/opencode.db")]);
    const report = cli(home, "--apply", "--allow-running-opencode");
    expect(report.sessions[0].status).toBe("skipped");
    expect(report.sessions[0].reason).toContain("externalized");
    expect(report.backup).toBeUndefined();
    expect(readdirSync(join(home, "opencode/storage"))).toEqual(["plugin"]);
  });
});
