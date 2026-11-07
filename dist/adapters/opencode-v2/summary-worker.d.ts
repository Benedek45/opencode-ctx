import type { V2PluginContextLike } from "./host.js";
export declare const SUMMARY_AGENT = "ctx-summarizer";
export declare const SUMMARY_TITLE = "Context summary worker";
type RecordValue = Record<string, any>;
export declare function assertWorkerCapabilities(ctx: V2PluginContextLike): void;
/** Registration and all mutations are opt-in; default-off does not add any hook. */
export declare function registerWorkerAgent(ctx: V2PluginContextLike): Promise<void>;
export declare class V2SummaryWorkerTransport {
    private readonly ctx;
    private readonly model;
    private readonly prompts;
    constructor(ctx: V2PluginContextLike, model: {
        providerID: string;
        id: string;
    });
    /** Never run the parent pipeline on a worker. Remove ALL tools, not just ctx tools. */
    context(event: RecordValue): void;
    /** Shared summarizer performs bounded calls/late-create recovery and cleanup. */
    sessionFacade(): Record<string, unknown>;
}
export {};
//# sourceMappingURL=summary-worker.d.ts.map