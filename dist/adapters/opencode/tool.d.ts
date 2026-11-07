import { type CoreState } from "../../types/state.js";
import type { CoreConfig } from "../../types/config.js";
import type { Persistence } from "../../services/persistence.js";
import type { Tokenizer } from "../../services/tokenizer.js";
import type { Logger } from "../../services/logger.js";
import type { ContentStore } from "../../services/contentStore.js";
import type { HostMessageEntry, HostToolContext, HostToolResult } from "./host-types.js";
interface TierSelectionArgs {
    promoteBlockIds?: string[];
    demoteBlockIds?: string[];
}
interface RangeCompressionArgs extends TierSelectionArgs {
    topic?: string;
    content?: Array<{
        startId: string;
        endId: string;
        summary: string;
        topic?: string;
    }>;
}
interface MessageCompressionArgs extends TierSelectionArgs {
    topic?: string;
    content?: Array<{
        messageId: string;
        topic?: string;
        summary: string;
    }>;
}
export type CompressionOutcome = "committed" | "rejected" | "failed" | "unavailable";
/** The same complete visible projection and stable refs used by validation. */
export declare function projectedCompressionMessages(entries: HostMessageEntry[], state: CoreState): {
    ref: string | undefined;
    id: string;
    role: import("../../index.js").MessageRole;
    sessionId: string;
    createdAt: number;
    isSummary?: boolean;
    isIgnored?: boolean;
    isManualReplacement?: boolean;
    parts: import("../../index.js").NeutralPart[];
    tokens?: import("../../index.js").TokenUsage;
}[];
export interface CompressToolDeps {
    getState: (sessionId: string) => CoreState | undefined;
    setState: (sessionId: string, state: CoreState) => void;
    getConfig: (sessionId: string) => CoreConfig | undefined;
    getProjectedEntries: (sessionId: string) => HostMessageEntry[] | undefined;
    getRawEntries: (sessionId: string) => HostMessageEntry[] | undefined;
    setProjectedEntries: (sessionId: string, entries: HostMessageEntry[]) => void;
    contentStore?: ContentStore;
    persistence: Persistence;
    tokenizer: Tokenizer;
    /** Model-specific uncalibrated tokenizer; falls back to tokenizer for stubs/tests. */
    getTokenizer?: (sessionId: string) => Tokenizer | undefined;
    logger: Logger;
    runExclusive: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
}
/**
 * Build the compress tool definition for registration in the opencode plugin hooks.
 *
 * The tool is registered under the key "compress" in the Hooks.tool map.
 * In this reporting-agent integration it does not call context.ask(): the BFF
 * cannot answer interactive permission prompts mid-stream, and compression only
 * mutates the context-manager's sidecar state / outgoing-message projection.
 */
export declare function buildCompressTool(deps: CompressToolDeps): {
    description: string;
    args: {
        topic: {
            type: string;
            description: string;
        };
        content: {
            type: string;
            description: string;
            items: {
                type: string;
                properties: {
                    startId: {
                        type: string;
                        description: string;
                    };
                    endId: {
                        type: string;
                        description: string;
                    };
                    topic: {
                        type: string;
                        description: string;
                    };
                    summary: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        promoteBlockIds: {
            type: string;
            description: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
        demoteBlockIds: {
            type: string;
            description: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
    };
    required: readonly ["topic", "content"];
    execute(args: RangeCompressionArgs, context: HostToolContext): Promise<HostToolResult>;
};
/** Per-message compression tool with the same transactional guarantees. */
export declare function buildCompressMessageTool(deps: CompressToolDeps): {
    description: string;
    args: {
        topic: {
            type: string;
            description: string;
        };
        content: {
            type: string;
            description: string;
            items: {
                type: string;
                properties: {
                    messageId: {
                        type: string;
                        description: string;
                    };
                    topic: {
                        type: string;
                        description: string;
                    };
                    summary: {
                        type: string;
                        description: string;
                    };
                };
                required: string[];
            };
        };
        promoteBlockIds: {
            type: string;
            description: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
        demoteBlockIds: {
            type: string;
            description: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
    };
    required: readonly ["content"];
    execute(args: MessageCompressionArgs, context: HostToolContext): Promise<HostToolResult>;
};
/** Search the current session's durable summary archive without exposing storage identities. */
export declare function buildCompressionArchiveSearchTool(deps: CompressToolDeps): {
    description: string;
    args: {
        query: {
            type: string;
            description: string;
        };
        limit: {
            type: string;
            description: string;
        };
    };
    execute(args: {
        query: string;
        limit?: number;
    }, context: HostToolContext): Promise<HostToolResult>;
};
/** Read-only eligibility refresh. Metadata only; never returns source content. */
export declare function buildCompressionStatusTool(deps: CompressToolDeps): {
    description: string;
    args: {};
    execute(_args: Record<string, never>, context: HostToolContext): Promise<HostToolResult>;
};
/** Worker commits use the same transaction, but never record model compliance attempts. */
export declare function commitWorkerCompression(deps: CompressToolDeps, sessionId: string, args: RangeCompressionArgs, directory?: string, beforeCommit?: () => Promise<boolean>): Promise<{
    committed: boolean;
    outcome: CompressionOutcome;
    codes: string[];
    blockIds: string[];
    output: string;
}>;
/** Retrieve whole cold summaries and promote their blocks persistently WARM. */
export declare function buildCompressionArchiveRetrieveTool(deps: CompressToolDeps): {
    description: string;
    args: {
        blockIds: {
            type: string;
            description: string;
            items: {
                type: string;
            };
            minItems: number;
            maxItems: number;
            uniqueItems: boolean;
        };
    };
    execute(args: {
        blockIds: string[];
    }, context: HostToolContext): Promise<HostToolResult>;
};
/** Persistently move active compression roots between WARM and COLD. */
export declare function buildContextTierUpdateTool(deps: CompressToolDeps): {
    description: string;
    args: {
        promoteBlockIds: {
            description: string;
            type: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
        demoteBlockIds: {
            description: string;
            type: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
    };
    execute(args: TierSelectionArgs, context: HostToolContext): Promise<HostToolResult>;
};
/** Release temporary summary leases without deleting durable archives. */
export declare function buildCompressionArchiveReleaseTool(deps: CompressToolDeps): {
    description: string;
    args: {
        blockIds: {
            type: string;
            description: string;
            items: {
                type: string;
            };
            maxItems: number;
            uniqueItems: boolean;
        };
    };
    execute(args: {
        blockIds?: string[];
    }, context: HostToolContext): Promise<HostToolResult>;
};
/**
 * Build the compress prompt for a session (used by the adapter to guide the model
 * when it needs to compress a specific range).
 */
export declare function buildSessionCompressPrompt(entries: HostMessageEntry[], state: CoreState, config: CoreConfig): string;
export {};
//# sourceMappingURL=tool.d.ts.map