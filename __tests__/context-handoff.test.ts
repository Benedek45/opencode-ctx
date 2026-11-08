// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile, readdir, lstat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { collectHandoff, importHandoff, composeRecoveryEntries, loadImportedSeed, localHandoffResourceReader } from "../adapters/opencode/context-handoff.js";
import { archiveCompressionSource, archiveCompressionSummary, loadCompressionSource } from "../adapters/opencode/compression-archive.js";
import { FilePersistence } from "../adapters/opencode/services.js";
import { FilesystemContentStore } from "../adapters/opencode/content-store.js";
import { encodeBundle, decodeBundle, makeBlob, blobId } from "../adapters/opencode/portable-context.js";
import { applyNeutral, toNeutral, advanceTurnBasis } from "../adapters/opencode/map.js";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
import { InMemoryContentStore } from "../services/contentStore.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { createInitialState, cloneCoreState, type CoreState, type BlockMetadata } from "../types/state.js";
import { resolveConfig } from "../core/config.js";
import { runTagging } from "../core/tagging.js";
import { runFinalize } from "../core/finalize.js";
import { applyDecisions } from "../core/applyDecisions.js";
import { applyManualOverrides } from "../core/manualOverrides.js";
import { buildCompressionIndex } from "../core/compress/transaction.js";
import { deactivateCompressionBlock } from "../core/compress/reversible.js";
import { estimateContextTokens } from "../core/tokens.js";
import { contextToHost, sessionHistoryToHost } from "../adapters/opencode-v2/map.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), "ctx-handoff-"))); dirs.push(dir); return dir; }
const tokenizer = new CharTokenizer();
function entry(id: string, text: string, sessionID = "source"): HostMessageEntry {
  return { info: { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } }, parts: [{ type: "text", id: `${id}-p`, messageID: id, sessionID, text }] };
}
function config(state: CoreState) { return resolveConfig(state.sessionId, { modelContextLimit: 1_000_000, hardCap: 900_000 }); }
function project(entries: HostMessageEntry[], state: CoreState, all = false) {
  const cfg = config(state);
  const tagged = runTagging(toNeutral(entries, state), state);
  return applyNeutral(entries, runFinalize(applyManualOverrides(applyDecisions(tagged, state, { contextTiers: { ...cfg.contextTiers, enabled: !all }, tokenizer, modelContextLimit: cfg.modelContextLimit }), state, tagged)));
}
function text(entries: HostMessageEntry[]): string { return entries.flatMap(item => item.parts.map(part => part.type === "text" ? (part as { text: string }).text : "")).join("\n"); }
async function fixture() {
  const state = createInitialState("source");
  const store = new InMemoryContentStore();
  const originals = [entry("first", "EXACT FIRST SOURCE"), entry("second", "EXACT SECOND SOURCE")];
  for (let index = 0; index < 2; index++) {
    const id = `b${index + 8}`;
    const source = originals[index];
    const summary = `summary ${index} retained`;
    const sourceRef = await archiveCompressionSource(store, "source", id, "phase", [source.info.id], [source]);
    const summaryRef = await archiveCompressionSummary(store, "source", id, "phase", summary);
    const block: BlockMetadata = { blockId: id, runId: "r1", mode: "range", topic: `phase ${index}`, startRef: source.info.id, endRef: source.info.id, anchorMessageId: source.info.id,
      active: true, deactivatedByUser: false, includedBlockIds: ["b1"], consumedBlockIds: ["b1"], parentBlockIds: [], directMessageIds: [source.info.id], effectiveMessageIds: [source.info.id], directToolCallIds: [], effectiveToolCallIds: [], sourceTokens: 99, summaryTokens: 9, netTokens: 90, summaryText: summary,
      durableSourceRef: sourceRef.record.id, durableSummaryRef: summaryRef.record.id, projectionTier: index ? "cold" : "warm", createdAt: index, updatedAt: index, updatedAtTurn: 0, sourceMessageIds: [source.info.id], createdAtTurn: 0, tokens: 9, consumed: false };
    state.blockRegistry.set(id, block);
  }
  state.compressionIndex = buildCompressionIndex(state);
  const hot = entry("hot", "LATEST USER INTENT");
  const history = [...originals, hot];
  const bundle = await collectHandoff({ state, projectedEntries: project(history, state, true) }, store, { read: async () => { throw new Error("no resource expected"); } });
  return { state, store, history, bundle };
}
async function destination(bundle: Awaited<ReturnType<typeof fixture>>["bundle"], overrides: Record<string, unknown> = {}) {
  const root = await temp();
  const state = createInitialState("destination");
  const store = new InMemoryContentStore();
  const persistence = new FilePersistence(root);
  const input = { bundle, currentState: state, hostEntries: [] as HostMessageEntry[], store, persistence, tokenizer, config: config(state), resourceRoot: root,
    project: (entries: HostMessageEntry[], next: CoreState) => project(entries, next), measure: (entries: HostMessageEntry[], next: CoreState) => estimateContextTokens(toNeutral(entries, next), tokenizer), ...overrides };
  return { root, store, state, persistence, input };
}

describe("durable context handoff", () => {
  it("rejects V2 media/opaque and native prompt files rather than exporting incomplete context", async () => {
    const state = createInitialState("source");
    const media = contextToHost([{ id: "media", role: "user", content: [{ type: "text", text: "image" }, { type: "media", data: "YQ==" }] }], { sessionID: "source" }).entries;
    const files = sessionHistoryToHost([{ id: "files", type: "user", text: "", files: [{ uri: "file:///x.png" }] }], "source");
    for (const projectedEntries of [media, files]) {
      await expect(collectHandoff({ state, projectedEntries }, new InMemoryContentStore(), { read: async () => new Uint8Array() })).rejects.toThrow("unsupported visible history part: v2-");
    }
  });
  it("does not multiply source scanning by thousands of unrelated registered offloads", async () => {
    const state = createInitialState("source");
    for (let i = 0; i < 1000; i++) state.messageIndex.set(`c${i}`, {
      messageId: `m${i}`, offloaded: true, masked: true, offloadPath: `/tmp/.ctx-offload/source/${i}.txt`,
    });
    const content = "source code\n".repeat(20_000);
    const bundle = await collectHandoff({ state, projectedEntries: [entry("large", content)] }, new InMemoryContentStore(), {
      read: async () => { throw new Error("unreferenced resources must not be read"); },
    });
    expect(Object.values(bundle.payload.blobs).some(blob => blob.data === content)).toBe(true);
    expect(Object.values(bundle.payload.blobs).every(blob => blob.bindings.length === 0)).toBe(true);
  });

  it("preserves HOT and flat WARM/COLD roots, remaps IDs, and restores exact historical sources", async () => {
    const source = await fixture();
    const dest = await destination(source.bundle);
    const result = await importHandoff(dest.input);
    expect([...result.state.blockRegistry.keys()]).toEqual(["b1", "b2"]);
    expect(result.state.blockRegistry.get("b1")?.includedBlockIds).toEqual([]);
    expect(result.state.blockRegistry.get("b2")?.projectionTier).toBe("cold");
    expect(result.state.blockRegistry.get("b1")?.topic).toBe("[Imported history] phase 0");
    expect(text(result.projectedEntries)).toContain("LATEST USER INTENT");
    expect(text(result.projectedEntries)).toContain("summary 0 retained");
    expect(text(result.projectedEntries)).toContain("[Imported history] phase 1");
    expect(text(result.projectedEntries)).not.toContain("summary 1 retained");
    expect(text(result.projectedEntries)).not.toContain("EXACT FIRST SOURCE");
    const block = result.state.blockRegistry.get("b1")!;
    const recovered = await loadCompressionSource(dest.store, block.durableSourceRef!, "destination", "b1", block.effectiveMessageIds);
    expect(text(recovered)).toContain("EXACT FIRST SOURCE");
    expect(recovered.every(item => item.info.sessionID === "destination" && item.info.id.startsWith("__ctx_import_"))).toBe(true);
    const restored = deactivateCompressionBlock(result.state, "b1")!;
    const continuation = entry("new", "NEXT TASK", "destination");
    expect(text(project(composeRecoveryEntries([continuation], result.seed), restored.state))).toContain("EXACT FIRST SOURCE");
    expect(text(project(composeRecoveryEntries([continuation], result.seed), restored.state))).not.toContain("summary 0 retained");
    advanceTurnBasis([continuation], restored.state);
    const turn = restored.state.currentTurn;
    advanceTurnBasis(composeRecoveryEntries([continuation], result.seed), restored.state);
    expect(restored.state.currentTurn).toBe(turn);
    expect(toNeutral(result.seed.entries, restored.state).every(item => item.role === "user" && item.tokens === undefined)).toBe(true);
  });

  it("loads from fresh filesystem store/persistence with no source file or memory seed", async () => {
    const source = await fixture();
    const root = await temp();
    const dest = await destination(source.bundle, { store: new FilesystemContentStore(root), persistence: new FilePersistence(root), resourceRoot: root });
    const first = await importHandoff(dest.input);
    const state = (await new FilePersistence(root).load("destination"))!;
    const seed = (await loadImportedSeed(state, new FilesystemContentStore(root), root))!;
    expect(text(project(composeRecoveryEntries([entry("after", "NEW HOST", "destination")], seed), state))).toContain("LATEST USER INTENT");
    expect(seed.entries.map(item => item.info.id)).toEqual(first.seed.entries.map(item => item.info.id));
    expect(state.importedContext?.bundleDigest).toBe(source.bundle.sha256);
  });

  it("same digest preserves progress; a different digest or populated destination is rejected", async () => {
    const { bundle } = await fixture();
    const dest = await destination(bundle);
    const first = await importHandoff(dest.input);
    first.state.currentTurn = 42;
    const second = await importHandoff({ ...dest.input, currentState: first.state, hostEntries: [entry("progress", "progress", "destination")] });
    expect(second.alreadyImported).toBe(true);
    expect(second.state).toBe(first.state);
    expect(second.state.currentTurn).toBe(42);
    const payload = structuredClone(bundle.payload);
    payload.roots[0].topic = "different";
    await expect(importHandoff({ ...dest.input, bundle: decodeBundle(encodeBundle(payload)), currentState: first.state })).rejects.toThrow("new empty chat");
    await expect(importHandoff({ ...dest.input, hostEntries: [entry("unrelated", "not new", "destination")] })).rejects.toThrow("new empty chat");
    expect(dest.state.importedContext).toBeUndefined();
  });

  it("legacy summary-only roots are explicit; declared missing/corrupt archives fail closed", async () => {
    const source = await fixture();
    const block = source.state.blockRegistry.get("b8")!;
    const originalRef = block.durableSourceRef!;
    delete block.durableSourceRef;
    const bundle = await collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() });
    expect(bundle.payload.roots[0].recoverable).toBe(false);
    const dest = await destination(bundle);
    const result = await importHandoff(dest.input);
    expect(result.state.blockRegistry.get("b1")?.durableSourceRef).toBeUndefined();
    expect(result.unrecoverableRoots).toHaveLength(1);
    block.durableSourceRef = originalRef;
    const archive = (await source.store.get(originalRef))!;
    archive.data = archive.data.replace("EXACT FIRST SOURCE", "CORRUPTED SOURCE");
    await expect(collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() })).rejects.toThrow("digest");
    await source.store.delete(originalRef);
    await expect(collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() })).rejects.toThrow();
  });

  it("embeds nested offloads and attachments, then recreates resource files on restart", async () => {
    const dir = await temp();
    const offloads = join(dir, ".ctx-offload");
    await mkdir(offloads);
    const inner = join(offloads, "inner.txt");
    const outer = join(offloads, "outer with spaces.txt");
    await writeFile(inner, "EXACT DEEP OUTPUT");
    await writeFile(outer, `Nested at '${inner}'`);
    const png = join(dir, "image.png");
    await writeFile(png, new Uint8Array([137, 80, 78, 71, 13, 10]));
    const state = createInitialState("source");
    state.messageIndex.set("tool", { messageId: "tool", offloaded: true, masked: true, offloadPath: outer });
    state.messageIndex.set("nested", { messageId: "nested", offloaded: true, masked: true, offloadPath: inner });
    const hot = entry("tool", `Read '${outer}'`);
    hot.parts.push({ type: "tool", id: "tp", sessionID: "source", messageID: "tool", callID: "call1", tool: "bash", state: { status: "completed", input: { command: "ORIGINAL COMMAND" }, output: "FULL TOOL OUTPUT", title: "result", time: { start: 1, end: 2 } } });
    hot.parts.push({ type: "file", id: "file", sessionID: "source", messageID: "tool", mime: "image/png", filename: "image.png", url: pathToFileURL(png).href });
    const bundle = await collectHandoff({ state, projectedEntries: [hot] }, new InMemoryContentStore(), localHandoffResourceReader(dir));
    expect(Object.values(bundle.payload.blobs).some(blob => blob.data === "EXACT DEEP OUTPUT")).toBe(true);
    await rm(offloads, { recursive: true });
    await rm(png);
    const dest = await destination(bundle);
    const first = await importHandoff(dest.input);
    const rendered = text(first.projectedEntries);
    expect(rendered).toContain("FULL TOOL OUTPUT");
    expect(rendered).toContain("ORIGINAL COMMAND");
    expect(rendered).not.toContain(outer);
    expect(rendered).not.toContain(inner);
    expect(first.projectedEntries.flatMap(item => item.parts).every(part => part.type === "text")).toBe(true);
    const files = await readdir(join(dest.root, "ctx-import-resources"), { recursive: true });
    const payloads: string[] = [];
    for (const file of files) try { payloads.push(await readFile(join(dest.root, "ctx-import-resources", file), "utf8")); } catch { /* directory */ }
    expect(payloads.some(value => value === "EXACT DEEP OUTPUT")).toBe(true);
    expect(payloads.some(value => value.includes(dest.root) && value.includes("Nested at"))).toBe(true);
    await rm(join(dest.root, "ctx-import-resources"), { recursive: true });
    const seed = (await loadImportedSeed(first.state, dest.store, dest.root))!;
    expect(text(seed.entries)).toContain(dest.root);
    expect((await readdir(join(dest.root, "ctx-import-resources"))).length).toBe(1);
  });

  it("does not copy host configuration or provider metadata; unknown visible parts fail", async () => {
    const state = createInitialState("source");
    const hot = entry("hot", "keep conversation");
    if (hot.info.role === "user") hot.info.system = "NEVER COPY SYSTEM SECRET";
    state.runtimeConfig = { recencyGuardTurns: 999 };
    const bundle = await collectHandoff({ state, projectedEntries: [hot] }, new InMemoryContentStore(), { read: async () => new Uint8Array() });
    const json = Buffer.from(encodeBundle(bundle.payload)).toString();
    expect(json).not.toContain("NEVER COPY SYSTEM SECRET");
    expect(json).not.toContain("recencyGuardTurns");
    hot.parts.push({ type: "unrecognized-image", id: "extra", sessionID: "source", messageID: "hot" });
    await expect(collectHandoff({ state, projectedEntries: [hot] }, new InMemoryContentStore(), { read: async () => new Uint8Array() })).rejects.toThrow("unsupported visible");
  });

  it("rolls back only newly written objects on state-save failure and rejects oversized projection", async () => {
    const { bundle } = await fixture();
    const dest = await destination(bundle);
    const existing = await dest.store.write({ data: "PREEXISTING", metadata: { sessionId: "destination" } });
    await expect(importHandoff({ ...dest.input, persistence: { load: async () => undefined, save: async () => { throw new Error("disk full"); } } })).rejects.toThrow("disk full");
    expect(await dest.store.size()).toBe(1);
    expect((await dest.store.get(existing.id))?.data).toBe("PREEXISTING");
    expect(dest.state.blockRegistry.size).toBe(0);
    await expect(importHandoff({ ...dest.input, config: { ...dest.input.config, modelContextLimit: 10, hardCap: 10 } })).rejects.toThrow("exceeds destination cap");
    expect(await dest.store.size()).toBe(1);
    expect(await dest.persistence.load("destination")).toBeUndefined();
  });

  it("rejects a corrupted durable seed on reload rather than losing imported history", async () => {
    const { bundle } = await fixture();
    const dest = await destination(bundle);
    const imported = await importHandoff(dest.input);
    const record = (await dest.store.get(imported.state.importedContext!.seedRef))!;
    record.data = record.data.replace("LATEST USER INTENT", "WRONG");
    await expect(loadImportedSeed(imported.state, dest.store, dest.root)).rejects.toThrow();
    const old = cloneCoreState(imported.state);
    old.sessionId = "another-session";
    await expect(loadImportedSeed(old, dest.store, dest.root)).rejects.toThrow("another session");
  });

  it("never treats corrupt canonical state as a new session or falls back to stale legacy state", async () => {
    const { bundle } = await fixture();
    const dest = await destination(bundle);
    await importHandoff(dest.input);
    const files = await readdir(join(dest.root, "ctx"));
    const canonical = join(dest.root, "ctx", files[0]);
    const good = await readFile(canonical, "utf8");
    await writeFile(join(dest.root, "ctx", "destination.json"), good);
    const broken = JSON.parse(good);
    broken.importedContext.bundleDigest = "corrupt";
    await writeFile(canonical, JSON.stringify(broken));
    await expect(new FilePersistence(dest.root).load("destination")).rejects.toThrow("cannot load persisted session");
    expect(await readFile(canonical, "utf8")).toBe(JSON.stringify(broken));
  });

  it("confines discovered prose offloads to approved roots and supports OS temporary-directory aliases", async () => {
    const root = await temp();
    await mkdir(join(root, ".ctx-offload"));
    const secret = join(root, ".ctx-offload", "secret.txt");
    await writeFile(secret, "DO NOT EMBED THIS");
    const state = createInitialState("source");
    const local = localHandoffResourceReader(root);
    let reads = 0;
    await expect(collectHandoff({ state, projectedEntries: [entry("user", `A prose path: ${secret}`)] }, new InMemoryContentStore(), {
      read: async (path, purpose) => { reads++; return local.read(path, purpose); },
    })).rejects.toThrow("not backed by structured session metadata");
    expect(reads).toBe(0);
    const rawRoot = await mkdtemp(join(tmpdir(), "ctx-alias-"));
    dirs.push(rawRoot);
    await mkdir(join(rawRoot, ".ctx-offload"));
    const path = join(rawRoot, ".ctx-offload", "real.txt");
    await writeFile(path, "VALID OFFLOAD THROUGH OS ALIAS");
    const reader = localHandoffResourceReader(rawRoot);
    expect(Buffer.from(await reader.read(path)).toString()).toBe("VALID OFFLOAD THROUGH OS ALIAS");
    const alias = join(rawRoot, ".ctx-offload", "symlink.txt");
    await symlink(path, alias);
    await expect(reader.read(alias)).rejects.toThrow("symlink");
  });

  it("accepts an exact tool-state output path as resource authority", async () => {
    const root = await temp();
    await mkdir(join(root, ".ctx-offload"));
    const path = join(root, ".ctx-offload", "metadata.txt");
    await writeFile(path, "STRUCTURED RESOURCE");
    const state = createInitialState("source");
    const hot = entry("tool", "tool result follows");
    hot.parts.push({
      type: "tool", id: "tp", sessionID: "source", messageID: "tool", callID: "call", tool: "bash",
      state: { status: "completed", input: {}, output: `Full output saved to ${path}`, title: "result", time: { start: 1, end: 2 }, metadata: { outputPath: path } } as any,
    });
    const bundle = await collectHandoff({ state, projectedEntries: [hot] }, new InMemoryContentStore(), localHandoffResourceReader(root));
    expect(Object.values(bundle.payload.blobs).some(blob => blob.data === "STRUCTURED RESOURCE")).toBe(true);
  });

  it("fails clearly when a registered required offload is missing", async () => {
    const root = await temp();
    const path = join(root, ".ctx-offload", "missing.txt");
    const state = createInitialState("source");
    state.messageIndex.set("missing", { messageId: "missing", offloaded: true, masked: true, offloadPath: path });
    await expect(collectHandoff({ state, projectedEntries: [entry("user", `Read ${path}`)] }, new InMemoryContentStore(), localHandoffResourceReader(root)))
      .rejects.toThrow("required authorized handoff offload resource could not be read");
  });

  it("bounds untrusted resource-pointer candidate accumulation before reading", async () => {
    const state = createInitialState("source");
    const pointers = Array.from({ length: 4_097 }, (_, index) => `/.ctx-offload/untrusted-${index}`).join(" ");
    let reads = 0;
    await expect(collectHandoff({ state, projectedEntries: [entry("user", pointers)] }, new InMemoryContentStore(), {
      read: async () => { reads++; return new Uint8Array(); },
    })).rejects.toThrow("candidates exceed limit");
    expect(reads).toBe(0);
  });

  it("rolls back resource files through noncanonical roots without deleting concurrently replaced files", async () => {
    const root = await temp();
    const state = createInitialState("source");
    const path = join(root, ".ctx-offload", "data.txt");
    state.messageIndex.set("tool", { messageId: "tool", offloaded: true, masked: true, offloadPath: path });
    const bundle = await collectHandoff({ state, projectedEntries: [entry("tool", `Read ${path}`)] }, new InMemoryContentStore(), { read: async () => Buffer.from("RESOURCE DATA") });
    const dest = await destination(bundle);
    const relativeRoot = relative(process.cwd(), dest.root);
    const resources = join(dest.root, "ctx-import-resources");
    const files = async () => {
      const paths = (await readdir(resources, { recursive: true })).map(value => join(resources, value));
      const flags = await Promise.all(paths.map(async value => (await lstat(value)).isFile()));
      return paths.filter((_, index) => flags[index]);
    };
    await expect(importHandoff({ ...dest.input, resourceRoot: relativeRoot, persistence: { load: async () => undefined, save: async () => { throw new Error("FAIL SAVE"); } } })).rejects.toThrow("FAIL SAVE");
    expect(await files()).toEqual([]);
    let replacement = "";
    await expect(importHandoff({ ...dest.input, persistence: { load: async () => undefined, save: async () => {
      replacement = (await files())[0];
      await rm(replacement);
      await writeFile(replacement, "CONCURRENT REPLACEMENT");
      throw new Error("FAIL SAVE");
    } } })).rejects.toThrow("unreferenced artifacts");
    expect(await readFile(replacement, "utf8")).toBe("CONCURRENT REPLACEMENT");
    expect(await dest.store.size()).toBe(0);
  });

  it("bakes root-summary replacement and exclusion without also exporting the original summary", async () => {
    const source = await fixture();
    source.state.manualOverrides.set("__summary_b8", { mode: "replace", text: "EDITED ROOT SUMMARY" });
    const replaced = await collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() });
    expect(replaced.payload.sequence.filter(node => node.type === "hot")).toHaveLength(1);
    expect(replaced.payload.blobs[replaced.payload.roots[0].summaryBlobId].data).toBe("EDITED ROOT SUMMARY");
    const dest = await destination(replaced);
    const imported = await importHandoff(dest.input);
    expect(text(imported.projectedEntries)).toContain("EDITED ROOT SUMMARY");
    expect(text(imported.projectedEntries)).not.toContain("summary 0 retained");
    source.state.manualOverrides.set("__summary_b8", { mode: "exclude" });
    const excluded = await collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() });
    expect(excluded.payload.roots[0].excluded).toBe(true);
    const other = await destination(excluded);
    expect(text((await importHandoff(other.input)).projectedEntries)).not.toContain("summary 0 retained");
  });

  it("normalizes legacy multiline root topics during export", async () => {
    const source = await fixture();
    source.state.blockRegistry.get("b8")!.topic = "legacy\nmultiline\u0000topic";
    const bundle = await collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() });
    expect(bundle.payload.roots[0].topic).toBe("legacy multiline topic");
  });

  it("preserves original structured records and summaries across a second handoff without wrapper growth", async () => {
    const source = await fixture();
    const dest = await destination(source.bundle);
    const first = await importHandoff(dest.input);
    const nextBundle = await collectHandoff({ state: first.state, importedSeed: first.seed, projectedEntries: project(first.seed.entries, first.state, true) }, dest.store, { read: async () => { throw new Error("must reuse embedded bytes"); } });
    expect(Object.values(nextBundle.payload.records)).toEqual(Object.values(source.bundle.payload.records));
    expect(Object.values(nextBundle.payload.blobs)).toEqual(Object.values(source.bundle.payload.blobs));
    expect(JSON.stringify(nextBundle)).not.toContain("Imported historical context");
  });

  it("validates the complete programmatic envelope and counts summary-only roots against strict WARM budget", async () => {
    const source = await fixture();
    const dest = await destination(source.bundle);
    await expect(importHandoff({ ...dest.input, bundle: { ...source.bundle, version: 2 } as any })).rejects.toThrow();
    const root = source.state.blockRegistry.get("b8")!;
    delete root.durableSourceRef;
    const legacy = await collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() });
    const cfg = { ...dest.input.config, contextTiers: { ...dest.input.config.contextTiers, warmBudgetMode: "strict" as const, warmMaxTokens: 1 } };
    await expect(importHandoff({ ...dest.input, bundle: legacy, config: cfg })).rejects.toThrow("strict WARM budget");
    expect(await dest.store.size()).toBe(0);
  });

  it("deduplicates shared effective sources while preserving distinct active root anchors", async () => {
    const source = await fixture();
    const second = source.state.blockRegistry.get("b9")!;
    second.effectiveMessageIds = ["first", "second"];
    second.sourceMessageIds = ["first", "second"];
    second.durableSourceRef = (await archiveCompressionSource(source.store, "source", "b9", "overlap", ["first", "second"], source.history.slice(0, 2))).record.id;
    source.state.compressionIndex = buildCompressionIndex(source.state);
    const bundle = await collectHandoff({ state: source.state, projectedEntries: project(source.history, source.state, true) }, source.store, { read: async () => new Uint8Array() });
    expect(Object.keys(bundle.payload.records)).toHaveLength(3);
    expect(bundle.payload.roots[0].sourceRecordIds[0]).toBe(bundle.payload.roots[1].sourceRecordIds[0]);
    const dest = await destination(bundle);
    const imported = await importHandoff(dest.input);
    expect(new Set(imported.seed.entries.map(item => item.info.id)).size).toBe(imported.seed.entries.length);
    expect(new Set([...imported.state.blockRegistry.values()].map(block => block.anchorMessageId)).size).toBe(2);
    let restored = deactivateCompressionBlock(imported.state, "b1")!.state;
    restored = deactivateCompressionBlock(restored, "b2")!.state;
    const restoredText = text(project(imported.seed.entries, restored));
    expect(restoredText.split("EXACT FIRST SOURCE")).toHaveLength(2);
    expect(restoredText.split("EXACT SECOND SOURCE")).toHaveLength(2);
  });

  it("keeps multiple roots missing from the rendered projection in chronological order", async () => {
    const source = await fixture();
    const bundle = await collectHandoff({ state: source.state, projectedEntries: [source.history[2]] }, source.store, { read: async () => { throw new Error("no resource expected"); } });
    expect(bundle.payload.sequence).toEqual([
      { type: "root", rootId: "b8" },
      { type: "root", rootId: "b9" },
      { type: "hot", recordId: "r3" },
    ]);
  });

  it("retains an excluded root's middle position for later decompression", async () => {
    const source = await fixture();
    const inactive = source.state.blockRegistry.get("b9")!;
    inactive.active = false;
    inactive.consumed = true;
    source.state.compressionIndex = buildCompressionIndex(source.state);
    source.state.manualOverrides.set("__summary_b8", { mode: "exclude" });
    const before = entry("before", "BEFORE ROOT");
    const middle = source.history[0];
    const after = entry("after", "AFTER ROOT");
    before.info.time.created = 1;
    middle.info.time.created = 2;
    after.info.time.created = 3;
    const history = [before, middle, after];
    const projected = project(history, source.state, true);
    const orderingState = cloneCoreState(source.state);
    orderingState.manualOverrides.delete("__summary_b8");
    const orderingEntries = project(history, orderingState, true);
    const bundle = await collectHandoff({ state: source.state, projectedEntries: projected, orderingEntries }, source.store, { read: async () => { throw new Error("no resource expected"); } });
    expect(bundle.payload.sequence.map(node => node.type)).toEqual(["hot", "root", "hot"]);

    const dest = await destination(bundle);
    const imported = await importHandoff(dest.input);
    const restored = deactivateCompressionBlock(imported.state, "b1")!.state;
    const restoredText = text(project(imported.seed.entries, restored));
    expect(restoredText.indexOf("BEFORE ROOT")).toBeLessThan(restoredText.indexOf("EXACT FIRST SOURCE"));
    expect(restoredText.indexOf("EXACT FIRST SOURCE")).toBeLessThan(restoredText.indexOf("AFTER ROOT"));
  });

  it("rejects reference amplification before constructing an unbounded historical transcript", async () => {
    const blob = makeBlob("x".repeat(64 * 1024));
    const id = blobId(blob);
    const bundle = decodeBundle(encodeBundle({ sequence: [{ type: "hot", recordId: "r1" }], roots: [], records: { r1: { role: "user", parts: Array.from({ length: 1100 }, () => ({ type: "text" as const, blobId: id })) } }, blobs: { [id]: blob } }));
    const dest = await destination(bundle);
    await expect(importHandoff(dest.input)).rejects.toThrow(/rendering limit|canonical JSON exceeds/);
    expect(await dest.store.size()).toBe(0);
  });
});
