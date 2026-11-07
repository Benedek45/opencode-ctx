import { unwrapData } from "./host.js";
import { isSummaryWorkerSession } from "../opencode/summary-worker.js";
export const SUMMARY_AGENT = "ctx-summarizer";
export const SUMMARY_TITLE = "Context summary worker";
export function assertWorkerCapabilities(ctx) {
    for (const name of ["create", "prompt", "wait", "context", "interrupt", "remove"]) {
        if (typeof ctx.session[name] !== "function")
            throw new Error(`ctx.summaryWorker: native V2 session.${name} is required`);
    }
    if (typeof ctx.agent?.transform !== "function")
        throw new Error("ctx.summaryWorker: native V2 agent.transform is required");
}
/** Registration and all mutations are opt-in; default-off does not add any hook. */
export async function registerWorkerAgent(ctx) {
    await ctx.agent.transform(editor => {
        if (editor.get(SUMMARY_AGENT))
            return; // preserve user agent definitions
        editor.update(SUMMARY_AGENT, agent => {
            agent.name = SUMMARY_AGENT;
            agent.mode = "subagent";
            agent.hidden = true;
            agent.description = "Internal isolated context summary worker";
            agent.permissions = [{ action: "*", resource: "*", effect: "deny" }];
        });
    });
}
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Malformed V2 worker response");
    return value;
}
export class V2SummaryWorkerTransport {
    ctx;
    model;
    prompts = new Map();
    constructor(ctx, model) {
        this.ctx = ctx;
        this.model = model;
    }
    /** Never run the parent pipeline on a worker. Remove ALL tools, not just ctx tools. */
    context(event) {
        const prompt = this.prompts.get(event.sessionID);
        if (!prompt || !isSummaryWorkerSession(event.sessionID))
            throw new Error("Unowned summary worker request");
        if (event.agent !== SUMMARY_AGENT || event.model?.providerID !== this.model.providerID || event.model?.id !== this.model.id) {
            throw new Error("Summary worker model/agent changed");
        }
        event.tools = {};
        // Fresh session must contain only this data prompt. Do not inherit project
        // instructions, reminders, references, or provider-generated continuations.
        event.system = [{ type: "text", text: prompt.system }];
        const users = Array.isArray(event.messages) ? event.messages.filter((message) => message.role === "user" && message.id) : [];
        if (users.length !== 1 || event.messages.some((message) => message.role === "assistant" || message.role === "tool")) {
            throw new Error("Summary worker context is not an isolated first request");
        }
        const content = users[0].content;
        if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || content[0]?.text !== prompt.text) {
            throw new Error("Summary worker source prompt changed");
        }
        event.messages.splice(0, event.messages.length, users[0]);
    }
    /** Shared summarizer performs bounded calls/late-create recovery and cleanup. */
    sessionFacade() {
        const ctx = this.ctx;
        const request = (parameters) => ({ signal: parameters.signal });
        const sessionID = (parameters) => object(parameters.path).id;
        return {
            create: async (parameters) => {
                const info = object(unwrapData(await ctx.session.create({
                    title: SUMMARY_TITLE, agent: SUMMARY_AGENT, model: this.model,
                    location: { directory: ctx.location.directory },
                    // Session rules run after agent rules, so a pre-existing user agent
                    // cannot grant a worker tool authority.
                    permissions: [{ action: "*", resource: "*", effect: "deny" }],
                }, request(parameters))));
                return { data: info };
            },
            prompt: async (parameters) => {
                const id = sessionID(parameters);
                const body = object(parameters.body);
                if (!isSummaryWorkerSession(id) || body.agent !== SUMMARY_AGENT
                    || body.model?.providerID !== this.model.providerID || body.model?.modelID !== this.model.id
                    || typeof body.system !== "string" || body.parts?.length !== 1 || typeof body.parts[0]?.text !== "string") {
                    throw new Error("Invalid V2 worker prompt");
                }
                const text = body.parts[0].text;
                this.prompts.set(id, { system: body.system, text });
                const receipt = object(unwrapData(await ctx.session.prompt({ sessionID: id, text }, request(parameters))));
                if (receipt.sessionID !== id || receipt.type !== "user" || typeof receipt.id !== "string" || !receipt.id) {
                    throw new Error("Malformed V2 worker inbox receipt");
                }
                await ctx.session.wait({ sessionID: id }, request(parameters));
                const history = unwrapData(await ctx.session.context({ sessionID: id }, request(parameters)));
                if (!Array.isArray(history) || history.length !== 2)
                    throw new Error("Worker did not finish exactly one response");
                const user = object(history[0]);
                const assistant = object(history[1]);
                // V2 context messages carry no sessionID; the scoped call binds them.
                // Reject a conflicting field if a future host happens to supply one.
                if (user.type !== "user" || user.sessionID !== undefined && user.sessionID !== id || user.id !== receipt.id || user.text !== text
                    || assistant.type !== "assistant" || assistant.sessionID !== undefined && assistant.sessionID !== id || typeof assistant.id !== "string"
                    || !assistant.id || assistant.agent !== SUMMARY_AGENT || assistant.model?.id !== this.model.id
                    || assistant.model?.providerID !== this.model.providerID || assistant.finish !== "stop"
                    || assistant.error != null || assistant.retry != null || !Number.isFinite(assistant.time?.completed)
                    || !Array.isArray(assistant.content)
                    || assistant.content.some((part) => !["text", "reasoning"].includes(part.type) || typeof part.text !== "string")) {
                    throw new Error("Unfinished, extra, tool-bearing or model-mismatched V2 worker response");
                }
                return { data: { info: { id: assistant.id, sessionID: id, role: "assistant", agent: assistant.agent,
                            providerID: assistant.model.providerID, modelID: assistant.model.id, finish: assistant.finish, time: assistant.time },
                        parts: assistant.content.map((part, index) => ({ ...part,
                            id: `${assistant.id}:${index}`, sessionID: id, messageID: assistant.id })) } };
            },
            abort: async (parameters) => {
                const id = sessionID(parameters);
                // Drop source-bearing request data even if cleanup cannot be confirmed.
                // The shared registry retains only the exact suppressed worker ID.
                this.prompts.delete(id);
                const result = object(unwrapData(await ctx.session.interrupt({ sessionID: id, resume: false }, request(parameters))));
                if (typeof result.interrupted !== "boolean")
                    throw new Error("Unacknowledged worker interrupt");
                return { data: true }; // interrupted:false is the documented idle no-op
            },
            delete: async (parameters) => {
                const id = sessionID(parameters);
                await ctx.session.remove({ sessionID: id }, request(parameters));
                this.prompts.delete(id);
                return { data: true }; // successful V2 remove returns void (204)
            },
        };
    }
}
//# sourceMappingURL=summary-worker.js.map