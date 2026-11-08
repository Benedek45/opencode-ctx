// PolyForm Noncommercial License 1.0.0 — see LICENSE
// OpenCode V2 context/session-history ↔ V1 host entry mapping.

import { describe, expect, it } from "bun:test";
import {
  contextFromHost,
  contextToHost,
  createdAtFromId,
  sessionHistoryToHost,
  type V2Message,
} from "../adapters/opencode-v2/map.js";
import type { HostToolPart } from "../adapters/opencode/host-types.js";
import { toNeutral } from "../adapters/opencode/map.js";
import { estimateContextTokens } from "../core/tokens.js";
import { CharTokenizer } from "../services/tokenizer.js";

/** Stand-in for the host's `Schema.Class` Message: replacements must use its constructor. */
class FakeMessage implements V2Message {
  readonly id?: string;
  readonly role!: string;
  readonly content!: V2Message["content"];
  constructor(input: Record<string, unknown>) {
    Object.assign(this, input);
  }
}

const msg = (fields: Record<string, unknown>) => new FakeMessage(fields);
const id = (ms: number, counter = 1) => `msg_${((BigInt(ms) * 0x1000n + BigInt(counter)) & 0xffffffffffffn).toString(16).padStart(12, "0")}abcdefghijklmn`;

const T0 = Date.now() - 60_000;
const U1 = id(T0), A1 = id(T0 + 10), U2 = id(T0 + 20), A2 = id(T0 + 30);

function conversation(): V2Message[] {
  return [
    msg({ id: U1, role: "user", content: [{ type: "text", text: "read the file" }] }),
    msg({
      id: A1,
      role: "assistant",
      content: [
        { type: "reasoning", text: "thinking", providerMetadata: { openai: { itemId: "rs_1" } } },
        { type: "tool-call", id: "call_1", name: "read", input: { filePath: "/a.ts" }, providerMetadata: { openai: { itemId: "fc_1" } } },
      ],
    }),
    msg({ role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "FILE CONTENTS" } }] }),
    msg({ role: "system", content: [{ type: "text", text: "instructions changed" }] }),
    msg({ id: U2, role: "user", content: [{ type: "text", text: "thanks" }, { type: "media", media: { source: { type: "url", url: "https://x/y.png" } } }] }),
    msg({ id: A2, role: "assistant", content: [{ type: "text", text: "done" }] }),
  ];
}

describe("opencode v2 context mapping", () => {
  it("archives opaque parts without counting base64 as model text, prefers live stash and rejects legacy missing payloads", () => {
    const media = { type: "media", media: { source: { type: "base64", data: "YQ==".repeat(10_000) } } };
    const plan = contextToHost([msg({ id: U1, role: "user", content: [{ type: "text", text: "hello" }, media] })], { sessionID: "ses_1" });
    const archived = JSON.parse(JSON.stringify(plan.entries));
    const fresh = contextToHost([], { sessionID: "ses_1" });
    expect(contextFromHost(archived, fresh)[0].content[1]).toEqual(media);
    expect(estimateContextTokens(toNeutral(archived), new CharTokenizer())).toBeLessThan(100);
    archived[0].parts[1].ctxV2.payload.part.media.source.data = "archive changed";
    expect(contextFromHost(archived, plan)[0].content[1]).toBe(media);
    delete archived[0].parts[1].ctxV2;
    expect(() => contextFromHost(archived, fresh)).toThrow("V2 recovery payload unavailable");
  });

  it("retains native prompt files and assistant opaque parts for fail-closed handoff validation", () => {
    const entries = sessionHistoryToHost([{ id: U1, type: "user", text: "", files: [{ uri: "file:///image.png", mime: "image/png" }] },
      { id: A1, type: "assistant", content: [{ type: "effort", value: "high" }] }], "ses_1");
    expect(entries[0].parts[0].type).toBe("v2-history-files");
    expect(entries[1].parts[0].type).toBe("v2-effort");
  });
  it("decodes creation time from V2 ascending ids", () => {
    expect(createdAtFromId(U1)).toBe(T0);
    expect(createdAtFromId("not-an-id")).toBeUndefined();
  });

  it("maps messages to V1 entries with paired tool state and stable ids", () => {
    const plan = contextToHost(conversation(), { sessionID: "ses_1", model: { id: "gpt-x", providerID: "openai" } });
    expect(plan.entries.map(entry => [entry.info.id, entry.info.role])).toEqual([
      [U1, "user"], [A1, "assistant"], [U2, "user"], [A2, "assistant"],
    ]);
    const tool = plan.entries[1].parts.find(part => part.type === "tool") as HostToolPart;
    expect(tool.callID).toBe("call_1");
    expect(tool.tool).toBe("read");
    expect(tool.state).toMatchObject({ status: "completed", input: { filePath: "/a.ts" }, output: "FILE CONTENTS" });
    expect(plan.entries[1].info).toMatchObject({ parentID: U1, providerID: "openai", modelID: "gpt-x" });
    expect(plan.entries[0].info.time.created).toBe(T0);
    expect(plan.passthrough.map(item => item.index)).toEqual([3]);
  });

  it("returns the original message objects when nothing changed", () => {
    const original = conversation();
    const plan = contextToHost(original, { sessionID: "ses_1" });
    const rebuilt = contextFromHost(structuredClone(plan.entries), plan);
    expect(rebuilt.length).toBe(original.length);
    rebuilt.forEach((message, index) => expect(message).toBe(original[index]));
  });

  it("rewrites only the masked tool output and keeps provider metadata", () => {
    const original = conversation();
    const plan = contextToHost(original, { sessionID: "ses_1" });
    const entries = structuredClone(plan.entries);
    const tool = entries[1].parts.find(part => part.type === "tool") as HostToolPart;
    tool.state = { ...tool.state, output: "[masked]" } as HostToolPart["state"];
    const rebuilt = contextFromHost(entries, plan);

    expect(rebuilt.length).toBe(original.length);
    expect(rebuilt[0]).toBe(original[0]);
    const assistant = rebuilt[1];
    expect(assistant).toBeInstanceOf(FakeMessage);
    expect(assistant.id).toBe(A1);
    expect(assistant.content[0]).toBe(original[1].content[0]);
    expect(assistant.content[1]).toBe(original[1].content[1]);
    const toolMessage = rebuilt[2];
    expect(toolMessage).toBeInstanceOf(FakeMessage);
    expect(toolMessage.role).toBe("tool");
    expect(toolMessage.content[0]).toMatchObject({ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "[masked]" } });
    expect(rebuilt[3]).toBe(original[3]);
  });

  it("drops a removed assistant together with its tool results and keeps passthrough order", () => {
    const original = conversation();
    const plan = contextToHost(original, { sessionID: "ses_1" });
    const summary = {
      info: { id: "__summary_b1", sessionID: "ses_1", role: "user" as const, time: { created: T0 }, agent: "ctx-compress", model: { providerID: "ctx", modelID: "compress" } },
      parts: [{ id: "__summary_b1-text", sessionID: "ses_1", messageID: "__summary_b1", type: "text" as const, text: "SUMMARY" }],
    };
    const entries = [summary, ...structuredClone(plan.entries.slice(2))];
    const rebuilt = contextFromHost(entries, plan);
    expect(rebuilt.map(message => [message.id, message.role])).toEqual([
      ["__summary_b1", "user"], [undefined, "system"], [U2, "user"], [A2, "assistant"],
    ]);
    expect(rebuilt[0]).toBeInstanceOf(FakeMessage);
    expect(rebuilt[0].content).toEqual([{ type: "text", text: "SUMMARY" }]);
    expect(rebuilt.some(message => message.role === "tool")).toBe(false);
  });

  it("appends nudge text to a user message while keeping non-text parts", () => {
    const original = conversation();
    const plan = contextToHost(original, { sessionID: "ses_1" });
    const entries = structuredClone(plan.entries);
    const text = entries[2].parts[0] as { text: string };
    text.text += "\n<ctx-nudge/>";
    const rebuilt = contextFromHost(entries, plan);
    const user = rebuilt.find(message => message.id === U2)!;
    expect(user).not.toBe(original[4]);
    expect(user.content[0]).toEqual({ type: "text", text: "thanks\n<ctx-nudge/>" });
    expect(user.content[1]).toBe(original[4].content[1]);
  });

  it("builds fresh call/result pairs for entries restored from archives", () => {
    const plan = contextToHost(conversation().slice(4), { sessionID: "ses_1" });
    const restored = {
      info: { id: "msg_restored", sessionID: "ses_1", role: "assistant" as const, time: { created: 1 }, parentID: "", modelID: "", providerID: "", mode: "", path: { cwd: "", root: "" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      parts: [{ id: "p1", sessionID: "ses_1", messageID: "msg_restored", type: "tool", callID: "call_9", tool: "grep", state: { status: "completed", input: { q: "x" }, output: "hit", title: "grep", time: { start: 1, end: 1 } } }],
    };
    const rebuilt = contextFromHost([restored, ...plan.entries], plan);
    expect(rebuilt[0]).toMatchObject({ id: "msg_restored", role: "assistant", content: [{ type: "tool-call", id: "call_9", name: "grep", input: { q: "x" } }] });
    expect(rebuilt[1]).toMatchObject({ role: "tool", content: [{ type: "tool-result", id: "call_9", result: { type: "text", value: "hit" } }] });
  });

  it("treats id-less and duplicate messages as passthrough", () => {
    const messages = [
      msg({ role: "user", content: [{ type: "text", text: "plan reminder" }] }),
      msg({ id: U1, role: "user", content: [{ type: "text", text: "a" }] }),
      msg({ id: U1, role: "user", content: [{ type: "text", text: "dup" }] }),
    ];
    const plan = contextToHost(messages, { sessionID: "ses_1" });
    expect(plan.entries.length).toBe(1);
    expect(plan.passthrough.map(item => item.index)).toEqual([0, 2]);
    const rebuilt = contextFromHost(plan.entries, plan);
    rebuilt.forEach((message, index) => expect(message).toBe(messages[index]));
  });
});

describe("opencode v2 session history mapping", () => {
  it("matches context mapping ids, call ids and tool output", () => {
    const history = [
      { id: U1, type: "user", time: { created: T0 }, text: "read the file" },
      {
        id: A1, type: "assistant", time: { created: T0 + 10, completed: T0 + 11 }, agent: "build",
        model: { id: "gpt-x", providerID: "openai" }, finish: "tool-calls",
        tokens: { input: 100, output: 5, reasoning: 0, cache: { read: 50, write: 0 } },
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { filePath: "/a.ts" }, content: [{ type: "text", text: "FILE CONTENTS" }] }, time: { created: T0 } },
          { type: "tool", id: "call_2", name: "remote_submit", state: { status: "running", input: { task: "x" }, metadata: {} }, time: { created: T0 } },
        ],
      },
      { id: "msg_sys", type: "system", time: { created: T0 + 12 }, text: "ignored" },
      { id: U2, type: "synthetic", time: { created: T0 + 20 }, text: "[ctx] stats" },
    ];
    const entries = sessionHistoryToHost(history, "ses_1", "/proj");
    expect(entries.map(entry => [entry.info.id, entry.info.role])).toEqual([[U1, "user"], [A1, "assistant"], [U2, "user"]]);
    const assistant = entries[1];
    expect(assistant.info).toMatchObject({ parentID: U1, providerID: "openai", modelID: "gpt-x", finish: "tool-calls", time: { completed: T0 + 11 } });
    expect((assistant.info as { tokens: unknown }).tokens).toEqual({ input: 100, output: 5, reasoning: 0, cache: { read: 50, write: 0 } });
    const tools = assistant.parts.filter(part => part.type === "tool") as HostToolPart[];
    expect(tools[0]).toMatchObject({ callID: "call_1", state: { status: "completed", output: "FILE CONTENTS" } });
    expect(tools[1]).toMatchObject({ callID: "call_2", tool: "remote_submit", state: { status: "running" } });

    const contextPlan = contextToHost(conversation(), { sessionID: "ses_1" });
    const contextTool = contextPlan.entries[1].parts.find(part => part.type === "tool") as HostToolPart;
    expect(contextTool.callID).toBe(tools[0].callID);
    expect((contextTool.state as { output: string }).output).toBe((tools[0].state as { output: string }).output);
  });

  it("produces unique part ids accepted by the V1 handoff validator", () => {
    const entries = sessionHistoryToHost([
      { id: U1, type: "user", time: { created: T0 }, text: "a" },
      { id: A1, type: "assistant", time: { created: T0 + 1 }, model: { id: "m", providerID: "p" }, content: [{ type: "text", text: "b" }, { type: "text", text: "c" }] },
    ], "ses_1");
    const ids = entries.flatMap(entry => entry.parts.map(part => part.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of entries) for (const part of entry.parts) {
      expect(part.sessionID).toBe("ses_1");
      expect(part.messageID).toBe(entry.info.id);
    }
  });
});
