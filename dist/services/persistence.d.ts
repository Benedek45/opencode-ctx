import type { CoreState } from "../types/state.js";
/** Persistence service interface. */
export interface Persistence {
    /** Load state for a session. Returns undefined if not found. */
    load(sessionId: string): Promise<CoreState | undefined>;
    /** Save state for a session. */
    save(sessionId: string, state: CoreState): Promise<void>;
}
/** In-memory persistence for tests. */
export declare class InMemoryPersistence implements Persistence {
    private store;
    load(sessionId: string): Promise<CoreState | undefined>;
    save(sessionId: string, state: CoreState): Promise<void>;
    /** Clear all stored state (for test isolation). */
    clear(): void;
}
//# sourceMappingURL=persistence.d.ts.map