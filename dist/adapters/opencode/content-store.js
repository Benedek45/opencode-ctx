// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Filesystem-backed ContentStore implementation for the opencode adapter.
// Atomic writes, recovery from corrupt index, path-traversal safe.
import { readFile, writeFile, rename, mkdir, rm, readdir, stat, chmod, open } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { InMemoryContentStore, deriveContentId, contentHash } from "../../services/contentStore.js";
/** Same-process instances targeting one directory must share one index view. */
const sharedStatesByStorageDir = new Map();
function sharedState(storageDir) {
    const key = normalize(storageDir);
    let state = sharedStatesByStorageDir.get(key);
    if (!state) {
        state = {
            indexCache: null,
            indexLoadPromise: null,
            indexWriteChain: Promise.resolve(),
            contentWriteChain: Promise.resolve(),
            historyChain: Promise.resolve(),
            historyMetadata: new Map(),
            indexStamp: null,
            pendingUpserts: new Map(),
            pendingDeletions: new Set(),
        };
        sharedStatesByStorageDir.set(key, state);
    }
    return state;
}
// ── Path helpers ───────────────────────────────────────────────────────────
const BLOBS_DIR = "content-blobs";
const INDEX_FILE = "content-index.json";
const SNAPSHOTS_DIR = "session-snapshots";
const PENDING_SUFFIX = ".pending";
const PENDING_STALE_MS = 10 * 60_000;
function storageLayout(storageDir) {
    const blobsDir = join(storageDir, BLOBS_DIR);
    const indexFile = join(storageDir, INDEX_FILE);
    const snapshotsDir = join(storageDir, SNAPSHOTS_DIR);
    return { blobsDir, indexFile, snapshotsDir };
}
function snapshotStamp(info) {
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}
function validWorkspace(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 4096
        && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}
function historySummary(snapshot) {
    let title;
    const supplied = snapshot.summary?.workspace;
    let workspace = supplied === undefined || validWorkspace(supplied) ? supplied : undefined;
    let assistantWorkspace;
    let ambiguousWorkspace = false;
    if (supplied !== undefined && !validWorkspace(supplied))
        ambiguousWorkspace = true;
    for (const entry of snapshot.rawEntries) {
        if (entry.info.role === "assistant") {
            const cwd = entry.info.path?.cwd;
            if (!validWorkspace(cwd) || (assistantWorkspace !== undefined && assistantWorkspace !== cwd)
                || (workspace !== undefined && workspace !== cwd))
                ambiguousWorkspace = true;
            else
                assistantWorkspace = cwd;
        }
        if (entry.info.role !== "user")
            continue;
        if (title !== undefined)
            continue;
        const text = entry.parts.find(part => part.type === "text");
        if (text?.text?.trim()) {
            // Detach V8 sliced-string backing storage from potentially huge user text.
            // UTF-16 preserves the existing code-unit truncation, including lone surrogates.
            title = Buffer.from(text.text.trim().replace(/\s+/g, " ").slice(0, 80), "utf16le").toString("utf16le");
        }
    }
    workspace ??= assistantWorkspace;
    const version = snapshot.stateVersion?.split(":");
    const revision = snapshot.summary?.revision ?? (version?.length === 5 && version.every(value => /^\d+$/.test(value))
        ? Number(version[1]) : undefined);
    const tokenCount = snapshot.summary?.tokenCount;
    return {
        sessionId: snapshot.sessionId,
        updatedAt: snapshot.updatedAt,
        title,
        revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined,
        messageCount: snapshot.projectedEntries.length,
        tokenCount: typeof tokenCount === "number" && Number.isFinite(tokenCount) && tokenCount >= 0 ? tokenCount : undefined,
        ...(!ambiguousWorkspace && workspace ? { workspace } : {}),
    };
}
/** Reject IDs that try path traversal. */
function validateBlobId(id) {
    if (!id)
        throw new Error("content-store: empty blob id");
    if (id.includes("..") || id.includes("/") || id.includes("\\") || id.includes("\0")) {
        throw new Error(`content-store: invalid blob id (rejected path traversal): ${JSON.stringify(id)}`);
    }
    if (id.length > 256)
        throw new Error("content-store: blob id too long");
}
function blobPath(blobsDir, id) {
    validateBlobId(id);
    return join(blobsDir, `${id}.json`);
}
function pendingPath(blobsDir, id) {
    validateBlobId(id);
    return join(blobsDir, `${id}${PENDING_SUFFIX}`);
}
// ── Serialization helpers ──────────────────────────────────────────────────
function entryFromRecord(r) {
    return {
        id: r.id,
        sessionId: r.metadata.sessionId,
        projectId: r.metadata.projectId,
        source: r.metadata.source,
        kind: r.metadata.kind,
        blockId: r.metadata.blockId,
        callId: r.metadata.callId,
        label: r.metadata.label,
        createdAt: r.createdAt,
        byteSize: r.byteSize,
    };
}
function metadataFromEntry(e) {
    return {
        sessionId: e.sessionId,
        projectId: e.projectId,
        source: e.source,
        kind: e.kind,
        blockId: e.blockId,
        callId: e.callId,
        label: e.label,
    };
}
function recordToFilePayload(r) {
    return { ...r, metadata: { ...r.metadata } };
}
function filePayloadToRecord(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("content-store: malformed blob");
    const p = payload;
    if (typeof p.id !== "string" || typeof p.data !== "string" || !p.metadata
        || typeof p.metadata !== "object" || Array.isArray(p.metadata)
        || typeof p.metadata.sessionId !== "string"
        || typeof p.createdAt !== "number" || !Number.isFinite(p.createdAt)
        || typeof p.byteSize !== "number" || !Number.isFinite(p.byteSize) || p.byteSize < 0) {
        throw new Error("content-store: malformed blob");
    }
    return {
        id: p.id,
        data: p.data,
        metadata: p.metadata,
        createdAt: p.createdAt,
        byteSize: p.byteSize,
    };
}
// ── FilesystemContentStore ─────────────────────────────────────────────────
export class FilesystemContentStore {
    storageDir;
    blobsDir;
    indexFile;
    snapshotsDir;
    shared;
    constructor(storageDir) {
        this.storageDir = storageDir;
        const layout = storageLayout(storageDir);
        this.blobsDir = layout.blobsDir;
        this.indexFile = layout.indexFile;
        this.snapshotsDir = layout.snapshotsDir;
        this.shared = sharedState(storageDir);
    }
    // ── Initialization ──────────────────────────────────────────────────────
    /**
     * Ensure directory structure exists.
     * Call once before any read/write operations.
     */
    async ensureDir() {
        await Promise.all([
            mkdir(this.blobsDir, { recursive: true, mode: 0o700 }),
            mkdir(this.snapshotsDir, { recursive: true, mode: 0o700 }),
        ]);
    }
    // ── Index management ────────────────────────────────────────────────────
    async loadIndex() {
        if (this.shared.indexCache)
            return this.shared.indexCache;
        if (this.shared.indexLoadPromise)
            return this.shared.indexLoadPromise;
        this.shared.indexLoadPromise = (async () => {
            try {
                const { index: parsed, stamp } = await this.readDiskIndex();
                this.shared.indexStamp = stamp;
                this.shared.indexCache = parsed;
                return parsed;
            }
            catch {
                // Corrupt or missing index: rebuild from blob sidecars
                return this.rebuildIndex();
            }
        })();
        try {
            return await this.shared.indexLoadPromise;
        }
        finally {
            this.shared.indexLoadPromise = null;
        }
    }
    async isPending(id) {
        try {
            await stat(pendingPath(this.blobsDir, id));
            return true;
        }
        catch (err) {
            if (err.code === "ENOENT")
                return false;
            throw err;
        }
    }
    async writePendingMarker(path) {
        await writeFile(path, JSON.stringify({ pid: process.pid, at: Date.now() }), { encoding: "utf8", mode: 0o600 });
        await chmod(path, 0o600);
    }
    /**
     * Called only by writers about to (re)publish `id`. A marker left by a killed
     * writer would otherwise block that ID forever (and fail every batch that
     * contains it). A marker is stale when its recorded PID is dead or it is older
     * than PENDING_STALE_MS; legacy markers without a PID rely on age alone. Live
     * markers still reject. Reads keep treating any marker as unpublished.
     */
    async reclaimStalePending(id) {
        const path = pendingPath(this.blobsDir, id);
        let raw;
        let mtimeMs;
        try {
            mtimeMs = (await stat(path)).mtimeMs;
            raw = await readFile(path, "utf8");
        }
        catch (err) {
            if (err.code === "ENOENT")
                return;
            throw err;
        }
        let pid;
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0)
                pid = parsed.pid;
        }
        catch { /* legacy "1" marker */ }
        let stale = Date.now() - mtimeMs > PENDING_STALE_MS;
        if (!stale && pid !== undefined && pid !== process.pid) {
            try {
                process.kill(pid, 0);
            }
            catch (err) {
                stale = err.code === "ESRCH";
            }
        }
        if (!stale)
            throw new Error("content-store: blob publication is pending");
        await rm(path, { force: true });
    }
    async indexFileStamp() {
        try {
            return snapshotStamp(await stat(this.indexFile));
        }
        catch (err) {
            if (err.code === "ENOENT")
                return null;
            throw err;
        }
    }
    async readDiskIndex() {
        // Read and stamp the same inode even if another publisher renames the path.
        const file = await open(this.indexFile, "r");
        try {
            const index = JSON.parse(await file.readFile("utf8"));
            if (!index || typeof index !== "object" || index.version !== 1
                || !index.records || typeof index.records !== "object" || Array.isArray(index.records)) {
                throw new Error("content-store: malformed index");
            }
            const stamp = snapshotStamp(await file.stat());
            for (const id of Object.keys(index.records)) {
                if (await this.isPending(id))
                    delete index.records[id];
            }
            return { index, stamp };
        }
        finally {
            await file.close();
        }
    }
    async acquireIndexLock() {
        const path = `${this.indexFile}.lock`;
        // Large legacy indexes can need many pending-marker stats during a merge.
        const deadline = Date.now() + 60_000;
        let attempt = 0;
        while (true) {
            let file;
            try {
                file = await open(path, "wx", 0o600);
            }
            catch (err) {
                if (err.code !== "EEXIST")
                    throw err;
            }
            if (file) {
                const identity = await file.stat();
                try {
                    await file.writeFile(JSON.stringify({ pid: process.pid, timestamp: Date.now() }));
                }
                catch (err) {
                    await file.close();
                    await rm(path, { force: true });
                    throw err;
                }
                await file.close();
                return async () => {
                    try {
                        const current = await stat(path);
                        if (current.dev === identity.dev && current.ino === identity.ino)
                            await rm(path);
                    }
                    catch (err) {
                        if (err.code !== "ENOENT")
                            throw err;
                    }
                };
            }
            // Serialize stale-lock reclaimers, so two observers of a dead owner cannot
            // unlink a new owner's lock. A live PID is never evicted solely for age.
            let reaper;
            try {
                reaper = await open(`${path}.reap`, "wx", 0o600);
            }
            catch (err) {
                if (err.code !== "EEXIST")
                    throw err;
            }
            if (reaper) {
                try {
                    const info = await stat(path);
                    let dead = false;
                    try {
                        const owner = JSON.parse(await readFile(path, "utf8"));
                        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                            try {
                                process.kill(owner.pid, 0);
                            }
                            catch (err) {
                                dead = err.code === "ESRCH";
                            }
                        }
                        else
                            dead = Date.now() - info.mtimeMs > 30_000;
                    }
                    catch (err) {
                        if (err.code && err.code !== "ENOENT")
                            throw err;
                        dead = Date.now() - info.mtimeMs > 30_000;
                    }
                    if (dead) {
                        const current = await stat(path);
                        if (current.dev === info.dev && current.ino === info.ino
                            && current.mtimeMs === info.mtimeMs)
                            await rm(path, { force: true });
                    }
                }
                catch (err) {
                    if (err.code !== "ENOENT")
                        throw err;
                }
                finally {
                    await reaper.close();
                    await rm(`${path}.reap`, { force: true });
                }
            }
            if (Date.now() >= deadline)
                throw new Error("content-store: timed out waiting for index lock");
            await new Promise(resolve => setTimeout(resolve, Math.min(10 * 2 ** Math.min(attempt++, 4), 160)));
        }
    }
    async saveIndex(index, publishedIds = []) {
        const write = this.shared.indexWriteChain.then(async () => {
            const tmp = `${this.indexFile}.${randomUUID()}.tmp`;
            const release = await this.acquireIndexLock();
            try {
                const upserts = new Map(this.shared.pendingUpserts);
                const deletions = new Set(this.shared.pendingDeletions);
                let merged = index;
                if (await this.indexFileStamp() !== this.shared.indexStamp) {
                    try {
                        merged = (await this.readDiskIndex()).index;
                    }
                    catch (err) {
                        if (err.code === "ENOENT")
                            merged = { version: 1, records: {} };
                        else if (err instanceof SyntaxError || err.message === "content-store: malformed index") {
                            // Preserve the existing corrupt-index recovery contract, but do
                            // the exceptional full scan only while publication is locked.
                            merged = await this.rebuildIndex();
                            for (const [id, entry] of this.shared.pendingUpserts)
                                upserts.set(id, entry);
                        }
                        else
                            throw err;
                    }
                    for (const [id, entry] of upserts)
                        merged.records[id] = entry;
                    for (const id of deletions)
                        delete merged.records[id];
                }
                // Serialize inside the chain so a concurrent mutation of the shared
                // in-memory index cannot be lost to out-of-order renames.
                await writeFile(tmp, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
                await chmod(tmp, 0o600);
                await rename(tmp, this.indexFile);
                for (const id of publishedIds)
                    await rm(pendingPath(this.blobsDir, id), { force: true });
                this.shared.indexStamp = await this.indexFileStamp();
                for (const [id, entry] of upserts) {
                    if (this.shared.pendingUpserts.get(id) === entry)
                        this.shared.pendingUpserts.delete(id);
                }
                for (const id of deletions)
                    this.shared.pendingDeletions.delete(id);
                for (const [id, entry] of this.shared.pendingUpserts)
                    merged.records[id] = entry;
                for (const id of this.shared.pendingDeletions)
                    delete merged.records[id];
                // Keep all existing readers' shared index object current, too.
                index.records = merged.records;
                this.shared.indexCache = index;
            }
            catch (err) {
                try {
                    await rm(tmp, { force: true });
                }
                catch { /* best-effort */ }
                throw err;
            }
            finally {
                await release();
            }
        });
        this.shared.indexWriteChain = write.catch(() => undefined);
        await write;
    }
    async rebuildIndex() {
        // A rebuild is not a synchronized disk-index view. Publish its recovered
        // entries as local upserts on the next save.
        this.shared.indexStamp = null;
        const index = { version: 1, records: {} };
        try {
            const files = await readdir(this.blobsDir);
            for (const file of files) {
                if (!file.endsWith(".json"))
                    continue;
                const id = file.slice(0, -5);
                // Validate id before trusting it
                try {
                    validateBlobId(id);
                }
                catch {
                    continue;
                }
                try {
                    // A pending marker means a crash interrupted publication after the
                    // blob rename. Ignore it so rebuild cannot expose uncommitted data.
                    if (await this.isPending(id))
                        continue;
                    const raw = await readFile(join(this.blobsDir, file), "utf8");
                    const payload = JSON.parse(raw);
                    const record = filePayloadToRecord(payload);
                    if (record.id !== id)
                        continue;
                    index.records[id] = entryFromRecord(record);
                    this.shared.pendingUpserts.set(id, index.records[id]);
                }
                catch {
                    // Skip corrupt sidecars
                    continue;
                }
            }
        }
        catch {
            // blobsDir does not exist yet — empty index is fine
        }
        this.shared.indexCache = index;
        return index;
    }
    /** Force a full rescan from blob files. Useful after external changes. */
    async rescan() {
        this.shared.indexCache = null;
        await this.rebuildIndex();
    }
    // ── Core ContentStore operations ─────────────────────────────────────────
    async write(request) {
        return (await this.writeWithStatus(request)).record;
    }
    async writeWithStatus(request) {
        let result;
        const operation = this.shared.contentWriteChain.then(async () => {
            result = await this.writeWithStatusExclusive(request);
        });
        this.shared.contentWriteChain = operation.catch(() => undefined);
        await operation;
        return result;
    }
    async writeWithStatusExclusive(request) {
        await this.ensureDir();
        const id = request.id ?? deriveContentId(request.data, request.metadata);
        const index = await this.loadIndex();
        // Immutable: if already stored, return existing
        const existing = await this.getExclusive(id);
        if (existing)
            return { record: existing, created: false };
        if (await this.isPending(id)) {
            await this.reclaimStalePending(id);
            const recovered = await this.getExclusive(id);
            if (recovered)
                return { record: recovered, created: false };
        }
        const record = {
            id,
            data: request.data,
            metadata: { ...request.metadata },
            createdAt: Date.now(),
            byteSize: Buffer.byteLength(request.data, "utf8"),
        };
        // Atomic blob write
        const bp = blobPath(this.blobsDir, id);
        const pending = pendingPath(this.blobsDir, id);
        const tmp = `${bp}.${randomUUID()}.tmp`;
        try {
            await this.writePendingMarker(pending);
            await writeFile(tmp, JSON.stringify(recordToFilePayload(record)), { encoding: "utf8", mode: 0o600 });
            await chmod(tmp, 0o600);
            await rename(tmp, bp);
        }
        catch (err) {
            try {
                await rm(tmp, { force: true });
            }
            catch { /* best-effort */ }
            throw err;
        }
        try {
            // Update index only after the blob is durable. If index publication fails,
            // remove the blob and revert the shared index so a rescan cannot resurrect
            // an archive from a transaction that reported failure.
            index.records[id] = entryFromRecord(record);
            this.shared.pendingDeletions.delete(id);
            this.shared.pendingUpserts.set(id, index.records[id]);
            await this.saveIndex(index, [id]);
        }
        catch (err) {
            delete index.records[id];
            this.shared.pendingUpserts.delete(id);
            this.shared.pendingDeletions.add(id);
            this.shared.indexCache = index;
            await rm(bp, { force: true });
            await rm(pending, { force: true });
            throw err;
        }
        return { record, created: true };
    }
    /**
     * Batched immutable write. Each new blob is published exactly like
     * {@link writeWithStatus} (pending marker → atomic blob rename), but the
     * shared index — which spans every session and can be tens of MB — is
     * serialized ONCE for the batch instead of once per blob. Rewriting it per
     * blob made archiving a long re-fed history quadratic (minutes per turn).
     * Indexed records are skipped without reading their blobs; intact unindexed
     * blobs are adopted into the same publication without being overwritten. If the single
     * index publication fails, every blob created by this batch is removed and
     * the shared index reverted, matching the single-write rollback contract.
     */
    async writeMany(requests) {
        let results = [];
        const operation = this.shared.contentWriteChain.then(async () => {
            results = await this.writeManyExclusive(requests);
        });
        this.shared.contentWriteChain = operation.catch(() => undefined);
        await operation;
        return results;
    }
    async writeManyExclusive(requests) {
        if (requests.length === 0)
            return [];
        await this.ensureDir();
        const index = await this.loadIndex();
        const results = [];
        const created = [];
        const createdIds = new Set();
        const adoptedIds = new Set();
        const removeCreated = async () => {
            for (const item of created) {
                delete index.records[item.id];
                this.shared.pendingUpserts.delete(item.id);
                this.shared.pendingDeletions.add(item.id);
                try {
                    await rm(item.blob, { force: true });
                }
                catch { /* best-effort */ }
                try {
                    await rm(item.pending, { force: true });
                }
                catch { /* best-effort */ }
            }
            // Repairs do not own their existing blobs. Retry adoption on the next
            // lookup, but never leak a failed batch's dirty metadata into a later save.
            for (const id of adoptedIds) {
                delete index.records[id];
                this.shared.pendingUpserts.delete(id);
            }
            this.shared.indexCache = index;
        };
        try {
            for (const request of requests) {
                const id = request.id ?? deriveContentId(request.data, request.metadata);
                if (index.records[id] || createdIds.has(id)) {
                    results.push({ id, created: false });
                    continue;
                }
                // Defer repair publication so even a batch of orphaned blobs saves once.
                if (await this.getExclusive(id, false)) {
                    adoptedIds.add(id);
                    results.push({ id, created: false });
                    continue;
                }
                if (await this.isPending(id)) {
                    await this.reclaimStalePending(id);
                    if (await this.getExclusive(id, false)) {
                        adoptedIds.add(id);
                        results.push({ id, created: false });
                        continue;
                    }
                }
                const record = {
                    id,
                    data: request.data,
                    metadata: { ...request.metadata },
                    createdAt: Date.now(),
                    byteSize: Buffer.byteLength(request.data, "utf8"),
                };
                const bp = blobPath(this.blobsDir, id);
                const pending = pendingPath(this.blobsDir, id);
                const tmp = `${bp}.${randomUUID()}.tmp`;
                try {
                    await this.writePendingMarker(pending);
                    created.push({ id, blob: bp, pending });
                    createdIds.add(id);
                    await writeFile(tmp, JSON.stringify(recordToFilePayload(record)), { encoding: "utf8", mode: 0o600 });
                    await chmod(tmp, 0o600);
                    await rename(tmp, bp);
                }
                catch (err) {
                    try {
                        await rm(tmp, { force: true });
                    }
                    catch { /* best-effort */ }
                    throw err;
                }
                index.records[id] = entryFromRecord(record);
                this.shared.pendingDeletions.delete(id);
                this.shared.pendingUpserts.set(id, index.records[id]);
                results.push({ id, created: true });
            }
            if (created.length > 0 || adoptedIds.size > 0)
                await this.saveIndex(index, created.map(item => item.id));
        }
        catch (err) {
            await removeCreated();
            throw err;
        }
        return results;
    }
    async get(id) {
        const operation = this.shared.contentWriteChain.then(() => this.getExclusive(id));
        this.shared.contentWriteChain = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async getExclusive(id, publish = true) {
        validateBlobId(id);
        const index = await this.loadIndex();
        if (index.records[id])
            return this.readBlob(id);
        // Negative lookups only stat the blob: no scans, JSON reads, or publication.
        try {
            await stat(blobPath(this.blobsDir, id));
        }
        catch (err) {
            if (err.code === "ENOENT")
                return undefined;
            throw err;
        }
        if (await this.isPending(id))
            return undefined;
        const record = await this.readBlob(id);
        if (!record)
            return undefined;
        index.records[id] = entryFromRecord(record);
        this.shared.pendingDeletions.delete(id);
        this.shared.pendingUpserts.set(id, index.records[id]);
        if (!publish)
            return record;
        try {
            await this.saveIndex(index);
        }
        catch (err) {
            // Recovery never owns the existing blob. Leave it intact, but make the
            // next lookup retry adoption/publication rather than report a false repair.
            delete index.records[id];
            this.shared.pendingUpserts.delete(id);
            throw err;
        }
        return record;
    }
    async delete(id) {
        const operation = this.shared.contentWriteChain.then(() => this.deleteExclusive(id));
        this.shared.contentWriteChain = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async deleteExclusive(id) {
        validateBlobId(id);
        const index = await this.loadIndex();
        if (!index.records[id]) {
            try {
                await stat(blobPath(this.blobsDir, id));
            }
            catch (err) {
                if (err.code === "ENOENT")
                    return false;
                throw err;
            }
            if (await this.isPending(id))
                return false;
        }
        // Delete the durable blob first. A failure must remain visible so callers do
        // not claim rollback succeeded while a rescan could resurrect the record.
        const bp = blobPath(this.blobsDir, id);
        await rm(bp, { force: true });
        await rm(pendingPath(this.blobsDir, id), { force: true });
        delete index.records[id];
        this.shared.pendingUpserts.delete(id);
        this.shared.pendingDeletions.add(id);
        try {
            await this.saveIndex(index);
        }
        catch (err) {
            // Blob deletion is authoritative. Keep the in-memory index free of this
            // record even if publishing the repaired index must wait for a retry.
            this.shared.indexCache = index;
            throw err;
        }
        return true;
    }
    async list(filter) {
        const index = await this.loadIndex();
        const entries = Object.values(index.records);
        const filtered = filter
            ? entries.filter(e => matchesFilter(e, filter))
            : entries;
        filtered.sort((a, b) => a.createdAt - b.createdAt);
        const results = [];
        for (const e of filtered) {
            const blob = await this.readBlob(e.id);
            if (blob)
                results.push(blob);
        }
        return results;
    }
    async search(query) {
        const index = await this.loadIndex();
        // Keep ranking query-local, and reject unrelated metadata before loading
        // payloads so a session-scoped search does not materialize the entire store.
        const searchEngine = new InMemoryContentStore();
        for (const entry of Object.values(index.records)) {
            if (query.filters && !matchesFilter(entry, query.filters))
                continue;
            const blob = await this.readBlob(entry.id);
            if (blob)
                await searchEngine.write({ data: blob.data, metadata: blob.metadata, id: blob.id });
        }
        return searchEngine.search(query);
    }
    async clear() {
        const operation = this.shared.contentWriteChain.then(() => this.clearExclusive());
        this.shared.contentWriteChain = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async clearExclusive() {
        const index = await this.loadIndex();
        // Remove all blob files
        try {
            const files = await readdir(this.blobsDir);
            for (const file of files) {
                if (!file.endsWith(".json"))
                    continue;
                try {
                    await rm(join(this.blobsDir, file), { force: true });
                }
                catch { /* best-effort */ }
            }
        }
        catch { /* blobsDir may not exist */ }
        // Reset index
        for (const id of Object.keys(index.records)) {
            this.shared.pendingUpserts.delete(id);
            this.shared.pendingDeletions.add(id);
        }
        index.records = {};
        await this.saveIndex(index);
    }
    async size() {
        const index = await this.loadIndex();
        return Object.keys(index.records).length;
    }
    // ── Blob I/O ────────────────────────────────────────────────────────────
    async readBlob(id) {
        validateBlobId(id);
        const bp = blobPath(this.blobsDir, id);
        try {
            const raw = await readFile(bp, "utf8");
            const record = filePayloadToRecord(JSON.parse(raw));
            if (record.id !== id)
                throw new Error("content-store: blob id mismatch");
            return record;
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
            // Blob missing: remove from index
            const index = await this.loadIndex();
            if (index.records[id]) {
                delete index.records[id];
                this.shared.pendingUpserts.delete(id);
                this.shared.pendingDeletions.add(id);
                await this.saveIndex(index);
            }
            return undefined;
        }
    }
    // ── Delete-unreferenced ──────────────────────────────────────────────────
    /**
     * Remove all records whose id is NOT in the active set.
     * Returns the number of records removed.
     */
    async deleteUnreferenced(activeIds) {
        const index = await this.loadIndex();
        const toRemove = Object.keys(index.records).filter(id => !activeIds.has(id));
        for (const id of toRemove) {
            await this.delete(id);
        }
        return toRemove.length;
    }
    // ── Snapshot API (dashboard-friendly) ────────────────────────────────────
    /**
     * Return a serializable snapshot of all content records.
     * The dashboard uses this for the "raw" history view.
     */
    async historySnapshot() {
        const all = await this.list();
        return {
            version: 1,
            records: all,
            exportedAt: Date.now(),
        };
    }
    /** Atomically replace the latest raw/projected view for one session. */
    async saveSessionHistory(snapshot) {
        const operation = this.shared.historyChain.then(() => this.saveSessionHistoryExclusive(snapshot));
        this.shared.historyChain = operation.catch(() => undefined);
        await operation;
    }
    async saveSessionHistoryExclusive(snapshot) {
        if (snapshot.summary?.workspace !== undefined && !validWorkspace(snapshot.summary.workspace)) {
            throw new Error("content-store: summary.workspace must be a normalized absolute directory (at most 4096 characters)");
        }
        await this.ensureDir();
        const path = this.sessionSnapshotPath(snapshot.sessionId);
        const tmp = `${path}.${randomUUID()}.tmp`;
        let summary;
        let written;
        try {
            // Capture metadata from the same input as serialization, before yielding.
            try {
                summary = historySummary(snapshot);
            }
            catch { /* exact history still wins */ }
            await writeFile(tmp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
            await chmod(tmp, 0o600);
            try {
                written = await stat(tmp);
            }
            catch { /* metadata is optional */ }
            await rename(tmp, path);
        }
        catch (err) {
            try {
                await rm(tmp, { force: true });
            }
            catch { /* best effort */ }
            throw err;
        }
        // The exact history commit is authoritative. A disposable metadata failure
        // must never roll it back or make the caller report that history was lost.
        try {
            const published = await stat(path);
            // Another process may have replaced the snapshot after our rename. Never
            // attach our summary to that process's generation. Rename can change ctime.
            if (!summary || !written || published.dev !== written.dev || published.ino !== written.ino
                || published.size !== written.size || published.mtimeMs !== written.mtimeMs)
                return;
            const metadata = {
                version: 1,
                stamp: snapshotStamp(published),
                summary,
            };
            this.shared.historyMetadata.set(path, metadata);
            await this.saveHistoryMetadata(path, metadata);
        }
        catch { /* listing repairs missing/stale metadata */ }
    }
    async loadSessionHistory(sessionId) {
        for (const path of [this.sessionSnapshotPath(sessionId), this.legacySessionSnapshotPath(sessionId)]) {
            try {
                const raw = await readFile(path, "utf8");
                const parsed = JSON.parse(raw);
                if (parsed.version !== 1 || parsed.sessionId !== sessionId)
                    continue;
                if (!Array.isArray(parsed.rawEntries) || !Array.isArray(parsed.projectedEntries))
                    continue;
                return parsed;
            }
            catch { /* try the next compatible path */ }
        }
        return undefined;
    }
    async listSessionHistories(resolveLegacyRevision) {
        // Coalesce concurrent dashboard instances and snapshot publication. Only
        // lightweight metadata survives this queue, never parsed history payloads.
        const operation = this.shared.historyChain.then(() => this.listSessionHistoriesExclusive(resolveLegacyRevision));
        this.shared.historyChain = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async listSessionHistoriesExclusive(resolveLegacyRevision) {
        await this.ensureDir();
        const result = new Map();
        const files = await readdir(this.snapshotsDir);
        const present = new Set(files.map(file => join(this.snapshotsDir, file)));
        for (const path of this.shared.historyMetadata.keys()) {
            if (!present.has(path))
                this.shared.historyMetadata.delete(path);
        }
        for (const file of files) {
            if (!file.endsWith(".json"))
                continue;
            const path = join(this.snapshotsDir, file);
            try {
                const stamp = snapshotStamp(await stat(path));
                let metadata = this.shared.historyMetadata.get(path);
                if (metadata?.stamp !== stamp) {
                    metadata = undefined;
                    try {
                        const sidecar = `${path}.summary`;
                        if ((await stat(sidecar)).size > 16_384)
                            throw new Error("oversized history metadata");
                        const parsed = JSON.parse(await readFile(sidecar, "utf8"));
                        const s = parsed.summary;
                        if (parsed.version === 1 && parsed.stamp === stamp && s
                            && typeof s.sessionId === "string" && this.isSessionSnapshotPath(path, s.sessionId)
                            && Number.isFinite(s.updatedAt) && Number.isSafeInteger(s.messageCount) && s.messageCount >= 0
                            && (s.title === undefined || (typeof s.title === "string" && s.title.length <= 80))
                            && (s.revision === undefined || (Number.isSafeInteger(s.revision) && s.revision >= 0))
                            && (s.tokenCount === undefined || (Number.isFinite(s.tokenCount) && s.tokenCount >= 0))
                            && (s.workspace === undefined || validWorkspace(s.workspace))) {
                            // Do not retain arbitrary fields from a sidecar in the shared cache.
                            metadata = { version: 1, stamp, summary: {
                                    sessionId: s.sessionId, updatedAt: s.updatedAt, title: s.title,
                                    revision: s.revision, messageCount: s.messageCount, tokenCount: s.tokenCount,
                                    ...(s.workspace ? { workspace: s.workspace } : {}),
                                } };
                        }
                    }
                    catch { /* legacy, corrupt, or stale sidecar: migrate below */ }
                    if (!metadata) {
                        metadata = { version: 1, stamp };
                        try {
                            // Legacy migration is deliberately serial: at most one full JSON
                            // snapshot is parsed at a time, then only its summary is retained.
                            const parsed = JSON.parse(await readFile(path, "utf8"));
                            if (parsed.version === 1 && typeof parsed.sessionId === "string"
                                && this.isSessionSnapshotPath(path, parsed.sessionId) && Number.isFinite(parsed.updatedAt)
                                && Array.isArray(parsed.rawEntries) && Array.isArray(parsed.projectedEntries)) {
                                metadata.summary = historySummary(parsed);
                            }
                        }
                        catch { /* cache malformed files too, until their generation changes */ }
                        if (snapshotStamp(await stat(path)) !== stamp)
                            continue;
                        await this.saveHistoryMetadata(path, metadata);
                    }
                    this.shared.historyMetadata.set(path, metadata);
                }
                const summary = metadata.summary;
                if (!summary)
                    continue;
                if (summary.revision === undefined && resolveLegacyRevision) {
                    const revision = await resolveLegacyRevision(summary.sessionId);
                    if (Number.isSafeInteger(revision) && revision >= 0) {
                        summary.revision = revision;
                        await this.saveHistoryMetadata(path, metadata);
                    }
                }
                const canonical = path === this.sessionSnapshotPath(summary.sessionId);
                const previous = result.get(summary.sessionId);
                // Selection prefers the collision-resistant path too, even when an old
                // legacy file happens to carry a later timestamp.
                if (!previous || canonical)
                    result.set(summary.sessionId, { ...summary });
            }
            catch { /* skip malformed snapshots */ }
        }
        return [...result.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
    }
    isSessionSnapshotPath(path, sessionId) {
        return path === this.sessionSnapshotPath(sessionId) || path === this.legacySessionSnapshotPath(sessionId);
    }
    async saveHistoryMetadata(path, metadata) {
        const target = `${path}.summary`;
        const tmp = `${target}.${randomUUID()}.tmp`;
        try {
            await writeFile(tmp, JSON.stringify(metadata), { encoding: "utf8", mode: 0o600 });
            await chmod(tmp, 0o600);
            await rename(tmp, target);
        }
        catch {
            try {
                await rm(tmp, { force: true });
            }
            catch { /* best effort */ }
        }
    }
    sessionSnapshotPath(sessionId) {
        const readable = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "session";
        return join(this.snapshotsDir, `${readable}-${contentHash(sessionId)}.json`);
    }
    legacySessionSnapshotPath(sessionId) {
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
        return join(this.snapshotsDir, `${safe}.json`);
    }
    /**
     * Save a full snapshot to a JSON file.
     * Useful for dashboard export or debugging.
     */
    async saveSnapshot(filePath) {
        const snapshot = await this.historySnapshot();
        const tmp = `${filePath}.${randomUUID()}.tmp`;
        try {
            await writeFile(tmp, JSON.stringify(snapshot, null, 2), { encoding: "utf8", mode: 0o600 });
            await chmod(tmp, 0o600);
            await rename(tmp, filePath);
        }
        catch (err) {
            try {
                await rm(tmp, { force: true });
            }
            catch { /* best-effort */ }
            throw err;
        }
    }
    /**
     * Load a snapshot from a JSON file and merge into the current store.
     * Existing records are NOT overwritten (immutability).
     * Returns the number of new records added.
     */
    async loadSnapshot(filePath) {
        const raw = await readFile(filePath, "utf8");
        const snapshot = JSON.parse(raw);
        if (snapshot.version !== 1)
            throw new Error("unknown snapshot version");
        let added = 0;
        for (const record of snapshot.records) {
            const existing = await this.get(record.id);
            if (!existing) {
                await this.write({ data: record.data, metadata: record.metadata, id: record.id });
                added++;
            }
        }
        return added;
    }
}
// ── Filter helper ──────────────────────────────────────────────────────────
function matchesFilter(entry, filter) {
    for (const [key, value] of Object.entries(filter)) {
        if (value === undefined)
            continue;
        const entryKey = key;
        if (entry[entryKey] !== value)
            return false;
    }
    return true;
}
//# sourceMappingURL=content-store.js.map