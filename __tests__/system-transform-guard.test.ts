// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Regression test for the system.transform "empty turn" bug.
//
// The vendored opencode engine invokes experimental.chat.system.transform with a
// `Provider.Model` whose model id field is `id` (NOT `modelID`) and whose provider
// id is `providerID`
// (vendor/opencode/packages/opencode/src/provider/provider.ts:1018). The earlier
// adapter read `model.modelID` (undefined at runtime) and called `.toLowerCase()`
// on it, which THREW inside the hook and aborted the whole turn — every assistant
// response came back empty with no surfaced error.
//
// These tests pin the contract: onSystemTransform must NEVER throw and must leave
// output.system untouched, regardless of which id fields the host supplies.

import { describe, it, expect } from "bun:test";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { isInternalModel } from "../adapters/opencode/config.js";
import type {
  HostMessageEntry,
  MessagesTransformOutput,
  SystemTransformInput,
  SystemTransformOutput,
} from "../adapters/opencode/host-types.js";

const SESSION_ID = "guard-test-session-001";

async function buildPlugin() {
  const tmpDir = `${process.env.TEMP ?? "/tmp"}/ctx-guard-test-${Date.now()}`;
  const hooks = (await CtxPlugin({}, { ctx: { storagePath: tmpDir } })) as Record<string, unknown>;
  return hooks;
}

function makeUserEntry(text: string): HostMessageEntry {
  const id = "guard-msg-0001";
  return {
    info: {
      id,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: Date.now() },
      agent: "compliance",
      model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    },
    parts: [{ id: `${id}-p`, sessionID: SESSION_ID, messageID: id, type: "text", text }],
  };
}

async function initSession(hooks: Record<string, unknown>): Promise<void> {
  const transform = hooks["experimental.chat.messages.transform"] as (
    input: Record<string, never>,
    output: MessagesTransformOutput
  ) => Promise<void>;
  const output: MessagesTransformOutput = { messages: [makeUserEntry("Hello.")] };
  await transform({}, output);
}

describe("system.transform: undefined-modelID guard (empty-turn regression)", () => {
  it("does NOT throw when the model uses the real vendored shape (`id`, no `modelID`)", async () => {
    const hooks = await buildPlugin();
    await initSession(hooks);
    const onSystem = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput,
      output: SystemTransformOutput
    ) => Promise<void>;

    const sysOutput: SystemTransformOutput = { system: ["Existing system prompt."] };

    // The real Provider.Model: `id` holds the model id, there is NO `modelID`.
    let threw = false;
    try {
      await onSystem(
        {
          sessionID: SESSION_ID,
          model: { id: "deepseek-v4-flash", providerID: "opencode-go", limit: { context: 1_000_000 } },
        },
        sysOutput
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // Output-safe: the hook must not empty or rewrite the system prompt.
    expect(sysOutput.system).toHaveLength(1);
    expect(sysOutput.system[0]).toBe("Existing system prompt.");
  });

  it("does NOT throw when the model object has no id fields at all", async () => {
    const hooks = await buildPlugin();
    await initSession(hooks);
    const onSystem = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput,
      output: SystemTransformOutput
    ) => Promise<void>;

    const sysOutput: SystemTransformOutput = { system: ["Existing system prompt."] };

    let threw = false;
    try {
      await onSystem({ sessionID: SESSION_ID, model: {} }, sysOutput);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    expect(sysOutput.system).toHaveLength(1);
    expect(sysOutput.system[0]).toBe("Existing system prompt.");
  });

  it("still detects internal models via the resolved `id` field", async () => {
    const hooks = await buildPlugin();
    await initSession(hooks);
    const onSystem = hooks["experimental.chat.system.transform"] as (
      input: SystemTransformInput,
      output: SystemTransformOutput
    ) => Promise<void>;

    const sysOutput: SystemTransformOutput = { system: ["Existing system prompt."] };

    let threw = false;
    try {
      await onSystem(
        { sessionID: SESSION_ID, model: { id: "title-generator", providerID: "opencode-go" } },
        sysOutput
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    expect(sysOutput.system).toHaveLength(1);
    expect(sysOutput.system[0]).toBe("Existing system prompt.");
  });
});

describe("isInternalModel: type-guard against undefined", () => {
  it("returns false for undefined instead of throwing", () => {
    expect(() => isInternalModel(undefined)).not.toThrow();
    expect(isInternalModel(undefined)).toBe(false);
  });

  it("still classifies real model ids correctly", () => {
    expect(isInternalModel("deepseek-v4-flash")).toBe(false);
    expect(isInternalModel("title-generator")).toBe(true);
    expect(isInternalModel("summarize-agent")).toBe(true);
  });
});
