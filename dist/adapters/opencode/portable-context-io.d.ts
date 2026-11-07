import { type PortableLimits } from "./portable-context.js";
export interface FilePublication {
    path: string;
    dev: number;
    ino: number;
}
export declare function parseHandoffArguments(argumentsText: string, allowOverwrite: boolean): {
    path: string;
    overwrite: boolean;
};
export declare function readBundleFile(projectRoot: string, path: string, limits?: Partial<PortableLimits>): Promise<Uint8Array>;
export declare function writeBundleFile(projectRoot: string, path: string, bytes: Uint8Array, overwrite?: boolean, onPublished?: (file: FilePublication) => void): Promise<void>;
//# sourceMappingURL=portable-context-io.d.ts.map