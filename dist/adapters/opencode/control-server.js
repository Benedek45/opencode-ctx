// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Loopback-only HTTP control plane for inspecting and editing context projection.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { CONTROL_UI_HTML } from "./control-ui.js";
export class RevisionConflictError extends Error {
    code = "REVISION_CONFLICT";
    expectedRevision;
    actualRevision;
    constructor(message = "Session revision changed", expectedRevision, actualRevision) {
        super(message);
        this.name = "RevisionConflictError";
        this.expectedRevision = expectedRevision;
        this.actualRevision = actualRevision;
    }
}
class HttpError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
const BODY_LIMIT = 256 * 1024;
const DETAIL_LIMIT = 64 * 1024 * 1024;
const COOKIE_NAME = "ctx_control";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MUTATION_METHODS = new Set(["PATCH", "POST", "PUT", "DELETE"]);
function normalizedHostname(value) {
    const hostname = value.toLowerCase();
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
function validateLoopbackHost(host) {
    if (!LOOPBACK_HOSTS.has(normalizedHostname(host))) {
        throw new HttpError(400, "INVALID_HOST", "Control server must bind to an explicit loopback host");
    }
}
/** Maximum characters of chat label allowed inside the public hostname. */
const HOST_LABEL_MAX = 24;
const HOST_SUFFIX = ".localhost";
/**
 * Reduce arbitrary chat text to a single safe DNS label fragment.
 * Returns an empty string when nothing usable remains.
 */
export function sanitizeHostLabel(value) {
    if (!value)
        return "";
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, HOST_LABEL_MAX)
        .replace(/-+$/g, "");
}
function buildPublicHost(nonce, label) {
    const slug = sanitizeHostLabel(label);
    return slug ? `ctx-${slug}-${nonce}${HOST_SUFFIX}` : `ctx-${nonce}${HOST_SUFFIX}`;
}
/**
 * Accept only this server's own `*.localhost` origins: the bare
 * `ctx-<nonce>.localhost` or any `ctx-<label>-<nonce>.localhost`. Possession of
 * the nonce is still required, so a labeled alias is no easier to guess than the
 * bare form, and each alias keeps its own host-only cookie.
 */
function isOwnPublicHost(hostname, nonce) {
    if (!hostname.endsWith(HOST_SUFFIX))
        return false;
    const label = hostname.slice(0, -HOST_SUFFIX.length);
    if (label.length === 0 || label.length > 63 || !/^[a-z0-9-]+$/.test(label))
        return false;
    if (label === `ctx-${nonce}`)
        return true;
    if (!label.startsWith("ctx-") || !label.endsWith(`-${nonce}`))
        return false;
    const slug = label.slice("ctx-".length, -(nonce.length + 1));
    // Accept exactly the canonical form buildPublicHost can generate. This keeps
    // the cookie surface to one bare and one sanitized labeled alias per chat.
    return slug.length > 0 && slug.length <= HOST_LABEL_MAX && sanitizeHostLabel(slug) === slug;
}
function requestHost(req, nonce) {
    const value = req.headers.host;
    if (!value)
        throw new HttpError(400, "INVALID_HOST", "Missing Host header");
    let hostname;
    try {
        hostname = new URL(`http://${value}`).hostname;
    }
    catch {
        throw new HttpError(400, "INVALID_HOST", "Invalid Host header");
    }
    if (nonce && isOwnPublicHost(normalizedHostname(hostname), nonce)) {
        return { host: value, ownPublicHost: true };
    }
    // Bare loopback stays reachable for Bearer clients, but never receives a
    // cookie: host-only cookies are not port-scoped, so a `127.0.0.1` cookie would
    // be sent to every other local service on that hostname.
    validateLoopbackHost(hostname);
    return { host: value, ownPublicHost: false };
}
function secureEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
function cookieToken(req) {
    const cookies = req.headers.cookie?.split(";") ?? [];
    for (const item of cookies) {
        const separator = item.indexOf("=");
        if (separator < 0 || item.slice(0, separator).trim() !== COOKIE_NAME)
            continue;
        try {
            return decodeURIComponent(item.slice(separator + 1).trim());
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
function bearerToken(req) {
    const value = req.headers.authorization;
    if (!value)
        return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(value);
    return match?.[1];
}
function isAuthenticated(req, token) {
    const supplied = bearerToken(req) ?? cookieToken(req);
    return supplied !== undefined && secureEqual(supplied, token);
}
function applySecurityHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
}
function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
}
function sendData(res, data, status = 200) {
    sendJson(res, status, { data });
}
function sendExactDetail(res, data) {
    const body = JSON.stringify({ data });
    if (Buffer.byteLength(body) > DETAIL_LIMIT) {
        throw new HttpError(413, "DETAIL_TOO_LARGE", "Exact detail exceeds 64 MiB");
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(body);
}
function errorDetails(error) {
    if (error instanceof RevisionConflictError) {
        const details = {};
        if (error.expectedRevision !== undefined)
            details.expectedRevision = error.expectedRevision;
        if (error.actualRevision !== undefined)
            details.actualRevision = error.actualRevision;
        return details;
    }
    return undefined;
}
function sendError(res, error) {
    if (res.headersSent || res.writableEnded)
        return;
    const backendCode = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;
    const conflict = error instanceof RevisionConflictError || backendCode === "REVISION_CONFLICT";
    const backendStatus = backendCode === "NOT_FOUND" ? 404 : backendCode === "INVALID_REQUEST" ? 400 : undefined;
    const status = error instanceof HttpError ? error.status : conflict ? 409 : backendStatus ?? 500;
    const code = error instanceof HttpError ? error.code : conflict ? "REVISION_CONFLICT" : backendCode && backendStatus ? backendCode : "INTERNAL_ERROR";
    const message = error instanceof HttpError || conflict || backendStatus !== undefined
        ? (error instanceof Error ? error.message : "Session revision changed")
        : "Internal server error";
    const details = error instanceof HttpError ? error.details : errorDetails(error);
    const body = { code, message };
    if (details !== undefined)
        body.details = details;
    sendJson(res, status, { error: body });
}
function requireJson(req) {
    const contentType = req.headers["content-type"];
    if (!contentType || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
    }
}
async function readJson(req) {
    requireJson(req);
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > BODY_LIMIT) {
        req.resume();
        throw new HttpError(413, "BODY_TOO_LARGE", "JSON body exceeds 256KB");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > BODY_LIMIT)
            throw new HttpError(413, "BODY_TOO_LARGE", "JSON body exceeds 256KB");
        chunks.push(buffer);
    }
    if (size === 0)
        throw new HttpError(400, "INVALID_JSON", "JSON body is required");
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new HttpError(400, "INVALID_JSON", "JSON body must be an object");
    }
    return parsed;
}
function revisionFrom(body) {
    const revision = body.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new HttpError(400, "INVALID_REVISION", "revision must be a non-negative integer");
    }
    return revision;
}
function queryInteger(url, key, min, max, fallback) {
    const values = url.searchParams.getAll(key);
    if (!values.length)
        return fallback;
    if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0])) {
        throw new HttpError(400, "INVALID_QUERY", `${key} must be an integer from ${min} to ${max}`);
    }
    const value = Number(values[0]);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new HttpError(400, "INVALID_QUERY", `${key} must be an integer from ${min} to ${max}`);
    }
    return value;
}
function viewOptions(url, mutation = false) {
    const view = url.searchParams.getAll("view");
    if (!view.length) {
        if (url.searchParams.size)
            throw new HttpError(400, "INVALID_QUERY", "view=inventory is required for paging");
        return undefined;
    }
    if (view.length !== 1 || view[0] !== "inventory")
        throw new HttpError(400, "INVALID_QUERY", "view must be inventory");
    for (const key of url.searchParams.keys()) {
        if (!["view", "messageOffset", "blockOffset", "overrideOffset", "limit", "generation", ...(mutation ? [] : ["revision"])].includes(key)) {
            throw new HttpError(400, "INVALID_QUERY", `Unknown inventory query parameter: ${key}`);
        }
    }
    return {
        view: "inventory",
        messageOffset: queryInteger(url, "messageOffset", 0, Number.MAX_SAFE_INTEGER, 0),
        blockOffset: queryInteger(url, "blockOffset", 0, Number.MAX_SAFE_INTEGER, 0),
        overrideOffset: queryInteger(url, "overrideOffset", 0, Number.MAX_SAFE_INTEGER, 0),
        limit: queryInteger(url, "limit", 1, 100, 50),
        ...(!mutation && url.searchParams.has("revision") ? { revision: queryInteger(url, "revision", 0, Number.MAX_SAFE_INTEGER) } : {}),
        ...(url.searchParams.has("generation") ? { generation: queryGeneration(url) } : {}),
    };
}
function queryGeneration(url) {
    const values = url.searchParams.getAll("generation");
    if (!values.length)
        return undefined;
    if (values.length !== 1 || !/^[a-f0-9-]{36}$/.test(values[0])) {
        throw new HttpError(400, "INVALID_QUERY", "generation must be a projection identity");
    }
    return values[0];
}
function objectFrom(body, key) {
    const value = body[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(400, "INVALID_REQUEST", `${key} must be a JSON object`);
    }
    return value;
}
function decodeSegment(segment) {
    try {
        const value = decodeURIComponent(segment);
        if (!value)
            throw new Error();
        return value;
    }
    catch {
        throw new HttpError(400, "INVALID_PATH", "Invalid or empty path identifier");
    }
}
function enforceSameOrigin(req, host, allowMissingOrigin) {
    const site = req.headers["sec-fetch-site"];
    if (site === "cross-site")
        throw new HttpError(403, "CROSS_ORIGIN", "Cross-origin mutation rejected");
    const origin = req.headers.origin;
    if (!origin) {
        if (allowMissingOrigin)
            return;
        throw new HttpError(403, "CROSS_ORIGIN", "Mutation Origin header is required");
    }
    let expected;
    let supplied;
    try {
        expected = new URL(`http://${host}`);
        supplied = new URL(origin);
    }
    catch {
        throw new HttpError(403, "CROSS_ORIGIN", "Invalid mutation origin");
    }
    if (supplied.origin !== expected.origin)
        throw new HttpError(403, "CROSS_ORIGIN", "Cross-origin mutation rejected");
}
function methodNotAllowed(allowed) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", `Allowed methods: ${allowed.join(", ")}`, { allowed });
}
/** Largest batch a single dashboard save may submit. */
const PROJECTION_EDIT_LIMIT = 500;
function parseOverride(candidate) {
    const mode = candidate.mode;
    if (mode !== "keep" && mode !== "exclude" && mode !== "replace") {
        throw new HttpError(400, "INVALID_OVERRIDE", "override.mode must be keep, exclude, or replace");
    }
    if (mode === "replace" && typeof candidate.text !== "string") {
        throw new HttpError(400, "INVALID_OVERRIDE", "replace override requires text");
    }
    if (mode !== "replace" && candidate.text !== undefined) {
        throw new HttpError(400, "INVALID_OVERRIDE", "text is only valid for replace override");
    }
    return mode === "replace" ? { mode, text: candidate.text } : { mode };
}
function parseProjectionEdits(body) {
    const raw = body.edits;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new HttpError(400, "INVALID_REQUEST", "edits must be a non-empty array");
    }
    if (raw.length > PROJECTION_EDIT_LIMIT) {
        throw new HttpError(400, "INVALID_REQUEST", `edits may contain at most ${PROJECTION_EDIT_LIMIT} entries`);
    }
    const seen = new Set();
    return raw.map((item, index) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            throw new HttpError(400, "INVALID_REQUEST", `edits[${index}] must be an object`);
        }
        const entry = item;
        const messageId = entry.messageId;
        if (typeof messageId !== "string" || messageId.trim().length === 0) {
            throw new HttpError(400, "INVALID_REQUEST", `edits[${index}].messageId is required`);
        }
        if (seen.has(messageId)) {
            throw new HttpError(400, "INVALID_REQUEST", `edits[${index}].messageId is duplicated`);
        }
        seen.add(messageId);
        if (entry.override === null || entry.override === undefined) {
            return { messageId, override: null };
        }
        return { messageId, override: parseOverride(objectFrom(entry, "override")) };
    });
}
async function routeApi(req, res, url, backend) {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/sessions") {
        if (method !== "GET")
            methodNotAllowed(["GET"]);
        sendData(res, await backend.listSessions());
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts.length === 3) {
        if (method !== "GET")
            methodNotAllowed(["GET"]);
        const snapshot = await backend.getSession(decodeSegment(parts[2]), viewOptions(url));
        if (!snapshot)
            throw new HttpError(404, "SESSION_NOT_FOUND", "Session not found");
        sendData(res, snapshot);
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "messages" && parts.length === 5) {
        if (method !== "GET")
            methodNotAllowed(["GET"]);
        if (!backend.getMessageDetail)
            throw new HttpError(404, "NOT_FOUND", "Message detail unavailable");
        if ([...url.searchParams.keys()].some(key => key !== "revision" && key !== "generation"))
            throw new HttpError(400, "INVALID_QUERY", "Only revision and generation are allowed");
        const revision = queryInteger(url, "revision", 0, Number.MAX_SAFE_INTEGER);
        if (revision === undefined)
            throw new HttpError(400, "INVALID_QUERY", "revision is required");
        const detail = await backend.getMessageDetail(decodeSegment(parts[2]), decodeSegment(parts[4]), revision, queryGeneration(url));
        if (!detail)
            throw new HttpError(404, "NOT_FOUND", "Message not found");
        sendExactDetail(res, detail);
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "blocks" && parts[5] === "detail" && parts.length === 6) {
        if (method !== "GET")
            methodNotAllowed(["GET"]);
        if (!backend.getBlockDetail)
            throw new HttpError(404, "NOT_FOUND", "Block detail unavailable");
        if ([...url.searchParams.keys()].some(key => key !== "revision" && key !== "generation"))
            throw new HttpError(400, "INVALID_QUERY", "Only revision and generation are allowed");
        const revision = queryInteger(url, "revision", 0, Number.MAX_SAFE_INTEGER);
        if (revision === undefined)
            throw new HttpError(400, "INVALID_QUERY", "revision is required");
        const detail = await backend.getBlockDetail(decodeSegment(parts[2]), decodeSegment(parts[4]), revision, queryGeneration(url));
        if (!detail)
            throw new HttpError(404, "NOT_FOUND", "Block not found");
        sendExactDetail(res, detail);
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "settings" && parts.length === 4) {
        if (method !== "PATCH")
            methodNotAllowed(["PATCH"]);
        const body = await readJson(req);
        sendData(res, await backend.updateSettings(decodeSegment(parts[2]), revisionFrom(body), objectFrom(body, "settings"), viewOptions(url, true)));
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "overrides" && parts.length === 5) {
        if (method !== "PUT" && method !== "DELETE")
            methodNotAllowed(["PUT", "DELETE"]);
        const body = await readJson(req);
        const sessionId = decodeSegment(parts[2]);
        const messageId = decodeSegment(parts[4]);
        const revision = revisionFrom(body);
        if (method === "DELETE") {
            sendData(res, await backend.deleteMessageOverride(sessionId, messageId, revision, viewOptions(url, true)));
            return;
        }
        sendData(res, await backend.putMessageOverride(sessionId, messageId, revision, parseOverride(objectFrom(body, "override")), viewOptions(url, true)));
        return;
    }
    // Batch save: the entire staged edit set applies under one revision, so the
    // conversation prefix is rewritten (and re-cached) exactly once.
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "projection" && parts.length === 4) {
        if (method !== "POST")
            methodNotAllowed(["POST"]);
        const body = await readJson(req);
        sendData(res, await backend.applyProjectionEdits(decodeSegment(parts[2]), revisionFrom(body), parseProjectionEdits(body), viewOptions(url, true)));
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "blocks" && parts[5] === "actions" && parts.length === 6) {
        if (method !== "POST")
            methodNotAllowed(["POST"]);
        const body = await readJson(req);
        const action = body.action;
        if (action !== "deactivate" && action !== "reactivate" && action !== "recompress" && action !== "promote" && action !== "demote") {
            throw new HttpError(400, "INVALID_BLOCK_ACTION", "action must be deactivate, reactivate, recompress, promote, or demote");
        }
        sendData(res, await backend.performBlockAction(decodeSegment(parts[2]), decodeSegment(parts[4]), revisionFrom(body), action, viewOptions(url, true)));
        return;
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "archive" && parts[4] === "search" && parts.length === 5) {
        if (method !== "GET")
            methodNotAllowed(["GET"]);
        const text = url.searchParams.get("q")?.trim() ?? "";
        if (!text)
            throw new HttpError(400, "INVALID_SEARCH", "q is required");
        const sessionId = decodeSegment(parts[2]);
        const rawLimit = url.searchParams.get("limit");
        let limit;
        if (rawLimit !== null) {
            limit = Number(rawLimit);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
                throw new HttpError(400, "INVALID_SEARCH", "limit must be an integer from 1 to 100");
        }
        sendData(res, await backend.searchArchivedContent({ text, sessionId, limit }));
        return;
    }
    throw new HttpError(404, "NOT_FOUND", "Route not found");
}
/** Start an authenticated server on an explicit loopback interface. */
export async function startControlServer(options) {
    const requestedHost = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;
    validateLoopbackHost(requestedHost);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
        throw new HttpError(400, "INVALID_PORT", "port must be an integer from 0 to 65535");
    // Normalize every accepted loopback spelling to an explicit IPv4 listener.
    // The public random *.localhost origin resolves to this address, while no
    // user-controlled DNS result is ever used for the listening socket.
    const host = "127.0.0.1";
    const token = randomBytes(32).toString("hex");
    // Host-only cookies are not port-scoped. A random localhost subdomain keeps
    // the HttpOnly dashboard cookie away from unrelated 127.0.0.1/localhost apps.
    // Chat labels may be prefixed onto it; the nonce is always required.
    const hostNonce = token.slice(0, 16);
    const publicHost = buildPublicHost(hostNonce);
    const server = createServer(async (req, res) => {
        applySecurityHeaders(res);
        try {
            const { host: hostHeader, ownPublicHost } = requestHost(req, hostNonce);
            const url = new URL(req.url ?? "/", `http://${hostHeader}`);
            const method = req.method ?? "GET";
            if (url.pathname === "/health") {
                if (method !== "GET")
                    methodNotAllowed(["GET"]);
                sendData(res, { status: "ok" });
                return;
            }
            // The HTML shell contains no session data and may be loaded before auth so
            // a token kept in the URL fragment (never sent in HTTP/referrers) can be
            // exchanged for the HttpOnly cookie.
            if (url.pathname === "/" && method === "GET") {
                res.statusCode = 200;
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(CONTROL_UI_HTML);
                return;
            }
            if (url.pathname === "/bootstrap") {
                if (method !== "POST")
                    methodNotAllowed(["POST"]);
                if (!ownPublicHost) {
                    throw new HttpError(400, "INVALID_HOST", "Bootstrap the dashboard cookie through the labeled ctx-*.localhost origin, not a bare loopback host");
                }
                const body = await readJson(req);
                const supplied = body.token;
                if (typeof supplied !== "string" || !secureEqual(supplied, token)) {
                    throw new HttpError(401, "UNAUTHORIZED", "Invalid bootstrap token");
                }
                res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`);
                sendData(res, { authenticated: true });
                return;
            }
            if (!isAuthenticated(req, token))
                throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
            if (MUTATION_METHODS.has(method))
                enforceSameOrigin(req, hostHeader, bearerToken(req) !== undefined);
            if (url.pathname.startsWith("/api/")) {
                await routeApi(req, res, url, options.backend);
                return;
            }
            throw new HttpError(404, "NOT_FOUND", "Route not found");
        }
        catch (error) {
            sendError(res, error);
        }
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise(resolve => server.close(() => resolve()));
        throw new Error("Control server did not expose a TCP address");
    }
    const actualPort = address.port;
    if (!LOOPBACK_HOSTS.has(normalizedHostname(address.address))) {
        await new Promise(resolve => server.close(() => resolve()));
        throw new Error(`Control server bound to non-loopback address ${address.address}`);
    }
    // The control plane must never keep an otherwise finished CLI/test process alive.
    server.unref();
    let closing;
    const control = {
        host,
        port: actualPort,
        origin: `http://${publicHost}:${actualPort}`,
        token,
        originFor(label) {
            return `http://${buildPublicHost(hostNonce, label)}:${actualPort}`;
        },
        close() {
            if (!closing) {
                closing = new Promise((resolve, reject) => {
                    server.close(error => {
                        error ? reject(error) : resolve();
                    });
                    server.closeIdleConnections();
                });
            }
            return closing;
        },
    };
    return control;
}
//# sourceMappingURL=control-server.js.map