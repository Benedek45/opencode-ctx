// PolyForm Noncommercial License 1.0.0 — see LICENSE
// OpenCode V2 plugin binding for the context manager.
//
// The V1 adapter (adapters/opencode/plugin.ts) stays the single implementation of
// context-manager behavior: pipeline, durable archives, compression tools, tiers, control
// server, handoff and remote-context bridge. This module binds it to the V2
// plugin API by translating each V2 seam onto the V1 hook it replaces:
//
//   V2 seam                                   → V1 hook / facility
//   ─────────────────────────────────────────────────────────────────────────────
//   session.hook("context")  event.system     → experimental.chat.system.transform (read-only)
//   session.hook("context")  event.messages   → experimental.chat.messages.transform
//   tool.transform(editor.add)                → tool: { compress, ... }
//   command.transform(editor.add)             → config.command + command.execute.before
//   tool.hook("execute.before")               → tool.execute.before (routing)
//   tool.hook("execute.after") compress       → event message.part.updated (compress timing)
//   event.subscribe()  session.status/idle    → event session.status (cache eviction)
//   event.subscribe()  session.step.ended     → assistant `info.tokens` (calibration)
//   setup() cleanup                           → event server.instance.disposed
//   ctx.session/model domains                 → V1 PluginInput.client facade (host.ts)
//
// No V2 equivalent: experimental.text.complete. The core already strips
// hallucinated `ctx-message-id` tags from model-facing text during tagging; with
// V2 they can only remain visible in the stored/displayed assistant text.
import { CtxPlugin } from "../opencode/plugin.js";
import { validateSummaryWorker } from "../opencode/config.js";
import { isSummaryWorkerSession } from "../opencode/summary-worker.js";
import { assertWorkerCapabilities, registerWorkerAgent, V2SummaryWorkerTransport, SUMMARY_TITLE } from "./summary-worker.js";
import { appendLogLine, ctxLogFile, resolveStorageDir } from "../opencode/services.js";
import { contextFromHost, contextToHost } from "./map.js";
import { V2HostRuntime, } from "./host.js";
export const CTX_V2_PLUGIN_ID = "context-manager";
/** Context hooks slower than this are logged (they delay the model request). */
const SLOW_CONTEXT_MS = 5_000;
/**
 * V1 command responses that are model prompts rather than status notes. V1
 * replaced the command's user message with this text; every other response
 * (stats, restore/re-apply, export, errors, no-ops) is a local status note.
 */
const MODEL_FACING_COMMAND_TEXT = new Map([
    ["ctx-compress", text => text.startsWith("[Manual compress trigger]")],
    ["ctx-import", text => /^ctx-import: (imported|already imported)/.test(text)],
]);
/** V1 tool-class names whose V2 built-in tool was renamed. */
const TOOL_CLASS_ALIASES = [
    ["bash", "shell"],
    ["apply_patch", "patch"],
];
/**
 * Build the V2 plugin definition (`Plugin.define`-compatible: `{ id, setup }`).
 * `Plugin.define` from `@opencode/plugin` is the identity function, so the plain
 * object is used directly and the compiled entry has no runtime host import.
 */
export function createCtxV2Plugin(deps = {}) {
    return {
        id: CTX_V2_PLUGIN_ID,
        async setup(rawCtx) {
            const ctx = rawCtx;
            const options = normalizeV2Options(ctx.options ?? {});
            const workerOptions = validateSummaryWorker(options.ctx?.summaryWorker);
            let worker;
            if (workerOptions.enabled) {
                if (options.ctx.summaryWorker?.sdkVersion !== undefined) {
                    throw new Error("ctx.summaryWorker.sdkVersion is a legacy SDK option; omit it for the native V2 worker");
                }
                assertWorkerCapabilities(ctx);
                await registerWorkerAgent(ctx);
                const separator = workerOptions.model.indexOf("/");
                worker = new V2SummaryWorkerTransport(ctx, { providerID: workerOptions.model.slice(0, separator), id: workerOptions.model.slice(separator + 1) });
                await ctx.session.hook("title", event => {
                    if (isSummaryWorkerSession(event.sessionID))
                        event.result = SUMMARY_TITLE;
                });
                await ctx.session.hook("compaction", event => {
                    if (isSummaryWorkerSession(event.sessionID))
                        throw new Error("Summary worker automatic compaction is disabled");
                });
            }
            const logger = deps.logger ?? consoleLogger(storageLogFile(options));
            const factory = deps.v1Factory ?? CtxPlugin;
            let hooks;
            const runtime = new V2HostRuntime(ctx, {
                logger,
                onEvent: event => forwardEvent(event),
            });
            hooks = await factory(runtime.pluginInput(worker?.sessionFacade()), options);
            const v1 = hooks;
            async function forwardEvent(event) {
                if (!hooks)
                    return;
                const data = (event.data ?? {});
                const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
                if (!sessionID)
                    return;
                let status;
                if (event.type === "session.status")
                    status = data.status?.type;
                else if (event.type === "session.idle" || event.type.startsWith("session.execution.") && event.type !== "session.execution.started")
                    status = "idle";
                else if (event.type === "session.execution.started")
                    status = "busy";
                if (status === "idle" || status === "busy" || status === "retry") {
                    await hooks.event({ event: { type: "session.status", properties: { sessionID, status: { type: status } } } });
                }
            }
            // ── Tools ───────────────────────────────────────────────────────────────
            const toolEntries = Object.entries(v1.tool ?? {});
            await ctx.tool.transform(editor => {
                for (const [name, definition] of toolEntries)
                    editor.add(toV2Tool(name, definition, runtime));
            });
            // ── Commands ────────────────────────────────────────────────────────────
            const commandConfig = {};
            await v1.config(commandConfig);
            const commands = Object.entries((commandConfig.command ?? {}))
                .filter(([name]) => name.startsWith("ctx-"));
            await ctx.command.transform(editor => {
                for (const [name, definition] of commands) {
                    editor.add({
                        name,
                        description: definition.description,
                        execute: invocation => runCommand(name, invocation),
                    });
                }
            });
            async function runCommand(name, invocation) {
                const sessionID = invocation.sessionID;
                if (isSummaryWorkerSession(sessionID))
                    return;
                const args = typeof invocation.prompt?.text === "string" ? invocation.prompt.text : "";
                if (name === "ctx-import")
                    await seedImportInvocation(sessionID, args);
                const output = { parts: [] };
                try {
                    await v1["command.execute.before"]({ command: name, sessionID, arguments: args }, output);
                }
                catch (error) {
                    // V1 aborts local-only commands (ctx-ui) by throwing; V2 commands
                    // simply return without contacting the model.
                    if (name !== "ctx-ui")
                        logger.warn(`ctx-v2: /${name} failed`, error);
                    return;
                }
                const text = output.parts
                    .filter(part => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
                    .map(part => part.text)
                    .join("\n");
                if (!text)
                    return;
                const modelFacing = MODEL_FACING_COMMAND_TEXT.get(name)?.(text) === true;
                try {
                    if (modelFacing) {
                        await ctx.session.prompt({ sessionID, text, ...(invocation.delivery ? { delivery: invocation.delivery } : {}) });
                    }
                    else {
                        await ctx.session.synthetic({ sessionID, text, description: `/${name}`, resume: false });
                    }
                }
                catch (error) {
                    logger.warn(`ctx-v2: could not deliver /${name} result`, error);
                }
            }
            /**
             * V1 `/ctx-import` requires the new chat to contain exactly the invocation
             * message. V2 commands do not create one, so record it as a synthetic
             * message and wait (bounded) until it is visible in session history.
             */
            async function seedImportInvocation(sessionID, args) {
                const text = `/ctx-import${args.trim() ? ` ${args.trim()}` : ""}`;
                try {
                    if ((await runtime.history(sessionID)).length > 0)
                        return;
                    await ctx.session.synthetic({ sessionID, text, description: "/ctx-import", resume: false });
                    for (let attempt = 0; attempt < 30; attempt++) {
                        if ((await runtime.history(sessionID)).length > 0)
                            return;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                catch (error) {
                    logger.warn("ctx-v2: could not record the /ctx-import invocation", error);
                }
            }
            // ── Context (system accounting + message pipeline) ──────────────────────
            await ctx.session.hook("context", event => onContext(event));
            async function onContext(event) {
                const sessionID = event.sessionID;
                if (typeof sessionID !== "string" || !Array.isArray(event.messages))
                    return;
                // Fail closed outside the fail-open parent transform catch. Worker errors
                // must abort generation, not send inherited context or tool authority.
                if (isSummaryWorkerSession(sessionID)) {
                    if (!worker)
                        throw new Error("Summary worker belongs to a retired plugin owner");
                    worker.context(event);
                    return;
                }
                if (worker)
                    await runtime.observe({ type: "session.execution.started", data: { sessionID } }, false);
                const started = Date.now();
                const inputCount = event.messages.length;
                try {
                    const model = event.model;
                    const limit = await runtime.contextLimit(model);
                    const system = (event.system ?? [])
                        .map(part => (typeof part?.text === "string" ? part.text : ""))
                        .filter(text => text.length > 0);
                    await v1["experimental.chat.system.transform"]({
                        sessionID,
                        model: { id: model?.id, providerID: model?.providerID, ...(limit ? { limit: { context: limit } } : {}) },
                    }, { system });
                    const plan = contextToHost(event.messages, {
                        sessionID,
                        model,
                        tokensFor: id => runtime.usageFor(sessionID, id),
                        projectRoot: runtime.projectRoot,
                    });
                    if (plan.entries.length === 0)
                        return;
                    const output = { messages: plan.entries };
                    await v1["experimental.chat.messages.transform"]({ sessionID }, output);
                    const next = contextFromHost(output.messages, plan);
                    event.messages.splice(0, event.messages.length, ...next);
                }
                catch (error) {
                    // Never break a turn: on any failure the host request stays unmodified.
                    logger.warn("ctx-v2: context transform failed; sending unmodified context", error);
                }
                finally {
                    const elapsed = Date.now() - started;
                    if (elapsed >= SLOW_CONTEXT_MS) {
                        logger.info(`ctx-v2: slow context transform ${elapsed}ms for ${sessionID} (${inputCount} -> ${event.messages.length} messages)`);
                    }
                }
            }
            // ── Tool execution hooks ────────────────────────────────────────────────
            await ctx.tool.hook("execute.before", async (event) => {
                if (isSummaryWorkerSession(event.sessionID))
                    throw new Error("Tools are disabled in summary worker sessions");
                await v1["tool.execute.before"]({ tool: event.tool, sessionID: event.sessionID, callID: event.id }, { args: event.input });
            });
            await ctx.tool.hook("execute.after", async (event) => {
                if (isSummaryWorkerSession(event.sessionID))
                    return;
                if (event.tool !== "compress" || event.status !== "completed")
                    return;
                await v1.event({
                    event: {
                        type: "message.part.updated",
                        properties: { part: { type: "tool", tool: "compress", sessionID: event.sessionID } },
                    },
                });
            });
            // ── Events and cleanup ──────────────────────────────────────────────────
            const controller = new AbortController();
            runtime.start(controller.signal);
            logger.info(`ctx-v2: loaded for ${runtime.directory} (${toolEntries.length} tools, ${commands.length} commands)`);
            return async () => {
                controller.abort();
                await runtime.stopped();
                try {
                    await v1.event({ event: { type: "server.instance.disposed", properties: { directory: runtime.directory } } });
                }
                catch (error) {
                    logger.warn("ctx-v2: cleanup failed", error);
                }
                hooks = undefined;
            };
        },
    };
}
function toV2Tool(name, definition, runtime) {
    return {
        name,
        description: definition.description,
        input: {
            type: "object",
            properties: definition.args ?? {},
            ...(definition.required?.length ? { required: [...definition.required] } : {}),
        },
        // Direct model-visible tools like OpenCode's own read/edit/shell; Code Mode
        // would hide them behind `execute`, which context-manager nudges never mention.
        options: { codemode: false },
        async execute(input, context) {
            if (isSummaryWorkerSession(context.sessionID))
                throw new Error("Context tools are disabled in summary worker sessions");
            const result = await definition.execute(input ?? {}, {
                sessionID: context.sessionID,
                messageID: context.messageID,
                agent: context.agent,
                callID: context.id,
                directory: runtime.directory,
                worktree: runtime.projectRoot,
                abort: context.signal ?? new AbortController().signal,
                metadata: (update) => {
                    void context.progress?.({ ...(update?.metadata ?? {}), ...(update?.title ? { title: update.title } : {}) })
                        ?.catch(() => undefined);
                },
                ask: async () => undefined,
            });
            if (typeof result === "string")
                return { content: result };
            return {
                content: result.output,
                ...(result.title || result.metadata
                    ? { metadata: { ...(result.metadata ?? {}), ...(result.title ? { title: result.title } : {}) } }
                    : {}),
            };
        },
    };
}
/**
 * Copy V2 plugin options into V1 factory options. The V1 tuple options object
 * (`{ "ctx": { ... } }`) is accepted unchanged; V1 tool-class names whose V2
 * built-in was renamed (`bash` → `shell`, `apply_patch` → `patch`) are mirrored
 * when the V2 name is not configured explicitly.
 */
export function normalizeV2Options(options) {
    const copy = JSON.parse(JSON.stringify(options ?? {}));
    const managerOptions = copy.ctx;
    if (!managerOptions || typeof managerOptions !== "object" || Array.isArray(managerOptions))
        return copy;
    const aliasClasses = (layer) => {
        if (!layer || typeof layer !== "object")
            return;
        const classes = layer.toolClasses;
        if (!classes || typeof classes !== "object" || Array.isArray(classes))
            return;
        const record = classes;
        for (const [v1, v2] of TOOL_CLASS_ALIASES) {
            if (record[v1] !== undefined && record[v2] === undefined)
                record[v2] = structuredClone(record[v1]);
        }
    };
    const root = managerOptions;
    aliasClasses(root);
    for (const key of ["providers", "models"]) {
        const layers = root[key];
        if (layers && typeof layers === "object" && !Array.isArray(layers)) {
            for (const layer of Object.values(layers))
                aliasClasses(layer);
        }
    }
    return copy;
}
function storageLogFile(options) {
    const managerOptions = options.ctx;
    return ctxLogFile(resolveStorageDir(typeof managerOptions?.storagePath === "string" ? managerOptions.storagePath : undefined));
}
/** Console plus the shared context-manager log file (V2 services discard plugin console output). */
function consoleLogger(filePath) {
    return {
        warn: (message, error) => {
            console.warn(`[ctx-v2] ${message}`, error ?? "");
            appendLogLine(filePath, "WARN", `[ctx-v2] ${message}`, error === undefined ? [] : [error]);
        },
        info: message => {
            console.info(`[ctx-v2] ${message}`);
            appendLogLine(filePath, "INFO", `[ctx-v2] ${message}`, []);
        },
        debug: () => undefined,
    };
}
/** Default V2 plugin definition. */
export const CtxV2Plugin = createCtxV2Plugin();
//# sourceMappingURL=plugin.js.map