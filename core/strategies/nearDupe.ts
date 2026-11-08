// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Near-duplicate dedup: SimHash-based detection of semantically similar tool
// outputs from STATELESS tools (read/grep/glob/webfetch/websearch), catching
// cases exact-match dedup (core/strategies/dedup.ts) misses — e.g. re-reading
// overlapping/mostly-the-same file ranges, re-running a search that returns a
// near-identical (but not byte-identical) result set.
//
// Technique: Charikar's SimHash — a 64-bit fingerprint built from weighted
// word-shingle hash-bit voting, compared by Hamming distance. This is the
// industry-standard, zero-model-call, deterministic technique for near-
// duplicate detection at scale (Google's own web-page dedup system: Manku,
// Jain, Sarma, "Detecting Near-Duplicates for Web Crawling", WWW 2007 — 64-bit
// fingerprints, Hamming distance 3, validated across an 8B-page repository).
// It requires no embeddings/model calls, so it fits the core's "zero deps, no
// fetch" invariant.
//
// Scoped to STATELESS tool classes only (config.toolClasses[tool].stateless):
// for stateful tools (bash/test/etc.) small output differences are often
// meaningful signal (a different test failure, a different exit code), not
// noise, so we do not risk false-positive collapsing there.

import type { NeutralMessage, ToolPart } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
import type { CoreState } from "../../types/state.js";
import type { TelemetryEvent } from "../../types/telemetry.js";
import { PLACEHOLDER_NEAR_DUPE } from "../placeholders.js";
import { isAlwaysProtected, isWithinTieredRetention } from "./guards.js";
import { findToolClassKey } from "../glob.js";

/**
 * Minimum output length (chars) to attempt near-dup detection. Below this,
 * word-shingle sets are too small for a stable fingerprint (short strings
 * collide by chance); exact-match dedup already covers small outputs.
 */
const MIN_OUTPUT_CHARS_FOR_NEAR_DUPE = 200;

/**
 * Default maximum differing bits (out of 64): 4. This is a similarity
 * heuristic, NOT semantic equivalence. Additionally require the same resource
 * and identical punctuation/operator token sequences; retain the later output.
 */
const DEFAULT_HAMMING_THRESHOLD = 4;

/** Word-shingle window size for the SimHash feature set. */
const SHINGLE_SIZE = 3;

/** Result of the near-dupe pass. */
export interface NearDupeResult {
  messages: NeutralMessage[];
  nearDupeCount: number;
  /** Decisions first created by this pass, excluding byte-stable reapplication. */
  newDecisionCount: number;
  tokensSaved: number;
}

/** Deterministic 64-bit FNV-1a hash (no external deps, no Math.random). */
function fnv1a64(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

/** Preserve identifier case and syntax; SimHash is similarity, not equivalence. */
function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? [];
}

/** Lexical only: never conflate case, relative/absolute paths, or parent segments. */
export function nearDupeResourceKey(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  const text = (key: string) => typeof fields[key] === "string" && (fields[key] as string).trim()
    ? fields[key] as string : undefined;
  const path = text("filePath") ?? text("file_path") ?? text("path");
  const normalizedPath = path?.replace(/\\/g, "/").replace(/\/\.\//g, "/").replace(/^\.\//, "");
  // Queries/commands need their scope too. Missing search scope is ambiguous.
  const pattern = text("pattern");
  if (pattern) return normalizedPath ? JSON.stringify(["search", pattern, normalizedPath]) : undefined;
  const command = text("command");
  if (command) return JSON.stringify(["command", command, text("workdir") ?? text("cwd") ?? ""]);
  const url = text("url");
  if (url) return JSON.stringify(["url", url]);
  return normalizedPath ? JSON.stringify(["path", normalizedPath]) : undefined;
}

/** v1 decisions lack resource/pair evidence: discard once rather than replay unsafe masks. */
export function upgradeNearDupeDecisions(state: CoreState): string[] {
  if (state.nearDupeVersion === 2) return [];
  const removed = [...state.nearDupeDecisions];
  state.nearDupeDecisions.clear();
  state.nearDupeVersion = 2;
  return removed;
}

/** Build overlapping word k-shingles from a token list. */
function shingles(tokens: string[], size: number): string[] {
  if (tokens.length === 0) return [];
  if (tokens.length < size) return [tokens.join(" ")];
  const result: string[] = [];
  for (let i = 0; i <= tokens.length - size; i++) {
    result.push(tokens.slice(i, i + size).join(" "));
  }
  return result;
}

/** Compute a 64-bit Charikar SimHash fingerprint for a text. */
export function simhash64(text: string): bigint {
  const shingleSet = shingles(tokenize(text), SHINGLE_SIZE);
  const v = new Array<number>(64).fill(0);
  for (const shingle of shingleSet) {
    const h = fnv1a64(shingle);
    for (let bit = 0; bit < 64; bit++) {
      const bitVal = (h >> BigInt(bit)) & 1n;
      v[bit] += bitVal === 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (v[bit] > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

/** Hamming distance between two 64-bit fingerprints. */
export function hammingDistance64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

function isStatelessTool(toolName: string, config: CoreConfig): boolean {
  const key = findToolClassKey(toolName, config.toolClasses);
  if (key) return config.toolClasses[key].stateless;
  return false; // unknown tools default to NOT eligible (conservative)
}

interface Candidate {
  callId: string;
  tool: string;
  resource: string;
  fingerprint: bigint;
  syntax: string;
  outputChars: number;
}

/**
 * Pure detection pass: returns the set of callIds whose output is superseded
 * by a later, near-identical (same-tool, stateless) occurrence. Does NOT
 * mutate state or messages — used both by the real strategy (runNearDupe) and
 * by the cascade's pre-flight Cost-ROI candidate-savings estimate
 * (estimateNearDupeSavings), which must not have side effects.
 *
 * Most-recent-wins: only EARLIER occurrences in a near-duplicate pair are
 * marked superseded (matches exact-match dedup semantics in dedup.ts).
 */
function detectNearDupes(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  hammingThreshold: number
): Map<string, number> {
  const candidates: Candidate[] = [];

  for (const msg of messages) {
    if (msg.isIgnored) continue;
    for (const part of msg.parts) {
      if (part.type !== "tool") continue;
      if (part.status !== "completed") continue;
      if (isAlwaysProtected(part.tool)) continue;
      if (isWithinTieredRetention(part, currentTurn, config)) continue;
      if (!isStatelessTool(part.tool, config)) continue;
      const resource = nearDupeResourceKey(part.input);
      if (!resource) continue;

      const output = part.output ?? "";
      if (output.length < MIN_OUTPUT_CHARS_FOR_NEAR_DUPE) continue;
      if (output === PLACEHOLDER_NEAR_DUPE) continue;
      // Already exact-duplicated (dedup.ts already handles this callId).
      if (state.dedupDecisions.has(part.callId)) continue;

      candidates.push({
        callId: part.callId,
        tool: part.tool,
        resource,
        fingerprint: simhash64(output),
        syntax: tokenize(output).filter(token => /^[^\p{L}\p{N}_]+$/u.test(token)).join(" "),
        outputChars: output.length,
      });
    }
  }

  // Group by exact tool name AND normalized resource; unknowns fail closed.
  const byTool = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = JSON.stringify([c.tool, c.resource]);
    const arr = byTool.get(key) ?? [];
    arr.push(c);
    byTool.set(key, arr);
  }

  // For each candidate, if a LATER candidate (same tool, document order) is
  // within the Hamming threshold, this (earlier) one is superseded. Small N per
  // tool per session (low tens, not thousands), so O(n^2) per group is fine.
  const supersededChars = new Map<string, number>();
  for (const group of byTool.values()) {
    for (let i = 0; i < group.length; i++) {
      if (supersededChars.has(group[i].callId)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].syntax === group[j].syntax &&
          hammingDistance64(group[i].fingerprint, group[j].fingerprint) <= hammingThreshold) {
          supersededChars.set(group[i].callId, group[i].outputChars);
          break;
        }
      }
    }
  }

  return supersededChars;
}

/**
 * Estimate near-dupe savings without mutating state (for the Cost-ROI P2
 * candidate-savings check in cascade.ts — see estimateDedupStaleSavings).
 * Only counts callIds not already decided (new savings this pass).
 */
export function estimateNearDupeSavings(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  hammingThreshold: number = DEFAULT_HAMMING_THRESHOLD
): number {
  const superseded = detectNearDupes(messages, currentTurn, config, state, hammingThreshold);
  let estimated = 0;
  for (const [callId, chars] of superseded) {
    if (state.nearDupeDecisions.has(callId)) continue;
    estimated += chars / 4;
  }
  return estimated;
}

/**
 * Run the near-duplicate dedup strategy.
 *
 * Writes NEW decisions to `state.nearDupeDecisions`. Only counts savings for
 * newly decided callIds (not ones already in the decision set) — mirrors
 * runDedup's decide/apply split semantics exactly.
 */
export function runNearDupe(
  messages: NeutralMessage[],
  currentTurn: number,
  config: CoreConfig,
  state: CoreState,
  hammingThreshold: number = DEFAULT_HAMMING_THRESHOLD,
  emit?: (event: TelemetryEvent) => void
): NearDupeResult {
  upgradeNearDupeDecisions(state);
  const superseded = detectNearDupes(messages, currentTurn, config, state, hammingThreshold);
  if (superseded.size === 0) {
    return { messages, nearDupeCount: 0, newDecisionCount: 0, tokensSaved: 0 };
  }

  let nearDupeCount = 0;
  let newDecisionCount = 0;
  let tokensSaved = 0;

  const result = messages.map(msg => {
    if (msg.isIgnored) return msg;
    let modified = false;
    const newParts = msg.parts.map(part => {
      if (part.type !== "tool") return part;
      if (!superseded.has(part.callId)) return part;

      const isNew = !state.nearDupeDecisions.has(part.callId);
      if (isNew) {
        newDecisionCount++;
        const savedTokens = (part.output?.length ?? 0) / 4;
        tokensSaved += savedTokens;
        state.nearDupeDecisions.add(part.callId);
        emit?.({ type: "near-dupe", callId: part.callId, tool: part.tool, tokens: savedTokens });
      }
      nearDupeCount++;
      modified = true;
      return { ...part, output: PLACEHOLDER_NEAR_DUPE } satisfies ToolPart;
    });
    if (!modified) return msg;
    return { ...msg, parts: newParts };
  });

  return { messages: result, nearDupeCount, newDecisionCount, tokensSaved };
}
