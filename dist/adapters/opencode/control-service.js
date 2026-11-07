// PolyForm Noncommercial License 1.0.0 — see LICENSE
// One authenticated control listener per storage root; workspace backends can reload.
import { isAbsolute, resolve } from "node:path";
import { startControlServer } from "./control-server.js";
export class ControlService {
    storageRoot;
    workspaces = new Map();
    observed = new Map();
    inferred = new Set();
    server;
    starting;
    configuredPort;
    constructor(storageRoot) {
        this.storageRoot = storageRoot;
    }
    get listener() { return this.server; }
    /** Anonymous/headless scope is safe only while it is the sole registered owner. */
    isSoleWorkspace(workspace) {
        return this.workspaces.size === 1 && this.workspaces.has(resolve(workspace));
    }
    observe(sessionId, workspace) {
        const key = resolve(workspace);
        if (this.workspaces.has(key)) {
            this.observed.set(sessionId, key);
            this.inferred.delete(sessionId);
        }
    }
    /** Release resident-only routing; persisted identity is revalidated on demand. */
    forget(sessionId) {
        this.observed.delete(sessionId);
        this.inferred.delete(sessionId);
    }
    async owner(sessionId, metadataChecked = false) {
        const live = this.observed.get(sessionId);
        if (live && this.workspaces.has(live))
            return this.workspaces.get(live);
        const first = [...this.workspaces.values()].find(item => item.durable !== false)
            ?? this.workspaces.values().next().value;
        if (!first)
            return undefined;
        const persisted = metadataChecked ? undefined : await first.persistedOwner(sessionId);
        const candidates = new Set();
        if (persisted && isAbsolute(persisted))
            candidates.add(resolve(persisted));
        if (!persisted) {
            for (const workspace of this.workspaces.values()) {
                const host = await workspace.hostOwner?.(sessionId);
                if (host && isAbsolute(host))
                    candidates.add(resolve(host));
            }
        }
        const matched = candidates.size === 1 ? this.workspaces.get([...candidates][0]) : undefined;
        if (matched) {
            this.observed.set(sessionId, matched.workspace);
            this.inferred.add(sessionId);
        }
        return matched;
    }
    dispatch = {
        listSessions: async () => {
            // All backends share the same root-wide snapshots and resident cache.
            // Enumerate once, never N workspaces x N snapshots or N token scans.
            const backend = [...this.workspaces.values()].find(item => item.durable !== false)
                ?? this.workspaces.values().next().value;
            if (!backend)
                return [];
            const candidates = await backend.backend.listSessions();
            const result = [];
            for (const summary of candidates) {
                const workspace = typeof summary.workspace === "string" && isAbsolute(summary.workspace)
                    ? resolve(summary.workspace) : undefined;
                const observed = this.observed.get(summary.sessionId);
                let owner = workspace && this.workspaces.has(workspace)
                    ? workspace
                    : !workspace && observed && this.workspaces.has(observed)
                        ? observed
                        : !workspace && this.workspaces.size === 1 && backend.workspace === this.storageRoot
                            ? backend.workspace : undefined;
                if (!owner && !workspace)
                    owner = (await this.owner(summary.sessionId, true))?.workspace;
                if (!owner)
                    continue;
                // A persisted directory beats stale inferred routing. Do not disclose
                // the absolute filesystem path in the dashboard list payload.
                const { workspace: _directory, ...publicSummary } = summary;
                result.push(publicSummary);
            }
            return result.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        },
        getSession: async (id, options) => (await this.owner(id))?.backend.getSession(id, options),
        getMessageDetail: async (id, message, revision, generation) => (await this.requireOwner(id)).backend.getMessageDetail?.(id, message, revision, generation),
        getBlockDetail: async (id, block, revision, generation) => (await this.requireOwner(id)).backend.getBlockDetail?.(id, block, revision, generation),
        updateSettings: async (id, revision, settings, options) => (await this.requireOwner(id)).backend.updateSettings(id, revision, settings, options),
        putMessageOverride: async (id, message, revision, override, options) => (await this.requireOwner(id)).backend.putMessageOverride(id, message, revision, override, options),
        deleteMessageOverride: async (id, message, revision, options) => (await this.requireOwner(id)).backend.deleteMessageOverride(id, message, revision, options),
        applyProjectionEdits: async (id, revision, edits, options) => (await this.requireOwner(id)).backend.applyProjectionEdits(id, revision, edits, options),
        performBlockAction: async (id, block, revision, action, options) => (await this.requireOwner(id)).backend.performBlockAction(id, block, revision, action, options),
        searchArchivedContent: async (query) => (await this.requireOwner(query.sessionId)).backend.searchArchivedContent(query),
    };
    async requireOwner(sessionId) {
        const workspace = await this.owner(sessionId);
        if (!workspace)
            throw Object.assign(new Error("Session workspace is unknown or ambiguous"), { code: "NOT_FOUND" });
        return workspace;
    }
    async register(registration, options, bootstrap) {
        const port = options.port ?? 0;
        if (this.configuredPort !== undefined && port !== 0 && port !== this.configuredPort && port !== this.server?.port) {
            throw new Error(`ctx control: port ${port} conflicts with root listener port ${this.server?.port ?? this.configuredPort}`);
        }
        const creating = !this.starting && !this.server;
        if (creating) {
            this.configuredPort = port;
            this.starting = (async () => {
                const server = await startControlServer({ backend: this.dispatch, host: options.host, port });
                try {
                    await bootstrap(server);
                }
                catch (error) {
                    await server.close();
                    throw error;
                }
                this.server = server;
                return server;
            })().finally(() => { this.starting = undefined; });
        }
        let server;
        try {
            server = this.server ?? await this.starting;
        }
        catch (error) {
            if (!this.server)
                this.configuredPort = undefined;
            throw error;
        }
        if (port !== 0 && port !== server.port)
            throw new Error(`ctx control: port ${port} conflicts with root listener port ${server.port}`);
        if (!creating)
            await bootstrap(server);
        const workspace = resolve(registration.workspace);
        const token = {};
        for (const id of this.inferred)
            this.observed.delete(id);
        this.inferred.clear();
        this.workspaces.set(workspace, { ...registration, workspace, token });
        // A newly registered owner invalidates ownership previously inferred from
        // persisted history; exact live observations are refreshed by the plugin.
        return {
            server,
            unregister: async () => {
                if (this.workspaces.get(workspace)?.token !== token)
                    return;
                this.workspaces.delete(workspace);
                for (const [id, key] of this.observed)
                    if (key === workspace) {
                        this.observed.delete(id);
                        this.inferred.delete(id);
                    }
                if (this.workspaces.size === 0 && this.server === server) {
                    this.server = undefined;
                    this.configuredPort = undefined;
                    await server.close();
                }
            },
        };
    }
}
const services = new Map();
export function sharedControlService(root) {
    const key = resolve(root);
    let service = services.get(key);
    if (!service) {
        service = new ControlService(key);
        services.set(key, service);
    }
    return service;
}
//# sourceMappingURL=control-service.js.map