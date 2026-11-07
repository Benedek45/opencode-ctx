import { type ControlPlaneBackend, type ControlServer } from "./control-server.js";
export interface WorkspaceControlRegistration {
    workspace: string;
    backend: ControlPlaneBackend;
    /** Whether this backend can enumerate durable snapshots for this root. */
    durable?: boolean;
    /** Shared-root summary lookup; returns validated assistant cwd, or undefined. */
    persistedOwner(sessionId: string): Promise<string | undefined>;
    /** Optional read-only host lookup when a legacy/ambiguous summary has no cwd. */
    hostOwner?(sessionId: string): Promise<string | undefined>;
}
export declare class ControlService {
    readonly storageRoot: string;
    private readonly workspaces;
    private readonly observed;
    private readonly inferred;
    private server?;
    private starting?;
    private configuredPort?;
    constructor(storageRoot: string);
    get listener(): ControlServer | undefined;
    /** Anonymous/headless scope is safe only while it is the sole registered owner. */
    isSoleWorkspace(workspace: string): boolean;
    observe(sessionId: string, workspace: string): void;
    /** Release resident-only routing; persisted identity is revalidated on demand. */
    forget(sessionId: string): void;
    private owner;
    private readonly dispatch;
    private requireOwner;
    register(registration: WorkspaceControlRegistration, options: {
        host?: "127.0.0.1" | "::1" | "localhost";
        port?: number;
    }, bootstrap: (server: ControlServer) => Promise<void>): Promise<{
        server: ControlServer;
        unregister(): Promise<void>;
    }>;
}
export declare function sharedControlService(root: string): ControlService;
//# sourceMappingURL=control-service.d.ts.map