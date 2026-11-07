// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Process-local bridge used by remote-worker tools to capture portable context.
import { isAbsolute, normalize, resolve } from "node:path";
export const REMOTE_CONTEXT_BRIDGE_KEY = Symbol.for("opencode.context-manager.remote-handoff.v1");
// Ownership is deliberately process-private and does not extend the structural
// bridge contract consumed by remote-worker.
const bridgeOwnership = new WeakMap();
export function normalizeRemoteContextDirectory(directory) {
    if (typeof directory !== "string" || !directory.trim() || !isAbsolute(directory)) {
        throw new Error("remote context directory must be an absolute path");
    }
    return normalize(resolve(directory));
}
/** Atomically register one directory/worktree alias set for a plugin workspace. */
export function registerRemoteContextBridge(directories, bridge, ownerToken) {
    const target = globalThis;
    const existingRegistry = target[REMOTE_CONTEXT_BRIDGE_KEY];
    if (existingRegistry !== undefined && !(existingRegistry instanceof Map)) {
        throw new Error("remote context bridge registry is not a Map");
    }
    const registry = existingRegistry ?? new Map();
    const aliases = new Set();
    for (const directory of directories) {
        aliases.add(normalizeRemoteContextDirectory(directory));
    }
    const normalized = [...aliases].sort();
    if (normalized.length === 0)
        return [];
    const ownershipToken = ownerToken ?? normalized.join("\0");
    if (!ownershipToken)
        throw new Error("remote context bridge owner token must not be empty");
    // Validate every alias before publishing any. A shared directory paired with
    // a different worktree is a different owner and must not leave a half-new,
    // half-stale routing table.
    for (const alias of normalized) {
        const existing = registry.get(alias);
        if (!existing || existing === bridge)
            continue;
        const ownership = bridgeOwnership.get(existing);
        if (!ownership || ownership.token !== ownershipToken) {
            throw new Error(`remote context bridge alias is owned by another workspace: ${alias}`);
        }
    }
    bridgeOwnership.set(bridge, { token: ownershipToken });
    for (const alias of normalized)
        registry.set(alias, bridge);
    if (!existingRegistry)
        target[REMOTE_CONTEXT_BRIDGE_KEY] = registry;
    return normalized;
}
/** A stale factory cannot remove a replacement's directory binding. */
export function unregisterRemoteContextBridge(directories, bridge) {
    const registry = globalThis[REMOTE_CONTEXT_BRIDGE_KEY];
    if (!(registry instanceof Map))
        return;
    for (const directory of directories) {
        const key = normalizeRemoteContextDirectory(directory);
        if (registry.get(key) === bridge)
            registry.delete(key);
    }
}
//# sourceMappingURL=remote-context-bridge.js.map