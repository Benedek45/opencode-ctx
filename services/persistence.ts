// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Persistence service interface + in-memory implementation for tests.

import type { CoreState } from "../types/state.js";

/** Persistence service interface. */
export interface Persistence {
  /** Load state for a session. Returns undefined if not found. */
  load(sessionId: string): Promise<CoreState | undefined>;
  /** Save state for a session. */
  save(sessionId: string, state: CoreState): Promise<void>;
}

/** In-memory persistence for tests. */
export class InMemoryPersistence implements Persistence {
  private store = new Map<string, CoreState>();

  async load(sessionId: string): Promise<CoreState | undefined> {
    return this.store.get(sessionId);
  }

  async save(sessionId: string, state: CoreState): Promise<void> {
    this.store.set(sessionId, state);
  }

  /** Clear all stored state (for test isolation). */
  clear(): void {
    this.store.clear();
  }
}
