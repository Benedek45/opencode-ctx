import type { HostMessageEntry } from "../opencode/host-types.js";
export interface V2ContentPart {
    readonly type: string;
    readonly [key: string]: unknown;
}
export interface V2Message {
    readonly id?: string;
    readonly role: "system" | "user" | "assistant" | "tool" | string;
    readonly content: ReadonlyArray<V2ContentPart>;
    readonly metadata?: Record<string, unknown>;
    readonly providerMetadata?: Record<string, unknown>;
    readonly native?: Record<string, unknown>;
}
export interface V2ModelRef {
    readonly id: string;
    readonly providerID: string;
    readonly variant?: string;
}
export interface V2TokenUsage {
    input: number;
    output: number;
    reasoning: number;
    cache: {
        read: number;
        write: number;
    };
}
export interface ContextMapOptions {
    sessionID: string;
    model?: V2ModelRef;
    /** Provider usage recorded for an assistant message (from session.step.ended events). */
    tokensFor?: (messageId: string) => V2TokenUsage | undefined;
    /** Project root used for HostAssistantMessage.path (archive metadata only). */
    projectRoot?: string;
}
interface PartStash {
    part?: V2ContentPart;
    call?: V2ContentPart;
    result?: V2ContentPart;
    /** Provider-executed results live inside the assistant message content. */
    resultInline?: boolean;
    /** Original separate `role: "tool"` message holding `result`. */
    resultMessage?: V2Message;
    /** Canonical host-normalized input/output at mapping time. */
    input?: Record<string, unknown>;
    output?: string;
}
interface EntryOrigin {
    originalIndex: number;
    messages: V2Message[];
    raw: HostMessageEntry;
}
/** Everything needed to rebuild V2 context messages from mutated host entries. */
export interface ContextPlan {
    readonly entries: HostMessageEntry[];
    readonly sessionID: string;
    readonly passthrough: Array<{
        index: number;
        message: V2Message;
    }>;
    readonly origins: Map<string, EntryOrigin>;
    readonly stash: Map<string, PartStash>;
    readonly make: (fields: Record<string, unknown>, template?: V2Message) => V2Message;
}
/**
 * Creation time encoded in an OpenCode V2 ascending identifier
 * (`msg_` + 12 hex chars). The host packs `timestamp * 0x1000 + counter` into
 * 48 bits, so only the low 36 bits of the millisecond timestamp survive; the
 * full time is the matching value closest to (and not after) `reference`.
 */
export declare function createdAtFromId(id: string | undefined, reference?: number): number | undefined;
export declare function errorText(error: unknown): string;
/** Canonical text for V2 tool content (`Tool.Content[]`). */
export declare function toolContentText(content: unknown): string;
/**
 * Map V2 context-hook messages onto V1 host entries.
 *
 * Messages without a stable id (system updates, plugin-injected reminders,
 * orphan tool results) are not given to the core. They are re-inserted at their
 * original relative position by {@link contextFromHost}.
 */
export declare function contextToHost(messages: ReadonlyArray<V2Message>, options: ContextMapOptions): ContextPlan;
/**
 * Rebuild V2 context messages from the pipeline's (possibly mutated) entries.
 *
 * - Unchanged entries reuse their original V2 message objects verbatim.
 * - Changed entries are rebuilt part-by-part, keeping each original V2 part
 *   (and its provider metadata) and replacing only the text, tool input or tool
 *   output context-manager rewrote.
 * - Entries context-manager authored (compression summaries, dashboard replacements) or
 *   restored from durable archives become fresh messages.
 * - Id-less passthrough messages keep their position relative to surviving
 *   original messages.
 */
export declare function contextFromHost(entries: ReadonlyArray<HostMessageEntry>, plan: ContextPlan): V2Message[];
export interface V2SessionMessage {
    readonly id: string;
    readonly type: string;
    readonly time?: {
        created?: number;
        completed?: number;
    };
    readonly [key: string]: unknown;
}
/**
 * Map persisted V2 session history (`session.context`) onto V1 host entries for
 * the handoff/remote-capture readers. Ids, tool call ids and tool output text
 * match {@link contextToHost} so durable state keyed by them stays consistent.
 */
export declare function sessionHistoryToHost(history: ReadonlyArray<V2SessionMessage>, sessionID: string, projectRoot?: string): HostMessageEntry[];
export {};
//# sourceMappingURL=map.d.ts.map