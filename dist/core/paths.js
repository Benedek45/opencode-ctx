// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Path utilities for offloaded tool outputs.
/**
 * Build the offload file path for a tool call.
 * Format: <workspaceDir>/.ctx-offload/<sessionId>/<callId>.txt
 */
export function buildOffloadPath(workspaceDir, sessionId, callId) {
    // Keep caller-controlled host IDs from escaping the adapter-owned directory.
    const safeSessionId = safePathSegment(sessionId);
    const safeCallId = safePathSegment(callId);
    return `${workspaceDir}/.ctx-offload/${safeSessionId}/${safeCallId}.txt`;
}
/** Convert an opaque host ID to one non-special filesystem segment. */
export function safePathSegment(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!cleaned || cleaned === "." || cleaned === "..")
        return cleaned.replace(/\./g, "_") || "_";
    return cleaned;
}
/** Recognize explicit reads/searches of this workspace's offloads without file I/O. */
export function referencesOffloadPath(input, workspaceDir) {
    if (!input || typeof input !== "object")
        return false;
    const fields = input;
    // Lexical normalization covers relative paths and host path separators, not symlinks.
    const normalize = (path) => {
        const segments = [];
        for (const segment of path.replace(/\\/g, "/").split("/")) {
            if (!segment || segment === ".")
                continue;
            if (segment === "..")
                segments.pop();
            else
                segments.push(segment);
        }
        return segments.join("/");
    };
    const root = normalize(`${workspaceDir}/.ctx-offload`);
    return [fields.filePath, fields.file_path, fields.path].some(value => {
        if (typeof value !== "string")
            return false;
        const path = value.replace(/\\/g, "/");
        const resolved = normalize(/^(?:\/|[A-Za-z]:\/)/.test(path) ? path : `${workspaceDir}/${path}`);
        return resolved === root || resolved.startsWith(`${root}/`);
    });
}
/**
 * Extract the first N lines from a string for use as a preview.
 * Returns the lines joined by newline.
 */
export function extractPreviewLines(text, n, maxChars = 1200) {
    const lines = text.split("\n");
    const preview = lines.slice(0, n).join("\n");
    return preview.length > maxChars ? `${preview.slice(0, maxChars)}\n…` : preview;
}
/** Count the number of lines in a string. */
export function countLines(text) {
    if (!text)
        return 0;
    return text.split("\n").length;
}
/**
 * Extract the last N lines from a string for use as a tail.
 */
export function extractTailLines(text, n) {
    const lines = text.split("\n");
    return lines.slice(-n).join("\n");
}
//# sourceMappingURL=paths.js.map