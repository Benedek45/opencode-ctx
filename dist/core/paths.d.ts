/**
 * Build the offload file path for a tool call.
 * Format: <workspaceDir>/.ctx-offload/<sessionId>/<callId>.txt
 */
export declare function buildOffloadPath(workspaceDir: string, sessionId: string, callId: string): string;
/** Convert an opaque host ID to one non-special filesystem segment. */
export declare function safePathSegment(value: string): string;
/** Recognize explicit reads/searches of this workspace's offloads without file I/O. */
export declare function referencesOffloadPath(input: unknown, workspaceDir: string): boolean;
/**
 * Extract the first N lines from a string for use as a preview.
 * Returns the lines joined by newline.
 */
export declare function extractPreviewLines(text: string, n: number, maxChars?: number): string;
/** Count the number of lines in a string. */
export declare function countLines(text: string): number;
/**
 * Extract the last N lines from a string for use as a tail.
 */
export declare function extractTailLines(text: string, n: number): string;
//# sourceMappingURL=paths.d.ts.map