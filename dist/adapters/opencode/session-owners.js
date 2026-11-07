// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Root-local session ownership and replaceable workspace lifecycle ports.
import { resolve } from "node:path";
export class SessionOwners {
    sessionWorkspaces = new Map();
    registrations = new Map();
    retired = new Map();
    register(workspace, ports) {
        const key = resolve(workspace);
        const token = {};
        const reopened = [];
        for (const [sessionId, owner] of this.retired) {
            if (owner.workspace !== key)
                continue;
            this.retired.delete(sessionId);
            this.sessionWorkspaces.set(sessionId, key);
            reopened.push(sessionId);
        }
        this.registrations.set(key, { token, ports });
        return Object.assign(() => {
            if (this.registrations.get(key)?.token !== token)
                return;
            this.registrations.delete(key);
            for (const [sessionId, owner] of this.sessionWorkspaces) {
                if (owner === key)
                    this.sessionWorkspaces.delete(sessionId);
            }
        }, { token, workspace: key, reopened });
    }
    /** Verified host disposal only. Preserve immutable durability facts without SDK closures. */
    retire(registration) {
        if (!this.isCurrent(registration))
            return [];
        const result = [];
        const ports = this.registrations.get(registration.workspace).ports;
        for (const [sessionId, workspace] of this.sessionWorkspaces) {
            if (workspace !== registration.workspace)
                continue;
            this.sessionWorkspaces.delete(sessionId);
            this.retired.set(sessionId, { workspace, durable: ports.durable, realWorkspace: ports.realWorkspace });
            result.push(sessionId);
        }
        return result;
    }
    isCurrent(registration) {
        return this.registrations.get(registration.workspace)?.token === registration.token;
    }
    claim(sessionId, registration) {
        if (this.isCurrent(registration))
            this.sessionWorkspaces.set(sessionId, registration.workspace);
    }
    get(sessionId) { return this.sessionWorkspaces.get(sessionId); }
    entries() { return this.sessionWorkspaces.entries(); }
    delete(sessionId) { this.sessionWorkspaces.delete(sessionId); this.retired.delete(sessionId); }
    hasRegistrations() { return this.registrations.size > 0; }
    hasRetired() { return this.retired.size > 0; }
    current(sessionId, workspace) {
        const owner = this.get(sessionId) ?? resolve(workspace);
        return this.registrations.get(owner);
    }
    knownWorkspace(sessionId) {
        const owner = this.get(sessionId);
        if (owner && this.registrations.get(owner)?.ports.realWorkspace)
            return owner;
        const retired = this.retired.get(sessionId);
        return retired?.realWorkspace ? retired.workspace : undefined;
    }
    durable(sessionId) {
        const owner = this.get(sessionId);
        return owner !== undefined ? this.registrations.get(owner)?.ports.durable === true
            : this.retired.get(sessionId)?.durable === true;
    }
    async status(sessionId) {
        const owner = this.get(sessionId);
        if (!owner)
            return "unknown";
        const port = this.registrations.get(owner)?.ports;
        if (!port)
            return "unknown";
        // A status call started just before disposal must not strand the root sweep
        // indefinitely. Timeout remains fail-closed for ordinary, unretired chats.
        let timer;
        const timeout = new Promise(resolve => {
            timer = setTimeout(() => resolve("unknown"), 3_000);
            timer.unref?.();
        });
        try {
            return await Promise.race([port.status(sessionId, owner), timeout]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=session-owners.js.map