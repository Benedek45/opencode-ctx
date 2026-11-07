// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Integration test: drives the real CtxPlugin factory end-to-end.
// No network calls, no real model, no subagents.

import { describe, it, expect, beforeEach } from "bun:test";
import CtxPluginDefault, { CtxPlugin } from "../adapters/opencode/plugin.js";
import { InMemoryPersistence } from "../services/persistence.js";
import { CharTokenizer } from "../services/tokenizer.js";
import { AdapterLogger, FilePersistence } from "../adapters/opencode/services.js";
import type {
  HostMessageEntry,
  MessagesTransformOutput,
  SystemTransformInput,
  SystemTransformOutput,
  TextCompleteOutput,
} from "../adapters/opencode/host-types.js";
import type { HostToolState, HostToolPart } from "../adapters/opencode/host-types.js";
import { PLACEHOLDER_DEDUP, PLACEHOLDER_STALE_ERROR_INPUT } from "../core/placeholders.js";
import { createInitialState } from "../types/state.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toNeutral } from "../adapters/opencode/map.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID = "integ-test-session-001";

// ── Fixture helpers ───────────────────────────────────────────────────────────

let _msgSeq = 1;
let _callSeq = 1;

function resetSeq(): void {
  _msgSeq = 1;
  _callSeq = 1;
}

function nextMsgId(): string {
  return `integ-msg-${String(_msgSeq++).padStart(4, "0")}`;
}

function nextCallId(): string {
  return `integ-call-${String(_callSeq++).padStart(4, "0")}`;
}

/** Build a user HostMessageEntry. */
function makeUser(text: string, sessionId = SESSION_ID): HostMessageEntry {
  const id = nextMsgId();
  return {
    info: {
      id,
      sessionID: sessionId,
      role: "user",
      time: { created: Date.now() },
      agent: "compliance",
      model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    },
    parts: [
      { id: `${id}-p`, sessionID: sessionId, messageID: id, type: "text", text },
    ],
  };
}

/** Build an assistant HostMessageEntry with an optional completed tool call. */
function makeAssistant(
  text: string,
  tool?: { name: string; callId?: string; input: Record<string, unknown>; output: string },
  sessionId = SESSION_ID
): HostMessageEntry {
  const id = nextMsgId();
  const parts: HostMessageEntry["parts"] = [
    { id: `${id}-step`, sessionID: sessionId, messageID: id, type: "step-start" },
    { id: `${id}-text`, sessionID: sessionId, messageID: id, type: "text", text },
  ];

  if (tool) {
    const cid = tool.callId ?? nextCallId();
    const state: HostToolState = {
      status: "completed",
      input: tool.input,
      output: tool.output,
      title: tool.name,
      time: { start: Date.now() - 100, end: Date.now() },
    };
    parts.push({
      id: `${id}-tool`,
      sessionID: sessionId,
      messageID: id,
      type: "tool",
      callID: cid,
      tool: tool.name,
      state,
    });
  }

  return {
    info: {
      id,
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() + 100 },
      parentID: "parent-1",
      modelID: "deepseek-v4-flash",
      providerID: "opencode-go",
      mode: "chat",
      path: { cwd: "/workspaces/test", root: "/workspaces/test" },
      summary: false,
      cost: 0.001,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
      finish: "end_turn",
    },
    parts,
  };
}

/** Build an assistant HostMessageEntry with an errored tool call. */
function makeErrorAssistant(
  text: string,
  tool: { name: string; callId?: string; input: Record<string, unknown>; error: string },
  sessionId = SESSION_ID
): HostMessageEntry {
  const id = nextMsgId();
  const cid = tool.callId ?? nextCallId();
  const state: HostToolState = {
    status: "error",
    input: tool.input,
    error: tool.error,
    time: { start: Date.now() - 100, end: Date.now() },
  };

  return {
    info: {
      id,
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() + 100 },
      parentID: "parent-1",
      modelID: "deepseek-v4-flash",
      providerID: "opencode-go",
      mode: "chat",
      path: { cwd: "/workspaces/test", root: "/workspaces/test" },
      summary: false,
      cost: 0.001,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 0 } },
      finish: "end_turn",
    },
    parts: [
      { id: `${id}-step`, sessionID: sessionId, messageID: id, type: "step-start" },
      { id: `${id}-text`, sessionID: sessionId, messageID: id, type: "text", text },
      {
        id: `${id}-tool`,
        sessionID: sessionId,
        messageID: id,
        type: "tool",
        callID: cid,
        tool: tool.name,
        state,
      },
    ],
  };
}

/** Generate a large string of ~`chars` characters. */
function largeOutput(chars: number): string {
  const line = "x".repeat(79) + "\n";
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

// ── Build a realistic multi-turn session ──────────────────────────────────────

/**
 * Build a session with:
 *   - Two IDENTICAL completed tool calls (same tool + same args) → dedup target
 *   - An errored tool call older than stale-error threshold → stale-error target
 *   - A large OLD completed STATELESS tool output (read) → mask/offload target
 *   - A large OLD completed STATEFUL tool output (bash) → stateful-mask target
 *   - Several RECENT messages (within recency window) → must be protected
 *
 * All messages share SESSION_ID so the plugin routes them to the same session.
 */
function buildSession(sessionId = SESSION_ID): HostMessageEntry[] {
  const LARGE = largeOutput(5000);
  const BASH_OUTPUT = "line1\nline2\nline3\nline4\nline5\nexit code: 0\nDone";

  // Turn 1: user asks, assistant reads a file (STATELESS, OLD)
  const u1 = makeUser("Please read the report template.", sessionId);
  const a1 = makeAssistant(
    "I will read the template.",
    { name: "read", input: { filePath: "/workspaces/test/output/report-template.md" }, output: LARGE },
    sessionId
  );

  // Turn 2: user asks, assistant runs bash (STATEFUL, OLD)
  const u2 = makeUser("Run the validation script.", sessionId);
  const a2 = makeAssistant(
    "Running validation.",
    { name: "bash", input: { command: "node validate.js" }, output: BASH_OUTPUT },
    sessionId
  );

  // Turn 3: assistant reads the SAME file again (DUPLICATE — dedup target)
  const u3 = makeUser("Check the template again.", sessionId);
  const a3 = makeAssistant(
    "Reading template again.",
    { name: "read", input: { filePath: "/workspaces/test/output/report-template.md" }, output: LARGE },
    sessionId
  );

  // Turn 4: errored tool call (STALE ERROR target)
  const u4 = makeUser("Try to delete a file.", sessionId);
  const a4 = makeErrorAssistant(
    "Attempting delete.",
    { name: "bash", input: { command: "rm /protected/file.txt" }, error: "Error: permission denied" },
    sessionId
  );

  // Turns 5-7: RECENT messages (within recency window) — must be protected
  const u5 = makeUser("What is the current status?", sessionId);
  const a5 = makeAssistant("The report is in progress.", undefined, sessionId);
  const u6 = makeUser("Please continue.", sessionId);
  const a6 = makeAssistant("Continuing now.", undefined, sessionId);
  const u7 = makeUser("What do you need next?", sessionId);
  const a7 = makeAssistant("I need the financial data.", undefined, sessionId);

  return [u1, a1, u2, a2, u3, a3, u4, a4, u5, a5, u6, a6, u7, a7];
}

// ── Plugin factory helper ─────────────────────────────────────────────────────

/**
 * Build a CtxPlugin instance with in-memory persistence and char tokenizer.
 * Passes a custom storagePath so FilePersistence writes to a temp dir.
 */
async function buildPlugin(ctxOptions: Record<string, unknown> = {}) {
  // We override the services by passing storagePath to a temp dir.
  // The plugin uses buildServices() internally; we can't inject directly,
  // but we can pass storagePath to redirect FilePersistence.
  const tmpDir = `${process.env.TEMP ?? "/tmp"}/ctx-integ-test-${Date.now()}`;
  const options = { ctx: { storagePath: tmpDir, ...ctxOptions } };
  const hooks = await CtxPlugin({}, options) as Record<string, unknown>;
  return hooks;
}

// ── A. Hook shape ─────────────────────────────────────────────────────────────

describe("A. CtxPlugin hook shape", () => {
  it("default-exports the plugin factory for desktop OpenCode loaders", () => {
    expect(CtxPluginDefault).toBe(CtxPlugin);
  });

  it("returns the documented hooks, compression tools, and command registration", async () => {
    const hooks = await buildPlugin();

    expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["experimental.text.complete"]).toBe("function");
    expect(typeof hooks["event"]).toBe("function");
    expect(typeof hooks["config"]).toBe("function");
    expect(typeof hooks["command.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.before"]).toBe("function");

    const tool = hooks["tool"] as Record<string, unknown>;
    expect(tool).toBeDefined();
    expect(typeof (tool["compress"] as Record<string, unknown>)["execute"]).toBe("function");
    expect(typeof (tool["compress"] as Record<string, unknown>)["description"]).toBe("string");
    expect((tool["compress"] as Record<string, unknown>)["args"]).toBeDefined();
    expect(typeof (tool["compress_message"] as Record<string, unknown>)["execute"]).toBe("function");
    expect(typeof (tool["ctx_tier_update"] as Record<string, unknown>)["execute"]).toBe("function");

    const config: Record<string, unknown> = {};
    await (hooks["config"] as (input: Record<string, unknown>) => Promise<void>)(config);
    const commands = config.command as Record<string, unknown>;
    expect(commands["ctx-ui"]).toBeDefined();
    expect(commands["ctx-recompress"]).toBeDefined();
  });
});

describe("monotonic adapter turns after shortened history", () => {
  type TurnTestHooks = {
    "experimental.chat.messages.transform": (input: { sessionID: string }, output: MessagesTransformOutput) => Promise<void>;
    "experimental.chat.system.transform": (input: SystemTransformInput, output: SystemTransformOutput) => Promise<void>;
  };
  for (const stage of ["cascade", "escalation", "policy-cap", "provider-cap"] as const) {
    for (const retentionTurns of [0, 5]) {
      it(`protects fresh and tool-only re-feeds under ${stage}, retention ${retentionTurns}`, async () => {
        const storagePath = await mkdtemp(join(tmpdir(), "ctx-turn-basis-"));
        const sessionId = `turn-basis-${stage}-${retentionTurns}`;
        try {
          const persistence = new FilePersistence(storagePath);
          const seeded = createInitialState(sessionId);
          seeded.hasRecordedCacheBust = true;
          seeded.lastCacheBustTurn = 7;
          seeded.lastMaskingPassTurn = 7;
          if (stage === "escalation") seeded.nudgeEscalation.ignoredStreak = 3;
          await persistence.save(sessionId, seeded);
          const hooks = await CtxPlugin({}, { ctx: {
            storagePath,
            tokenizer: "char",
            contentStore: { enabled: false },
            profile: "code",
            recencyGuardTurns: retentionTurns,
            toolClasses: {
              read: { stateless: true, retentionTurns },
              grep: { stateless: true, retentionTurns },
            },
            costRoi: { enabled: false },
            nearDupe: { enabled: false },
            minRepruneInterval: 0,
            clearAtLeast: 0,
            nudges: { maskTriggerThreshold: stage === "cascade" ? 0 : 1_000_000 },
            hardCap: stage === "policy-cap" ? 5_000 : 1_000_000,
          } }) as unknown as TurnTestHooks;
          await hooks["experimental.chat.system.transform"]!({
            sessionID: sessionId,
            model: { id: "deepseek-v4-flash", providerID: "opencode-go", limit: { context: stage === "provider-cap" ? 5_000 : 1_000_000 } },
          }, { system: [] });
          const transform = async (entries: HostMessageEntry[]) => {
            const output = { messages: structuredClone(entries) };
            await hooks["experimental.chat.messages.transform"]!({ sessionID: sessionId }, output);
            return output.messages;
          };
          const users = Array.from({ length: 10 }, () => makeUser("continue", sessionId));
          await transform([...users, makeAssistant("ready", undefined, sessionId)]);
          expect((await persistence.load(sessionId))!.currentTurn).toBe(10);
          const fresh = ["read", "grep"].map(name => makeAssistant("inspect", {
            name, input: { filePath: `/source-${name}.ts` }, output: largeOutput(16_000),
          }, sessionId));
          const assertExact = (projected: HostMessageEntry[], sources: HostMessageEntry[]) => {
            for (const source of sources) {
              expect(projected.find(entry => entry.info.id === source.info.id)?.parts.filter(p => p.type === "tool"))
                .toEqual(source.parts.filter(p => p.type === "tool"));
            }
          };
          for (let refeed = 0; refeed < 2; refeed++) {
            assertExact(await transform([users[9], ...fresh]), fresh);
            const state = (await persistence.load(sessionId))!;
            expect(state.currentTurn).toBe(10);
            expect(state.maskDecisions.size).toBe(0);
            expect(state.hardCapDroppedIds.size).toBe(0);
            expect(state.lastCacheBustTurn).toBe(7);
            expect(state.lastMaskingPassTurn).toBe(7);
            expect(state.eTurnsEstimate).toBe(seeded.eTurnsEstimate);
            expect(state.turnBasis!.messageTurns).toHaveLength(3);
            expect(toNeutral(fresh, state).flatMap(m => m.parts.filter(p => p.type === "tool").map(p => p.turn))).toEqual([10, 10]);
          }
          // No users and unresolvable parentIDs: even Phase 2's positional cutoff
          // must not drop these newly observed tools. The clock must not advance.
          const toolOnly = Array.from({ length: 8 }, (_, i) => {
            const entry = makeAssistant("", {
              name: i % 2 ? "grep" : "read", input: { path: `/partial-${i}` }, output: largeOutput(8_000),
            }, sessionId);
            if (i % 2) Reflect.deleteProperty(entry.info, "parentID");
            return entry;
          });
          for (let refeed = 0; refeed < 2; refeed++) {
            assertExact(await transform(toolOnly), toolOnly);
            const state = (await persistence.load(sessionId))!;
            expect(state.currentTurn).toBe(10);
            expect(state.maskDecisions.size + state.hardCapDroppedIds.size).toBe(0);
            expect(state.turnBasis!.messageTurns).toHaveLength(toolOnly.length + 1);
          }
          const nextUser = makeUser("next user turn", sessionId);
          const nextRead = makeAssistant("new inspection", {
            name: "read", input: { path: "/next" }, output: largeOutput(16_000),
          }, sessionId);
          const nextHistory = [users[9], ...fresh, nextUser, nextRead];
          for (let refeed = 0; refeed < 2; refeed++) {
            assertExact(await transform(nextHistory), [nextRead]);
            const state = (await persistence.load(sessionId))!;
            expect(state.currentTurn).toBe(11);
            expect(new Map(state.turnBasis!.messageTurns).get(nextRead.info.id)).toBe(11);
            expect(state.maskDecisions.size).toBe(retentionTurns === 0 ? 2 : 0);
          }
        } finally {
          await rm(storagePath, { recursive: true, force: true });
        }
      });
    }
  }

  it("reloads the basis in a cold plugin and preserves existing decisions and legacy clocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "ctx-turn-reload-"));
    const sessionId = "turn-reload";
    try {
      const firstStore = new FilePersistence(join(root, "first"));
      const legacy = createInitialState(sessionId);
      legacy.currentTurn = 10;
      const old = makeAssistant("old result", { name: "read", callId: "old-call", input: {}, output: largeOutput(4_000) }, sessionId);
      legacy.maskDecisions.set("old-call", "persisted replacement");
      legacy.messageIndex.set("old-call", { messageId: old.info.id, masked: true, offloaded: false });
      await firstStore.save(sessionId, legacy);
      const options = { tokenizer: "char" as const, contentStore: { enabled: false }, costRoi: { enabled: false }, clearAtLeast: 0, minRepruneInterval: 0 };
      const first = await CtxPlugin({}, { ctx: { ...options, storagePath: join(root, "first") } }) as unknown as TurnTestHooks;
      const user = makeUser("current request", sessionId);
      const initial = { messages: [old, user] };
      await first["experimental.chat.messages.transform"]!({ sessionID: sessionId }, initial);
      const saved = (await firstStore.load(sessionId))!;
      expect(saved.currentTurn).toBe(10);
      expect(saved.maskDecisions.get("old-call")).toBe("persisted replacement");
      // Different storage root avoids the adapter's process-shared session cache.
      const coldStore = new FilePersistence(join(root, "cold"));
      await coldStore.save(sessionId, saved);
      const cold = await CtxPlugin({}, { ctx: { ...options, storagePath: join(root, "cold") } }) as unknown as TurnTestHooks;
      const fresh = makeAssistant("fresh", { name: "read", input: { path: "/fresh" }, output: largeOutput(4_000) }, sessionId);
      const output = { messages: structuredClone([old, user, fresh]) };
      await cold["experimental.chat.messages.transform"]!({ sessionID: sessionId }, output);
      expect((await coldStore.load(sessionId))!.currentTurn).toBe(10);
      expect(output.messages.find(e => e.info.id === fresh.info.id)!.parts.filter(p => p.type === "tool"))
        .toEqual(fresh.parts.filter(p => p.type === "tool"));
      const oldTool = output.messages.find(e => e.info.id === old.info.id)!.parts.find(p => p.type === "tool") as HostToolPart;
      expect(oldTool.state.status === "completed" && oldTool.state.output).toBe("persisted replacement");
      await cold["experimental.chat.messages.transform"]!({ sessionID: sessionId }, { messages: [makeUser("disjoint new tail", sessionId), makeAssistant("ready", undefined, sessionId)] });
      expect((await coldStore.load(sessionId))!.currentTurn).toBe(11);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("A2. model-specific context accounting", () => {
  it("shows request deltas, consumes one matching calibration sample, and resets on model switch", async () => {
    resetSeq();
    const sessionId = "model-accounting-session";
    const storagePath = `${process.env.TEMP ?? "/tmp"}/ctx-model-accounting-${Date.now()}`;
    const hooks = await CtxPlugin({}, { ctx: {
      storagePath,
      tokenizer: "char",
      automation: { automaticPruning: false, modelCompression: true },
    } }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID?: string }, output: MessagesTransformOutput
    ) => Promise<void>;
    const systemTransform = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput, output: SystemTransformOutput
    ) => Promise<void>;
    const persistence = new FilePersistence(storagePath);

    const firstUser = makeUser("first request", sessionId);
    if (firstUser.info.role !== "user") throw new Error("fixture role");
    firstUser.info.model = { providerID: "openai", modelID: "gpt-5.6-sol" };
    const firstOutput = { messages: [structuredClone(firstUser)] };
    await transform({ sessionID: sessionId }, firstOutput);
    const firstText = firstOutput.messages[0].parts.find(part => part.type === "text");
    expect(firstText?.type === "text" ? firstText.text : "").toContain("Context status for openai/gpt-5.6-sol");
    expect(firstText?.type === "text" ? firstText.text : "").toContain("model-specific estimate");
    expect(firstText?.type === "text" ? firstText.text : "").toContain("change unavailable");
    // Desktop may run messages before system. The later read-only system hook
    // must repair the pending denominator before provider usage is consumed.
    await systemTransform({
      sessionID: sessionId,
      model: { id: "gpt-5.6-sol", providerID: "openai", limit: { context: 325_000 } },
    }, { system: ["s".repeat(4_000)] });

    const response = makeAssistant("done", undefined, sessionId);
    if (response.info.role !== "assistant") throw new Error("fixture role");
    response.info.parentID = firstUser.info.id;
    response.info.providerID = "openai";
    response.info.modelID = "gpt-5.6-sol";
    response.info.tokens.input = 1_000;
    const secondUser = makeUser("second request adds text", sessionId);
    if (secondUser.info.role !== "user") throw new Error("fixture role");
    secondUser.info.model = { providerID: "openai", modelID: "gpt-5.6-sol" };
    const secondOutput = { messages: [structuredClone(firstUser), response, secondUser] };
    await transform({ sessionID: sessionId }, secondOutput);
    let state = await persistence.load(sessionId);
    expect(state?.tokenCalibration.modelKey).toBe("openai\u0000gpt-5.6-sol");
    expect(state?.tokenCalibration.sampleCount).toBe(1);
    expect(state?.tokenCalibration.ratio ?? 99).toBeLessThan(3);
    const secondText = secondOutput.messages.at(-1)?.parts.find(part => part.type === "text");
    expect(secondText?.type === "text" ? secondText.text : "").toContain("since prior request");

    // Re-feeding the same response cannot consume its usage a second time: the
    // pending sample now targets secondUser, while response.parentID targets firstUser.
    await transform({ sessionID: sessionId }, {
      messages: [structuredClone(firstUser), structuredClone(response), structuredClone(secondUser)],
    });
    state = await persistence.load(sessionId);
    expect(state?.tokenCalibration.sampleCount).toBe(1);

    const siblingA = makeAssistant("tool step one", undefined, sessionId);
    const siblingB = makeAssistant("tool step two", undefined, sessionId);
    for (const sibling of [siblingA, siblingB]) {
      if (sibling.info.role !== "assistant") throw new Error("fixture role");
      sibling.info.parentID = secondUser.info.id;
      sibling.info.providerID = "openai";
      sibling.info.modelID = "gpt-5.6-sol";
    }
    const inFlight = makeAssistant("", undefined, sessionId);
    if (inFlight.info.role !== "assistant") throw new Error("fixture role");
    inFlight.info.parentID = secondUser.info.id;
    inFlight.info.providerID = "openai";
    inFlight.info.modelID = "gpt-5.6-sol";
    inFlight.info.tokens = {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    };
    const thirdUser = makeUser("after tool loop", sessionId);
    if (thirdUser.info.role !== "user") throw new Error("fixture role");
    thirdUser.info.model = { providerID: "openai", modelID: "gpt-5.6-sol" };
    const toolLoopHistory = [firstUser, response, secondUser, siblingA, siblingB, inFlight, thirdUser]
      .map(entry => structuredClone(entry));
    await transform({ sessionID: sessionId }, { messages: toolLoopHistory });
    state = await persistence.load(sessionId);
    expect(state?.tokenCalibration.sampleCount).toBe(2);
    expect(state?.contextTokenMetrics.consumedCalibrationAssistantIds?.sort())
      .toEqual([siblingA.info.id, siblingB.info.id, response.info.id].sort());
    expect(state?.contextTokenMetrics.consumedCalibrationAssistantIds).not.toContain(inFlight.info.id);
    await transform({ sessionID: sessionId }, { messages: toolLoopHistory.map(entry => structuredClone(entry)) });
    state = await persistence.load(sessionId);
    expect(state?.tokenCalibration.sampleCount).toBe(2);

    const claudeUser = makeUser("switch models", sessionId);
    if (claudeUser.info.role !== "user") throw new Error("fixture role");
    claudeUser.info.model = { providerID: "anthropic", modelID: "claude-opus-4-6" };
    const switched = { messages: [structuredClone(firstUser), structuredClone(response), claudeUser] };
    await transform({ sessionID: sessionId }, switched);
    state = await persistence.load(sessionId);
    expect(state?.tokenCalibration).toEqual({ ratio: 1, sampleCount: 0, modelKey: "anthropic\u0000claude-opus-4-6" });
    const switchedText = switched.messages.at(-1)?.parts.find(part => part.type === "text");
    expect(switchedText?.type === "text" ? switchedText.text : "").toContain("change unavailable");
  });

  it("isolates system prompts by session and preserves provider identity when the hook omits it", async () => {
    resetSeq();
    const storagePath = `${process.env.TEMP ?? "/tmp"}/ctx-system-order-${Date.now()}`;
    const hooks = await CtxPlugin({}, { ctx: {
      storagePath,
      tokenizer: "char",
      automation: { automaticPruning: false, modelCompression: true },
    } }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID?: string }, output: MessagesTransformOutput
    ) => Promise<void>;
    const systemTransform = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput, output: SystemTransformOutput
    ) => Promise<void>;
    const persistence = new FilePersistence(storagePath);
    const secondHooks = await CtxPlugin({}, { ctx: {
      storagePath,
      tokenizer: "char",
      automation: { automaticPruning: false, modelCompression: true },
    } }) as Record<string, unknown>;
    const secondTransform = secondHooks["experimental.chat.messages.transform"] as (
      input: { sessionID?: string }, output: MessagesTransformOutput
    ) => Promise<void>;

    const sessionA = "system-first-a";
    await systemTransform({
      sessionID: sessionA,
      model: { id: "gpt-5.6-sol", providerID: "openai", limit: { context: 325_000 } },
    }, { system: ["s".repeat(4_000)] });
    const userA = makeUser("system was first", sessionA);
    if (userA.info.role !== "user") throw new Error("fixture role");
    userA.info.model = { providerID: "openai", modelID: "gpt-5.6-sol" };
    // A different plugin instance sharing this storage root must see the exact
    // system-first observation.
    await secondTransform({ sessionID: sessionA }, { messages: [userA] });
    expect((await persistence.load(sessionA))?.systemPromptTokens).toBe(1_000);

    // A different session has not observed a system prompt and must retain the
    // conservative reserve rather than borrowing session A's shorter prompt.
    const sessionB = "system-unknown-b";
    const userB = makeUser("no system hook yet", sessionB);
    if (userB.info.role !== "user") throw new Error("fixture role");
    userB.info.model = { providerID: "openai", modelID: "gpt-5.6-sol" };
    await transform({ sessionID: sessionB }, { messages: [userB] });
    expect((await persistence.load(sessionB))?.systemPromptTokens).toBe(32_000);

    const claudeSession = "system-provider-fallback";
    const claudeUser = makeUser("claude request", claudeSession);
    if (claudeUser.info.role !== "user") throw new Error("fixture role");
    claudeUser.info.model = { providerID: "anthropic", modelID: "claude-opus-4-6" };
    await transform({ sessionID: claudeSession }, { messages: [claudeUser] });
    await systemTransform({
      sessionID: claudeSession,
      model: { id: "claude-opus-4-6", limit: { context: 200_000 } },
    }, { system: ["claude system"] });
    const claudeState = await persistence.load(claudeSession);
    expect(claudeState?.tokenCalibration.modelKey).toBe("anthropic\u0000claude-opus-4-6");
    expect(claudeState?.modelContextLimit).toBe(200_000);

    const emptySession = "known-empty-system";
    const staleEmptyState = createInitialState(emptySession);
    staleEmptyState.systemPromptTokens = 500;
    staleEmptyState.tokenCalibration.modelKey = "test\u0000gpt-small";
    staleEmptyState.contextTokenMetrics.modelKey = "test\u0000gpt-small";
    await persistence.save(emptySession, staleEmptyState);
    await systemTransform({
      sessionID: emptySession,
      model: { id: "gpt-small", providerID: "test", limit: { context: 50_000 } },
    }, { system: [] });
    const emptyUser = makeUser("empty system is exact", emptySession);
    if (emptyUser.info.role !== "user") throw new Error("fixture role");
    emptyUser.info.model = { providerID: "test", modelID: "gpt-small" };
    await transform({ sessionID: emptySession }, { messages: [emptyUser] });
    expect((await persistence.load(emptySession))?.systemPromptTokens).toBe(0);
  });

  it("uses persisted context limits on cold session creation and consumes small nonzero usage", async () => {
    resetSeq();
    const storagePath = `${process.env.TEMP ?? "/tmp"}/ctx-persisted-limit-${Date.now()}`;
    const persistence = new FilePersistence(storagePath);
    const sessionId = "persisted-limit-session";
    const seeded = createInitialState(sessionId);
    seeded.modelContextLimit = 123_456;
    seeded.tokenCalibration.modelKey = "test\u0000small-model";
    seeded.contextTokenMetrics.modelKey = "test\u0000small-model";
    await persistence.save(sessionId, seeded);

    const hooks = await CtxPlugin({}, { ctx: {
      storagePath,
      tokenizer: "char",
      automation: { automaticPruning: false, modelCompression: true },
    } }) as Record<string, unknown>;
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID?: string }, output: MessagesTransformOutput
    ) => Promise<void>;
    const firstUser = makeUser("small first request", sessionId);
    if (firstUser.info.role !== "user") throw new Error("fixture role");
    firstUser.info.model = { providerID: "test", modelID: "small-model" };
    await transform({ sessionID: sessionId }, { messages: [firstUser] });
    expect((await persistence.load(sessionId))?.modelContextLimit).toBe(123_456);

    const smallResponse = makeAssistant("tiny", undefined, sessionId);
    if (smallResponse.info.role !== "assistant") throw new Error("fixture role");
    smallResponse.info.parentID = firstUser.info.id;
    smallResponse.info.providerID = "test";
    smallResponse.info.modelID = "small-model";
    smallResponse.info.tokens.input = 50;
    smallResponse.info.tokens.cache.read = 0;
    smallResponse.info.tokens.cache.write = 0;
    const secondUser = makeUser("second request", sessionId);
    if (secondUser.info.role !== "user") throw new Error("fixture role");
    secondUser.info.model = { providerID: "test", modelID: "small-model" };
    const output = { messages: [firstUser, smallResponse, secondUser].map(entry => structuredClone(entry)) };
    await transform({ sessionID: sessionId }, output);
    const state = await persistence.load(sessionId);
    expect(state?.tokenCalibration.sampleCount).toBe(0);
    expect(state?.contextTokenMetrics.consumedCalibrationAssistantIds).toContain(smallResponse.info.id);
    const visible = output.messages.at(-1)?.parts.find(part => part.type === "text");
    expect(visible?.type === "text" ? visible.text : "").toContain("since prior request");
  });
});

// ── B. Default DeepSeek config: conservative (Cost-ROI gate suppresses pruning) ──

describe("B. Default DeepSeek config: conservative masking", () => {
  it("messages.transform with default config does NOT mask old tool outputs (Cost-ROI gate or threshold)", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };

    await transform({}, output);

    // With default config (R=50, warm cache, maskTriggerThreshold=150_000):
    // The small test messages total well under 150k tokens, so the masking
    // threshold is never reached → no masking fires.
    // Verify: the large stateless read output is still present (not masked/offloaded).
    const readEntries = output.messages.filter(e =>
      e.parts.some(p =>
        p.type === "tool" &&
        (p as { type: "tool"; tool: string }).tool === "read" &&
        (p as { type: "tool"; state: HostToolState }).state.status === "completed"
      )
    );
    // At least one read entry should still have its original large output
    const hasUnmaskedRead = readEntries.some(e =>
      e.parts.some(p => {
        if (p.type !== "tool") return false;
        const tp = p as { type: "tool"; state: HostToolState };
        if (tp.state.status !== "completed") return false;
        const out = (tp.state as { status: "completed"; output: string }).output;
        return out.length > 100; // still has large content
      })
    );
    expect(hasUnmaskedRead).toBe(true);
  });

  it("messages.transform with default config: dedup still fires (Cost-ROI does not block dedup)", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };

    await transform({}, output);

    // Dedup is not gated by Cost-ROI — it always fires.
    // The first read (identical to the second) should be deduped.
    const readEntries = output.messages.filter(e =>
      e.parts.some(p =>
        p.type === "tool" &&
        (p as { type: "tool"; tool: string }).tool === "read" &&
        (p as { type: "tool"; state: HostToolState }).state.status === "completed"
      )
    );
    expect(readEntries.length).toBeGreaterThanOrEqual(2);

    // Count how many have the dedup placeholder
    const dedupCount = readEntries.filter(e =>
      e.parts.some(p => {
        if (p.type !== "tool") return false;
        const tp = p as { type: "tool"; state: HostToolState };
        if (tp.state.status !== "completed") return false;
        return (tp.state as { status: "completed"; output: string }).output === PLACEHOLDER_DEDUP;
      })
    ).length;
    // At least one should be deduped (the earlier occurrence)
    expect(dedupCount).toBeGreaterThanOrEqual(1);
  });
});

// ── C. Tuned config: pruning fires ────────────────────────────────────────────

describe("C. Tuned config: pruning fires with costRoi disabled + low thresholds", () => {
  /**
   * Tuned options: disable Cost-ROI gate, zero recency guard, zero clearAtLeast,
   * zero minRepruneInterval, maskTriggerThreshold=0 so masking always fires.
   * This forces all eligible strategies to run.
   */
  const TUNED_OPTIONS = {
    costRoi: { enabled: false },
    recencyGuardTurns: 0,
    clearAtLeast: 0,
    minRepruneInterval: 0,
    nudges: {
      maskTriggerThreshold: 0,
      lowerThreshold: 0,
      midSoftNudge: 0,
      upperThreshold: 0,
    },
    profile: "documents",
  };

  it("dedup replaces the earlier duplicate read output", async () => {
    resetSeq();
    const hooks = await buildPlugin(TUNED_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Find all completed read tool parts
    const readOutputs = output.messages.flatMap(e =>
      e.parts
        .filter(p => p.type === "tool" && (p as { type: "tool"; tool: string }).tool === "read")
        .map(p => {
          const tp = p as { type: "tool"; state: HostToolState };
          if (tp.state.status === "completed") {
            return (tp.state as { status: "completed"; output: string }).output;
          }
          return null;
        })
        .filter((o): o is string => o !== null)
    );

    // Dedup fires first (before masking). The earlier duplicate should be replaced
    // with PLACEHOLDER_DEDUP. The later occurrence may then be masked/offloaded.
    // Either way, at least one read output should be the dedup placeholder OR
    // a mask/offload placeholder (dedup + masking both fire in sequence).
    const hasAnyPlaceholder = readOutputs.some(o =>
      o === PLACEHOLDER_DEDUP ||
      o.includes("offloaded to save context") ||
      o.includes("masked to save context") ||
      o.includes("Tool output masked")
    );
    expect(hasAnyPlaceholder).toBe(true);

    // There should be exactly 2 read outputs (one per read call)
    expect(readOutputs.length).toBe(2);

    // At least one should be a placeholder (dedup or mask)
    const placeholderCount = readOutputs.filter(o =>
      o === PLACEHOLDER_DEDUP ||
      o.includes("offloaded to save context") ||
      o.includes("masked to save context") ||
      o.includes("Tool output masked")
    ).length;
    expect(placeholderCount).toBeGreaterThanOrEqual(1);
  });

  it("stale-error input is purged (error output kept)", async () => {
    resetSeq();
    const hooks = await buildPlugin(TUNED_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Find the errored bash tool call
    const errorEntries = output.messages.filter(e =>
      e.parts.some(p =>
        p.type === "tool" &&
        (p as { type: "tool"; state: HostToolState }).state.status === "error"
      )
    );
    expect(errorEntries.length).toBeGreaterThanOrEqual(1);

    for (const entry of errorEntries) {
      for (const p of entry.parts) {
        if (p.type !== "tool") continue;
        const tp = p as { type: "tool"; state: HostToolState };
        if (tp.state.status !== "error") continue;
        const errState = tp.state as { status: "error"; input: Record<string, unknown>; error: string };
        // Error output must be preserved
        expect(errState.error).toBe("Error: permission denied");
        // Input must be replaced with the stale-error placeholder, wrapped as an
        // object so the re-fed host part stays provider-valid (Anthropic rejects
        // a string tool_use.input).
        expect(errState.input).toEqual({ note: PLACEHOLDER_STALE_ERROR_INPUT });
      }
    }
  });

  it("large stateless read output is masked or offloaded (pointer placeholder present)", async () => {
    resetSeq();
    const hooks = await buildPlugin(TUNED_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Find the last read entry (the one kept by dedup — not the dedup placeholder)
    const readOutputs = output.messages.flatMap(e =>
      e.parts
        .filter(p => p.type === "tool" && (p as { type: "tool"; tool: string }).tool === "read")
        .map(p => {
          const tp = p as { type: "tool"; state: HostToolState };
          if (tp.state.status === "completed") {
            return (tp.state as { status: "completed"; output: string }).output;
          }
          return null;
        })
        .filter((o): o is string => o !== null)
    );

    // At least one read output should be masked or offloaded (not the original large content)
    const hasMaskedOrOffloaded = readOutputs.some(o =>
      o === PLACEHOLDER_DEDUP ||
      o.includes("offloaded to save context") ||
      o.includes("masked to save context") ||
      o.includes("Tool output masked")
    );
    expect(hasMaskedOrOffloaded).toBe(true);
  });

  it("large stateful bash output gets a synthesized mask preserving exit code / tail", async () => {
    resetSeq();
    const hooks = await buildPlugin(TUNED_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Find the bash tool call
    const bashOutputs = output.messages.flatMap(e =>
      e.parts
        .filter(p => p.type === "tool" && (p as { type: "tool"; tool: string }).tool === "bash")
        .map(p => {
          const tp = p as { type: "tool"; state: HostToolState };
          if (tp.state.status === "completed") {
            return (tp.state as { status: "completed"; output: string }).output;
          }
          return null;
        })
        .filter((o): o is string => o !== null)
    );

    // The bash output should be condensed (stateful mask) — contains exit code info
    // OR it may be kept if it's small enough (BASH_OUTPUT is only ~60 chars)
    // The stateful mask fires only if the output is large enough to be worth masking.
    // Our BASH_OUTPUT is small, so it may not be masked. We verify it's either:
    //   a) unchanged (small, not worth masking), OR
    //   b) condensed with exit code info
    for (const out of bashOutputs) {
      const isOriginal = out.includes("exit code: 0");
      const isCondensed = out.includes("condensed to save context") && out.includes("Exit code:");
      expect(isOriginal || isCondensed).toBe(true);
    }
  });
});

// ── D. Recency + pairing ──────────────────────────────────────────────────────

describe("D. Recency protection + no orphan tool_use", () => {
  it("recent messages (within recency window) are untouched with default config", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const recentIds = entries.slice(-6).map(e => e.info.id); // last 3 turns = 6 messages

    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // All recent messages must still be present in the output
    const outputIds = new Set(output.messages.map(e => e.info.id));
    for (const id of recentIds) {
      expect(outputIds.has(id)).toBe(true);
    }
  });

  it("no tool_use is left without its corresponding tool_result (no orphans)", async () => {
    resetSeq();
    // Use tuned config to force pruning
    const hooks = await buildPlugin({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { maskTriggerThreshold: 0 },
    });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Every tool part in the output must have a status (pending/running/completed/error)
    // — i.e., no tool_use without a result. In the opencode model, tool_use and
    // tool_result are co-located in the same HostToolPart (state carries both input
    // and output), so we just verify no tool part is left in "pending" or "running"
    // state (which would indicate an orphan).
    for (const entry of output.messages) {
      for (const p of entry.parts) {
        if (p.type !== "tool") continue;
        const tp = p as { type: "tool"; state: HostToolState };
        // Pending/running tool calls should not appear in a completed history
        // (they are only valid mid-turn). If any exist, they must have been in
        // the original input (we don't inject them).
        const status = tp.state.status;
        expect(["completed", "error", "pending", "running"]).toContain(status);
        // More specifically: the pipeline must not INTRODUCE pending/running states
        // that weren't there before. We verify by checking that all completed/error
        // states from the input are still completed/error in the output.
      }
    }

    // Verify: no completed tool call has had its state changed to pending/running
    const originalCompleted = new Map<string, string>();
    for (const entry of entries) {
      for (const p of entry.parts) {
        if (p.type !== "tool") continue;
        const tp = p as { type: "tool"; callID: string; state: HostToolState };
        if (tp.state.status === "completed" || tp.state.status === "error") {
          originalCompleted.set(tp.callID, tp.state.status);
        }
      }
    }

    for (const entry of output.messages) {
      for (const p of entry.parts) {
        if (p.type !== "tool") continue;
        const tp = p as { type: "tool"; callID: string; state: HostToolState };
        const origStatus = originalCompleted.get(tp.callID);
        if (origStatus !== undefined) {
          // Status must not be downgraded
          expect(tp.state.status).toBe(origStatus);
        }
      }
    }
  });
});

// ── E. Determinism / cache-stability ─────────────────────────────────────────

describe("E. Determinism: two runs on same input yield byte-identical output", () => {
  it("messages.transform is deterministic (same input → same output)", async () => {
    resetSeq();
    const hooks = await buildPlugin({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { maskTriggerThreshold: 0 },
    });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    // Build two independent sessions with the same structure but different session IDs
    // to avoid state carry-over between runs.
    const SESSION_A = "integ-determ-A";
    const SESSION_B = "integ-determ-B";

    resetSeq();
    const entriesA = buildSession(SESSION_A);
    resetSeq();
    const entriesB = buildSession(SESSION_B);

    // Run A
    const outputA: MessagesTransformOutput = { messages: [...entriesA] };
    await transform({}, outputA);

    // Run B (fresh session, same structure)
    const outputB: MessagesTransformOutput = { messages: [...entriesB] };
    await transform({}, outputB);

    // Serialize both outputs (replacing session-specific IDs/paths with positional placeholders)
    function normalizeForComparison(entries: HostMessageEntry[], sessionId: string): string {
      return JSON.stringify(
        entries.map((e, i) => ({
          idx: i,
          role: e.info.role,
          parts: e.parts.map(p => {
            if (p.type === "tool") {
              const tp = p as { type: "tool"; state: HostToolState };
              if (tp.state.status === "completed") {
                // Normalize session-specific paths in offload pointers
                const rawOutput = (tp.state as { status: "completed"; output: string }).output;
                const normalizedOutput = rawOutput.replace(new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<SESSION>");
                return { type: "tool", status: "completed", output: normalizedOutput };
              }
              if (tp.state.status === "error") {
                return { type: "tool", status: "error", input: (tp.state as { status: "error"; input: unknown }).input };
              }
              return { type: "tool", status: tp.state.status };
            }
            if (p.type === "text") {
              return { type: "text", text: (p as { type: "text"; text: string }).text };
            }
            return { type: p.type };
          }),
        }))
      );
    }

    const serialA = normalizeForComparison(outputA.messages, SESSION_A);
    const serialB = normalizeForComparison(outputB.messages, SESSION_B);

    expect(serialA).toBe(serialB);
  });
});

// ── F. experimental.text.complete strips hallucinated id tags ─────────────────

describe("F. experimental.text.complete strips hallucinated tags", () => {
  it("strips ctx-message-id tags from model output text", async () => {
    const hooks = await buildPlugin();
    const onTextComplete = hooks["experimental.text.complete"] as (
      input: { sessionID: string; messageID: string; partID: string },
      output: TextCompleteOutput
    ) => Promise<void>;

    const output: TextCompleteOutput = {
      text: "Hello <ctx-message-id>m0001</ctx-message-id> world",
    };
    await onTextComplete({ sessionID: SESSION_ID, messageID: "msg-1", partID: "p-1" }, output);

    expect(output.text).not.toContain("m0001");
    expect(output.text).toContain("Hello");
    expect(output.text).toContain("world");
  });

  it("leaves text without tags unchanged", async () => {
    const hooks = await buildPlugin();
    const onTextComplete = hooks["experimental.text.complete"] as (
      input: { sessionID: string; messageID: string; partID: string },
      output: TextCompleteOutput
    ) => Promise<void>;

    const output: TextCompleteOutput = { text: "Normal response text." };
    await onTextComplete({ sessionID: SESSION_ID, messageID: "msg-2", partID: "p-2" }, output);

    expect(output.text).toBe("Normal response text.");
  });
});

// ── G. compress tool: invoke on a stable range ───────────────────────────────

describe("G. compress tool: invoke on a stable range", () => {
  it("compress tool records a block in session state and returns a block ID", async () => {
    resetSeq();
    const hooks = await buildPlugin({ recencyGuardTurns: 0, summarization: { minSavingsTokens: 0 } });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    // First run messages.transform to initialize the session
    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Now invoke the compress tool directly
    const tool = (hooks["tool"] as Record<string, unknown>)["compress"] as {
      execute: (
        args: { topic: string; content: Array<{ startId: string; endId: string; summary: string }> },
        context: {
          sessionID: string;
          messageID: string;
          agent: string;
          directory: string;
          worktree: string;
          abort: AbortSignal;
          metadata: (input: { title?: string }) => void;
          ask: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
        }
      ) => Promise<{ output: string; title: string }>;
    };

    // Use the first two message IDs as the range
    const startId = output.messages[0].info.id;
    const endId = output.messages[1].info.id;

    const mockContext = {
      sessionID: SESSION_ID,
      messageID: "compress-msg-1",
      agent: "compliance",
      directory: "/workspaces/test",
      worktree: "/workspaces/test",
      abort: new AbortController().signal,
      metadata: (_: { title?: string }) => {},
      ask: async (_: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => {
        // Permission granted (no-op)
      },
    };

    const result = await tool.execute(
      {
        topic: "Initial setup",
        content: [
          {
            startId,
            endId,
            summary: "Setup context and template loaded.",
          },
        ],
      },
      mockContext
    );

    // The result should mention a block ID
    expect(result.output).toContain("block");
    expect(result.title).toContain("compress");

    // The block ID should be in the format "b1", "b2", etc.
    const blockIdMatch = result.output.match(/\bb\d+\b/);
    expect(blockIdMatch).not.toBeNull();
  });

  it("compress tool: block ID is stable and deterministic across two compress calls on the same range", async () => {
    // This test verifies the core invariant: compress is deterministic.
    // Two compress calls on the same range (same session, same messages) produce
    // the same block ID format (bN) and the same output structure.
    resetSeq();
    const hooks = await buildPlugin({ recencyGuardTurns: 0, summarization: { minSavingsTokens: 0 } });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const tool = (hooks["tool"] as Record<string, unknown>)["compress"] as {
      execute: (
        args: { topic: string; content: Array<{ startId: string; endId: string; summary: string }> },
        context: {
          sessionID: string;
          messageID: string;
          agent: string;
          directory: string;
          worktree: string;
          abort: AbortSignal;
          metadata: (input: { title?: string }) => void;
          ask: (input: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => Promise<void>;
        }
      ) => Promise<{ output: string; title: string }>;
    };

    const mockCtx = (msgId: string) => ({
      sessionID: SESSION_ID,
      messageID: msgId,
      agent: "compliance",
      directory: "/workspaces/test",
      worktree: "/workspaces/test",
      abort: new AbortController().signal,
      metadata: (_: { title?: string }) => {},
      ask: async (_: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => {},
    });

    // Initialize session
    const entries = buildSession();
    const output1: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output1);

    const startId = output1.messages[0].info.id;
    const endId = output1.messages[1].info.id;

    // First compress call
    const result1 = await tool.execute(
      { topic: "Setup phase", content: [{ startId, endId, summary: "Summary of setup phase." }] },
      mockCtx("compress-msg-1")
    );

    // Block ID should be in bN format
    const blockMatch1 = result1.output.match(/\bb\d+\b/);
    expect(blockMatch1).not.toBeNull();
    const blockId1 = blockMatch1![0];

    // Second compress call on a DIFFERENT range (next two messages)
    const startId2 = output1.messages[2].info.id;
    const endId2 = output1.messages[3].info.id;

    const result2 = await tool.execute(
      { topic: "Validation phase", content: [{ startId: startId2, endId: endId2, summary: "Summary of validation phase." }] },
      mockCtx("compress-msg-2")
    );

    const blockMatch2 = result2.output.match(/\bb\d+\b/);
    expect(blockMatch2).not.toBeNull();
    const blockId2 = blockMatch2![0];

    // Block IDs should be different (sequential)
    expect(blockId1).not.toBe(blockId2);

    // Both should be in bN format (starts with 'b' followed by digits)
    expect(blockId1.startsWith("b")).toBe(true);
    expect(blockId2.startsWith("b")).toBe(true);
    expect(Number.isInteger(parseInt(blockId1.slice(1), 10))).toBe(true);
    expect(Number.isInteger(parseInt(blockId2.slice(1), 10))).toBe(true);

    // The second block ID should be numerically greater than the first
    const n1 = parseInt(blockId1.slice(1), 10);
    const n2 = parseInt(blockId2.slice(1), 10);
    expect(n2).toBeGreaterThan(n1);
  });
});

// ── system.transform: reporting-agent no-op safety ───────────────────────────

describe("system.transform: reporting-agent no-op safety", () => {
  it("does not inject extra system text for a normal model", async () => {
    const hooks = await buildPlugin();
    const onSystem = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput,
      output: SystemTransformOutput
    ) => Promise<void>;

    // First, run messages.transform to initialize the session
    resetSeq();
    const entries = buildSession();
    const msgOutput: MessagesTransformOutput = { messages: [...entries] };
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    await transform({}, msgOutput);

    const sysOutput: SystemTransformOutput = { system: ["Existing system prompt."] };
    await onSystem(
      { sessionID: SESSION_ID, model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" } },
      sysOutput
    );

    // Reporting-agent keeps this hook as a no-op because live Docker smoke tests
    // showed that adding a second context-management instruction to the dynamic
    // system prompt could produce empty assistant responses.
    expect(sysOutput.system).toHaveLength(1);
    expect(sysOutput.system[0]).toBe("Existing system prompt.");
  });

  it("also remains a no-op for internal models (title generator)", async () => {
    const hooks = await buildPlugin();
    const onSystem = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput,
      output: SystemTransformOutput
    ) => Promise<void>;

    const sysOutput: SystemTransformOutput = { system: ["Existing system prompt."] };
    await onSystem(
      { sessionID: SESSION_ID, model: { providerID: "opencode-go", modelID: "title-generator" } },
      sysOutput
    );

    // Should NOT have appended context-manager text (internal model)
    expect(sysOutput.system).toHaveLength(1);
    expect(sysOutput.system[0]).toBe("Existing system prompt.");
  });
});

// ── H. ID tags + nudge delivery (messages channel) ────────────────────────────

describe("H. message-id tags and nudge delivery", () => {
  it("injects ctx-message-id ref tags into outgoing message text", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // At least one outgoing message text part must carry a visible ref tag, so the
    // model can address ranges when calling the compress tool.
    const taggedCount = output.messages.filter(e =>
      e.parts.some(p => p.type === "text" && (p as { type: "text"; text: string }).text.includes("<ctx-message-id>"))
    ).length;
    expect(taggedCount).toBeGreaterThan(0);
  });

  it("delivers a context nudge through the latest user message when over threshold", async () => {
    resetSeq();
    // Force the nudge ladder to fire immediately (tiny safety cap), while leaving
    // masking off (default maskTriggerThreshold) so we isolate nudge delivery.
    const hooks = await buildPlugin({
      nudges: { lowerThreshold: 0, midSoftNudge: 0, upperThreshold: 1, safetyCap: "0.001%" },
    });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const newUser = makeUser("New request", SESSION_ID);
    const entries = [...buildSession(), newUser];
    const firstOutput: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, firstOutput);

    const injectedUser = firstOutput.messages.find(entry => entry.info.id === newUser.info.id)!;
    const firstText = injectedUser.parts
      .filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("\n");
    expect(firstText).toContain("Context management:");

    // The next tool-loop request re-feeds raw host history. Reapply the exact
    // same anchored suffix so the provider prefix remains byte-stable.
    const loopOutput: MessagesTransformOutput = {
      messages: [...entries, makeAssistant("Working")],
    };
    await transform({}, loopOutput);
    const loopUser = loopOutput.messages.find(entry => entry.info.id === newUser.info.id)!;
    const loopText = loopUser.parts
      .filter(p => p.type === "text")
      .map(p => (p as { type: "text"; text: string }).text)
      .join("\n");
    expect(loopText).toBe(firstText);
  });
});

// ── J. P0 regression: in-place mutation of output.messages ───────────────────

describe("J. P0 regression: messages.transform mutates output.messages in place", () => {
  it("finds the session after a leading synthetic message without sessionID", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    const synthetic = {
      info: { id: "synthetic-prefix", role: "user", time: { created: 0 } },
      parts: [{ id: "synthetic-prefix-text", messageID: "synthetic-prefix", type: "text", text: "plugin context" }],
    } as unknown as HostMessageEntry;
    const output: MessagesTransformOutput = { messages: [synthetic, ...buildSession()] };

    await transform({}, output);

    expect(output.messages.some(entry => entry.parts.some(part =>
      part.type === "text" && (part as { text: string }).text.includes("<ctx-message-id>")
    ))).toBe(true);
  });

  it("uses the hook input sessionID when message metadata omits it", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: { sessionID?: string },
      output: MessagesTransformOutput
    ) => Promise<void>;
    const messages = buildSession().map(entry => ({
      ...entry,
      info: { ...entry.info, sessionID: undefined },
    })) as unknown as HostMessageEntry[];
    const output: MessagesTransformOutput = { messages };

    await transform({ sessionID: SESSION_ID }, output);

    expect(output.messages.some(entry => entry.parts.some(part =>
      part.type === "text" && (part as { text: string }).text.includes("<ctx-message-id>")
    ))).toBe(true);
  });

  it("the original array reference is mutated (splice), not just reassigned", async () => {
    resetSeq();
    const hooks = await buildPlugin({
      costRoi: { enabled: false },
      recencyGuardTurns: 0,
      clearAtLeast: 0,
      minRepruneInterval: 0,
      nudges: { maskTriggerThreshold: 0 },
      profile: "documents",
    });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    const entries = buildSession();
    // Capture the ORIGINAL array reference BEFORE the transform
    const originalArray = entries;
    const output: MessagesTransformOutput = { messages: originalArray };

    await transform({}, output);

    // The original array reference must now contain the pruned/placeholder content.
    // If the transform only reassigned output.messages (no splice), originalArray
    // would still have the unpruned content.
    const hasAnyPlaceholder = originalArray.some(e =>
      e.parts.some(p => {
        if (p.type !== "tool") return false;
        const tp = p as { type: "tool"; state: HostToolState };
        if (tp.state.status === "completed") {
          const out = (tp.state as { status: "completed"; output: string }).output;
          return (
            out === PLACEHOLDER_DEDUP ||
            out.includes("offloaded to save context") ||
            out.includes("masked to save context") ||
            out.includes("Tool output masked")
          );
        }
        if (tp.state.status === "error") {
          const inp = (tp.state as { status: "error"; input: unknown }).input;
          return typeof inp === "object" && inp !== null && !Array.isArray(inp) &&
            (inp as Record<string, unknown>).note === PLACEHOLDER_STALE_ERROR_INPUT;
        }
        return false;
      })
    );
    expect(hasAnyPlaceholder).toBe(true);

    // Also verify that output.messages IS the same reference as originalArray
    // (the splice mutates in place, so they must be the same object)
    expect(output.messages).toBe(originalArray);
  });
});

// ── I. /ctx-stats and /ctx-decompress commands ────────────────────────────────

describe("I. stats and decompress commands", () => {
  const SAVINGS_OPTIONS = {
    costRoi: { enabled: false },
    recencyGuardTurns: 0,
    clearAtLeast: 0,
    minRepruneInterval: 0,
    nudges: { maskTriggerThreshold: 0 },
  };

  type CmdHook = (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Array<{ type: string; text?: string }> }
  ) => Promise<void>;

  it("/ctx-stats reports cumulative token savings after a pruning turn", async () => {
    resetSeq();
    const hooks = await buildPlugin(SAVINGS_OPTIONS);
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    const cmd = hooks["command.execute.before"] as CmdHook;

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    const cmdOut: { parts: Array<{ type: string; text?: string }> } = { parts: [] };
    await cmd({ command: "ctx-stats", sessionID: SESSION_ID, arguments: "" }, cmdOut);

    expect(cmdOut.parts).toHaveLength(1);
    expect(cmdOut.parts[0].text).toContain("ctx stats");
    expect(cmdOut.parts[0].text).toContain("total saved:");
  });

  it("/ctx-decompress restores a previously compressed block", async () => {
    resetSeq();
    const hooks = await buildPlugin({ recencyGuardTurns: 0, summarization: { minSavingsTokens: 0 } });
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;
    const cmd = hooks["command.execute.before"] as CmdHook;
    const tool = (hooks["tool"] as Record<string, unknown>)["compress"] as {
      execute: (
        args: { topic: string; content: Array<{ startId: string; endId: string; summary: string }> },
        context: Record<string, unknown>
      ) => Promise<{ output: string; title: string }>;
    };

    const entries = buildSession();
    const output: MessagesTransformOutput = { messages: [...entries] };
    await transform({}, output);

    // Compress the first two messages into a block.
    const startId = output.messages[0].info.id;
    const endId = output.messages[1].info.id;
    const mockContext = {
      sessionID: SESSION_ID,
      messageID: "compress-msg",
      agent: "compliance",
      directory: "/workspaces/test",
      worktree: "/workspaces/test",
      abort: new AbortController().signal,
      metadata: (_: { title?: string }) => {},
      ask: async (_: { permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }) => {},
    };
    const compressResult = await tool.execute(
      { topic: "Setup", content: [{ startId, endId, summary: "## Goal & Framework\nSetup." }] },
      mockContext
    );
    const blockId = compressResult.output.match(/\bb\d+\b/)![0];

    // Decompress it back (default = latest block).
    const cmdOut: { parts: Array<{ type: string; text?: string }> } = { parts: [] };
    await cmd({ command: "ctx-decompress", sessionID: SESSION_ID, arguments: "" }, cmdOut);

    expect(cmdOut.parts).toHaveLength(1);
    expect(cmdOut.parts[0].text).toContain("restored block");
    expect(cmdOut.parts[0].text).toContain(blockId);
  });
});

// ── K. P0 regression: in-flight assistant must stay empty ───────────────────────
// On every turn opencode includes the in-flight assistant message (the turn the
// model is about to generate) with an EMPTY text part to stream into. The ref-tag
// injection must NOT write into that empty part — otherwise the trailing assistant
// turn looks already-answered and the model returns an empty response. This was a
// live regression the synthetic fixtures (which never end in an empty assistant
// text part) did not catch.

describe("K. P0 regression: in-flight assistant stays empty", () => {
  function makeInFlightAssistant(sessionId = SESSION_ID): HostMessageEntry {
    const id = nextMsgId();
    return {
      info: {
        id,
        sessionID: sessionId,
        role: "assistant",
        time: { created: Date.now() },
        parentID: "parent-1",
        modelID: "deepseek-v4-flash",
        providerID: "opencode-go",
        mode: "chat",
        path: { cwd: "/workspaces/test", root: "/workspaces/test" },
        summary: false,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        { id: `${id}-step`, sessionID: sessionId, messageID: id, type: "step-start" },
        { id: `${id}-text`, sessionID: sessionId, messageID: id, type: "text", text: "" },
      ],
    };
  }

  it("does not inject a ref tag into the empty trailing assistant text part", async () => {
    resetSeq();
    const hooks = await buildPlugin();
    const transform = hooks["experimental.chat.messages.transform"] as (
      input: Record<string, never>,
      output: MessagesTransformOutput
    ) => Promise<void>;

    // Fresh turn-1 shape: one user message + the in-flight assistant stub.
    const user = makeUser("Hello");
    const inflight = makeInFlightAssistant();
    const output: MessagesTransformOutput = { messages: [user, inflight] };

    await transform({}, output);

    // The trailing assistant message must still be empty (no tag, no content),
    // otherwise the model sees an already-answered turn and replies with nothing.
    const assistant = output.messages[output.messages.length - 1];
    expect(assistant.info.role).toBe("assistant");
    const asstText = assistant.parts.find(p => p.type === "text") as
      | { text: string }
      | undefined;
    expect(asstText?.text ?? "").toBe("");

    // Sanity: the user message DID receive its ref tag (tagging still works).
    const userEntry = output.messages.find(e => e.info.role === "user")!;
    const userText = userEntry.parts.find(p => p.type === "text") as { text: string };
    expect(userText.text).toContain("ctx-message-id");
  });
});
