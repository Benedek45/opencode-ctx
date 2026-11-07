// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Minimal glob-like pattern matching for tool name classification.
// No external dependencies.
/**
 * Test whether a tool name matches a simple glob pattern.
 * Supports only '*' (matches any sequence of non-separator chars) and '?' (matches one char).
 * Case-insensitive.
 */
export function matchesGlob(toolName, pattern) {
    const name = toolName.toLowerCase();
    const pat = pattern.toLowerCase();
    return globMatch(name, pat, 0, 0);
}
function globMatch(s, p, si, pi) {
    while (pi < p.length) {
        const pc = p[pi];
        if (pc === "*") {
            // Skip consecutive stars
            while (pi < p.length && p[pi] === "*")
                pi++;
            if (pi === p.length)
                return true;
            for (let i = si; i <= s.length; i++) {
                if (globMatch(s, p, i, pi))
                    return true;
            }
            return false;
        }
        else if (pc === "?") {
            if (si >= s.length)
                return false;
            si++;
            pi++;
        }
        else {
            if (si >= s.length || s[si] !== pc)
                return false;
            si++;
            pi++;
        }
    }
    return si === s.length;
}
/**
 * Find the tool class config key that matches a tool name.
 * Tries exact match first, then glob patterns.
 * Returns undefined if no match.
 */
export function findToolClassKey(toolName, toolClasses) {
    // Exact match first
    if (toolName in toolClasses)
        return toolName;
    // Glob match
    for (const key of Object.keys(toolClasses)) {
        if (key.includes("*") || key.includes("?")) {
            if (matchesGlob(toolName, key))
                return key;
        }
    }
    return undefined;
}
//# sourceMappingURL=glob.js.map