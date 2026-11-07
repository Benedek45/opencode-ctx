import type { HostMessageEntry } from "./host-types.js";
/** Read-only OpenCode APIs needed to import a session into a handoff bundle. */
export interface HandoffHostReader {
    readonly projectRoot: string;
    /** Returns validated stored history before OpenCode's compaction projection. */
    readAllHistory(sessionId: string): Promise<HostMessageEntry[]>;
    /** Returns the history OpenCode currently projects after compaction filtering. */
    readHistory(sessionId: string): Promise<HostMessageEntry[]>;
    /**
     * Uses OpenCode's authoritative status map when available. Idle sessions are
     * absent from that map. On older hosts without `session.status`, this only
     * proves that one persisted-history snapshot has no pending/running tool,
     * unmatched latest user message, or incomplete latest assistant response;
     * neither path prevents activity beginning after the check.
     */
    assertIdle(sessionId: string): Promise<void>;
    /**
     * Resolves the persisted session/latest-user model, or the configured default,
     * against OpenCode's provider metadata. Returns undefined when the host cannot
     * identify that model or does not expose its limit; API failures and malformed
     * responses still throw.
     */
    getModelContext(sessionId: string): Promise<{
        providerId: string;
        modelId: string;
        contextLimit: number;
    } | undefined>;
    /** Compatibility accessor delegating to getModelContext. */
    getContextLimit(sessionId: string): Promise<number | undefined>;
}
/**
 * Build a strictly read-only reader over the V1 PluginInput SDK client.
 *
 * The V1 methods use `{ path: { id }, query: { directory } }` and return the
 * default Hey API `{ data, error, request, response }` envelope. In particular,
 * `session.messages` is intentionally called without `limit`: the server's
 * no-limit branch walks every page, while any positive limit is a tail page.
 */
export declare function createHandoffHostReader(input: unknown): HandoffHostReader;
//# sourceMappingURL=handoff-host.d.ts.map