// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Offline SQLite readers. No migrations, host startup, or database writes.
import { DatabaseSync } from "node:sqlite";
import { sessionHistoryToHost } from "../adapters/opencode-v2/map.js";
const LIMIT = 64 * 1024 * 1024;
function object(data) {
    if (typeof data !== "string")
        throw new Error("database JSON is not text");
    const value = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("database JSON is not an object");
    return value;
}
/** Schema families are identified structurally; unknown layouts fail closed. */
export class OfflineHistory {
    database;
    tables;
    constructor(path) {
        this.database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
        this.tables = new Set(this.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
        try {
            if (this.tables.has("session_message")) {
                this.requireColumns("session_v2", ["id", "directory"]);
                this.requireColumns("session_message", ["id", "session_id", "seq", "type", "data", "time_created"]);
                if (this.tables.has("session_part"))
                    this.requireColumns("session_part", ["message_id", "session_id", "ordinal", "data"]);
            }
            else if (!this.tables.has("message"))
                throw new Error("unsupported database schema: no known message table");
            if (this.tables.has("message")) {
                this.requireColumns("session", ["id", "directory"]);
                this.requireColumns("message", ["id", "session_id", "data", "time_created"]);
                this.requireColumns("part", ["id", "message_id", "session_id", "data"]);
            }
        }
        catch (error) {
            this.database.close();
            throw error;
        }
    }
    requireColumns(table, names) {
        const columns = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
        if (!names.every(name => columns.has(name)))
            throw new Error(`unsupported database schema: ${table} requires ${names.join(", ")}`);
    }
    rows(sql, session) {
        const rows = [];
        let bytes = 0;
        for (const row of this.database.prepare(sql).iterate(session)) {
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (bytes > LIMIT || rows.length >= 100_000)
                throw new Error("session history exceeds 64 MiB / 100000 rows");
            rows.push(row);
        }
        return rows;
    }
    read(session) {
        // One consistent read snapshot across messages and parts, even on a copy with WAL.
        this.database.exec("BEGIN");
        try {
            return this.readSnapshot(session);
        }
        finally {
            this.database.exec("ROLLBACK");
        }
    }
    readSnapshot(session) {
        if (this.tables.has("session_message")) {
            const owner = this.database.prepare("SELECT directory FROM session_v2 WHERE id=?").get(session);
            if (owner) {
                const rows = this.rows("SELECT * FROM session_message WHERE session_id=? ORDER BY seq, id", session);
                const parts = this.tables.has("session_part")
                    ? this.rows("SELECT * FROM session_part WHERE session_id=? ORDER BY message_id, ordinal", session) : [];
                const split = new Map();
                const ids = new Set(rows.map(row => String(row.id)));
                for (const row of parts) {
                    if (!ids.has(String(row.message_id)))
                        throw new Error("orphan native part");
                    const content = split.get(String(row.message_id)) ?? [];
                    content.push(object(row.data));
                    split.set(String(row.message_id), content);
                }
                const history = rows.map(row => {
                    const data = object(row.data);
                    if ((data.id !== undefined && data.id !== row.id) || (data.type !== undefined && data.type !== row.type))
                        throw new Error("native message identity mismatch");
                    if (data.sessionID !== undefined && data.sessionID !== session)
                        throw new Error("native message belongs to another session");
                    if (row.type === "assistant") {
                        if (data.content !== undefined && !Array.isArray(data.content))
                            throw new Error("malformed native assistant content");
                        data.content = [...(split.get(String(row.id)) ?? []), ...(data.content ?? [])];
                    }
                    // Externalized blob references are not exact text. Never stringify them as sources.
                    assertInlineText(data);
                    return { ...data, id: String(row.id), type: String(row.type) };
                });
                return { entries: sessionHistoryToHost(history, session, String(owner.directory)), schema: "native-v2-seq" };
            }
        }
        if (!this.tables.has("message") || !this.database.prepare("SELECT id FROM session WHERE id=?").get(session))
            throw new Error("session not found in database");
        const rows = this.rows("SELECT * FROM message WHERE session_id=? ORDER BY time_created, id", session);
        const entries = rows.map(row => {
            const data = object(row.data);
            if (data.id !== undefined && data.id !== row.id || data.sessionID !== undefined && data.sessionID !== session)
                throw new Error("legacy message identity mismatch");
            if (data.role !== "user" && data.role !== "assistant")
                throw new Error("unsupported legacy message role");
            return { info: { ...data, id: row.id, sessionID: session }, parts: [] };
        });
        const byId = new Map(entries.map(entry => [entry.info.id, entry]));
        // Legacy host hydration orders part IDs, NOT creation timestamps.
        for (const row of this.rows("SELECT * FROM part WHERE session_id=? ORDER BY message_id, id", session)) {
            const entry = byId.get(String(row.message_id));
            if (!entry)
                throw new Error("orphan legacy part");
            const data = object(row.data);
            if (data.sessionID !== undefined && data.sessionID !== session || data.messageID !== undefined && data.messageID !== row.message_id || data.id !== undefined && data.id !== row.id)
                throw new Error("legacy part identity mismatch");
            entry.parts.push({ ...data, id: row.id, sessionID: session, messageID: row.message_id });
        }
        return { entries, schema: "legacy-message-part" };
    }
    close() { this.database.close(); }
}
function assertInlineText(value) {
    if (!value || typeof value !== "object")
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            assertInlineText(item);
        return;
    }
    const record = value;
    if (record.type === "text" || record.type === "reasoning" || record.type === "user" || record.type === "synthetic") {
        if (record.text !== undefined && typeof record.text !== "string")
            throw new Error("externalized or malformed text: exact inline sources unavailable");
    }
    for (const [key, item] of Object.entries(record)) {
        if (key === "text" && item && typeof item === "object")
            throw new Error("externalized text requires unsupported blob hydration");
        assertInlineText(item);
    }
}
//# sourceMappingURL=history.js.map