export interface HostUserMessage {
    id: string;
    sessionID: string;
    role: "user";
    time: {
        created: number;
    };
    summary?: {
        title?: string;
        body?: string;
        diffs: unknown[];
    };
    agent: string;
    model: {
        providerID: string;
        modelID: string;
    };
    system?: string;
    tools?: Record<string, boolean>;
}
export interface HostAssistantMessage {
    id: string;
    sessionID: string;
    role: "assistant";
    time: {
        created: number;
        completed?: number;
    };
    error?: unknown;
    parentID: string;
    modelID: string;
    providerID: string;
    mode: string;
    path: {
        cwd: string;
        root: string;
    };
    summary?: boolean;
    cost: number;
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
    finish?: string;
}
export type HostMessage = HostUserMessage | HostAssistantMessage;
export interface HostTextPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "text";
    text: string;
    synthetic?: boolean;
    ignored?: boolean;
}
export interface HostReasoningPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "reasoning";
    text: string;
}
export interface HostStepStartPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-start";
    snapshot?: string;
}
export interface HostStepFinishPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "step-finish";
    reason: string;
    cost: number;
    tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: {
            read: number;
            write: number;
        };
    };
}
export interface HostToolStatePending {
    status: "pending";
    input: Record<string, unknown>;
    raw: string;
}
export interface HostToolStateRunning {
    status: "running";
    input: Record<string, unknown>;
    title?: string;
    time: {
        start: number;
    };
}
export interface HostToolStateCompleted {
    status: "completed";
    input: Record<string, unknown>;
    output: string;
    title: string;
    time: {
        start: number;
        end: number;
        compacted?: number;
    };
}
export interface HostToolStateError {
    status: "error";
    input: Record<string, unknown>;
    error: string;
    time: {
        start: number;
        end: number;
    };
}
export type HostToolState = HostToolStatePending | HostToolStateRunning | HostToolStateCompleted | HostToolStateError;
export interface HostToolPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "tool";
    callID: string;
    tool: string;
    state: HostToolState;
}
export interface HostCompactionPart {
    id: string;
    sessionID: string;
    messageID: string;
    type: "compaction";
    auto: boolean;
}
export type HostPart = HostTextPart | HostReasoningPart | HostStepStartPart | HostStepFinishPart | HostToolPart | HostCompactionPart | {
    id: string;
    sessionID: string;
    messageID: string;
    type: string;
    [key: string]: unknown;
};
/** One entry in the messages.transform output array. */
export interface HostMessageEntry {
    info: HostMessage;
    parts: HostPart[];
}
/** Newer hosts provide sessionID here; older hosts pass an empty object. */
export interface MessagesTransformInput {
    sessionID?: string;
}
/** Output of experimental.chat.messages.transform. */
export interface MessagesTransformOutput {
    messages: HostMessageEntry[];
}
/**
 * Input to experimental.chat.system.transform.
 *
 * The vendored opencode engine invokes this hook with `{ sessionID, model }`
 * where `model` is a `Provider.Model`
 * (vendor/opencode/packages/opencode/src/provider/provider.ts:1018) whose model
 * id field is `id` — NOT `modelID` — and whose provider id is `providerID`. The
 * earlier `modelID: string` typing hid a runtime bug (the field was `undefined`,
 * and `.toLowerCase()` on it threw and emptied every turn). All id fields are
 * typed optional so reads must stay defensive; `id` is the correct field, with
 * `modelID`/`info.id` kept as cross-version fallbacks.
 */
export interface SystemTransformInput {
    sessionID?: string;
    model: {
        id?: string;
        modelID?: string;
        providerID?: string;
        info?: {
            id?: string;
        };
        limit?: {
            context?: number;
        };
    };
}
/** Output of experimental.chat.system.transform. */
export interface SystemTransformOutput {
    system: string[];
}
/** Input to experimental.text.complete. */
export interface TextCompleteInput {
    sessionID: string;
    messageID: string;
    partID: string;
}
/** Output of experimental.text.complete. */
export interface TextCompleteOutput {
    text: string;
}
/** Input to command.execute.before. */
export interface CommandExecuteInput {
    command: string;
    sessionID: string;
    arguments: string;
}
/** Output of command.execute.before. */
export interface CommandExecuteOutput {
    parts: HostPart[];
}
/** Input to tool.execute.before. */
export interface ToolExecuteBeforeInput {
    tool: string;
    sessionID: string;
    callID: string;
}
/** Output to tool.execute.before. Args are read-only for context-manager routing. */
export interface ToolExecuteBeforeOutput {
    args: unknown;
}
/** Input to event hook. */
export interface EventHookInput {
    event: {
        type: string;
        properties: Record<string, unknown>;
    };
}
/** Input to config hook. */
export interface ConfigHookInput {
    plugin?: Array<string | [string, Record<string, unknown>]>;
    command?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface HostToolContext {
    sessionID: string;
    messageID: string;
    agent: string;
    directory: string;
    worktree: string;
    abort: AbortSignal;
    metadata(input: {
        title?: string;
        metadata?: Record<string, unknown>;
    }): void;
    ask(input: {
        permission: string;
        patterns: string[];
        always: string[];
        metadata: Record<string, unknown>;
    }): Promise<void>;
}
export type HostToolResult = string | {
    title?: string;
    output: string;
    metadata?: Record<string, unknown>;
};
//# sourceMappingURL=host-types.d.ts.map