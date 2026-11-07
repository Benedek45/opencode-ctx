export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
    [key: string]: JsonValue;
}
export interface ControlSessionSummary {
    sessionId: string;
    title?: string;
    revision: number;
    messageCount?: number;
    tokenCount?: number;
    updatedAt?: number;
    [key: string]: JsonValue | undefined;
}
export interface ControlBlock extends JsonObject {
    blockId: string;
    status: string;
}
export interface MessageProjectionOverride {
    mode: "keep" | "exclude" | "replace";
    text?: string;
}
/**
 * One staged projection change. `override: null` clears an existing override.
 *
 * Edits are submitted as a batch so a whole dashboard save lands in a single
 * revision, and therefore costs a single prompt-cache invalidation instead of
 * one per edited message.
 */
export interface ProjectionEdit {
    messageId: string;
    override: MessageProjectionOverride | null;
}
export interface ControlSessionSnapshot {
    sessionId: string;
    revision: number;
    rawHostHistory: JsonValue[];
    projectedContext: JsonValue[];
    /** Projection after automatic decisions but before dashboard overrides. */
    automaticProjectedContext?: JsonValue[];
    blocks: ControlBlock[];
    /** Highest-precedence runtime overrides edited by the dashboard. */
    settings: JsonObject;
    /** Read-only fully resolved configuration after all layers. */
    effectiveSettings?: JsonObject;
    stats: JsonObject;
    [key: string]: JsonValue | undefined;
}
/** Inventory pages contain bounded previews and metadata, never exact payloads. */
export interface ControlViewOptions {
    view: "inventory";
    messageOffset: number;
    blockOffset: number;
    overrideOffset: number;
    limit: number;
    /** Required for subsequent pages and exact detail reads. */
    revision?: number;
    /** Projection identity, invalidated by ordinary model turns as well as edits. */
    generation?: string;
}
export interface ControlInventoryMessage {
    id: string;
    role: string;
    createdAt: number;
    tokenCount: number;
    preview: string;
    sourceId: string;
    /** Active compression coverage makes keep/replace invalid. */
    blockId?: string;
    override?: MessageProjectionOverride;
}
export interface ControlInventory {
    sessionId: string;
    revision: number;
    view: "inventory";
    generation: string;
    messageOffset: number;
    blockOffset: number;
    overrideOffset: number;
    limit: number;
    messageCount: number;
    blockCount: number;
    excludedOverrideCount: number;
    hotTokenCount: number;
    messages: ControlInventoryMessage[];
    blocks: ControlBlock[];
    excludedOverrides: ControlInventoryMessage[];
    settings: JsonObject;
    effectiveSettings: JsonObject;
    stats: JsonObject;
    pendingProjectionEdit: boolean;
    updatedAt: number;
}
export interface ControlDetail {
    sessionId: string;
    revision: number;
    id: string;
    /** Exact message (including all parts), or exact block summary. */
    message?: JsonValue;
    block?: ControlBlock;
    /** Exact saved replacement, only fetched with explicit message detail. */
    override?: MessageProjectionOverride | null;
}
export type BlockAction = "deactivate" | "reactivate" | "recompress" | "promote" | "demote";
export interface ArchiveSearchQuery {
    text: string;
    sessionId: string;
    limit?: number;
}
export interface ArchiveSearchResults extends JsonObject {
    items: JsonValue[];
}
/**
 * Host integration boundary. Every value crossing it is JSON-safe so the
 * server is independent of opencode and core in-memory types.
 */
export interface ControlPlaneBackend {
    listSessions(): Promise<ControlSessionSummary[]>;
    getSession(sessionId: string, options?: ControlViewOptions): Promise<ControlSessionSnapshot | ControlInventory | undefined>;
    /** Optional to preserve compatibility with older backend implementations. */
    getMessageDetail?(sessionId: string, messageId: string, revision: number, generation?: string): Promise<ControlDetail | undefined>;
    getBlockDetail?(sessionId: string, blockId: string, revision: number, generation?: string): Promise<ControlDetail | undefined>;
    updateSettings(sessionId: string, revision: number, settings: JsonObject, options?: ControlViewOptions): Promise<ControlSessionSnapshot | ControlInventory>;
    putMessageOverride(sessionId: string, messageId: string, revision: number, override: MessageProjectionOverride, options?: ControlViewOptions): Promise<ControlSessionSnapshot | ControlInventory>;
    deleteMessageOverride(sessionId: string, messageId: string, revision: number, options?: ControlViewOptions): Promise<ControlSessionSnapshot | ControlInventory>;
    /** Apply a whole staged batch atomically under one revision. */
    applyProjectionEdits(sessionId: string, revision: number, edits: ProjectionEdit[], options?: ControlViewOptions): Promise<ControlSessionSnapshot | ControlInventory>;
    performBlockAction(sessionId: string, blockId: string, revision: number, action: BlockAction, options?: ControlViewOptions): Promise<ControlSessionSnapshot | ControlInventory>;
    searchArchivedContent(query: ArchiveSearchQuery): Promise<ArchiveSearchResults>;
}
export interface StartControlServerOptions {
    backend: ControlPlaneBackend;
    host?: "127.0.0.1" | "::1" | "localhost";
    port?: number;
}
export interface ControlServer {
    readonly host: string;
    readonly port: number;
    readonly origin: string;
    readonly token: string;
    /**
     * Origin carrying a human-readable chat label, e.g.
     * `http://ctx-fix-login-bug-<nonce>.localhost:PORT`.
     *
     * The unguessable nonce is always retained: host-only cookies are not
     * port-scoped, so the nonce is what keeps the dashboard cookie away from
     * unrelated loopback services. The label only makes the URL self-describing.
     */
    originFor(label?: string): string;
    close(): Promise<void>;
}
export declare class RevisionConflictError extends Error {
    readonly code = "REVISION_CONFLICT";
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    constructor(message?: string, expectedRevision?: number, actualRevision?: number);
}
/**
 * Reduce arbitrary chat text to a single safe DNS label fragment.
 * Returns an empty string when nothing usable remains.
 */
export declare function sanitizeHostLabel(value: string | undefined): string;
/** Start an authenticated server on an explicit loopback interface. */
export declare function startControlServer(options: StartControlServerOptions): Promise<ControlServer>;
//# sourceMappingURL=control-server.d.ts.map