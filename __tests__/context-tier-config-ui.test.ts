// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Strict contextTiers validation across all config layers + dashboard tier controls.

import { describe, expect, test } from "bun:test";
import { buildCoreConfig, validateRuntimeConfig } from "../adapters/opencode/config.js";
import { CONTROL_UI_HTML } from "../adapters/opencode/control-ui.js";

function config(options: Parameters<typeof buildCoreConfig>[1], runtime?: Parameters<typeof buildCoreConfig>[5]) {
  return buildCoreConfig("s", options, 200_000, "opencode-go", "deepseek-v4-flash", runtime);
}

describe("contextTiers config validation", () => {
  test("plugin layer copies and strictly validates contextTiers, merging defaults", () => {
    const built = config({ contextTiers: { enabled: false, warmMaxTokens: "12%", warmMaxAgeTurns: 50 } });
    expect(built.contextTiers).toEqual({
      enabled: false,
      warmMaxTokens: "12%",
      warmBudgetMode: "strict",
      ageDemotionEnabled: true,
      warmMaxAgeTurns: 50,
      catalogMaxTokens: "1%",
      retrievalMaxTokens: "8%",
      retrievalTtlTurns: 2,
    });
  });

  test("provider and model layers merge contextTiers over the plugin defaults", () => {
    const built = config({
      contextTiers: { warmMaxTokens: "12%" },
      providers: { "opencode-go": { contextTiers: { retrievalMaxTokens: 500 } } },
      models: { "deepseek-v4-flash": { contextTiers: { retrievalTtlTurns: 5 } } },
    });
    expect(built.contextTiers.warmMaxTokens).toBe("12%");
    expect(built.contextTiers.retrievalMaxTokens).toBe(500);
    expect(built.contextTiers.retrievalTtlTurns).toBe(5);
    expect(built.contextTiers.catalogMaxTokens).toBe("1%");
  });

  test("runtime layer has the highest precedence and coexists with automation", () => {
    const built = config(
      { automation: { automaticPruning: false } },
      { contextTiers: { catalogMaxTokens: "2%" }, automation: { modelCompression: false } }
    );
    expect(built.contextTiers.catalogMaxTokens).toBe("2%");
    expect(built.contextTiers.retrievalTtlTurns).toBe(2);
    expect(built.automation).toEqual({ automaticPruning: false, modelCompression: false });
  });

  test("accepts zero and boundary budgets", () => {
    const built = config({
      contextTiers: { warmMaxTokens: 0, catalogMaxTokens: "0%", retrievalMaxTokens: "100%", warmMaxAgeTurns: 0, retrievalTtlTurns: 0 },
    });
    expect(built.contextTiers.warmMaxTokens).toBe(0);
    expect(built.contextTiers.catalogMaxTokens).toBe("0%");
    expect(built.contextTiers.retrievalMaxTokens).toBe("100%");
    expect(built.contextTiers.warmMaxAgeTurns).toBe(0);
    expect(built.contextTiers.retrievalTtlTurns).toBe(0);
  });

  test("rejects truthy strings for booleans at every layer", () => {
    expect(() => config({ contextTiers: { enabled: "true" as unknown as boolean } })).toThrow();
    expect(() => config({ contextTiers: { ageDemotionEnabled: "false" as unknown as boolean } })).toThrow();
    expect(() => config({ contextTiers: { enabled: "on" as unknown as boolean } })).toThrow();
    expect(() => config({ providers: { "opencode-go": { contextTiers: { enabled: 1 as unknown as boolean } } } })).toThrow();
    expect(() => config({ models: { "deepseek-v4-flash": { contextTiers: { enabled: "yes" as unknown as boolean } } } })).toThrow();
    expect(() => config({}, { contextTiers: { enabled: "off" as unknown as boolean } })).toThrow();
  });

  test("rejects malformed budgets and turn counts", () => {
    expect(() => config({ contextTiers: { warmBudgetMode: "loose" as "strict" } })).toThrow();
    expect(() => config({ contextTiers: { warmMaxTokens: -1 } })).toThrow();
    expect(() => config({ contextTiers: { warmMaxTokens: "101%" } })).toThrow();
    expect(() => config({ contextTiers: { warmMaxTokens: "50" } })).toThrow();
    expect(() => config({ contextTiers: { catalogMaxTokens: -0.5 } })).toThrow();
    expect(() => config({ contextTiers: { retrievalMaxTokens: "80" } })).toThrow();
    expect(() => config({ contextTiers: { warmMaxAgeTurns: 2.5 } })).toThrow();
    expect(() => config({ contextTiers: { warmMaxAgeTurns: "40" as unknown as number } })).toThrow();
    expect(() => config({ contextTiers: { retrievalTtlTurns: -2 } })).toThrow();
    expect(() => config({ contextTiers: { retrievalTtlTurns: Number.POSITIVE_INFINITY } })).toThrow();
  });

  test("rejects unknown keys in contextTiers at every layer", () => {
    expect(() => config({ contextTiers: { unknownKey: true } as never })).toThrow();
    expect(() => config({ providers: { "opencode-go": { contextTiers: { warmBudget: "5%" } as never } } })).toThrow();
    expect(() => config({ models: { "deepseek-v4-flash": { contextTiers: { ttlTurns: 3 } as never } } })).toThrow();
    expect(() => config({}, { contextTiers: { enabled: true, bogus: 1 } as never })).toThrow();
  });

  test("preserves the existing automation validation", () => {
    expect(() => config({ automation: { automaticPruning: "false" as unknown as boolean } })).toThrow();
    expect(() => config({ models: { "deepseek-v4-flash": { automation: { modelCompression: "off" as unknown as boolean } } } })).toThrow();
  });
});

describe("validateRuntimeConfig contextTiers", () => {
  test("accepts a valid contextTiers override alongside unrelated settings", () => {
    const result = validateRuntimeConfig({
      contextTiers: { enabled: false, retrievalTtlTurns: 3 },
      cachePrune: { ttlSeconds: 120 },
      automation: { automaticPruning: false },
    });
    expect(result.contextTiers).toEqual({ enabled: false, retrievalTtlTurns: 3 });
    expect(result.cachePrune).toEqual({ ttlSeconds: 120 });
    expect(result.automation).toEqual({ automaticPruning: false });
  });

  test("rejects unknown keys and truthy strings", () => {
    expect(() => validateRuntimeConfig({ contextTiers: { unknownKey: true } as never })).toThrow();
    expect(() => validateRuntimeConfig({ contextTiers: { enabled: "true" as unknown as boolean } })).toThrow();
    expect(() => validateRuntimeConfig({ contextTiers: { ageDemotionEnabled: "false" as unknown as boolean } })).toThrow();
    expect(() => validateRuntimeConfig({ contextTiers: { warmMaxAgeTurns: "40" as unknown as number } })).toThrow();
    expect(() => validateRuntimeConfig({ contextTiers: { warmMaxTokens: "120%" } })).toThrow();
    expect(() => validateRuntimeConfig({ contextTiers: { retrievalMaxTokens: -1 } })).toThrow();
    expect(() => validateRuntimeConfig({ contextTiers: { retrievalTtlTurns: 1.5 } })).toThrow();
  });

  test("contextTiers is a supported runtime key", () => {
    const result = validateRuntimeConfig({ contextTiers: { warmMaxTokens: "10%" } });
    expect(result.contextTiers).toEqual({ warmMaxTokens: "10%" });
  });
});

describe("dashboard tier controls", () => {
  test("exposes all tier controls and the durable-archive warning without innerHTML", () => {
    expect(CONTROL_UI_HTML).toContain('id="s-context-tiers"');
    expect(CONTROL_UI_HTML).toContain('id="s-warm-budget-mode"');
    expect(CONTROL_UI_HTML).toContain('id="s-age-demotion"');
    expect(CONTROL_UI_HTML).toContain('id="s-warm-budget"');
    expect(CONTROL_UI_HTML).toContain('id="s-warm-age"');
    expect(CONTROL_UI_HTML).toContain('id="s-cold-catalog"');
    expect(CONTROL_UI_HTML).toContain('id="s-retrieval-budget"');
    expect(CONTROL_UI_HTML).toContain('id="s-retrieval-ttl"');
    expect(CONTROL_UI_HTML).not.toContain("innerHTML");
    expect(CONTROL_UI_HTML).not.toContain("${");
    expect(CONTROL_UI_HTML).toContain("durably archived");
    expect(CONTROL_UI_HTML).toContain("persistently");
  });

  test("explains the compression summary search and retrieval tools", () => {
    expect(CONTROL_UI_HTML).toContain("ctx_archive_search");
    expect(CONTROL_UI_HTML).toContain("ctx_archive_retrieve");
    expect(CONTROL_UI_HTML).toContain("ctx_tier_update");
    expect(CONTROL_UI_HTML).toContain("persistently promote");
  });

  test("form exposes all managed tier controls", () => {
    const ids = ["s-context-tiers", "s-warm-budget-mode", "s-age-demotion", "s-warm-budget", "s-warm-age", "s-cold-catalog", "s-retrieval-budget", "s-retrieval-ttl"];
    for (const id of ids) {
      // render populates each control from the runtime settings layer.
      expect(CONTROL_UI_HTML).toContain(`el("${id}").value`);
    }
  });

  test("dashboard keeps the tier controls without the old raw-history timeline", () => {
    expect(CONTROL_UI_HTML).toContain("HOT / WARM / COLD CONTENTS");
    expect(CONTROL_UI_HTML).not.toContain('id="timeline-section"');
    expect(CONTROL_UI_HTML).not.toContain("EXACT MODEL CONTEXT");
  });
});

// ── Behavioural round-trip through the real embedded script ───────────────────

class FakeElement {
  value: unknown = "";
  textContent = "";
  className = "";
  hidden = false;
  open = false;
  checked = false;
  disabled = false;
  title = "";
  returnValue = "";
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  root = false;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  private listeners = new Map<string, Array<{ fn: (event: unknown) => void; once: boolean }>>();

  get isConnected(): boolean {
    return this.root || Boolean(this.parentElement?.isConnected);
  }

  addEventListener(type: string, fn: (event: unknown) => void, options?: { once?: boolean }) {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: options?.once === true });
    this.listeners.set(type, list);
  }

  replaceChildren(...nodes: FakeElement[]) {
    for (const child of this.children) child.parentElement = null;
    this.children = nodes;
    for (const child of nodes) child.parentElement = this;
  }

  append(...nodes: FakeElement[]) {
    for (const child of nodes) { child.parentElement = this; this.children.push(child); }
  }

  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }

  removeAttribute(key: string) {
    delete this.attributes[key];
  }

  showModal() {
    this.returnValue = "confirm";
    this.open = true;
    this.open = false;
    this.fire("close");
  }

  close(value = "cancel") { this.returnValue = value; this.open = false; this.fire("close"); }

  fire(type: string) {
    const list = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(type, list.filter(item => !item.once));
    const event = { preventDefault() {}, target: this };
    for (const { fn } of list) fn(event);
  }
}

const SESSION = "tier-session";
const COLD = "HUGE".repeat(1000);
const WARM = "complete warm summary " + "w".repeat(1200);
const HOT = "full hot content " + "h".repeat(1200);
const GENERATION = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function snapshot(settings: Record<string, unknown>, revision = 4, generation = GENERATION, blockOffset = 0, extraBlocks = 0): Record<string, unknown> {
  const blocks = [
    { blockId: "b1", status: "active", projectionTier: "cold", topic: "legacy docs", sourceTokens: 100, summaryTokens: 10, sourceCount: 1 },
    { blockId: "b2", status: "active", projectionTier: "warm", topic: "recent work", sourceTokens: 50, summaryTokens: 4, sourceCount: 1 },
    ...Array.from({ length: extraBlocks }, (_, index) => ({
      blockId: `b${index + 3}`, status: "active", projectionTier: "cold", topic: "older work",
      sourceTokens: 10, summaryTokens: 2, sourceCount: 1,
    })),
  ];
  return {
    sessionId: SESSION,
    view: "inventory",
    revision,
    generation,
    limit: 50,
    messageOffset: 0,
    blockOffset,
    overrideOffset: 0,
    messageCount: 1,
    blockCount: blocks.length,
    excludedOverrideCount: 0,
    hotTokenCount: 40,
    messages: [{ id: "hot-1", sourceId: "hot-1", role: "user", createdAt: 1, tokenCount: 40, preview: HOT.slice(0, 80) }],
    excludedOverrides: [],
    blocks: blocks.slice(blockOffset, blockOffset + 50),
    settings,
    effectiveSettings: {},
    stats: { projectedTokens: 100, modelContextLimit: 1000, totalTokensSaved: 0, systemPromptTokens: 0 },
    pendingProjectionEdit: false,
  };
}

async function bootDashboard(settings: Record<string, unknown>, options: {
  deferredDetails?: boolean;
  extraBlocks?: number;
} = {}) {
  const elements = new Map<string, FakeElement>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) {
        const element = new FakeElement();
        element.root = true;
        elements.set(id, element);
      }
      return elements.get(id)!;
    },
    createElement: () => new FakeElement(),
    createTextNode: (text: string) => { const node = new FakeElement(); node.textContent = text; return node; },
  };
  const location = { hash: "#token=" + "a".repeat(64), search: "", pathname: "/" };
  const history = { replaceState() {} };

  let captured: Record<string, unknown> | undefined;
  let revision = 4;
  let generation = GENERATION;
  let runtime = settings;
  let authenticated = false;
  const requests: Array<{ path: string; method: string }> = [];
  const pendingDetails: Array<{ path: string; resolve: (value: unknown) => void }> = [];
  const response = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
  const fetchStub = async (path: string, init?: { method?: string; body?: string; credentials?: string }) => {
    const method = init?.method ?? "GET";
    requests.push({ path, method });
    const url = new URL(path, "http://ctx-test.localhost");
    if (path === "/bootstrap" && method === "POST") {
      expect(JSON.parse(init?.body ?? "{}").token).toBe("a".repeat(64));
      authenticated = true;
      return response({ authenticated: true });
    }
    expect(authenticated).toBe(true);
    expect(init?.credentials).toBe("same-origin");
    if (url.pathname === "/api/sessions") return response([{ sessionId: SESSION, title: "tier", tokenCount: 100, updatedAt: 1 }]);
    if (url.pathname === `/api/sessions/${SESSION}/settings` && method === "PATCH") {
      expect(url.searchParams.get("view")).toBe("inventory");
      expect(url.searchParams.get("generation")).toBe(generation);
      expect(JSON.parse(init?.body ?? "{}").revision).toBe(revision);
      captured = JSON.parse(init?.body ?? "{}").settings;
      runtime = captured!;
      revision++;
      generation = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      return response(snapshot(runtime, revision, generation, 0, options.extraBlocks));
    }
    if (url.pathname === `/api/sessions/${SESSION}` && method === "GET") {
      expect(url.searchParams.get("view")).toBe("inventory");
      const blockOffset = Number(url.searchParams.get("blockOffset") ?? 0);
      if (blockOffset) {
        expect(url.searchParams.get("messageOffset")).toBe("0");
        expect(url.searchParams.get("overrideOffset")).toBe("0");
        expect(url.searchParams.get("limit")).toBe("50");
        expect(url.searchParams.get("revision")).toBe(String(revision));
        expect(url.searchParams.get("generation")).toBe(generation);
      }
      return response(snapshot(runtime, revision, generation, blockOffset, options.extraBlocks));
    }
    if (url.pathname.startsWith(`/api/sessions/${SESSION}/blocks/`) || url.pathname.startsWith(`/api/sessions/${SESSION}/messages/`)) {
      expect(url.searchParams.get("revision")).toBe(String(revision));
      expect(url.searchParams.get("generation")).toBe(generation);
      const blockId = url.pathname.split("/")[5];
      const data = url.pathname.includes("/blocks/")
        ? { block: { blockId, status: "active", summaryText: blockId === "b1" ? COLD : WARM } }
        : { message: { id: "hot-1", parts: [{ type: "text", text: HOT }] } };
      if (options.deferredDetails) return new Promise(resolve => pendingDetails.push({ path, resolve: () => resolve(response(data)) }));
      return response(data);
    }
    throw new Error("unexpected route " + path);
  };

  const script = /<script>([\s\S]*)<\/script>/.exec(CONTROL_UI_HTML)![1];
  const run = new Function("document", "location", "history", "fetch", script) as (
    doc: unknown, loc: unknown, hist: unknown, fetch: unknown
  ) => void;
  run(document, location, history, fetchStub);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(elements.get("status")?.textContent).not.toContain("unexpected route");
  return { elements, captured: () => captured, requests, pendingDetails };
}

describe("dashboard settings round-trip", () => {
  test("renderSettings populates tier controls and collectSettings preserves unrelated runtime JSON", async () => {
    const boot = await bootDashboard({
      compressionRecencyRequests: 7,
      cachePrune: { ttlSeconds: 999 },
      toolClasses: { read: { stateless: true, retentionTurns: 5 } },
      contextTiers: {
        enabled: true,
        warmBudgetMode: "advisory",
        ageDemotionEnabled: false,
        warmMaxTokens: "8%",
        warmMaxAgeTurns: 40,
        catalogMaxTokens: "1%",
        retrievalMaxTokens: "8%",
        retrievalTtlTurns: 2,
      },
    });
    const el = boot.elements;

    expect(el.get("s-compression-recency")!.value).toBe(7);
    expect(el.get("s-context-tiers")!.value).toBe("true");
    expect(el.get("s-warm-budget-mode")!.value).toBe("advisory");
    expect(el.get("s-age-demotion")!.value).toBe("false");
    expect(el.get("s-warm-budget")!.value).toBe("8%");
    expect(el.get("s-warm-age")!.value).toBe(40);
    expect(el.get("s-cold-catalog")!.value).toBe("1%");
    expect(el.get("s-retrieval-budget")!.value).toBe("8%");
    expect(el.get("s-retrieval-ttl")!.value).toBe(2);

    // The JSON editor shows the full override layer, including unrelated keys.
    const editor = JSON.parse(String(el.get("settings-json")!.value)) as {
      cachePrune: { ttlSeconds: number };
      contextTiers: { enabled: boolean; warmBudgetMode: string; ageDemotionEnabled: boolean };
    };
    expect(editor.cachePrune).toEqual({ ttlSeconds: 999 });
    expect(editor.contextTiers.enabled).toBe(true);
    expect(editor.contextTiers.warmBudgetMode).toBe("advisory");
    expect(editor.contextTiers.ageDemotionEnabled).toBe(false);

    // Edit a warm field, clear retrieval budget, then save the batch.
    el.get("s-warm-age")!.value = "25";
    el.get("s-compression-recency")!.value = "2";
    el.get("s-retrieval-budget")!.value = "";
    el.get("settings-form")!.fire("submit");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(boot.captured()).toEqual({
      compressionRecencyRequests: 2,
      cachePrune: { ttlSeconds: 999 },
      toolClasses: { read: { stateless: true, retentionTurns: 5 } },
      contextTiers: {
        enabled: true,
        warmBudgetMode: "advisory",
        ageDemotionEnabled: false,
        warmMaxTokens: "8%",
        warmMaxAgeTurns: 25,
        catalogMaxTokens: "1%",
        retrievalTtlTurns: 2,
      },
    });
  });

  test("clearing every tier control drops the whole contextTiers override", async () => {
    const boot = await bootDashboard({
      compressionRecencyRequests: 4,
      cachePrune: { ttlSeconds: 999 },
      contextTiers: { enabled: true, warmBudgetMode: "advisory", ageDemotionEnabled: false, warmMaxTokens: "8%", warmMaxAgeTurns: 40, catalogMaxTokens: "1%", retrievalMaxTokens: "8%", retrievalTtlTurns: 2 },
    });
    const el = boot.elements;
    el.get("s-compression-recency")!.value = "";
    for (const id of ["s-context-tiers", "s-warm-budget-mode", "s-age-demotion", "s-warm-budget", "s-warm-age", "s-cold-catalog", "s-retrieval-budget", "s-retrieval-ttl"]) {
      el.get(id)!.value = "";
    }
    el.get("settings-form")!.fire("submit");
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(boot.captured()).toEqual({ cachePrune: { ttlSeconds: 999 } });
  });

  test("tier inventory renders bounded HOT and block metadata; full WARM/COLD summaries and messages load only on expansion", async () => {
    const boot = await bootDashboard({});
    const allText = (node: FakeElement): string => node.textContent + node.children.map(allText).join(" ");
    const blockCards = boot.elements.get("blocks")!.children.filter(card => card.className === "card");
    expect(blockCards).toHaveLength(3);
    const cold = blockCards.find(card => allText(card).includes("b1"))!;
    const warm = blockCards.find(card => allText(card).includes("b2"))!;
    expect(allText(cold)).toContain("cold");
    expect(allText(cold)).toContain("Promote to WARM");
    expect(allText(warm)).toContain("warm");
    expect(allText(warm)).toContain("Move to COLD");
    expect(allText(boot.elements.get("blocks")!)).not.toContain(COLD);
    expect(allText(boot.elements.get("blocks")!)).not.toContain(WARM);
    expect(boot.requests.some(request => request.path.includes("/detail"))).toBe(false);

    const expand = async (card: FakeElement, full: string) => {
      const details = card.children.find(child => child.children[0]?.textContent.includes("summary"))!;
      details.open = true;
      details.fire("toggle");
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(allText(details)).toContain(full);
      expect(boot.requests.at(-1)?.path).toContain("revision=4&generation=" + GENERATION);
      details.open = false;
      details.fire("toggle");
      expect(allText(details)).not.toContain(full);
    };
    await expand(cold, COLD);
    await expand(warm, WARM);

    const hotDetails = boot.elements.get("messages")!.children[0].children.find(child =>
      child.children[0]?.textContent === "Show exact HOT contents")!;
    expect(allText(boot.elements.get("messages")!)).not.toContain(HOT);
    hotDetails.open = true;
    hotDetails.fire("toggle");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(allText(hotDetails)).toContain(HOT);
    hotDetails.open = false;
    hotDetails.fire("toggle");
    expect(allText(hotDetails)).not.toContain(HOT);
  });

  test("closed/reopened details ignore a prior in-flight response from the same generation", async () => {
    const boot = await bootDashboard({}, { deferredDetails: true });
    const allText = (node: FakeElement): string => node.textContent + node.children.map(allText).join(" ");
    const cold = boot.elements.get("blocks")!.children.find(card => allText(card).includes("b1"))!;
    const details = cold.children.find(child => child.children[0]?.textContent.includes("summary"))!;
    details.open = true;
    details.fire("toggle");
    details.open = false;
    details.fire("toggle");
    details.open = true;
    details.fire("toggle");
    expect(boot.pendingDetails).toHaveLength(2);
    boot.pendingDetails[0].resolve(undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(allText(details)).not.toContain(COLD);
    boot.pendingDetails[1].resolve(undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(allText(details)).toContain(COLD);
    details.open = false;
    details.fire("toggle");
    expect(allText(details)).not.toContain(COLD);
  });

  test("block paging is revision/generation guarded and drops a pending detail from the previous page", async () => {
    const boot = await bootDashboard({}, { extraBlocks: 53, deferredDetails: true });
    const allText = (node: FakeElement): string => node.textContent + node.children.map(allText).join(" ");
    const cold = boot.elements.get("blocks")!.children.find(card => allText(card).includes("b1"))!;
    const details = cold.children.find(child => child.children[0]?.textContent.includes("summary"))!;
    details.open = true;
    details.fire("toggle");
    expect(boot.pendingDetails).toHaveLength(1);

    const next = boot.elements.get("block-page")!.children[2];
    expect(next.disabled).toBe(false);
    next.fire("click");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(boot.requests.at(-1)?.path).toContain("blockOffset=50&overrideOffset=0&limit=50&revision=4&generation=" + GENERATION);
    expect(allText(boot.elements.get("blocks")!)).not.toContain("legacy docs");
    boot.pendingDetails[0].resolve(undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(allText(boot.elements.get("blocks")!)).not.toContain(COLD);
    expect(allText(details)).not.toContain(COLD);
  });
});
