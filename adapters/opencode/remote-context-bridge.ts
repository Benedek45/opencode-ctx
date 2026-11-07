// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Process-local bridge used by remote-worker tools to capture portable context.

import { isAbsolute, normalize, resolve } from "node:path";

export const REMOTE_CONTEXT_BRIDGE_KEY = Symbol.for("opencode.context-manager.remote-handoff.v1");

export interface RemoteContextRange {
  startId: string;
  endId: string;
}

export interface RemoteContextSelectionRequest {
  mode: "full" | "selected" | "none";
  messageRefs?: string[];
  blockIds?: string[];
  ranges?: RemoteContextRange[];
  includeRecovery?: boolean;
}

export interface RemoteContextCaptureRequest {
  sessionId: string;
  directory: string;
  messageId?: string;
  callId?: string;
  context?: RemoteContextSelectionRequest;
}

export interface RemoteContextCaptureSelection {
  mode: string;
  messageCount: number;
  blockCount: number;
  recoverableBlockCount: number;
  summaryOnlyBlockCount: number;
}

export interface RemoteContextCapture {
  bytes: Uint8Array;
  sessionId: string;
  directory: string;
  bundleDigest: string;
  selection: RemoteContextCaptureSelection;
}

export interface RemoteContextBridge {
  version: 1;
  capture(request: RemoteContextCaptureRequest): Promise<RemoteContextCapture>;
}

type BridgeGlobal = typeof globalThis & {
  [REMOTE_CONTEXT_BRIDGE_KEY]?: Map<string, RemoteContextBridge>;
};

interface BridgeOwnership {
  /** Private identity for the plugin's complete directory/worktree association. */
  token: string;
}

// Ownership is deliberately process-private and does not extend the structural
// bridge contract consumed by remote-worker.
const bridgeOwnership = new WeakMap<RemoteContextBridge, BridgeOwnership>();

export function normalizeRemoteContextDirectory(directory: string): string {
  if (typeof directory !== "string" || !directory.trim() || !isAbsolute(directory)) {
    throw new Error("remote context directory must be an absolute path");
  }
  return normalize(resolve(directory));
}

/** Atomically register one directory/worktree alias set for a plugin workspace. */
export function registerRemoteContextBridge(
  directories: Iterable<string>,
  bridge: RemoteContextBridge,
  ownerToken?: string,
): string[] {
  const target = globalThis as BridgeGlobal;
  const existingRegistry = target[REMOTE_CONTEXT_BRIDGE_KEY];
  if (existingRegistry !== undefined && !(existingRegistry instanceof Map)) {
    throw new Error("remote context bridge registry is not a Map");
  }
  const registry = existingRegistry ?? new Map<string, RemoteContextBridge>();
  const aliases = new Set<string>();
  for (const directory of directories) {
    aliases.add(normalizeRemoteContextDirectory(directory));
  }
  const normalized = [...aliases].sort();
  if (normalized.length === 0) return [];
  const ownershipToken = ownerToken ?? normalized.join("\0");
  if (!ownershipToken) throw new Error("remote context bridge owner token must not be empty");

  // Validate every alias before publishing any. A shared directory paired with
  // a different worktree is a different owner and must not leave a half-new,
  // half-stale routing table.
  for (const alias of normalized) {
    const existing = registry.get(alias);
    if (!existing || existing === bridge) continue;
    const ownership = bridgeOwnership.get(existing);
    if (!ownership || ownership.token !== ownershipToken) {
      throw new Error(`remote context bridge alias is owned by another workspace: ${alias}`);
    }
  }

  bridgeOwnership.set(bridge, { token: ownershipToken });
  for (const alias of normalized) registry.set(alias, bridge);
  if (!existingRegistry) target[REMOTE_CONTEXT_BRIDGE_KEY] = registry;
  return normalized;
}

/** A stale factory cannot remove a replacement's directory binding. */
export function unregisterRemoteContextBridge(directories: Iterable<string>, bridge: RemoteContextBridge): void {
  const registry = (globalThis as BridgeGlobal)[REMOTE_CONTEXT_BRIDGE_KEY];
  if (!(registry instanceof Map)) return;
  for (const directory of directories) {
    const key = normalizeRemoteContextDirectory(directory);
    if (registry.get(key) === bridge) registry.delete(key);
  }
}
