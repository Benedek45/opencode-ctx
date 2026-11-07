// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Persistence service interface + in-memory implementation for tests.
/** In-memory persistence for tests. */
export class InMemoryPersistence {
    store = new Map();
    async load(sessionId) {
        return this.store.get(sessionId);
    }
    async save(sessionId, state) {
        this.store.set(sessionId, state);
    }
    /** Clear all stored state (for test isolation). */
    clear() {
        this.store.clear();
    }
}
//# sourceMappingURL=persistence.js.map