export interface PortableBinding {
    path: string;
    blobId: string;
}
export interface PortableBlob {
    encoding: "utf8" | "base64";
    data: string;
    byteLength: number;
    sha256: string;
    bindings: PortableBinding[];
}
export type PortablePart = {
    type: "text" | "reasoning";
    blobId: string;
} | {
    type: "tool";
    tool: string;
    callId: string;
    status: "pending" | "running" | "completed" | "error";
    inputBlobId: string;
    outputBlobId?: string;
    title?: string;
} | {
    type: "attachment";
    blobId: string;
    mime: string;
    name: string;
};
export interface PortableRecord {
    role: "user" | "assistant";
    parts: PortablePart[];
}
export interface PortableRoot {
    id: string;
    topic: string;
    summaryBlobId: string;
    tier: "warm" | "cold";
    sourceRecordIds: string[];
    recoverable: boolean;
    excluded?: boolean;
}
export interface PortablePayload {
    sequence: Array<{
        type: "hot";
        recordId: string;
    } | {
        type: "root";
        rootId: string;
    }>;
    roots: PortableRoot[];
    records: Record<string, PortableRecord>;
    blobs: Record<string, PortableBlob>;
}
export interface PortableBundle {
    format: "ctx-context";
    version: 1;
    mode: "handoff";
    payload: PortablePayload;
    sha256: string;
}
export interface PortableLimits {
    maxFileBytes: number;
    maxDecodedBytes: number;
    maxRecords: number;
    maxRoots: number;
    maxEdges: number;
    maxBindings: number;
    maxBindingsPerBlob: number;
    maxBindingPathBytes: number;
    maxBindingPathBytesTotal: number;
    maxBindingSearchBytes: number;
    maxDepth: number;
}
export declare const PORTABLE_LIMITS: Readonly<PortableLimits>;
export declare const MAX_PORTABLE_TOPIC_BYTES = 512;
/** Deterministic JSON with recursively sorted object keys. */
export declare function canonicalJson(value: unknown): string;
export declare function sha256(data: string | Uint8Array): string;
/** Compact JSON byte size, computed without materializing the serialized value. */
export declare function canonicalJsonByteLength(value: unknown, maxBytes?: number): number;
/** Canonical JSON digest without materializing the canonical representation. */
export declare function canonicalSha256(value: unknown, maxBytes?: number): string;
/** Collapse legacy/model-authored topics into the portable one-line representation. */
export declare function normalizePortableTopic(value: string): string;
export declare function makeBlob(data: string | Uint8Array, bindings?: PortableBinding[]): PortableBlob;
export declare function blobId(blob: PortableBlob): string;
export declare function encodeBundle(payload: PortablePayload, limits?: Partial<PortableLimits>): Uint8Array;
/** Build and validate an in-memory bundle without serializing and reparsing it. */
export declare function createBundle(payload: PortablePayload, limits?: Partial<PortableLimits>): PortableBundle;
export declare function decodeBundle(bytes: Uint8Array, limits?: Partial<PortableLimits>): PortableBundle;
/** Decode an already available UTF-8 string without a string -> Buffer -> string round trip. */
export declare function decodeBundleText(text: string, limits?: Partial<PortableLimits>): PortableBundle;
/** Validate a programmatic bundle object without serializing and reparsing it. */
export declare function validateBundle(value: unknown, limits?: Partial<PortableLimits>): PortableBundle;
//# sourceMappingURL=portable-context.d.ts.map