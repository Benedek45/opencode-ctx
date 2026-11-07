/**
 * Test whether a tool name matches a simple glob pattern.
 * Supports only '*' (matches any sequence of non-separator chars) and '?' (matches one char).
 * Case-insensitive.
 */
export declare function matchesGlob(toolName: string, pattern: string): boolean;
/**
 * Find the tool class config key that matches a tool name.
 * Tries exact match first, then glob patterns.
 * Returns undefined if no match.
 */
export declare function findToolClassKey(toolName: string, toolClasses: Record<string, unknown>): string | undefined;
//# sourceMappingURL=glob.d.ts.map