#!/usr/bin/env node
// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Bulk, offline migration of @tarquinen/opencode-dcp v3 compression sidecars.
import { execFileSync } from "node:child_process";
import { copyFile, chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { FilePersistence, resolveStorageDir } from "../adapters/opencode/services.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { createInitialState } from "../types/state.js";
import { importUpstreamSession, planUpstreamSessionImport, readUpstreamSidecar } from "./importer.js";
import { OfflineHistory } from "./history.js";

export const HELP = `Offline DCP v3 migration (Node >=22.13; quit OpenCode first).
node dist/migration/cli.js [--apply | --dry-run] [--data-home DIR]
  --storage DIR       target plugin storage (same defaults as the plugin)
  --database FILE     source database (default DATA_HOME/opencode/opencode.db)
  --allow-incomplete-sources  preserve summaries without recoverable originals
  --allow-running-opencode   explicit unsafe override (isolated copies recommended)
Dry-run is default and writes NOTHING; JSON report goes to stdout.
Apply backs up target trees first; report also saved inside the backup directory.
No source sidecars, host database, or OpenCode configuration are written.`;

/** Fail closed when process enumeration fails. Known non-writers are excluded. */
export function parseProcesses(text: string, selfPid = process.pid): string[] {
  return text.split("\n").filter(line => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === selfPid) return false;
    const command = match[2];
    if (/chrome_crashpad_handler|\/OpenCode Stats\.command/.test(command)) return false;
    // Match executable tokens, not arbitrary project paths / parent shell prompts.
    return /^(?:\S*\/)?(?:opencode(?:-cli)?)(?:\s|$)|^.*\/OpenCode(?: 2)?\.app\/Contents\/(?:MacOS|Resources)\/(?:OpenCode|opencode-cli)(?:\s|$)/i.test(command);
  });
}

async function safePath(path: string): Promise<void> {
  const absolute = resolve(path);
  const components = absolute.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of components) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`symlink path refused: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

// Conservative whole-tree backup: covers index repairs, pending markers and all
// content-store writes without duplicating its private filename/hash conventions.
const TARGETS = ["ctx", "content-blobs", "content-index.json", "session-snapshots"];
async function backupTree(source: string, target: string): Promise<boolean> {
  let info;
  try { info = await lstat(source); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`symlink in target tree: ${source}`);
  if (info.isDirectory()) {
    await mkdir(target, { mode: 0o700 });
    for (const name of await readdir(source)) await backupTree(join(source, name), join(target, name));
  } else if (info.isFile()) {
    await copyFile(source, target);
    await chmod(target, 0o600);
  } else throw new Error(`non-regular target: ${source}`);
  return true;
}

export interface MigrationReport {
  dryRun: boolean;
  backup?: string;
  sessions: Array<{ sessionId: string; status: "ready" | "imported" | "already-imported" | "skipped"; reason?: string; schema?: string; blocks?: number; incompleteSourceBlocks?: number; archivedSources?: number; archivedSummaries?: number }>;
}

export async function migrate(argv: string[], dependencies: { processes?: () => string } = {}): Promise<MigrationReport> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (["--data-home", "--storage", "--database"].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} needs a value`);
      if (values.has(key)) throw new Error(`duplicate ${key}`);
      values.set(key, resolve(value));
    } else if (["--apply", "--dry-run", "--allow-incomplete-sources", "--allow-running-opencode"].includes(key)) flags.add(key);
    else throw new Error(`unknown option ${key}`);
  }
  if (flags.has("--apply") && flags.has("--dry-run")) throw new Error("--apply and --dry-run are exclusive");
  const apply = flags.has("--apply");
  const home = values.get("--data-home") ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const storage = resolve(values.get("--storage") ?? (values.has("--data-home") ? join(home, "opencode", "storage") : resolveStorageDir()));
  const source = join(home, "opencode", "storage", "plugin", "dcp");
  const databasePath = values.get("--database") ?? join(home, "opencode", "opencode.db");
  for (const path of [source, databasePath, storage, ...TARGETS.map(name => join(storage, name))]) await safePath(path);
  // Storage must not place a target tree over the read-only input.
  for (const target of TARGETS.map(name => join(storage, name))) {
    if ([source, databasePath].some(path => resolve(path) === target || resolve(path).startsWith(target + sep))) throw new Error("target overlaps read-only input");
  }
  if (apply && !flags.has("--allow-running-opencode")) {
    const processes = dependencies.processes?.() ?? execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (parseProcesses(processes).length) throw new Error("OpenCode is running; quit all clients and the service before --apply (or explicitly --allow-running-opencode)");
  }
  const report: MigrationReport = { dryRun: !apply, sessions: [] };
  const persistence = new FilePersistence(storage);
  const store = new FilesystemContentStore(storage);
  const history = new OfflineHistory(databasePath);
  let backedUp = false;
  try {
    const names = (await readdir(source)).filter(name => name.endsWith(".json")).sort();
    for (const name of names) {
      const sessionId = name.slice(0, -5);
      let phase = "validation";
      try {
        const upstreamState = await readUpstreamSidecar(sessionId, home);
        const { entries: hostEntries, schema } = history.read(sessionId);
        const currentState = await persistence.load(sessionId) ?? createInitialState(sessionId);
        const input = { sessionId, upstreamState, currentState, hostEntries, tokenizer: new CharTokenizer(), allowIncompleteSources: flags.has("--allow-incomplete-sources") };
        const plan = planUpstreamSessionImport(input);
        if (!apply) {
          report.sessions.push({ sessionId, schema, status: plan.alreadyImported ? "already-imported" : "ready", blocks: plan.blocks.length, incompleteSourceBlocks: plan.incompleteSourceBlockIds.length });
          continue;
        }
        if (!backedUp) {
          phase = "backup";
          const backup = join(dirname(storage), `ctx-import-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
          await safePath(backup);
          await mkdir(backup, { mode: 0o700 });
          const targets = [];
          for (const target of TARGETS) targets.push({ path: target, existed: await backupTree(join(storage, target), join(backup, target)) });
          await writeFile(join(backup, "manifest.json"), JSON.stringify({ version: 1, storage, targets }, null, 2), { flag: "wx", mode: 0o600 });
          report.backup = backup;
          backedUp = true;
        }
        phase = "import";
        const result = await importUpstreamSession({ ...input, persistence, contentStore: store, dryRun: false });
        report.sessions.push({ sessionId, schema, status: result.report.alreadyImported ? "already-imported" : "imported", blocks: result.report.importedBlocks, incompleteSourceBlocks: result.report.incompleteSourceBlocks, archivedSources: result.report.archivedSources, archivedSummaries: result.report.archivedSummaries });
      } catch (error) {
        // A failed backup must abort the batch: no session may be written after it.
        if (phase === "backup") throw error;
        report.sessions.push({ sessionId, status: "skipped", reason: `${phase}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  } finally { history.close(); }
  if (report.backup) await writeFile(join(report.backup, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) console.log(HELP);
  else {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || major === 22 && minor < 13 || major === 23 && minor < 4) throw new Error("migration requires Node >=22.13 (23.x requires >=23.4)");
    migrate(process.argv.slice(2)).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
      console.error(`migration: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
