import type { CoreConfig, LayeredConfig } from "../../types/config.js";
import type { Tokenizer } from "../../services/tokenizer.js";
export type HostSessionStatus = "idle" | "busy" | "retry" | "unknown";
export interface WorkspaceSessionPorts {
    durable: boolean;
    realWorkspace: boolean;
    status(sessionId: string, workspace: string): Promise<HostSessionStatus>;
    config(sessionId: string, limit: number, providerId: string, modelId: string, runtime: LayeredConfig): CoreConfig;
    tokenizer(providerId: string, modelId: string): Tokenizer;
}
interface Registration {
    token: object;
    ports: WorkspaceSessionPorts;
}
export type WorkspaceRegistration = (() => void) & {
    readonly token: object;
    readonly workspace: string;
    readonly reopened: readonly string[];
};
export declare class SessionOwners {
    private readonly sessionWorkspaces;
    private readonly registrations;
    private readonly retired;
    register(workspace: string, ports: WorkspaceSessionPorts): WorkspaceRegistration;
    /** Verified host disposal only. Preserve immutable durability facts without SDK closures. */
    retire(registration: WorkspaceRegistration): string[];
    isCurrent(registration: WorkspaceRegistration): boolean;
    claim(sessionId: string, registration: WorkspaceRegistration): void;
    get(sessionId: string): string | undefined;
    entries(): IterableIterator<[string, string]>;
    delete(sessionId: string): void;
    hasRegistrations(): boolean;
    hasRetired(): boolean;
    current(sessionId: string, workspace: string): Registration | undefined;
    knownWorkspace(sessionId: string): string | undefined;
    durable(sessionId: string): boolean;
    status(sessionId: string): Promise<HostSessionStatus>;
}
export {};
//# sourceMappingURL=session-owners.d.ts.map