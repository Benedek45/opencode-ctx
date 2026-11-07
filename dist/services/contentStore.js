// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Content store interfaces/types plus in-memory implementation for tests.
// Host-neutral: zero imports from adapters, no Node/Bun host APIs.
// ── Stable content hash (pure JS, deterministic, no host APIs) ────────────
/**
 * Stable 64-bit hash from DJB2 + FNV-1a mixing.
 * Deterministic across all JS runtimes. Returns a base-36 string.
 */
export function contentHash(data) {
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < data.length; i++) {
        const c = data.charCodeAt(i);
        h1 = ((h1 << 5) + h1 + c) | 0;
        h2 = (Math.imul(h2, 524287) + c) | 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
/** Canonicalize metadata for hash input (sorted keys, no undefined). */
function canonicalMetadata(m) {
    const keys = Object.keys(m).sort();
    const parts = [];
    for (const k of keys) {
        const v = m[k];
        if (v !== undefined)
            parts.push(`${k}:${v}`);
    }
    return parts.join("|");
}
/** Derive a content ID from data + metadata. */
export function deriveContentId(data, metadata) {
    return contentHash(data + "::" + canonicalMetadata(metadata));
}
// ── Tokenization helpers for search ─────────────────────────────────────────
function tokenize(text) {
    return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function buildTermFreqs(tokens) {
    const m = new Map();
    for (const t of tokens)
        m.set(t, (m.get(t) ?? 0) + 1);
    return m;
}
// ── In-memory implementation ───────────────────────────────────────────────
export class InMemoryContentStore {
    records = new Map();
    async write(request) {
        return (await this.writeWithStatus(request)).record;
    }
    async writeWithStatus(request) {
        const id = request.id ?? deriveContentId(request.data, request.metadata);
        const existing = this.records.get(id);
        if (existing)
            return { record: existing, created: false };
        const record = {
            id,
            data: request.data,
            metadata: { ...request.metadata },
            createdAt: Date.now(),
            byteSize: utf8ByteLength(request.data),
        };
        this.records.set(id, record);
        return { record, created: true };
    }
    async get(id) {
        return this.records.get(id);
    }
    async delete(id) {
        return this.records.delete(id);
    }
    async list(filter) {
        const all = Array.from(this.records.values());
        if (!filter)
            return all.sort((a, b) => a.createdAt - b.createdAt);
        return all.filter(r => matchesMetadata(r.metadata, filter))
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    async search(query) {
        const t0 = performance.now();
        const maxResults = query.maxResults ?? 20;
        const maxBytes = query.maxBytes ?? 1_048_576;
        const snippetChars = query.snippetMaxChars ?? 200;
        const qTokens = tokenize(query.text);
        if (qTokens.length === 0) {
            return { items: [], totalMatches: 0, truncatedResults: false, truncatedBytes: false, queryTimeMs: 0 };
        }
        const candidates = Array.from(this.records.values())
            .filter(r => !query.filters || matchesMetadata(r.metadata, query.filters));
        // Pre-scan for exact phrase for bonus
        const queryLower = query.text.toLowerCase();
        // Compute TF and IDF for BM25-like scoring
        const N = candidates.length;
        const docFreq = new Map();
        const docTokenLists = [];
        let totalLen = 0;
        for (const r of candidates) {
            const toks = tokenize(r.data);
            totalLen += toks.length;
            const freqs = buildTermFreqs(toks);
            docTokenLists.push({ record: r, freqs, tokens: toks });
            for (const t of new Set(toks)) {
                docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
            }
        }
        const avgdl = N > 0 ? totalLen / N : 1;
        const k1 = 1.2;
        const b = 0.75;
        const scored = [];
        let accumulatedBytes = 0;
        let truncatedBytes = false;
        let truncatedResults = false;
        for (const { record, freqs, tokens } of docTokenLists) {
            let score = 0;
            for (const qt of qTokens) {
                const n = docFreq.get(qt) ?? 0;
                const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
                const f = freqs.get(qt) ?? 0;
                const dl = tokens.length;
                const tf = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl)));
                score += idf * tf;
            }
            // Exact phrase bonus
            if (queryLower.length > 0 && record.data.toLowerCase().includes(queryLower)) {
                score += 2.0;
            }
            if (score <= 0)
                continue;
            // Build snippet from first match position
            let snippet;
            const firstIdx = findFirstMatchPos(record.data.toLowerCase(), qTokens, queryLower);
            if (firstIdx >= 0) {
                snippet = buildSnippet(record.data, firstIdx, snippetChars);
            }
            scored.push({ record, score, snippet });
        }
        scored.sort((a, b) => b.score - a.score);
        const items = [];
        for (const s of scored) {
            if (items.length >= maxResults) {
                truncatedResults = true;
                break;
            }
            if (accumulatedBytes + s.record.byteSize > maxBytes) {
                truncatedBytes = true;
                break;
            }
            items.push(s);
            accumulatedBytes += s.record.byteSize;
        }
        const t1 = performance.now();
        return {
            items,
            totalMatches: scored.length,
            truncatedResults,
            truncatedBytes,
            queryTimeMs: Math.round((t1 - t0) * 100) / 100,
        };
    }
    async clear() {
        this.records.clear();
    }
    async size() {
        return this.records.size;
    }
    /** Return all records for snapshot export (no copy). */
    allRecords() {
        return Array.from(this.records.values());
    }
}
const utf8Encoder = new TextEncoder();
/** Host-neutral UTF-8 byte length. */
export function utf8ByteLength(value) {
    return utf8Encoder.encode(value).byteLength;
}
// ── Helpers ─────────────────────────────────────────────────────────────────
function matchesMetadata(record, filter) {
    for (const [key, value] of Object.entries(filter)) {
        if (value === undefined)
            continue;
        if (record[key] !== value)
            return false;
    }
    return true;
}
function findFirstMatchPos(dataLower, qTokens, queryLower) {
    // Prefer exact phrase match position
    if (queryLower.length > 0) {
        const idx = dataLower.indexOf(queryLower);
        if (idx >= 0)
            return idx;
    }
    // Fall back to first token match
    let best = -1;
    for (const t of qTokens) {
        const idx = dataLower.indexOf(t);
        if (idx >= 0 && (best < 0 || idx < best))
            best = idx;
    }
    return best;
}
function buildSnippet(data, matchPos, maxChars) {
    const half = Math.floor(maxChars / 3);
    const start = Math.max(0, matchPos - half);
    const end = Math.min(data.length, matchPos + maxChars - half);
    const matchEnd = Math.min(end, matchPos + 100);
    const before = data.slice(start, matchPos);
    const matched = data.slice(matchPos, matchEnd);
    const after = data.slice(matchEnd, end);
    return {
        before: start > 0 ? "..." + before : before,
        match: matched,
        after: end < data.length ? after + "..." : after,
    };
}
//# sourceMappingURL=contentStore.js.map