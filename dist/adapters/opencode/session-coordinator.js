// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Serializes stateful operations per OpenCode session without blocking other sessions.
export class SessionCoordinator {
    chains = new Map();
    /** Includes operations waiting for the current operation to finish. */
    isActive(sessionId) { return this.chains.has(sessionId); }
    async run(sessionId, task) {
        const previous = this.chains.get(sessionId) ?? Promise.resolve();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const queued = previous.then(() => gate);
        this.chains.set(sessionId, queued);
        await previous;
        try {
            return await task();
        }
        finally {
            release();
            if (this.chains.get(sessionId) === queued)
                this.chains.delete(sessionId);
        }
    }
}
const coordinators = new Map();
export function sharedSessionCoordinator(namespace) {
    let coordinator = coordinators.get(namespace);
    if (!coordinator) {
        coordinator = new SessionCoordinator();
        coordinators.set(namespace, coordinator);
    }
    return coordinator;
}
//# sourceMappingURL=session-coordinator.js.map