import { sessionHistoryToHost, type V2ModelRef, type V2TokenUsage } from "./map.js";
/** Structural subset of the V2 plugin `Context` used by this adapter. */
export interface V2PluginContextLike {
    readonly options?: Readonly<Record<string, unknown>>;
    readonly location: {
        readonly directory: string;
        readonly project?: {
            readonly id?: string;
            readonly directory?: string;
            readonly canonical?: string;
        };
    };
    readonly app?: {
        readonly name?: string;
        readonly version?: string;
    };
    readonly event: {
        subscribe(options?: {
            signal?: AbortSignal;
        }): AsyncIterable<V2EventLike>;
    };
    readonly session: {
        hook(name: string, callback: (event: any) => Promise<void> | void, options?: unknown): Promise<{
            dispose(): Promise<void>;
        }>;
        get(input: {
            sessionID: string;
        }): Promise<unknown>;
        context(input: {
            sessionID: string;
        }, options?: {
            signal?: AbortSignal;
        }): Promise<unknown>;
        prompt(input: Record<string, unknown>, options?: {
            signal?: AbortSignal;
        }): Promise<unknown>;
        synthetic(input: Record<string, unknown>): Promise<unknown>;
        create?(input: Record<string, unknown>, options?: {
            signal?: AbortSignal;
        }): Promise<unknown>;
        wait?(input: {
            sessionID: string;
        }, options?: {
            signal?: AbortSignal;
        }): Promise<unknown>;
        interrupt?(input: {
            sessionID: string;
            resume: boolean;
        }, options?: {
            signal?: AbortSignal;
        }): Promise<unknown>;
        remove?(input: {
            sessionID: string;
        }, options?: {
            signal?: AbortSignal;
        }): Promise<unknown>;
    };
    readonly agent?: {
        transform(callback: (editor: {
            get(id: string): unknown;
            update(id: string, change: (agent: Record<string, any>) => void): void;
        }) => void): Promise<unknown>;
    };
    readonly tool: {
        transform(callback: (editor: V2ToolEditorLike) => void): Promise<{
            dispose(): Promise<void>;
        }>;
        hook(name: string, callback: (event: any) => Promise<void> | void): Promise<{
            dispose(): Promise<void>;
        }>;
    };
    readonly command: {
        transform(callback: (editor: V2CommandEditorLike) => void): Promise<{
            dispose(): Promise<void>;
        }>;
    };
    readonly model: {
        list(input?: unknown): Promise<unknown>;
        default(input?: unknown): Promise<unknown>;
    };
}
export interface V2ToolEditorLike {
    add(tool: Record<string, unknown>): void;
}
export interface V2CommandEditorLike {
    add(command: {
        name: string;
        description?: string;
        execute(input: V2CommandInvocation): Promise<void>;
    }): void;
}
export interface V2CommandInvocation {
    readonly sessionID: string;
    readonly prompt: {
        readonly text?: string;
        readonly [key: string]: unknown;
    };
    readonly delivery?: string;
}
export interface V2EventLike {
    readonly type: string;
    readonly data?: Record<string, unknown>;
    readonly [key: string]: unknown;
}
type StatusType = "idle" | "busy" | "retry";
export interface V2HostRuntimeOptions {
    logger?: {
        warn(message: string, error?: unknown): void;
        debug?(message: string): void;
    };
    /** Called for every received V2 event after internal bookkeeping. */
    onEvent?: (event: V2EventLike) => void | Promise<void>;
}
export declare class V2HostRuntime {
    private readonly ctx;
    private readonly options;
    readonly directory: string;
    readonly projectRoot: string;
    private readonly statuses;
    private readonly observedStatuses;
    private readonly usage;
    private modelCache;
    private modelLoad;
    private eventsLive;
    private loop;
    constructor(ctx: V2PluginContextLike, options?: V2HostRuntimeOptions);
    /** True once the event stream delivered at least one event (status is then authoritative). */
    get statusReliable(): boolean;
    start(signal: AbortSignal): void;
    /** Resolves after the event loop has stopped (abort the start() signal first). */
    stopped(): Promise<void>;
    private consume;
    /** Record one V2 event. Exposed for tests and for hosts that push events. */
    observe(event: V2EventLike, fromStream?: boolean): Promise<void>;
    private setStatus;
    status(sessionID: string): StatusType;
    /** Worker-only authority: an absent session is unknown, not inferred idle. */
    workerStatus(sessionID: string): StatusType | undefined;
    recordUsage(sessionID: string, messageId: string, tokens: V2TokenUsage): void;
    usageFor(sessionID: string, messageId: string): V2TokenUsage | undefined;
    private models;
    /** Context window of a model, or undefined when the host does not publish one. */
    contextLimit(model: V2ModelRef | undefined): Promise<number | undefined>;
    /** Session history as V1 host entries (`session.context`, i.e. after host compaction). */
    history(sessionID: string): Promise<ReturnType<typeof sessionHistoryToHost>>;
    /**
     * A read-only V1 `PluginInput` over V2 domains. Methods use the V1 SDK call
     * shape (`{ path: { id }, query }`) and return the Hey API `{ data }` /
     * `{ error }` envelope that the V1 adapter validates.
     */
    pluginInput(workerSession?: Record<string, unknown>): Record<string, unknown>;
}
/** The Promise V2 API returns plain values for most calls and `{ location, data }` for some. */
export declare function unwrapData(value: unknown): unknown;
export {};
//# sourceMappingURL=host.d.ts.map