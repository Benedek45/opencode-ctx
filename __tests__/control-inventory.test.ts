// PolyForm Noncommercial License 1.0.0 — see LICENSE
import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CtxPlugin } from "../adapters/opencode/plugin.js";
import { startControlServer, RevisionConflictError } from "../adapters/opencode/control-server.js";
import { CONTROL_UI_HTML } from "../adapters/opencode/control-ui.js";
import type { ControlPlaneBackend, ControlInventory, ControlSessionSnapshot, ControlViewOptions, ControlDetail } from "../adapters/opencode/control-server.js";
import type { HostMessageEntry, MessagesTransformOutput } from "../adapters/opencode/host-types.js";

describe("bounded control inventory", () => {
  it("embeds parseable browser code that requests paged inventory and exact detail", () => {
    const script = CONTROL_UI_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
    expect(script).toContain("?view=inventory");
    expect(script).toContain("/detail");
    expect(script).not.toContain("snapshot.rawHostHistory");
    expect(script).not.toContain("snapshot.projectedContext");
    expect(script).not.toContain("snapshot.automaticProjectedContext");
  });

  it("validates paging, revision, detail auth and forwards lean mutation response options", async () => {
    const calls: ControlViewOptions[] = [];
    let revision = 2;
    const inventory = (options: ControlViewOptions): ControlInventory => ({
      sessionId: "s", revision, view: "inventory", generation: "a".repeat(36), messageOffset: options.messageOffset,
      blockOffset: options.blockOffset, overrideOffset: options.overrideOffset, limit: options.limit,
      messageCount: 120, blockCount: 4, excludedOverrideCount: 0,
      hotTokenCount: 500, messages: [], blocks: [], excludedOverrides: [], settings: {}, effectiveSettings: {}, stats: {},
      pendingProjectionEdit: false, updatedAt: 0,
    });
    const full = (): ControlSessionSnapshot => ({
      sessionId: "s", revision, rawHostHistory: [{ parts: [{ text: "exact" }] }],
      projectedContext: [], blocks: [], settings: {}, stats: {},
    });
    const backend: ControlPlaneBackend = {
      async listSessions() { return []; },
      async getSession(_id, options) {
        if (options?.revision !== undefined && options.revision !== revision) throw new RevisionConflictError("stale", options.revision, revision);
        if (options) { calls.push(options); return inventory(options); }
        return full();
      },
      async getMessageDetail(_id, id, expected): Promise<ControlDetail> {
        if (expected !== revision) throw new RevisionConflictError("stale", expected, revision);
        return { sessionId: "s", revision, id, message: { parts: [{ text: "exact message" }] } };
      },
      async getBlockDetail(_id, id, expected): Promise<ControlDetail> {
        if (expected !== revision) throw new RevisionConflictError("stale", expected, revision);
        return { sessionId: "s", revision, id, block: { blockId: id, status: "active", summaryText: "exact summary" } };
      },
      async updateSettings(_id, _rev, _settings, options) { revision++; if (options) { calls.push(options); return inventory(options); } return full(); },
      async putMessageOverride() { return full(); },
      async deleteMessageOverride() { return full(); },
      async applyProjectionEdits(_id, _rev, _edits, options) { revision++; if (options) { calls.push(options); return inventory(options); } return full(); },
      async performBlockAction(_id, _bid, _rev, _action, options) { revision++; if (options) { calls.push(options); return inventory(options); } return full(); },
      async searchArchivedContent() { return { items: [] }; },
    };
    const server = await startControlServer({ backend });
    try {
      const headers = { Authorization: `Bearer ${server.token}` };
      const url = server.origin + "/api/sessions/s";
      const get = (path: string) => fetch(url + path, { headers });
      const initial = await get("");
      expect((await initial.json() as any).data.rawHostHistory[0].parts[0].text).toBe("exact");
      const page = await get("?view=inventory&messageOffset=50&blockOffset=2&limit=100");
      const paged = (await page.json() as any).data;
      expect([paged.revision, paged.messageOffset, paged.blockOffset, paged.limit, paged.messageCount]).toEqual([2, 50, 2, 100, 120]);
      for (const query of ["limit=0", "limit=101", "limit=2.5", "messageOffset=-1", "blockOffset=999999999999999999", "limit=1&limit=2", "extra=1", "revision=-1", "generation=invalid"]) {
        expect((await get("?view=inventory&" + query)).status).toBe(400);
      }
      expect((await get("?view=inventory&revision=1")).status).toBe(409);
      expect((await fetch(url + "/messages/m1?revision=2")).status).toBe(401);
      expect((await get("/messages/m1")).status).toBe(400);
      expect((await get("/messages/m1?revision=1")).status).toBe(409);
      expect((await (await get("/messages/m1?revision=2")).json() as any).data.message.parts[0].text).toBe("exact message");
      expect((await (await get("/blocks/b1/detail?revision=2")).json() as any).data.block.summaryText).toBe("exact summary");
      const mutate = async (path: string, method: string, body: object) => fetch(url + path + "?view=inventory", {
        method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ revision, ...body }),
      });
      for (const [path, method, body] of [
        ["/projection", "POST", { edits: [{ messageId: "m1", override: { mode: "exclude" } }] }],
        ["/settings", "PATCH", { settings: {} }],
        ["/blocks/b1/actions", "POST", { action: "demote" }],
      ] as const) {
        const response = await mutate(path, method, body);
        expect(response.status).toBe(200);
        const result = (await response.json() as any).data;
        expect([result.view, result.revision]).toEqual(["inventory", revision]);
      expect([calls.at(-1)?.messageOffset, calls.at(-1)?.blockOffset, calls.at(-1)?.overrideOffset, calls.at(-1)?.limit]).toEqual([0, 0, 0, 50]);
      }
      expect((await get("?view=inventory&revision=2")).status).toBe(409);
    } finally { await server.close(); }
  });

  it("keeps large raw tool output out of paged responses but serves exact explicit detail", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ctx-inventory-workspace-"));
    const storagePath = await mkdtemp(join(tmpdir(), "ctx-inventory-store-"));
    const sessionID = "inventory-large";
    const hooks = await CtxPlugin({ directory: workspace, worktree: workspace }, {
      ctx: { storagePath, compressionRecencyRequests: 0, summarization: { minSavingsTokens: 0 }, controlServer: { enabled: true, port: 0, openBrowser: false },
        nudges: { lowerThreshold: 10000000, midSoftNudge: 10000000, upperThreshold: 10000000, maskTriggerThreshold: 10000000 } },
    }) as Record<string, any>;
    const user = (id: string, created: number): HostMessageEntry => ({
      info: { id, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "test", modelID: "test" } },
      parts: [{ id: id + "-text", sessionID, messageID: id, type: "text", text: "instruction " + id }],
    });
    const payload = "X".repeat(3_000_000);
    const assistant: HostMessageEntry = {
      info: { id: "huge", sessionID, role: "assistant", time: { created: 2 }, parentID: "u0", providerID: "test",
        modelID: "test", mode: "chat", path: { cwd: workspace, root: workspace }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
      parts: [{ id: "huge-part", sessionID, messageID: "huge", type: "tool", callID: "huge-call", tool: "read",
        state: { status: "completed", input: {}, output: payload, title: "read", time: { start: 1, end: 2 } } }],
    };
    const first = user("u0", 1);
    (first.parts[0] as { text: string }).text = "instruction " + "A".repeat(10_000);
    const entries = [first, assistant, ...Array.from({ length: 130 }, (_, i) => user("u" + (i + 1), i + 3))];
    const transform = hooks["experimental.chat.messages.transform"] as (_input: object, output: MessagesTransformOutput) => Promise<void>;
    await transform({}, { messages: entries });
    const bootstrap = await readFile(join(storagePath, "ctx-control.html"), "utf8");
    const origin = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1])).origin;
    const token = new URL(JSON.parse(bootstrap.match(/location\.replace\((".*")\)/)![1])).hash.slice(7);
    const headers = { Authorization: `Bearer ${token}` };
    const base = `${origin}/api/sessions/${sessionID}`;
    const inventoryResponse = await fetch(base + "?view=inventory&limit=10", { headers });
    expect(inventoryResponse.status).toBe(200);
    const inventoryText = await inventoryResponse.text();
    const inventory = JSON.parse(inventoryText).data as ControlInventory;
    expect(inventoryText.length).toBeLessThan(50_000);
    expect(inventory.messageCount).toBeGreaterThan(100);
    expect(inventory.messages).toHaveLength(10);
    expect(inventory.messages[1].preview.length).toBeLessThanOrEqual(512);
    expect(inventoryText).not.toContain(payload.slice(0, 1000));
    expect((await (await fetch(base + "?view=inventory&limit=10&messageOffset=100&revision=" + inventory.revision + "&generation=" + inventory.generation, { headers })).json() as any).data.messages).toHaveLength(10);
    const detail = await fetch(base + "/messages/huge?revision=" + inventory.revision + "&generation=" + inventory.generation, { headers });
    expect(detail.status).toBe(200);
    expect((await detail.json() as any).data.message.parts[0].state.output).toBe(payload);
    const legacy = await fetch(base, { headers });
    expect(legacy.status).toBe(200);
    expect((await legacy.json() as any).data.rawHostHistory.find((item: any) => item.id === "huge").parts[0].state.output).toBe(payload);
    await transform({}, { messages: [...entries, user("next-turn", 200)] });
    const afterTurn = (await (await fetch(base + "?view=inventory", { headers })).json() as any).data as ControlInventory;
    expect(afterTurn.revision).toBe(inventory.revision);
    expect(afterTurn.generation).not.toBe(inventory.generation);
    expect((await fetch(base + "?view=inventory&revision=" + inventory.revision + "&generation=" + inventory.generation, { headers })).status).toBe(409);
    const staleMutation = await fetch(base + "/projection?view=inventory&generation=" + inventory.generation, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: inventory.revision, edits: [{ messageId: "next-turn", override: { mode: "exclude" } }] }),
    });
    expect(staleMutation.status).toBe(409);
    const summary = "S".repeat(3_000);
    const compressed = await hooks.tool.compress.execute({ topic: "old instruction", content: [{
      startId: "m0001", endId: "m0001", summary,
    }] }, { sessionID, messageID: "command", agent: "build", directory: workspace, worktree: workspace,
      abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });
    const blockId = compressed.output.match(/\bb\d+\b/)?.[0];
    expect(blockId).toBeDefined();
    const blockInventoryText = await (await fetch(base + "?view=inventory&limit=10", { headers })).text();
    const blockInventory = JSON.parse(blockInventoryText).data as ControlInventory;
    expect(blockInventory.blockCount).toBe(1);
    expect(blockInventory.blocks[0].summaryText).toBeUndefined();
    expect(blockInventoryText).not.toContain(summary);
    expect((await fetch(base + "?view=inventory&generation=" + inventory.generation, { headers })).status).toBe(409);
    const blockDetail = await fetch(base + "/blocks/" + blockId + "/detail?revision=" + blockInventory.revision + "&generation=" + blockInventory.generation, { headers });
    expect((await blockDetail.json() as any).data.block.summaryText).toBe(summary);
    const changed = await fetch(base + "/settings?view=inventory", {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: blockInventory.revision, settings: { recencyGuardTurns: 8 } }),
    });
    expect(changed.status).toBe(200);
    const changedText = await changed.text();
    const changedInventory = JSON.parse(changedText).data as ControlInventory;
    expect(changedInventory.revision).toBe(blockInventory.revision + 1);
    expect(changedInventory.view).toBe("inventory");
    expect(changedInventory.settings.recencyGuardTurns).toBe(8);
    expect(changedText.length).toBeLessThan(50_000);
    expect(changedText).not.toContain(summary);
    expect(changedText).not.toContain(payload.slice(0, 1000));
    const exclusion = await fetch(base + "/projection?view=inventory", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: changedInventory.revision, edits: [{ messageId: "next-turn", override: { mode: "exclude" } }] }),
    });
    expect(exclusion.status).toBe(200);
    const excludedInventory = (await exclusion.json() as any).data as ControlInventory;
    expect(excludedInventory.excludedOverrideCount).toBe(1);
    expect(excludedInventory.excludedOverrides[0].sourceId).toBe("next-turn");
    expect(excludedInventory.excludedOverrides[0].preview.length).toBeLessThanOrEqual(512);
    const excludedDetail = await fetch(base + "/messages/next-turn?revision=" + excludedInventory.revision +
      "&generation=" + excludedInventory.generation, { headers });
    expect((await excludedDetail.json() as any).data.message.parts[0].text).toContain("instruction next-turn");
  });
});
