// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Self-contained, host-neutral handoff format with strict validation.
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
export const PORTABLE_LIMITS = Object.freeze({
    maxFileBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxRecords: 10_000,
    maxRoots: 1_000,
    maxEdges: 100_000,
    maxBindings: 4_096,
    maxBindingsPerBlob: 256,
    maxBindingPathBytes: 4_096,
    maxBindingPathBytesTotal: 1024 * 1024,
    maxBindingSearchBytes: 64 * 1024 * 1024,
    maxDepth: 64,
});
export const MAX_PORTABLE_TOPIC_BYTES = 512;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const ROOT_ID = /^b[1-9][0-9]*$/;
const RECORD_ID = /^r[1-9][0-9]*$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_DIGEST_FIELD_BYTES = Buffer.byteLength(`,"sha256":"${"0".repeat(64)}"`, "utf8");
function fail(message) {
    throw new Error(`portable-context: ${message}`);
}
function normalizeLimits(overrides) {
    if (overrides !== undefined) {
        const object = asObject(overrides, "limits");
        assertExactKeys(object, [
            "maxFileBytes",
            "maxDecodedBytes",
            "maxRecords",
            "maxRoots",
            "maxEdges",
            "maxBindings",
            "maxBindingsPerBlob",
            "maxBindingPathBytes",
            "maxBindingPathBytesTotal",
            "maxBindingSearchBytes",
            "maxDepth",
        ], [], "limits");
    }
    const limits = { ...PORTABLE_LIMITS };
    if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (value !== undefined)
                limits[key] = value;
        }
    }
    for (const [key, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 0)
            fail(`${key} must be a non-negative safe integer`);
    }
    if (limits.maxDepth > PORTABLE_LIMITS.maxDepth) {
        fail(`maxDepth cannot exceed ${PORTABLE_LIMITS.maxDepth}`);
    }
    return limits;
}
/** Deterministic JSON with recursively sorted object keys. */
export function canonicalJson(value) {
    return canonicalJsonWithDepth(value, PORTABLE_LIMITS.maxDepth);
}
function canonicalJsonWithDepth(value, maxDepth) {
    const active = new WeakSet();
    const visit = (item, depth) => {
        if (depth > maxDepth)
            fail(`JSON depth exceeds ${maxDepth}`);
        if (item === null)
            return "null";
        if (typeof item === "string")
            return JSON.stringify(item);
        if (typeof item === "boolean")
            return item ? "true" : "false";
        if (typeof item === "number") {
            if (!Number.isFinite(item))
                fail("canonical JSON contains a non-finite number");
            return Object.is(item, -0) ? "0" : String(item);
        }
        if (typeof item !== "object")
            fail(`canonical JSON contains non-JSON type ${typeof item}`);
        const object = item;
        if (active.has(object))
            fail("canonical JSON contains a cycle");
        active.add(object);
        try {
            if (Array.isArray(item)) {
                if (Object.getOwnPropertySymbols(item).length !== 0)
                    fail("canonical JSON contains symbol keys");
                const expectedNames = new Set(["length", ...item.map((_, index) => String(index))]);
                if (Object.getOwnPropertyNames(item).some(key => !expectedNames.has(key))) {
                    fail("canonical JSON contains non-index array properties");
                }
                for (let i = 0; i < item.length; i++) {
                    if (!Object.prototype.hasOwnProperty.call(item, i))
                        fail("canonical JSON contains a sparse array");
                }
                return `[${item.map(entry => visit(entry, depth + 1)).join(",")}]`;
            }
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null)
                fail("canonical JSON contains a non-plain object");
            if (Object.getOwnPropertySymbols(item).length !== 0)
                fail("canonical JSON contains symbol keys");
            const record = item;
            const keys = Object.keys(record).sort();
            return `{${keys.map(key => `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`).join(",")}}`;
        }
        finally {
            active.delete(object);
        }
    };
    return visit(value, 0);
}
export function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}
/** Hash and size canonical JSON without constructing a second full JSON string. */
function canonicalMetrics(value, maxDepth, maxBytes) {
    const hash = createHash("sha256");
    const active = new WeakSet();
    let byteLength = 0;
    const emit = (chunk) => {
        byteLength += Buffer.byteLength(chunk, "utf8");
        if (!Number.isSafeInteger(byteLength) || (maxBytes !== undefined && byteLength > maxBytes)) {
            fail(`canonical JSON exceeds ${maxBytes} bytes`);
        }
        hash.update(chunk, "utf8");
    };
    const emitString = (value) => {
        emit("\"");
        const emitRange = (start, end) => {
            for (let offset = start; offset < end;) {
                let next = Math.min(end, offset + 64 * 1024);
                // Hash.update UTF-8 encodes each chunk independently. Never split a
                // surrogate pair, or the canonical digest would contain two replacements.
                if (next < end && value.charCodeAt(next - 1) >= 0xd800 && value.charCodeAt(next - 1) <= 0xdbff)
                    next++;
                emit(value.slice(offset, next));
                offset = next;
            }
        };
        const escaped = (code) => `\\u${code.toString(16).padStart(4, "0")}`;
        let runStart = 0;
        for (let index = 0; index < value.length; index++) {
            const code = value.charCodeAt(index);
            let replacement;
            if (code === 0x22)
                replacement = "\\\"";
            else if (code === 0x5c)
                replacement = "\\\\";
            else if (code === 0x08)
                replacement = "\\b";
            else if (code === 0x0c)
                replacement = "\\f";
            else if (code === 0x0a)
                replacement = "\\n";
            else if (code === 0x0d)
                replacement = "\\r";
            else if (code === 0x09)
                replacement = "\\t";
            else if (code <= 0x1f)
                replacement = escaped(code);
            else if (code >= 0xd800 && code <= 0xdbff) {
                const low = value.charCodeAt(index + 1);
                if (low >= 0xdc00 && low <= 0xdfff) {
                    index++;
                    continue;
                }
                replacement = escaped(code);
            }
            else if (code >= 0xdc00 && code <= 0xdfff)
                replacement = escaped(code);
            if (replacement === undefined)
                continue;
            emitRange(runStart, index);
            emit(replacement);
            runStart = index + 1;
        }
        emitRange(runStart, value.length);
        emit("\"");
    };
    const visit = (item, depth) => {
        if (depth > maxDepth)
            fail(`JSON depth exceeds ${maxDepth}`);
        if (item === null) {
            emit("null");
            return;
        }
        if (typeof item === "string") {
            emitString(item);
            return;
        }
        if (typeof item === "boolean") {
            emit(item ? "true" : "false");
            return;
        }
        if (typeof item === "number") {
            if (!Number.isFinite(item))
                fail("canonical JSON contains a non-finite number");
            emit(Object.is(item, -0) ? "0" : String(item));
            return;
        }
        if (typeof item !== "object")
            fail(`canonical JSON contains non-JSON type ${typeof item}`);
        const object = item;
        if (active.has(object))
            fail("canonical JSON contains a cycle");
        active.add(object);
        try {
            if (Array.isArray(item)) {
                if (Object.getOwnPropertySymbols(item).length !== 0)
                    fail("canonical JSON contains symbol keys");
                const expectedNames = new Set(["length", ...item.map((_, index) => String(index))]);
                if (Object.getOwnPropertyNames(item).some(key => !expectedNames.has(key))) {
                    fail("canonical JSON contains non-index array properties");
                }
                emit("[");
                for (let index = 0; index < item.length; index++) {
                    if (!Object.prototype.hasOwnProperty.call(item, index))
                        fail("canonical JSON contains a sparse array");
                    if (index > 0)
                        emit(",");
                    visit(item[index], depth + 1);
                }
                emit("]");
                return;
            }
            const prototype = Object.getPrototypeOf(item);
            if (prototype !== Object.prototype && prototype !== null)
                fail("canonical JSON contains a non-plain object");
            if (Object.getOwnPropertySymbols(item).length !== 0)
                fail("canonical JSON contains symbol keys");
            const record = item;
            const keys = Object.keys(record).sort();
            emit("{");
            for (let index = 0; index < keys.length; index++) {
                if (index > 0)
                    emit(",");
                emitString(keys[index]);
                emit(":");
                visit(record[keys[index]], depth + 1);
            }
            emit("}");
        }
        finally {
            active.delete(object);
        }
    };
    visit(value, 0);
    return { digest: hash.digest("hex"), byteLength };
}
/** Compact JSON byte size, computed without materializing the serialized value. */
export function canonicalJsonByteLength(value, maxBytes) {
    return canonicalMetrics(value, PORTABLE_LIMITS.maxDepth, maxBytes).byteLength;
}
/** Canonical JSON digest without materializing the canonical representation. */
export function canonicalSha256(value, maxBytes) {
    return canonicalMetrics(value, PORTABLE_LIMITS.maxDepth, maxBytes).digest;
}
/** Exact byte size of JSON.stringify(value, null, 2), without creating it. */
function prettyJsonByteLength(value, maxDepth, maxBytes) {
    let total = canonicalMetrics(value, maxDepth, maxBytes).byteLength;
    const reserve = (bytes) => {
        total += bytes;
        if (!Number.isSafeInteger(total) || total > maxBytes)
            fail(`bundle exceeds maxFileBytes (${total} > ${maxBytes})`);
    };
    const visit = (item, depth) => {
        if (depth > maxDepth)
            fail(`JSON depth exceeds ${maxDepth}`);
        if (Array.isArray(item)) {
            if (item.length > 0) {
                // Opening/closing newlines, indentation, and one newline after each comma.
                reserve(2 + item.length * ((depth + 1) * 2) + (item.length - 1) + depth * 2);
                for (const child of item)
                    visit(child, depth + 1);
            }
            return;
        }
        if (item && typeof item === "object") {
            const values = Object.values(item);
            if (values.length > 0) {
                // Objects additionally put one space after every colon.
                reserve(2 + values.length * ((depth + 1) * 2 + 1) + (values.length - 1) + depth * 2);
                for (const child of values)
                    visit(child, depth + 1);
            }
        }
    };
    visit(value, 0);
    return total;
}
/** Collapse legacy/model-authored topics into the portable one-line representation. */
export function normalizePortableTopic(value) {
    if (typeof value !== "string")
        fail("root topic must be a string");
    const compact = value.replace(/[\x00-\x20\x7f-\x9f\u2028\u2029]+/g, " ").trim() || "untitled";
    if (Buffer.byteLength(compact, "utf8") <= MAX_PORTABLE_TOPIC_BYTES)
        return compact;
    let result = "";
    for (const character of compact) {
        if (Buffer.byteLength(result + character + "...", "utf8") > MAX_PORTABLE_TOPIC_BYTES)
            break;
        result += character;
    }
    return `${result.trimEnd()}...`;
}
export function makeBlob(data, bindings = []) {
    const copiedBindings = validateBindingsForConstruction(bindings);
    let byteLength;
    let digest;
    let encoding;
    let encoded;
    if (typeof data === "string") {
        assertScalarString(data, "blob data");
        byteLength = Buffer.byteLength(data, "utf8");
        digest = sha256(data);
        encoding = "utf8";
        encoded = data;
    }
    else {
        if (!(data instanceof Uint8Array))
            fail("blob data must be a string or Uint8Array");
        if (copiedBindings.length !== 0)
            fail("binary blobs cannot have bindings");
        const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        byteLength = bytes.byteLength;
        digest = sha256(bytes);
        encoding = "base64";
        encoded = bytes.toString("base64");
    }
    if (encoding === "utf8") {
        const searchBytes = byteLength * copiedBindings.length;
        if (!Number.isSafeInteger(searchBytes) || searchBytes > PORTABLE_LIMITS.maxBindingSearchBytes) {
            fail("binding path search exceeds maxBindingSearchBytes");
        }
        for (const binding of copiedBindings) {
            if (!encoded.includes(binding.path))
                fail(`binding path ${JSON.stringify(binding.path)} is absent from blob data`);
        }
    }
    return {
        encoding,
        data: encoded,
        byteLength,
        sha256: digest,
        bindings: copiedBindings,
    };
}
export function blobId(blob) {
    return canonicalSha256(blob);
}
export function encodeBundle(payload, limits) {
    const resolved = normalizeLimits(limits);
    const envelope = createBundleWithLimits(payload, resolved);
    const expectedBytes = prettyJsonByteLength(envelope, resolved.maxDepth, resolved.maxFileBytes);
    const serialized = JSON.stringify(envelope, null, 2);
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength !== expectedBytes)
        fail("internal serialized byte count mismatch");
    return Buffer.from(serialized, "utf8");
}
/** Build and validate an in-memory bundle without serializing and reparsing it. */
export function createBundle(payload, limits) {
    return createBundleWithLimits(payload, normalizeLimits(limits));
}
function createBundleWithLimits(payload, resolved) {
    validatePayload(payload, resolved);
    const unsigned = { format: "ctx-context", version: 1, mode: "handoff", payload };
    const metrics = canonicalMetrics(unsigned, resolved.maxDepth, resolved.maxFileBytes);
    if (metrics.byteLength + ENVELOPE_DIGEST_FIELD_BYTES > resolved.maxFileBytes) {
        fail(`bundle exceeds maxFileBytes (${metrics.byteLength + ENVELOPE_DIGEST_FIELD_BYTES} > ${resolved.maxFileBytes})`);
    }
    return {
        ...unsigned,
        sha256: metrics.digest,
    };
}
export function decodeBundle(bytes, limits) {
    if (!(bytes instanceof Uint8Array))
        fail("bundle input must be a Uint8Array");
    const resolved = normalizeLimits(limits);
    if (bytes.byteLength > resolved.maxFileBytes) {
        fail(`bundle exceeds maxFileBytes (${bytes.byteLength} > ${resolved.maxFileBytes})`);
    }
    let text;
    try {
        // Keeping a BOM as U+FEFF makes the JSON parser reject it rather than silently normalizing bytes.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        fail("bundle is not valid UTF-8");
    }
    return decodeBundleTextWithLimits(text, resolved);
}
/** Decode an already available UTF-8 string without a string -> Buffer -> string round trip. */
export function decodeBundleText(text, limits) {
    return decodeBundleTextWithLimits(text, normalizeLimits(limits));
}
function decodeBundleTextWithLimits(text, resolved) {
    if (typeof text !== "string")
        fail("bundle input must be a string");
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > resolved.maxFileBytes) {
        fail(`bundle exceeds maxFileBytes (${byteLength} > ${resolved.maxFileBytes})`);
    }
    const parsed = new BoundedJsonParser(text, resolved.maxDepth).parse();
    return validateBundleWithLimits(parsed, resolved);
}
/** Validate a programmatic bundle object without serializing and reparsing it. */
export function validateBundle(value, limits) {
    return validateBundleWithLimits(value, normalizeLimits(limits));
}
function validateBundleWithLimits(parsed, resolved) {
    const envelope = asObject(parsed, "envelope");
    assertExactKeys(envelope, ["format", "version", "mode", "payload", "sha256"], ["format", "version", "mode", "payload", "sha256"], "envelope");
    if (envelope.format !== "ctx-context" || envelope.version !== 1 || envelope.mode !== "handoff") {
        fail("unsupported envelope format, version, or mode");
    }
    const digest = requireDigest(envelope.sha256, "envelope.sha256");
    validatePayload(envelope.payload, resolved);
    const metrics = canonicalMetrics({
        format: envelope.format,
        version: envelope.version,
        mode: envelope.mode,
        payload: envelope.payload,
    }, resolved.maxDepth, resolved.maxFileBytes);
    if (metrics.byteLength + ENVELOPE_DIGEST_FIELD_BYTES > resolved.maxFileBytes) {
        fail(`bundle exceeds maxFileBytes (${metrics.byteLength + ENVELOPE_DIGEST_FIELD_BYTES} > ${resolved.maxFileBytes})`);
    }
    if (!sameDigest(digest, metrics.digest))
        fail("envelope checksum mismatch");
    return envelope;
}
function validatePayload(value, limits) {
    const payload = asObject(value, "payload");
    assertExactKeys(payload, ["sequence", "roots", "records", "blobs"], ["sequence", "roots", "records", "blobs"], "payload");
    const sequence = asArray(payload.sequence, "payload.sequence");
    const roots = asArray(payload.roots, "payload.roots");
    const records = asObject(payload.records, "payload.records");
    const blobs = asObject(payload.blobs, "payload.blobs");
    const recordIds = Object.keys(records);
    const blobIds = Object.keys(blobs);
    if (recordIds.length > limits.maxRecords)
        fail("record count exceeds maxRecords");
    if (roots.length > limits.maxRoots)
        fail("root count exceeds maxRoots");
    // Every valid blob has an incoming reference, so it cannot exceed the total edge budget.
    if (blobIds.length > limits.maxEdges)
        fail("blob count exceeds maxEdges");
    let edgeCount = 0;
    let bindingCount = 0;
    let bindingPathBytes = 0;
    let bindingSearchBytes = 0;
    const addEdges = (count) => {
        edgeCount += count;
        if (!Number.isSafeInteger(edgeCount) || edgeCount > limits.maxEdges)
            fail("graph exceeds maxEdges");
    };
    addEdges(sequence.length);
    const dependencies = new Map();
    const decodedLengths = new Map();
    let decodedBytes = 0;
    // First pass establishes bounded sizes and the dependency graph without hashing blob bodies.
    for (const id of blobIds) {
        requireDigest(id, `blob key ${JSON.stringify(id)}`);
        const blob = asObject(blobs[id], `blob ${id}`);
        assertExactKeys(blob, ["encoding", "data", "byteLength", "sha256", "bindings"], ["encoding", "data", "byteLength", "sha256", "bindings"], `blob ${id}`);
        if (blob.encoding !== "utf8" && blob.encoding !== "base64")
            fail(`blob ${id} has invalid encoding`);
        const data = requireString(blob.data, `blob ${id}.data`);
        const byteLength = requireNonNegativeInteger(blob.byteLength, `blob ${id}.byteLength`);
        requireDigest(blob.sha256, `blob ${id}.sha256`);
        const bindings = asArray(blob.bindings, `blob ${id}.bindings`);
        if (blob.encoding === "base64" && bindings.length !== 0)
            fail(`binary blob ${id} cannot have bindings`);
        if (bindings.length > limits.maxBindingsPerBlob)
            fail(`blob ${id} binding count exceeds maxBindingsPerBlob`);
        bindingCount += bindings.length;
        if (!Number.isSafeInteger(bindingCount) || bindingCount > limits.maxBindings)
            fail("binding count exceeds maxBindings");
        addEdges(bindings.length);
        let calculatedLength;
        if (blob.encoding === "utf8") {
            assertScalarString(data, `blob ${id}.data`);
            calculatedLength = Buffer.byteLength(data, "utf8");
        }
        else {
            if (data.length % 4 !== 0 || !BASE64.test(data))
                fail(`blob ${id} has non-canonical base64`);
            const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
            calculatedLength = (data.length / 4) * 3 - padding;
        }
        if (calculatedLength !== byteLength)
            fail(`blob ${id} byteLength mismatch`);
        decodedBytes += calculatedLength;
        if (!Number.isSafeInteger(decodedBytes) || decodedBytes > limits.maxDecodedBytes) {
            fail("decoded blob bytes exceed maxDecodedBytes");
        }
        decodedLengths.set(id, calculatedLength);
        const paths = new Set();
        const targets = [];
        const searchBytes = calculatedLength * bindings.length;
        if (!Number.isSafeInteger(searchBytes))
            fail("binding search work is too large");
        bindingSearchBytes += searchBytes;
        if (!Number.isSafeInteger(bindingSearchBytes) || bindingSearchBytes > limits.maxBindingSearchBytes) {
            fail("binding path search exceeds maxBindingSearchBytes");
        }
        for (let index = 0; index < bindings.length; index++) {
            const binding = asObject(bindings[index], `blob ${id}.bindings[${index}]`);
            assertExactKeys(binding, ["path", "blobId"], ["path", "blobId"], `blob ${id}.bindings[${index}]`);
            const path = requireString(binding.path, `blob ${id}.bindings[${index}].path`);
            if (path.length === 0)
                fail(`blob ${id} has an empty binding path`);
            assertScalarString(path, `blob ${id}.bindings[${index}].path`);
            const pathBytes = Buffer.byteLength(path, "utf8");
            if (pathBytes > limits.maxBindingPathBytes)
                fail(`blob ${id} binding path exceeds maxBindingPathBytes`);
            bindingPathBytes += pathBytes;
            if (!Number.isSafeInteger(bindingPathBytes) || bindingPathBytes > limits.maxBindingPathBytesTotal) {
                fail("binding path bytes exceed maxBindingPathBytesTotal");
            }
            if (paths.has(path))
                fail(`blob ${id} has a duplicate binding path`);
            if (!data.includes(path))
                fail(`blob ${id} binding path is absent from its text`);
            paths.add(path);
            targets.push(requireDigest(binding.blobId, `blob ${id}.bindings[${index}].blobId`));
        }
        dependencies.set(id, targets);
    }
    for (const [id, targets] of dependencies) {
        for (const target of targets) {
            if (!Object.prototype.hasOwnProperty.call(blobs, target))
                fail(`blob ${id} references missing blob ${target}`);
        }
    }
    assertAcyclicBindings(blobIds, dependencies, limits.maxDepth);
    const rootsById = new Map();
    const sourceRecords = new Set();
    const initialBlobRefs = new Set();
    const toolInputIds = new Set();
    for (let index = 0; index < roots.length; index++) {
        const root = asObject(roots[index], `payload.roots[${index}]`);
        assertExactKeys(root, ["id", "topic", "summaryBlobId", "tier", "sourceRecordIds", "recoverable", "excluded"], ["id", "topic", "summaryBlobId", "tier", "sourceRecordIds", "recoverable"], `payload.roots[${index}]`);
        const id = requireMatchingString(root.id, ROOT_ID, `payload.roots[${index}].id`);
        if (rootsById.has(id))
            fail(`duplicate root ID ${id}`);
        const topic = requireString(root.topic, `root ${id}.topic`);
        assertScalarString(topic, `root ${id}.topic`);
        if (!topic || Buffer.byteLength(topic, "utf8") > MAX_PORTABLE_TOPIC_BYTES
            || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(topic)) {
            fail(`root ${id}.topic must be a non-empty single-line string of at most ${MAX_PORTABLE_TOPIC_BYTES} bytes`);
        }
        if (root.tier !== "warm" && root.tier !== "cold")
            fail(`root ${id} has invalid tier`);
        if (typeof root.recoverable !== "boolean")
            fail(`root ${id}.recoverable must be boolean`);
        if (Object.prototype.hasOwnProperty.call(root, "excluded") && typeof root.excluded !== "boolean") {
            fail(`root ${id}.excluded must be boolean`);
        }
        const sourceIds = asArray(root.sourceRecordIds, `root ${id}.sourceRecordIds`);
        if (!root.recoverable && sourceIds.length !== 0)
            fail(`unrecoverable root ${id} must have no sources`);
        if (root.recoverable && sourceIds.length === 0)
            fail(`recoverable root ${id} requires sources`);
        addEdges(sourceIds.length + 1);
        const localSources = new Set();
        for (const sourceValue of sourceIds) {
            const sourceId = requireMatchingString(sourceValue, RECORD_ID, `root ${id} source record ID`);
            if (localSources.has(sourceId))
                fail(`root ${id} has duplicate source record ${sourceId}`);
            localSources.add(sourceId);
            sourceRecords.add(sourceId);
        }
        const summaryBlobId = requireDigest(root.summaryBlobId, `root ${id}.summaryBlobId`);
        requireUtf8Blob(blobs, summaryBlobId, `root ${id} summary`);
        initialBlobRefs.add(summaryBlobId);
        rootsById.set(id, root);
    }
    const knownRecords = new Set(recordIds);
    for (const id of recordIds) {
        requireMatchingString(id, RECORD_ID, `record key ${JSON.stringify(id)}`);
        const record = asObject(records[id], `record ${id}`);
        assertExactKeys(record, ["role", "parts"], ["role", "parts"], `record ${id}`);
        if (record.role !== "user" && record.role !== "assistant")
            fail(`record ${id} has invalid role`);
        const parts = asArray(record.parts, `record ${id}.parts`);
        if (parts.length > limits.maxEdges - edgeCount)
            fail("graph exceeds maxEdges");
        for (let index = 0; index < parts.length; index++) {
            const part = asObject(parts[index], `record ${id}.parts[${index}]`);
            const type = requireString(part.type, `record ${id}.parts[${index}].type`);
            if (type === "text" || type === "reasoning") {
                assertExactKeys(part, ["type", "blobId"], ["type", "blobId"], `record ${id}.parts[${index}]`);
                addEdges(1);
                const reference = requireDigest(part.blobId, `record ${id}.parts[${index}].blobId`);
                requireUtf8Blob(blobs, reference, `${type} part`);
                initialBlobRefs.add(reference);
            }
            else if (type === "attachment") {
                assertExactKeys(part, ["type", "blobId", "mime", "name"], ["type", "blobId", "mime", "name"], `record ${id}.parts[${index}]`);
                addEdges(1);
                const reference = requireDigest(part.blobId, `record ${id}.parts[${index}].blobId`);
                requireBlob(blobs, reference, "attachment part");
                requireString(part.mime, `record ${id}.parts[${index}].mime`);
                requireString(part.name, `record ${id}.parts[${index}].name`);
                initialBlobRefs.add(reference);
            }
            else if (type === "tool") {
                assertExactKeys(part, ["type", "tool", "callId", "status", "inputBlobId", "outputBlobId", "title"], ["type", "tool", "callId", "status", "inputBlobId"], `record ${id}.parts[${index}]`);
                requireString(part.tool, `record ${id}.parts[${index}].tool`);
                requireString(part.callId, `record ${id}.parts[${index}].callId`);
                if (part.status !== "pending" && part.status !== "running" && part.status !== "completed" && part.status !== "error") {
                    fail(`record ${id}.parts[${index}] has invalid tool status`);
                }
                if (part.title !== undefined)
                    requireString(part.title, `record ${id}.parts[${index}].title`);
                const inputId = requireDigest(part.inputBlobId, `record ${id}.parts[${index}].inputBlobId`);
                requireUtf8Blob(blobs, inputId, "tool input");
                addEdges(1);
                initialBlobRefs.add(inputId);
                toolInputIds.add(inputId);
                if ((part.status === "completed" || part.status === "error") && part.outputBlobId === undefined) {
                    fail(`completed/error tool part ${id}[${index}] requires outputBlobId`);
                }
                if (part.outputBlobId !== undefined) {
                    const outputId = requireDigest(part.outputBlobId, `record ${id}.parts[${index}].outputBlobId`);
                    requireUtf8Blob(blobs, outputId, "tool output");
                    addEdges(1);
                    initialBlobRefs.add(outputId);
                }
            }
            else {
                fail(`record ${id}.parts[${index}] has unknown type ${JSON.stringify(type)}`);
            }
        }
    }
    for (const sourceId of sourceRecords) {
        if (!knownRecords.has(sourceId))
            fail(`root references missing source record ${sourceId}`);
    }
    const hotRecords = new Set();
    const sequencedRoots = new Set();
    for (let index = 0; index < sequence.length; index++) {
        const item = asObject(sequence[index], `payload.sequence[${index}]`);
        if (item.type === "hot") {
            assertExactKeys(item, ["type", "recordId"], ["type", "recordId"], `payload.sequence[${index}]`);
            const id = requireMatchingString(item.recordId, RECORD_ID, `payload.sequence[${index}].recordId`);
            if (!knownRecords.has(id))
                fail(`sequence references missing hot record ${id}`);
            if (hotRecords.has(id))
                fail(`duplicate hot record ${id} in sequence`);
            hotRecords.add(id);
        }
        else if (item.type === "root") {
            assertExactKeys(item, ["type", "rootId"], ["type", "rootId"], `payload.sequence[${index}]`);
            const id = requireMatchingString(item.rootId, ROOT_ID, `payload.sequence[${index}].rootId`);
            if (!rootsById.has(id))
                fail(`sequence references missing root ${id}`);
            if (sequencedRoots.has(id))
                fail(`duplicate root ${id} in sequence`);
            sequencedRoots.add(id);
        }
        else {
            fail(`payload.sequence[${index}] has invalid type`);
        }
    }
    for (const id of rootsById.keys()) {
        if (!sequencedRoots.has(id))
            fail(`root ${id} is not present in sequence`);
    }
    for (const id of hotRecords) {
        if (sourceRecords.has(id))
            fail(`source record ${id} cannot also be HOT`);
    }
    for (const id of knownRecords) {
        if (!hotRecords.has(id) && !sourceRecords.has(id))
            fail(`orphan record ${id}`);
    }
    const reachableBlobs = new Set();
    const pending = [...initialBlobRefs];
    while (pending.length !== 0) {
        const id = pending.pop();
        if (reachableBlobs.has(id))
            continue;
        reachableBlobs.add(id);
        for (const target of dependencies.get(id) ?? [])
            pending.push(target);
    }
    for (const id of blobIds) {
        if (!reachableBlobs.has(id))
            fail(`orphan blob ${id}`);
    }
    // Hashing and nested tool JSON parsing happen only after all byte, node, edge, and reachability checks.
    for (const id of blobIds) {
        const blob = blobs[id];
        let decoded;
        if (blob.encoding === "utf8") {
            if (!sameDigest(blob.sha256, sha256(blob.data)))
                fail(`blob ${id} content checksum mismatch`);
        }
        else {
            decoded = Buffer.from(blob.data, "base64");
            if (decoded.toString("base64") !== blob.data)
                fail(`blob ${id} has non-canonical base64`);
            if (!sameDigest(blob.sha256, sha256(decoded)))
                fail(`blob ${id} content checksum mismatch`);
        }
        if ((decoded?.byteLength ?? blob.byteLength) !== decodedLengths.get(id))
            fail(`blob ${id} decoded length mismatch`);
        if (!sameDigest(id, blobId(blob)))
            fail(`blob ${id} ID mismatch`);
    }
    for (const inputId of toolInputIds)
        validateToolInput(blobs[inputId].data, limits.maxDepth);
}
function validateToolInput(data, maxDepth) {
    const parsed = new BoundedJsonParser(data, maxDepth).parse();
    if (!isPlainObject(parsed))
        fail("tool input must be a JSON object");
}
function assertAcyclicBindings(ids, dependencies, maxDepth) {
    const incoming = new Map(ids.map(id => [id, 0]));
    const reverse = new Map();
    for (const [source, targets] of dependencies) {
        for (const target of targets) {
            incoming.set(target, (incoming.get(target) ?? 0) + 1);
            const dependents = reverse.get(source) ?? [];
            dependents.push(target);
            reverse.set(source, dependents);
        }
    }
    const ready = ids.filter(id => incoming.get(id) === 0);
    const depths = new Map();
    let visited = 0;
    while (ready.length !== 0) {
        const id = ready.pop();
        visited++;
        for (const target of reverse.get(id) ?? []) {
            const depth = Math.max(depths.get(target) ?? 0, (depths.get(id) ?? 0) + 1);
            if (depth > maxDepth)
                fail(`binding dependency depth exceeds ${maxDepth}`);
            depths.set(target, depth);
            const count = (incoming.get(target) ?? 0) - 1;
            incoming.set(target, count);
            if (count === 0)
                ready.push(target);
        }
    }
    if (visited !== ids.length)
        fail("blob binding dependency cycle detected");
}
function validateBindingsForConstruction(bindings) {
    if (!Array.isArray(bindings))
        fail("bindings must be an array");
    if (bindings.length > PORTABLE_LIMITS.maxBindingsPerBlob)
        fail("binding count exceeds maxBindingsPerBlob");
    const paths = new Set();
    let pathBytes = 0;
    return bindings.map((value, index) => {
        const binding = asObject(value, `bindings[${index}]`);
        assertExactKeys(binding, ["path", "blobId"], ["path", "blobId"], `bindings[${index}]`);
        const path = requireString(binding.path, `bindings[${index}].path`);
        if (path.length === 0)
            fail("binding path cannot be empty");
        assertScalarString(path, `bindings[${index}].path`);
        const bytes = Buffer.byteLength(path, "utf8");
        if (bytes > PORTABLE_LIMITS.maxBindingPathBytes)
            fail("binding path exceeds maxBindingPathBytes");
        pathBytes += bytes;
        if (pathBytes > PORTABLE_LIMITS.maxBindingPathBytesTotal)
            fail("binding path bytes exceed maxBindingPathBytesTotal");
        if (paths.has(path))
            fail(`duplicate binding path ${JSON.stringify(path)}`);
        paths.add(path);
        return { path, blobId: requireDigest(binding.blobId, `bindings[${index}].blobId`) };
    });
}
function requireBlob(blobs, id, where) {
    if (!Object.prototype.hasOwnProperty.call(blobs, id))
        fail(`${where} references missing blob ${id}`);
    return blobs[id];
}
function requireUtf8Blob(blobs, id, where) {
    const blob = requireBlob(blobs, id, where);
    if (blob.encoding !== "utf8")
        fail(`${where} must reference a utf8 blob`);
    return blob;
}
function asObject(value, where) {
    if (!isPlainObject(value))
        fail(`${where} must be an object`);
    return value;
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function asArray(value, where) {
    if (!Array.isArray(value))
        fail(`${where} must be an array`);
    return value;
}
function requireString(value, where) {
    if (typeof value !== "string")
        fail(`${where} must be a string`);
    return value;
}
function requireMatchingString(value, pattern, where) {
    const result = requireString(value, where);
    if (!pattern.test(result))
        fail(`${where} has invalid format`);
    return result;
}
function requireDigest(value, where) {
    return requireMatchingString(value, HEX_DIGEST, where);
}
function requireNonNegativeInteger(value, where) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        fail(`${where} must be a non-negative safe integer`);
    }
    return value;
}
function assertExactKeys(object, allowed, required, where) {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(object)) {
        if (!allowedSet.has(key))
            fail(`${where} has unknown field ${JSON.stringify(key)}`);
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(object, key))
            fail(`${where} is missing field ${JSON.stringify(key)}`);
    }
}
function assertScalarString(value, where) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff)
                fail(`${where} contains an unpaired UTF-16 surrogate`);
            index++;
        }
        else if (code >= 0xdc00 && code <= 0xdfff) {
            fail(`${where} contains an unpaired UTF-16 surrogate`);
        }
    }
}
function sameDigest(left, right) {
    if (!HEX_DIGEST.test(left) || !HEX_DIGEST.test(right))
        return false;
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
/** Minimal recursive-descent JSON parser that preserves decoded-key uniqueness. */
class BoundedJsonParser {
    text;
    maxDepth;
    index = 0;
    constructor(text, maxDepth) {
        this.text = text;
        this.maxDepth = maxDepth;
    }
    parse() {
        this.skipWhitespace();
        const value = this.parseValue(0);
        this.skipWhitespace();
        if (this.index !== this.text.length)
            this.invalid("trailing content");
        return value;
    }
    parseValue(depth) {
        if (depth > this.maxDepth)
            this.invalid(`depth exceeds ${this.maxDepth}`);
        const character = this.text[this.index];
        if (character === "{")
            return this.parseObject(depth);
        if (character === "[")
            return this.parseArray(depth);
        if (character === "\"")
            return this.parseString();
        if (character === "t")
            return this.parseLiteral("true", true);
        if (character === "f")
            return this.parseLiteral("false", false);
        if (character === "n")
            return this.parseLiteral("null", null);
        if (character === "-" || (character >= "0" && character <= "9"))
            return this.parseNumber();
        this.invalid("expected a JSON value");
    }
    parseObject(depth) {
        this.index++;
        const result = {};
        const keys = new Set();
        this.skipWhitespace();
        if (this.text[this.index] === "}") {
            this.index++;
            return result;
        }
        while (true) {
            if (this.text[this.index] !== "\"")
                this.invalid("expected an object key");
            const key = this.parseString();
            if (keys.has(key))
                this.invalid(`duplicate object key ${JSON.stringify(key)}`);
            keys.add(key);
            this.skipWhitespace();
            if (this.text[this.index] !== ":")
                this.invalid("expected ':' after object key");
            this.index++;
            this.skipWhitespace();
            const value = this.parseValue(depth + 1);
            Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
            this.skipWhitespace();
            const separator = this.text[this.index++];
            if (separator === "}")
                return result;
            if (separator !== ",")
                this.invalid("expected ',' or '}' in object");
            this.skipWhitespace();
        }
    }
    parseArray(depth) {
        this.index++;
        const result = [];
        this.skipWhitespace();
        if (this.text[this.index] === "]") {
            this.index++;
            return result;
        }
        while (true) {
            result.push(this.parseValue(depth + 1));
            this.skipWhitespace();
            const separator = this.text[this.index++];
            if (separator === "]")
                return result;
            if (separator !== ",")
                this.invalid("expected ',' or ']' in array");
            this.skipWhitespace();
        }
    }
    parseString() {
        this.index++;
        let segmentStart = this.index;
        let hadEscape = false;
        const decoded = [];
        let smallParts = [];
        let smallLength = 0;
        const flushSmall = () => {
            if (!smallParts.length)
                return;
            decoded.push(smallParts.join(""));
            smallParts = [];
            smallLength = 0;
        };
        const append = (value) => {
            if (!value)
                return;
            if (value.length >= 8_192) {
                flushSmall();
                decoded.push(value);
                return;
            }
            smallParts.push(value);
            smallLength += value.length;
            if (smallLength >= 8_192)
                flushSmall();
        };
        const escapes = {
            "\"": "\"",
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t",
        };
        while (this.index < this.text.length) {
            const code = this.text.charCodeAt(this.index);
            if (code === 0x22) {
                const tail = this.text.slice(segmentStart, this.index);
                this.index++;
                if (!hadEscape)
                    return tail;
                append(tail);
                flushSmall();
                return decoded.join("");
            }
            if (code < 0x20)
                this.invalid("unescaped control character in string");
            if (code === 0x5c) {
                hadEscape = true;
                append(this.text.slice(segmentStart, this.index));
                this.index++;
                const escape = this.text[this.index];
                if (escape === "u") {
                    const digits = this.text.slice(this.index + 1, this.index + 5);
                    if (!/^[0-9a-fA-F]{4}$/.test(digits))
                        this.invalid("invalid Unicode escape");
                    append(String.fromCharCode(Number.parseInt(digits, 16)));
                    this.index += 5;
                }
                else {
                    if (escape === undefined || !Object.prototype.hasOwnProperty.call(escapes, escape))
                        this.invalid("invalid string escape");
                    append(escapes[escape]);
                    this.index++;
                }
                segmentStart = this.index;
                continue;
            }
            this.index++;
        }
        this.invalid("unterminated string");
    }
    parseNumber() {
        const start = this.index;
        if (this.text[this.index] === "-")
            this.index++;
        if (this.text[this.index] === "0") {
            this.index++;
            if (this.isDigit(this.text[this.index]))
                this.invalid("leading zero in number");
        }
        else {
            if (!this.isDigitOneToNine(this.text[this.index]))
                this.invalid("invalid number");
            while (this.isDigit(this.text[this.index]))
                this.index++;
        }
        if (this.text[this.index] === ".") {
            this.index++;
            if (!this.isDigit(this.text[this.index]))
                this.invalid("invalid fractional number");
            while (this.isDigit(this.text[this.index]))
                this.index++;
        }
        if (this.text[this.index] === "e" || this.text[this.index] === "E") {
            this.index++;
            if (this.text[this.index] === "+" || this.text[this.index] === "-")
                this.index++;
            if (!this.isDigit(this.text[this.index]))
                this.invalid("invalid exponent");
            while (this.isDigit(this.text[this.index]))
                this.index++;
        }
        const value = Number(this.text.slice(start, this.index));
        if (!Number.isFinite(value))
            this.invalid("non-finite number");
        return value;
    }
    parseLiteral(source, value) {
        if (this.text.slice(this.index, this.index + source.length) !== source)
            this.invalid(`invalid literal`);
        this.index += source.length;
        return value;
    }
    skipWhitespace() {
        while (this.index < this.text.length) {
            const code = this.text.charCodeAt(this.index);
            if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
                return;
            this.index++;
        }
    }
    isDigit(character) {
        return character !== undefined && character >= "0" && character <= "9";
    }
    isDigitOneToNine(character) {
        return character !== undefined && character >= "1" && character <= "9";
    }
    invalid(message) {
        fail(`invalid JSON at offset ${this.index}: ${message}`);
    }
}
//# sourceMappingURL=portable-context.js.map