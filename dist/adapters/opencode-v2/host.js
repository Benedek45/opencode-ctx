// PolyForm Noncommercial License 1.0.0 — see LICENSE
// OpenCode V2 host runtime for the context-manager adapter.
//
// Owns everything the V1 adapter used to obtain from the V1 host and that V2
// exposes differently:
//   - session status (V1 `client.session.status`)      ← V2 event stream
//   - per-assistant provider usage (V1 `info.tokens`)  ← `session.step.ended` events
//   - model context limits (V1 `Provider.Model.limit`) ← `ctx.model.list()`
//   - a read-only V1 `PluginInput` facade (`client.session.get/messages/status`,
//     `client.config.get`, `client.provider.list`) for the handoff host reader,
//     remote-context bridge and control-plane ownership checks.
import { sessionHistoryToHost } from "./map.js";
const MAX_TRACKED_USAGE = 256;
const MODEL_CACHE_MS = 60_000;
const MODEL_LOOKUP_TIMEOUT_MS = 2_000;
export class V2HostRuntime {
    ctx;
    options;
    directory;
    projectRoot;
    statuses = new Map();
    observedStatuses = new Set();
    usage = new Map();
    modelCache;
    modelLoad;
    eventsLive = false;
    loop;
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.options = options;
        this.directory = ctx.location.directory;
        this.projectRoot = ctx.location.project?.directory ?? ctx.location.directory;
    }
    /** True once the event stream delivered at least one event (status is then authoritative). */
    get statusReliable() {
        return this.eventsLive;
    }
    // ── Events ──────────────────────────────────────────────────────────────────
    start(signal) {
        if (this.loop)
            return;
        this.loop = this.consume(signal);
    }
    /** Resolves after the event loop has stopped (abort the start() signal first). */
    async stopped() {
        await this.loop?.catch(() => undefined);
    }
    async consume(signal) {
        let delay = 250;
        while (!signal.aborted) {
            try {
                for await (const event of this.ctx.event.subscribe({ signal })) {
                    if (signal.aborted)
                        return;
                    delay = 250;
                    await this.observe(event);
                }
            }
            catch (error) {
                if (signal.aborted)
                    return;
                this.options.logger?.warn("ctx-v2: event subscription failed; retrying", error);
            }
            if (signal.aborted)
                return;
            this.eventsLive = false;
            this.observedStatuses.clear();
            await new Promise(resolve => {
                const timer = setTimeout(resolve, delay);
                signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            delay = Math.min(delay * 2, 10_000);
        }
    }
    /** Record one V2 event. Exposed for tests and for hosts that push events. */
    async observe(event, fromStream = true) {
        if (!event || typeof event.type !== "string")
            return;
        // A local context hook can revoke idle authority, but cannot establish a
        // connection or restore authority lost when the subscription disconnected.
        if (fromStream)
            this.eventsLive = true;
        const data = (event.data ?? {});
        const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
        switch (event.type) {
            case "session.status": {
                const status = data.status?.type;
                if (sessionID && (status === "idle" || status === "busy" || status === "retry"))
                    this.setStatus(sessionID, status);
                break;
            }
            case "session.idle":
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted":
                if (sessionID)
                    this.setStatus(sessionID, "idle");
                break;
            case "session.execution.started":
                if (sessionID)
                    this.setStatus(sessionID, "busy");
                break;
            case "session.step.ended":
            case "session.step.failed": {
                const messageId = typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined;
                const tokens = data.tokens;
                if (sessionID && messageId && isTokenUsage(tokens))
                    this.recordUsage(sessionID, messageId, tokens);
                break;
            }
            case "session.deleted":
                if (sessionID) {
                    this.statuses.delete(sessionID);
                    this.observedStatuses.delete(sessionID);
                    this.usage.delete(sessionID);
                }
                break;
            default:
                break;
        }
        try {
            await this.options.onEvent?.(event);
        }
        catch (error) {
            this.options.logger?.warn("ctx-v2: event handler failed", error);
        }
    }
    setStatus(sessionID, status) {
        this.observedStatuses.delete(sessionID);
        this.observedStatuses.add(sessionID);
        // Worker-only authority is a bounded LRU; an evicted status is unknown.
        while (this.observedStatuses.size > 2048)
            this.observedStatuses.delete(this.observedStatuses.values().next().value);
        if (status === "idle")
            this.statuses.delete(sessionID);
        else
            this.statuses.set(sessionID, status);
    }
    status(sessionID) {
        return this.statuses.get(sessionID) ?? "idle";
    }
    /** Worker-only authority: an absent session is unknown, not inferred idle. */
    workerStatus(sessionID) {
        return this.eventsLive && this.observedStatuses.has(sessionID) ? this.status(sessionID) : undefined;
    }
    recordUsage(sessionID, messageId, tokens) {
        let perSession = this.usage.get(sessionID);
        if (!perSession) {
            perSession = new Map();
            this.usage.set(sessionID, perSession);
        }
        perSession.delete(messageId);
        perSession.set(messageId, {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cache: { read: tokens.cache.read, write: tokens.cache.write },
        });
        while (perSession.size > MAX_TRACKED_USAGE)
            perSession.delete(perSession.keys().next().value);
    }
    usageFor(sessionID, messageId) {
        return this.usage.get(sessionID)?.get(messageId);
    }
    // ── Models ──────────────────────────────────────────────────────────────────
    async models(force = false) {
        if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS)
            return this.modelCache.models;
        this.modelLoad ??= (async () => {
            try {
                const listed = unwrapData(await this.ctx.model.list());
                const models = Array.isArray(listed) ? listed : [];
                this.modelCache = { at: Date.now(), models };
                return models;
            }
            finally {
                this.modelLoad = undefined;
            }
        })();
        return this.modelLoad;
    }
    /** Context window of a model, or undefined when the host does not publish one. */
    async contextLimit(model) {
        if (!model?.id || !model.providerID)
            return undefined;
        const find = (models) => models.find(info => info.providerID === model.providerID
            && (info.id === model.id || info.modelID === model.id))?.limit?.context;
        try {
            const lookup = (async () => {
                const cached = find(await this.models());
                if (cached !== undefined)
                    return cached;
                return find(await this.models(true));
            })();
            const limit = await withTimeout(lookup, MODEL_LOOKUP_TIMEOUT_MS);
            return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
        }
        catch (error) {
            this.options.logger?.warn("ctx-v2: model context limit lookup failed", error);
            return undefined;
        }
    }
    // ── V1 PluginInput facade ──────────────────────────────────────────────────
    /** Session history as V1 host entries (`session.context`, i.e. after host compaction). */
    async history(sessionID) {
        const result = unwrapData(await this.ctx.session.context({ sessionID }));
        if (!Array.isArray(result))
            throw new Error("session.context returned no message list");
        return sessionHistoryToHost(result, sessionID, this.projectRoot);
    }
    /**
     * A read-only V1 `PluginInput` over V2 domains. Methods use the V1 SDK call
     * shape (`{ path: { id }, query }`) and return the Hey API `{ data }` /
     * `{ error }` envelope that the V1 adapter validates.
     */
    pluginInput(workerSession) {
        const runtime = this;
        const envelope = async (task) => {
            try {
                return { data: await task() };
            }
            catch (error) {
                return { error: { message: error instanceof Error ? error.message : String(error) } };
            }
        };
        const sessionIdOf = (options) => {
            const path = options?.path;
            if (typeof path?.id !== "string" || !path.id)
                throw new Error("session id is required");
            return path.id;
        };
        const session = {
            get: (options) => envelope(async () => {
                const info = unwrapData(await runtime.ctx.session.get({ sessionID: sessionIdOf(options) }));
                const location = info?.location;
                const model = info?.model;
                return {
                    ...info,
                    id: info?.id,
                    directory: location?.directory ?? runtime.directory,
                    ...(model?.id && model.providerID ? { model: { providerID: model.providerID, id: model.id } } : {}),
                };
            }),
            messages: (options) => envelope(() => runtime.history(sessionIdOf(options))),
            status: (_options) => {
                if (!runtime.statusReliable) {
                    return Promise.resolve({ error: { message: "session status is unavailable until the V2 event stream is connected" } });
                }
                if (workerSession)
                    return envelope(async () => Object.fromEntries([...runtime.observedStatuses]
                        .map(id => [id, { type: runtime.workerStatus(id) ?? "unknown" }])));
                return envelope(async () => Object.fromEntries([...runtime.statuses].map(([id, type]) => [id, { type }])));
            },
        };
        if (workerSession)
            Object.assign(session, workerSession);
        const config = {
            get: (_options) => envelope(async () => {
                const model = unwrapData(await runtime.ctx.model.default());
                return model?.providerID && model.id ? { model: `${model.providerID}/${model.id}` } : {};
            }),
        };
        const provider = {
            list: (_options) => envelope(async () => {
                const byProvider = new Map();
                for (const model of await runtime.models(true)) {
                    if (!model.providerID || !model.id)
                        continue;
                    const models = byProvider.get(model.providerID) ?? {};
                    models[model.id] = { id: model.id, limit: model.limit };
                    byProvider.set(model.providerID, models);
                }
                return { all: [...byProvider].map(([id, models]) => ({ id, models })) };
            }),
        };
        return {
            directory: this.directory,
            worktree: this.projectRoot,
            project: this.ctx.location.project,
            client: { session, config, provider },
            ...(workerSession ? { workerStatus: (id) => runtime.workerStatus(id) ?? "unknown" } : {}),
        };
    }
}
function isTokenUsage(value) {
    if (!value || typeof value !== "object")
        return false;
    const record = value;
    return [record.input, record.output, record.reasoning, record.cache?.read, record.cache?.write]
        .every(item => typeof item === "number" && Number.isFinite(item));
}
/** The Promise V2 API returns plain values for most calls and `{ location, data }` for some. */
export function unwrapData(value) {
    if (value && typeof value === "object" && !Array.isArray(value) && "data" in value && "location" in value) {
        return value.data;
    }
    return value;
}
function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise.finally(() => { if (timer)
            clearTimeout(timer); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
}
//# sourceMappingURL=host.js.map