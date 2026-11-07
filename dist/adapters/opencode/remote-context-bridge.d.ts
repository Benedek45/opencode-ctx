export declare const REMOTE_CONTEXT_BRIDGE_KEY: unique symbol;
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
export declare function normalizeRemoteContextDirectory(directory: string): string;
/** Atomically register one directory/worktree alias set for a plugin workspace. */
export declare function registerRemoteContextBridge(directories: Iterable<string>, bridge: RemoteContextBridge, ownerToken?: string): string[];
/** A stale factory cannot remove a replacement's directory binding. */
export declare function unregisterRemoteContextBridge(directories: Iterable<string>, bridge: RemoteContextBridge): void;
//# sourceMappingURL=remote-context-bridge.d.ts.map