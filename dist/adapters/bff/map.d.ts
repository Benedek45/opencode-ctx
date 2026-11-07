import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreConfig } from "../../types/config.js";
export interface BffTokenUsage {
    input: number;
    output: number;
    reasoning: number;
    cache: {
        read: number;
        write: number;
    };
}
export interface BffMessageInfo {
    id: string;
    sessionID: string;
    role: "user" | "assistant";
    time: {
        created: number;
        completed?: number;
    };
    summary?: boolean;
    tokens?: BffTokenUsage;
}
export interface BffToolState {
    status: "pending" | "running" | "completed" | "error";
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
}
export interface BffPart {
    id: string;
    type: "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "compaction" | string;
    text?: string;
    callID?: string;
    tool?: string;
    state?: BffToolState;
    ignored?: boolean;
}
export interface BffMessageEntry {
    info: BffMessageInfo;
    parts: BffPart[];
}
/**
 * TODO(stub): Translate BFF message DTOs to NeutralMessage[].
 *
 * @param entries - The BFF message entries from GET /session/:id/message.
 * @param sessionId - The session identifier.
 */
export declare function toNeutral(_entries: BffMessageEntry[], _sessionId: string): NeutralMessage[];
/**
 * TODO(stub): Apply NeutralMessage mutations back to the BFF message DTOs.
 *
 * @param originalEntries - The original BFF message entries.
 * @param neutralMessages - The mutated neutral messages from the core pipeline.
 */
export declare function applyNeutral(_originalEntries: BffMessageEntry[], _neutralMessages: NeutralMessage[]): BffMessageEntry[];
/**
 * TODO(stub): Build a CoreConfig for a BFF session.
 *
 * @param sessionId - The opencode session ID.
 * @param modelContextLimit - The model's context limit (from GET /provider).
 * @param providerID - The provider ID (e.g. "opencode-go").
 * @param modelID - The model ID (e.g. "deepseek-v4-flash").
 */
export declare function loadConfig(sessionId: string, modelContextLimit?: number, _providerID?: string, _modelID?: string): CoreConfig;
//# sourceMappingURL=map.d.ts.map