export declare class SessionCoordinator {
    private readonly chains;
    /** Includes operations waiting for the current operation to finish. */
    isActive(sessionId: string): boolean;
    run<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
}
export declare function sharedSessionCoordinator(namespace: string): SessionCoordinator;
//# sourceMappingURL=session-coordinator.d.ts.map