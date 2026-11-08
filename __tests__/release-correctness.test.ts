// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCascade } from "../core/cascade.js";
import { runPipeline } from "../core/pipeline.js";
import { applyDecisions } from "../core/applyDecisions.js";
import { buildDefaultConfig } from "../core/defaults.js";
import { createInitialState } from "../types/state.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { NoopLogger } from "../services/logger.js";
import { materializeOffloadRequests } from "../adapters/opencode/offload-writer.js";
import { appendLogLine, FilePersistence } from "../adapters/opencode/services.js";
import { PLACEHOLDER_NEAR_DUPE } from "../core/placeholders.js";
import { nearDupeResourceKey, simhash64 } from "../core/strategies/nearDupe.js";
import type { ToolPart } from "../types/neutral.js";
import { makeToolMessage } from "./fixtures/messages.js";

function cascade(a: unknown, b: unknown, first: string, second: string) {
  const config = buildDefaultConfig("release");
  config.costRoi.enabled = false;
  config.nudges.maskTriggerThreshold = 1e9;
  const messages = [makeToolMessage("read", a as Record<string, unknown>, first, 1), makeToolMessage("read", b as Record<string, unknown>, second, 2)];
  const state = createInitialState("release");
  return { messages, state, config, result: runCascade(messages, 20, config, state, new CharTokenizer(), "/workspace") };
}

describe("v1.0.1 resource and syntax safety", () => {
  const code = 'function authorized(user) { return user.role === "admin"; }'.padEnd(247, " ");
  it("keeps the reviewer's 247-character different-file operator repro through the cascade", () => {
    const other = code.replace("===", "!==");
    expect(code.length).toBe(247);
    expect(other.length).toBe(247);
    const { result } = cascade({ filePath: "/a.ts" }, { filePath: "/b.ts" }, code, other);
    expect(result.nearDupeCount).toBe(0);
    expect(result.messages.map(m => (m.parts[0] as ToolPart).output)).toEqual([code, other]);
    expect(simhash64(code)).not.toBe(simhash64(other));
  });
  it("supersedes only the older same-resource tiny edit through the cascade", () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}: module configuration and default values here`).join("\n");
    const later = base + "\nsmall addition";
    const { result } = cascade({ filePath: "/f.ts", offset: 0 }, { path: "/f.ts", offset: 1 }, base, later);
    expect(result.nearDupeCount).toBe(1);
    expect(result.messages.map(m => (m.parts[0] as ToolPart).output)).toEqual([PLACEHOLDER_NEAR_DUPE, later]);
  });
  it("keeps same-resource operator changes even if SimHash similarity would pass", () => {
    const base = code + "\nunchanged surrounding text ".repeat(100);
    const { result } = cascade({ path: "/f", offset: 0 }, { path: "/f", offset: 1 }, base, base.replace("===", "!=="));
    expect(result.nearDupeCount).toBe(0);
  });
  it("fails closed for unknown resources and distinct search scopes", () => {
    expect(cascade({ offset: 0 }, { offset: 1 }, code, code + " ").result.nearDupeCount).toBe(0);
    expect(nearDupeResourceKey({ pattern: "x" })).toBeUndefined();
    expect(nearDupeResourceKey({ pattern: "x", path: "/a" })).not.toBe(nearDupeResourceKey({ pattern: "x", path: "/b" }));
    expect(nearDupeResourceKey({ file_path: "./src/f" })).toBe(nearDupeResourceKey({ path: "src/f" }));
    expect(nearDupeResourceKey({ path: "/A" })).not.toBe(nearDupeResourceKey({ path: "/a" }));
  });
  it("invalidates legacy decisions once, restores the prefix and persists the new version", async () => {
    const { state, messages, config } = cascade({ path: "/a" }, { path: "/b" }, code, code);
    delete state.nearDupeVersion;
    state.nearDupeDecisions.add((messages[0].parts[0] as ToolPart).callId);
    expect((applyDecisions(messages, state)[0].parts[0] as ToolPart).output).toBe(code);
    state.currentTurn = 20;
    const result = runPipeline({ messages, state, config, nowMs: 1 }, { tokenizer: new CharTokenizer(), workspaceDir: "/workspace" });
    expect(state.nearDupeVersion).toBe(2);
    expect(state.nearDupeDecisions.size).toBe(0);
    expect(result.projectionEdit).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "ctx-version-"));
    try {
      const persistence = new FilePersistence(dir);
      await persistence.save(state.sessionId, state);
      expect((await persistence.load(state.sessionId))?.nearDupeVersion).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("v1.0.1 private output modes", () => {
  it("rejects symlinked offload roots without chmod-ing their target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-mode-link-"));
    try {
      const target = join(dir, "target");
      await mkdir(target, { mode: 0o755 });
      await chmod(target, 0o755);
      await symlink(target, join(dir, ".ctx-offload"));
      const failed = await materializeOffloadRequests([{ callId: "call", path: join(dir, ".ctx-offload", "session", "call.txt"), content: "private", tokens: 1 }], createInitialState("session"), new NoopLogger());
      expect(failed.has("call")).toBe(true);
      expect((await stat(target)).mode & 0o777).toBe(0o755);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("writes owner-only offloads under umask 022 and tightens legacy plugin directories, not their parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ctx-modes-"));
    const previous = process.umask(0o022);
    try {
      await chmod(dir, 0o755);
      const root = join(dir, ".ctx-offload"), session = join(root, "session"), path = join(session, "call.txt");
      await mkdir(session, { recursive: true, mode: 0o755 });
      await chmod(root, 0o755);
      await chmod(session, 0o755);
      await writeFile(path, "legacy", { mode: 0o644 });
      const failed = await materializeOffloadRequests([{ callId: "call", path, content: "private output", tokens: 10 }], createInitialState("session"), new NoopLogger());
      expect(failed.size).toBe(0);
      expect(await readFile(path, "utf8")).toBe("private output");
      for (const p of [root, session]) expect((await stat(p)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o755);
      const log = join(dir, "ctx.log");
      await writeFile(log, "legacy", { mode: 0o644 });
      appendLogLine(log, "info", "private", []);
      expect((await stat(log)).mode & 0o777).toBe(0o600);
    } finally { process.umask(previous); await rm(dir, { recursive: true, force: true }); }
  });
});
