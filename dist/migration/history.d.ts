import { DatabaseSync } from "node:sqlite";
import type { HostMessageEntry } from "../adapters/opencode/host-types.js";
/** Schema families are identified structurally; unknown layouts fail closed. */
export declare class OfflineHistory {
    readonly database: DatabaseSync;
    private readonly tables;
    constructor(path: string);
    private requireColumns;
    private rows;
    read(session: string): {
        entries: HostMessageEntry[];
        schema: string;
    };
    private readSnapshot;
    close(): void;
}
//# sourceMappingURL=history.d.ts.map