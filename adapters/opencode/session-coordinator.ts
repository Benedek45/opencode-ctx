// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Serializes stateful operations per OpenCode session without blocking other sessions.

export class SessionCoordinator {
  private readonly chains = new Map<string, Promise<void>>();

  /** Includes operations waiting for the current operation to finish. */
  isActive(sessionId: string): boolean { return this.chains.has(sessionId); }

  async run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    this.chains.set(sessionId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.chains.get(sessionId) === queued) this.chains.delete(sessionId);
    }
  }
}

const coordinators = new Map<string, SessionCoordinator>();

export function sharedSessionCoordinator(namespace: string): SessionCoordinator {
  let coordinator = coordinators.get(namespace);
  if (!coordinator) {
    coordinator = new SessionCoordinator();
    coordinators.set(namespace, coordinator);
  }
  return coordinator;
}
