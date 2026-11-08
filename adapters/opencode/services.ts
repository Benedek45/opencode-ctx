// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Concrete service implementations for the opencode adapter.
//
// Provides:
//   - AnthropicTokenizer: tries @anthropic-ai/tokenizer; falls back to CharTokenizer
//   - WallClock: real Date.now()
//   - FilePersistence: atomic (temp+rename) JSON sidecar under the session storage dir
//   - ConsoleLogger: prefixed console output

import { readFile, writeFile, rename, mkdir, rm, chmod } from "node:fs/promises";
import { appendFileSync, chmodSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { Clock } from "../../services/clock.js";
import type { Persistence } from "../../services/persistence.js";
import type { Logger } from "../../services/logger.js";
import type { CoreState } from "../../types/state.js";
import { CharTokenizer } from "../../services/tokenizer.js";
import { WallClock } from "../../services/clock.js";
import { createInitialState } from "../../types/state.js";
import { FilesystemContentStore } from "./content-store.js";
import { buildCompressionIndex } from "../../core/compress/transaction.js";
import { contentHash } from "../../services/contentStore.js";

const contentStoresByRoot = new Map<string, FilesystemContentStore>();

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Tokenizer that tries to load @anthropic-ai/tokenizer dynamically.
 * Falls back to CharTokenizer (len/4) if the package is not available.
 *
 * The opencode engine image may or may not have @anthropic-ai/tokenizer installed.
 * We attempt a dynamic import once and cache the result.
 */
/** Strings shorter than this are cheap to tokenize and not memoized. */
const MEMO_MIN_CHARS = 64;
/** Upper bound on characters retained by the token-count memo (~64 MB of UTF-16 at most 128 MB). */
const MEMO_MAX_CHARS = 64_000_000;

export class AnthropicTokenizer implements Tokenizer {
  private delegate: Tokenizer = new CharTokenizer();
  private initialized = false;
  private loaded = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      // Dynamic import — only works if the package is installed in the engine.
      // We use a string variable to prevent tsc from resolving the module at
      // compile time (the package is an optional runtime dependency).
      const pkgName = "@anthropic-ai/tokenizer";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await (import(pkgName) as Promise<any>);
      // `countTokens` builds (and frees) a fresh WASM encoder — loading the full
      // BPE rank table — on EVERY call, which dominated per-turn cost. Reuse one
      // encoder for the process lifetime with the package's exact normalization.
      const getTokenizer = mod.getTokenizer ?? mod.default?.getTokenizer;
      const encoder = typeof getTokenizer === "function" ? getTokenizer() : undefined;
      const countFn = mod.countTokens ?? mod.default?.countTokens;
      if (encoder && typeof encoder.encode === "function") {
        this.delegate = {
          countTokens: (text: string) => encoder.encode(text.normalize("NFKC"), "all").length as number,
        };
        this.loaded = true;
      } else if (typeof countFn === "function") {
        this.delegate = {
          countTokens: (text: string) => countFn(text) as number,
        };
        this.loaded = true;
      }
    } catch {
      // Package not available — CharTokenizer fallback stays in place
    }
  }

  /**
   * The pipeline re-estimates the same history many times per turn (budget,
   * cascade ROI, nudges, hard caps, status suffix). With the char tokenizer that
   * is free; exact BPE over a long session took minutes per turn and stalled
   * Claude sessions entirely. Counts are memoized per exact string, bounded by
   * the total characters retained as keys (oldest entries evicted first).
   */
  private readonly memo = new Map<string, number>();
  private memoChars = 0;

  countTokens(text: string): number {
    if (!this.loaded || text.length < MEMO_MIN_CHARS) return this.delegate.countTokens(text);
    const hit = this.memo.get(text);
    if (hit !== undefined) return hit;
    const count = this.delegate.countTokens(text);
    if (text.length <= MEMO_MAX_CHARS) {
      this.memo.set(text, count);
      this.memoChars += text.length;
      for (const key of this.memo.keys()) {
        if (this.memoChars <= MEMO_MAX_CHARS) break;
        this.memo.delete(key);
        this.memoChars -= key.length;
      }
    }
    return count;
  }

  get isAvailable(): boolean {
    return this.loaded;
  }
}

export type TokenizerMode = "auto" | "char" | "anthropic";

/** Build the selected tokenizer. Char mode is the fast provider-calibrated default. */
export async function buildTokenizer(mode: "char" | "anthropic" = "char"): Promise<Tokenizer> {
  if (mode === "char") return new CharTokenizer();
  const tok = new AnthropicTokenizer();
  await tok.init();
  return tok;
}

// ── Clock ─────────────────────────────────────────────────────────────────────

export { WallClock };

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * File-based persistence: writes an atomic JSON sidecar per session.
 *
 * Storage path: <storageDir>/ctx/<sessionId>.json
 * Default storageDir: process.env.CONTEXT_MANAGER_STORAGE_DIR, or
 * <WORKSPACES_ROOT>/.context-manager so app/opencode share lifecycle cleanup.
 *
 * Atomic write: write to a temp file then rename (same directory, so rename is atomic
 * on POSIX; on Windows rename is also atomic for same-volume moves).
 *
 * CoreState contains Map and Set instances which are not JSON-serializable by default.
 * We serialize them as arrays and deserialize back.
 */
export class FilePersistence implements Persistence {
  private readonly storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = resolveStorageDir(storageDir);
  }

  private sidecarPath(sessionId: string): string {
    return join(this.storageDir, "ctx", `${sessionFileKey(sessionId)}.json`);
  }

  private legacySidecarPath(sessionId: string): string {
    return join(this.storageDir, "ctx", `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128)}.json`);
  }

  async load(sessionId: string): Promise<CoreState | undefined> {
    for (const path of [this.sidecarPath(sessionId), this.legacySidecarPath(sessionId)]) {
      try {
        const raw = await readFile(path, "utf8");
        const state = deserializeState(JSON.parse(raw));
        if (state.sessionId === sessionId) return state;
        if (path === this.sidecarPath(sessionId)) throw new Error("sidecar belongs to another session");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        // A corrupt existing sidecar is not an empty session. In particular,
        // falling back would sever durable imported history on the next save.
        throw new Error(`ctx: cannot load persisted session ${sessionId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return undefined;
  }

  async save(sessionId: string, state: CoreState): Promise<void> {
    const path = this.sidecarPath(sessionId);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(serializeState(state), null, 2), { encoding: "utf8", mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    } catch (err) {
      // Best-effort cleanup of temp file
      try { await rm(tmp, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  }
}

export function resolveStorageDir(storageDir?: string): string {
  if (storageDir) return storageDir;
  const explicit = process.env.CONTEXT_MANAGER_STORAGE_DIR;
  if (explicit) return explicit;
  const workspacesRoot = process.env.WORKSPACES_ROOT;
  if (workspacesRoot) return join(workspacesRoot, ".context-manager");
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return join(xdg, "opencode", "storage");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return join(home, ".local", "share", "opencode", "storage");
}

function sessionFileKey(id: string): string {
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
  return `${readable}-${contentHash(id)}`;
}

// ── State serialization ───────────────────────────────────────────────────────
// CoreState uses Map and Set which are not JSON-serializable.
// We convert them to/from plain arrays.

type SerializedState = Omit<CoreState,
  | "blockRegistry"
  | "temporaryRetrievals"
  | "messageIndex"
  | "compressionIndex"
  | "manualOverrides"
  | "activeByAnchorMessageId"
  | "dedupDecisions"
  | "staleErrorDecisions"
  | "nearDupeDecisions"
  | "maskDecisions"
  | "hardCapDroppedIds"
  | "toolParameters"
  | "toolIdList"
  | "messageIds"
  | "nudges"
> & {
  blockRegistry: Array<[string, unknown]>;
  temporaryRetrievals: Array<[string, unknown]>;
  messageIndex: Array<[string, unknown]>;
  compressionIndex: Array<[string, unknown]>;
  manualOverrides: Array<[string, unknown]>;
  activeByAnchorMessageId: Array<[string, string]>;
  dedupDecisions: string[];
  staleErrorDecisions: string[];
  nearDupeDecisions: string[];
  maskDecisions: Array<[string, string]>;
  hardCapDroppedIds: string[];
  toolParameters: Array<[string, unknown]>;
  toolIdList: string[];
  messageIds: {
    byRawId: Array<[string, string]>;
    byRef: Array<[string, string]>;
    nextRef: number;
  };
  nudges: {
    contextLimitAnchors: string[];
    midSoftNudgeAnchors: string[];
    turnNudgeAnchors: number[];
    iterationNudgeAnchors: number[];
  };
};

function serializeState(state: CoreState): SerializedState {
  return {
    ...state,
    blockRegistry: Array.from(state.blockRegistry.entries()),
    temporaryRetrievals: Array.from(state.temporaryRetrievals.entries()),
    messageIndex: Array.from(state.messageIndex.entries()),
    compressionIndex: Array.from(state.compressionIndex.entries()),
    manualOverrides: Array.from(state.manualOverrides.entries()),
    activeByAnchorMessageId: Array.from(state.activeByAnchorMessageId.entries()),
    dedupDecisions: Array.from(state.dedupDecisions),
    staleErrorDecisions: Array.from(state.staleErrorDecisions),
    nearDupeDecisions: Array.from(state.nearDupeDecisions),
    maskDecisions: Array.from(state.maskDecisions.entries()),
    hardCapDroppedIds: Array.from(state.hardCapDroppedIds),
    toolParameters: Array.from(state.toolParameters.entries()),
    toolIdList: state.toolIdList,
    messageIds: {
      byRawId: Array.from(state.messageIds.byRawId.entries()),
      byRef: Array.from(state.messageIds.byRef.entries()),
      nextRef: state.messageIds.nextRef,
    },
    nudges: {
      contextLimitAnchors: Array.from(state.nudges.contextLimitAnchors),
      midSoftNudgeAnchors: Array.from(state.nudges.midSoftNudgeAnchors),
      turnNudgeAnchors: Array.from(state.nudges.turnNudgeAnchors),
      iterationNudgeAnchors: Array.from(state.nudges.iterationNudgeAnchors),
    },
  };
}

function deserializeState(raw: SerializedState): CoreState {
  try {
    if (raw.importedContext !== undefined) {
      const seed = raw.importedContext;
      if (!seed || seed.version !== 1 || typeof seed.seedRef !== "string" || !seed.seedRef
        || !/^[a-f0-9]{64}$/.test(seed.bundleDigest) || !Number.isSafeInteger(seed.importedAtTurn) || seed.importedAtTurn < 0) {
        throw new Error("invalid imported context reference");
      }
    }
    const state: CoreState = {
      ...raw,
      blockRegistry: new Map(raw.blockRegistry as Array<[string, CoreState["blockRegistry"] extends Map<string, infer V> ? V : never]>),
      // Retrieval output is intentionally process-local. After restart, old tool
      // results fail closed and must be retrieved again from immutable archives.
      temporaryRetrievals: new Map(),
      messageIndex: new Map(raw.messageIndex as Array<[string, CoreState["messageIndex"] extends Map<string, infer V> ? V : never]>),
      compressionIndex: new Map((raw.compressionIndex ?? []) as Array<[string, CoreState["compressionIndex"] extends Map<string, infer V> ? V : never]>),
      manualOverrides: new Map((raw.manualOverrides ?? []) as Array<[string, CoreState["manualOverrides"] extends Map<string, infer V> ? V : never]>),
      activeByAnchorMessageId: new Map(raw.activeByAnchorMessageId),
      dedupDecisions: new Set(raw.dedupDecisions ?? []),
      staleErrorDecisions: new Set(raw.staleErrorDecisions ?? []),
      nearDupeDecisions: new Set(raw.nearDupeDecisions ?? []),
      maskDecisions: new Map(raw.maskDecisions ?? []),
      hardCapDroppedIds: new Set(raw.hardCapDroppedIds ?? []),
      lastPruneCompressRuns: raw.lastPruneCompressRuns ?? 0,
      toolParameters: new Map(raw.toolParameters),
      toolIdList: raw.toolIdList ?? [],
      messageIds: {
        byRawId: new Map(raw.messageIds.byRawId),
        byRef: new Map(raw.messageIds.byRef),
        nextRef: raw.messageIds.nextRef,
      },
      nudges: {
        contextLimitAnchors: new Set(raw.nudges.contextLimitAnchors),
        midSoftNudgeAnchors: new Set(raw.nudges.midSoftNudgeAnchors),
        turnNudgeAnchors: new Set(raw.nudges.turnNudgeAnchors),
        iterationNudgeAnchors: new Set(raw.nudges.iterationNudgeAnchors),
      },
      // Backward-compat fallbacks: sessions persisted before these fields
      // existed won't have them in their JSON sidecar.
      nudgeEscalation: raw.nudgeEscalation ?? { ignoredStreak: 0, compressRunsAtLastCheck: 0 },
      eTurnsEstimate: raw.eTurnsEstimate ?? 5,
      // Older state used 0 as both "none" and a real turn-zero event. Treat a
      // positive persisted turn as observed; new state records the distinction.
      hasRecordedCacheBust: raw.hasRecordedCacheBust ?? (raw.lastCacheBustTurn ?? 0) > 0,
      lastCacheBustTurn: raw.lastCacheBustTurn ?? 0,
      tokenCalibration: raw.tokenCalibration ?? { ratio: 1.0, sampleCount: 0 },
      contextTokenMetrics: raw.contextTokenMetrics ?? {},
      runtimeConfig: raw.runtimeConfig ?? {},
      controlRevision: raw.controlRevision ?? 0,
      projectionEditRevision: raw.projectionEditRevision ?? 0,
      projectionEditAppliedRevision: raw.projectionEditAppliedRevision ?? 0,
      projectionEditPendingIds: raw.projectionEditPendingIds ?? [],
      projectionEditCutIds: raw.projectionEditCutIds ?? [],
    };
    if (!raw.compressionIndex) state.compressionIndex = buildCompressionIndex(state);
    for (const block of state.blockRegistry.values()) block.projectionTier ??= "warm";
    return state;
  } catch {
    // Malformed state — return undefined so the adapter starts fresh
    throw new Error("deserializeState: malformed state JSON");
  }
}

// ── Logger ────────────────────────────────────────────────────────────────────

/**
 * Append one log line to a size-capped file. Hosts that run plugins inside a
 * background service (OpenCode V2 desktop) discard plugin console output, so
 * without a file sink failures are invisible.
 */
export function appendLogLine(filePath: string | undefined, level: string, message: string, args: unknown[]): void {
  if (!filePath) return;
  try {
    try {
      chmodSync(filePath, 0o600);
      if (statSync(filePath).size > LOG_FILE_MAX_BYTES) writeFileSync(filePath, "", { mode: 0o600 });
    } catch { /* missing file is created below */ }
    const detail = args.map(arg => {
      if (arg instanceof Error) return arg.stack ?? arg.message;
      if (typeof arg === "string") return arg;
      try { return JSON.stringify(arg); } catch { return String(arg); }
    }).filter(text => text.length > 0).join(" ");
    appendFileSync(filePath, `${new Date().toISOString()} ${level} ${message}${detail ? ` ${detail}` : ""}\n`, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch { /* logging must never break a turn */ }
}

const LOG_FILE_MAX_BYTES = 5_000_000;

/** Logger that prefixes all messages with [ctx-adapter]; info+ also go to `filePath`. */
export class AdapterLogger implements Logger {
  private readonly prefix: string;
  private readonly filePath: string | undefined;

  constructor(prefix = "[ctx-adapter]", filePath?: string) {
    this.prefix = prefix;
    this.filePath = filePath;
  }

  debug(message: string, ...args: unknown[]): void {
    console.debug(`${this.prefix} DEBUG ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    console.info(`${this.prefix} INFO ${message}`, ...args);
    appendLogLine(this.filePath, "INFO", message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`${this.prefix} WARN ${message}`, ...args);
    appendLogLine(this.filePath, "WARN", message, args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`${this.prefix} ERROR ${message}`, ...args);
    appendLogLine(this.filePath, "ERROR", message, args);
  }
}

/** File sink shared by every context-manager logger for one storage root. */
export function ctxLogFile(storageRoot: string): string {
  return join(storageRoot, "ctx.log");
}

/** Build all services for the opencode adapter. */
export async function buildServices(
  storageDir?: string,
  tokenizerMode: TokenizerMode = "auto"
): Promise<{
  tokenizer: Tokenizer;
  tokenizerFor(providerId: string, modelId: string): Tokenizer;
  clock: Clock;
  persistence: Persistence;
  logger: Logger;
  contentStore: FilesystemContentStore;
  storageRoot: string;
}> {
  const charTokenizer = new CharTokenizer();
  const anthropicTokenizer = new AnthropicTokenizer();
  if (tokenizerMode !== "char") await anthropicTokenizer.init();
  const tokenizer = tokenizerMode === "anthropic" ? anthropicTokenizer : charTokenizer;
  const tokenizerFor = (providerId: string, modelId: string): Tokenizer => {
    if (tokenizerMode === "char") return charTokenizer;
    if (tokenizerMode === "anthropic") return anthropicTokenizer;
    const identity = `${providerId}/${modelId}`.toLowerCase();
    return identity.includes("anthropic") || identity.includes("claude")
      ? anthropicTokenizer
      : charTokenizer;
  };
  const storageRoot = resolveStorageDir(storageDir);
  let contentStore = contentStoresByRoot.get(storageRoot);
  if (!contentStore) {
    contentStore = new FilesystemContentStore(storageRoot);
    contentStoresByRoot.set(storageRoot, contentStore);
  }
  return {
    tokenizer,
    tokenizerFor,
    clock: new WallClock(),
    persistence: new FilePersistence(storageRoot),
    logger: new AdapterLogger(undefined, ctxLogFile(storageRoot)),
    contentStore,
    storageRoot,
  };
}

/** Build a fresh initial state, loading from persistence if available. */
export async function loadOrCreateState(
  sessionId: string,
  persistence: Persistence
): Promise<CoreState> {
  const loaded = await persistence.load(sessionId);
  return loaded ?? createInitialState(sessionId);
}
