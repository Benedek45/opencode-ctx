// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Bounded Aho-Corasick index: find authorized literal paths in one pass per text.
export function createResourcePathMatcher(paths, maxNodes = 65_536) {
    const nodes = [{ edges: new Map(), fail: 0 }];
    const unique = [...new Set(paths)];
    for (let id = 0; id < unique.length; id++) {
        if (!unique[id])
            throw new Error("empty resource path");
        let node = 0;
        for (let i = 0; i < unique[id].length; i++) {
            const char = unique[id][i];
            let next = nodes[node].edges.get(char);
            if (next === undefined) {
                if (nodes.length >= maxNodes)
                    throw new Error("resource path index exceeds its node limit");
                next = nodes.length;
                nodes[node].edges.set(char, next);
                nodes.push({ edges: new Map(), fail: 0 });
            }
            node = next;
        }
        nodes[node].terminal = id;
    }
    const queue = [...nodes[0].edges.values()];
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const parent = queue[cursor];
        for (const [char, child] of nodes[parent].edges) {
            let fallback = nodes[parent].fail;
            while (fallback && !nodes[fallback].edges.has(char))
                fallback = nodes[fallback].fail;
            nodes[child].fail = nodes[fallback].edges.get(char) ?? 0;
            queue.push(child);
        }
    }
    return (text, maxMatches = 256) => {
        let node = 0;
        const matches = new Set();
        // Inspect each failure-chain node at most once per text, even for repeated
        // matches. Avoid copying suffix output lists into every trie node.
        const visited = new Set();
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            while (node && !nodes[node].edges.has(char))
                node = nodes[node].fail;
            node = nodes[node].edges.get(char) ?? 0;
            for (let output = node; output && !visited.has(output); output = nodes[output].fail) {
                visited.add(output);
                const terminal = nodes[output].terminal;
                if (terminal !== undefined) {
                    matches.add(terminal);
                    if (matches.size > maxMatches)
                        throw new Error("too many resource references in one blob");
                }
            }
        }
        return unique.filter((_, id) => matches.has(id));
    };
}
//# sourceMappingURL=resource-path-matcher.js.map