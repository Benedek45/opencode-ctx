// PolyForm Noncommercial License 1.0.0 — see LICENSE

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  RevisionConflictError,
  startControlServer,
} from "../adapters/opencode/control-server.js";
import type {
  ArchiveSearchQuery,
  ArchiveSearchResults,
  BlockAction,
  ControlPlaneBackend,
  ControlServer,
  ControlSessionSnapshot,
  ControlSessionSummary,
  JsonObject,
  MessageProjectionOverride,
  ProjectionEdit,
} from "../adapters/opencode/control-server.js";

function snapshot(revision: number): ControlSessionSnapshot {
  return {
    sessionId: "session/a",
    revision,
    rawHostHistory: [{ id: "m1", role: "user", parts: [{ type: "text", text: "raw question" }], tokenCount: 3 }],
    projectedContext: [{ id: "m1", role: "user", parts: [{ type: "text", text: "projected question" }], tokenCount: 2 }],
    blocks: [{ blockId: "b1", status: "active", summaryText: "summary" }],
    settings: { profile: "code" },
    stats: { totalTokensSaved: 12 },
  };
}

class TestBackend implements ControlPlaneBackend {
  revision = 4;
  calls: string[] = [];

  private mutate(expected: number, call: string): ControlSessionSnapshot {
    if (expected !== this.revision) throw new RevisionConflictError("stale revision", expected, this.revision);
    this.calls.push(call);
    this.revision++;
    return snapshot(this.revision);
  }

  async listSessions(): Promise<ControlSessionSummary[]> {
    this.calls.push("list");
    return [{ sessionId: "session/a", title: "Primary", revision: this.revision, messageCount: 1, tokenCount: 2 }];
  }

  async getSession(sessionId: string): Promise<ControlSessionSnapshot | undefined> {
    this.calls.push(`get:${sessionId}`);
    return sessionId === "session/a" ? snapshot(this.revision) : undefined;
  }

  async updateSettings(sessionId: string, revision: number, settings: JsonObject): Promise<ControlSessionSnapshot> {
    return this.mutate(revision, `settings:${sessionId}:${String(settings.profile)}`);
  }

  async putMessageOverride(sessionId: string, messageId: string, revision: number, override: MessageProjectionOverride): Promise<ControlSessionSnapshot> {
    return this.mutate(revision, `put:${sessionId}:${messageId}:${override.mode}`);
  }

  async deleteMessageOverride(sessionId: string, messageId: string, revision: number): Promise<ControlSessionSnapshot> {
    return this.mutate(revision, `delete:${sessionId}:${messageId}`);
  }

  async applyProjectionEdits(sessionId: string, revision: number, edits: ProjectionEdit[]): Promise<ControlSessionSnapshot> {
    const described = edits.map(edit => `${edit.messageId}=${edit.override ? edit.override.mode : "reset"}`).join("+");
    return this.mutate(revision, `batch:${sessionId}:${described}`);
  }

  async performBlockAction(sessionId: string, blockId: string, revision: number, action: BlockAction): Promise<ControlSessionSnapshot> {
    return this.mutate(revision, `block:${sessionId}:${blockId}:${action}`);
  }

  async searchArchivedContent(query: ArchiveSearchQuery): Promise<ArchiveSearchResults> {
    this.calls.push(`search:${query.text}:${query.sessionId ?? ""}`);
    return { items: [{ id: "archive-1", snippet: "matching archive" }] };
  }
}

describe("localhost control server", () => {
  let backend: TestBackend;
  let server: ControlServer;

  beforeEach(async () => {
    backend = new TestBackend();
    server = await startControlServer({ backend, host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await server.close();
  });

  const auth = (): Record<string, string> => ({ Authorization: `Bearer ${server.token}` });
  const jsonAuth = (): Record<string, string> => ({ ...auth(), "Content-Type": "application/json" });
  const json = async (response: Response): Promise<Record<string, any>> => response.json() as Promise<Record<string, any>>;

  it("bootstraps an HttpOnly Strict cookie from a fragment-safe POST", async () => {
    expect(server.token).toHaveLength(64);
    expect(/^ctx-[a-f0-9]+\.localhost$/.test(new URL(server.origin).hostname)).toBe(true);
    const shell = await fetch(`${server.origin}/`);
    expect(shell.status).toBe(200);
    const response = await fetch(`${server.origin}/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: server.token }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ctx_control=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("token=");

    const cookiePair = cookie.split(";", 1)[0];
    const page = await fetch(`${server.origin}/`, { headers: { Cookie: cookiePair } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("HOT / WARM / COLD CONTENTS");
  });

  it("allows health but rejects unauthenticated API requests with structured errors", async () => {
    const health = await fetch(`${server.origin}/health`);
    expect(health.status).toBe(200);
    expect(await json(health)).toEqual({ data: { status: "ok" } });
    const response = await fetch(`${server.origin}/api/sessions`);
    expect(response.status).toBe(401);
    expect(await json(response)).toEqual({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
  });

  it("rejects non-loopback binds and non-loopback Host headers", async () => {
    await expect(startControlServer({ backend, host: "0.0.0.0" as "127.0.0.1", port: 0 })).rejects.toThrow("loopback");
    const response = await fetch(`${server.origin}/api/sessions`, { headers: { ...auth(), Host: "example.com" } });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe("INVALID_HOST");
  });

  it("resolves localhost to an explicit loopback listener", async () => {
    const local = await startControlServer({ backend, host: "localhost", port: 0 });
    try {
      expect(local.host).toBe("127.0.0.1");
      expect(/^http:\/\/ctx-[a-f0-9]+\.localhost:/.test(local.origin)).toBe(true);
    } finally {
      await local.close();
    }
  });

  it("sets restrictive security headers and no CORS headers", async () => {
    const response = await fetch(`${server.origin}/`, { headers: auth() });
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves session listing and an exact detail snapshot", async () => {
    const listing = await fetch(`${server.origin}/api/sessions`, { headers: auth() });
    expect(listing.status).toBe(200);
    expect((await json(listing)).data[0].sessionId).toBe("session/a");
    const detail = await fetch(`${server.origin}/api/sessions/session%2Fa`, { headers: auth() });
    const body = await json(detail);
    expect(detail.status).toBe(200);
    expect(body.data.rawHostHistory[0].parts[0].text).toBe("raw question");
    expect(body.data.projectedContext[0].parts[0].text).toBe("projected question");
    expect(body.data.stats.totalTokensSaved).toBe(12);
  });

  it("routes settings, all override operations, and every block action", async () => {
    let revision = backend.revision;
    const mutate = async (path: string, method: string, body: JsonObject) => {
      const response = await fetch(`${server.origin}${path}`, { method, headers: jsonAuth(), body: JSON.stringify({ revision, ...body }) });
      expect(response.status).toBe(200);
      revision = (await json(response)).data.revision;
    };
    await mutate("/api/sessions/session%2Fa/settings", "PATCH", { settings: { profile: "balanced" } });
    await mutate("/api/sessions/session%2Fa/overrides/m1", "PUT", { override: { mode: "keep" } });
    await mutate("/api/sessions/session%2Fa/overrides/m1", "PUT", { override: { mode: "exclude" } });
    await mutate("/api/sessions/session%2Fa/overrides/m1", "PUT", { override: { mode: "replace", text: "replacement" } });
    await mutate("/api/sessions/session%2Fa/overrides/m1", "DELETE", {});
    for (const action of ["deactivate", "reactivate", "recompress", "promote", "demote"]) {
      await mutate("/api/sessions/session%2Fa/blocks/b1/actions", "POST", { action });
    }
    expect(backend.calls).toContain("settings:session/a:balanced");
    expect(backend.calls).toContain("put:session/a:m1:replace");
    expect(backend.calls).toContain("delete:session/a:m1");
    expect(backend.calls).toContain("block:session/a:b1:recompress");
    expect(backend.calls).toContain("block:session/a:b1:promote");
    expect(backend.calls).toContain("block:session/a:b1:demote");
  });

  it("applies a staged batch under a single revision", async () => {
    const before = backend.revision;
    const response = await fetch(`${server.origin}/api/sessions/session%2Fa/projection`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify({
        revision: before,
        edits: [
          { messageId: "m1", override: { mode: "exclude" } },
          { messageId: "m2", override: { mode: "replace", text: "condensed" } },
          { messageId: "m3", override: null },
        ],
      }),
    });
    expect(response.status).toBe(200);
    // One batch is one revision, so one prompt-cache rewrite rather than three.
    expect((await json(response)).data.revision).toBe(before + 1);
    expect(backend.revision).toBe(before + 1);
    expect(backend.calls).toContain("batch:session/a:m1=exclude+m2=replace+m3=reset");
  });

  it("rejects malformed projection batches", async () => {
    const post = (body: JsonObject) => fetch(`${server.origin}/api/sessions/session%2Fa/projection`, {
      method: "POST",
      headers: jsonAuth(),
      body: JSON.stringify(body),
    });
    const empty = await post({ revision: backend.revision, edits: [] });
    expect(empty.status).toBe(400);
    const duplicate = await post({
      revision: backend.revision,
      edits: [{ messageId: "m1", override: null }, { messageId: "m1", override: null }],
    });
    expect((await json(duplicate)).error.message).toContain("duplicated");
    const badMode = await post({ revision: backend.revision, edits: [{ messageId: "m1", override: { mode: "nope" } }] });
    expect((await json(badMode)).error.code).toBe("INVALID_OVERRIDE");
    const missingText = await post({ revision: backend.revision, edits: [{ messageId: "m1", override: { mode: "replace" } }] });
    expect((await json(missingText)).error.code).toBe("INVALID_OVERRIDE");
    // A rejected batch must not consume the revision.
    expect(backend.revision).toBe(4);
  });

  it("serves chat-labeled origins that still require the host nonce", async () => {
    const labeled = new URL(server.originFor("Fix Login Bug!!"));
    const nonce = new URL(server.origin).hostname.replace(/^ctx-/, "").replace(/\.localhost$/, "");
    expect(labeled.hostname).toBe(`ctx-fix-login-bug-${nonce}.localhost`);
    expect(labeled.port).toBe(String(server.port));
    expect(server.originFor("")).toBe(server.origin);
    expect(server.originFor("x".repeat(80)).length).toBeLessThan(server.origin.length + 40);

    const accepted = await fetch(`${server.origin}/api/sessions`, { headers: { ...auth(), Host: labeled.host } });
    expect(accepted.status).toBe(200);
    const foreign = await fetch(`${server.origin}/api/sessions`, {
      headers: { ...auth(), Host: `ctx-fix-login-bug-${"0".repeat(nonce.length)}.localhost:${server.port}` },
    });
    expect(foreign.status).toBe(400);
    expect((await json(foreign)).error.code).toBe("INVALID_HOST");

    const nonCanonical = await fetch(`${server.origin}/api/sessions`, {
      headers: { ...auth(), Host: `ctx-foo--${nonce}.localhost:${server.port}` },
    });
    expect(nonCanonical.status).toBe(400);
    expect((await json(nonCanonical)).error.code).toBe("INVALID_HOST");
  });

  it("refuses to issue the cookie on a bare loopback host", async () => {
    // Host-only cookies are not port-scoped, so a 127.0.0.1 cookie would leak to
    // every other local service on that hostname.
    const response = await fetch(`${server.origin}/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: `127.0.0.1:${server.port}` },
      body: JSON.stringify({ token: server.token }),
    });
    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe("INVALID_HOST");
    expect(response.headers.get("set-cookie")).toBeNull();
    // Bearer clients still reach the API on the bare loopback host.
    const api = await fetch(`${server.origin}/api/sessions`, { headers: { ...auth(), Host: `127.0.0.1:${server.port}` } });
    expect(api.status).toBe(200);
  });

  it("routes archived-content search with session scope", async () => {
    const response = await fetch(`${server.origin}/api/sessions/session%2Fa/archive/search?q=matching&limit=10`, { headers: auth() });
    expect(response.status).toBe(200);
    expect((await json(response)).data.items[0].snippet).toBe("matching archive");
    expect(backend.calls).toContain("search:matching:session/a");
  });

  it("requires JSON, caps bodies at 256KB, and rejects cross-origin mutations", async () => {
    const wrongType = await fetch(`${server.origin}/api/sessions/session%2Fa/settings`, { method: "PATCH", headers: auth(), body: "{}" });
    expect(wrongType.status).toBe(415);
    expect((await json(wrongType)).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const tooLarge = await fetch(`${server.origin}/api/sessions/session%2Fa/settings`, { method: "PATCH", headers: jsonAuth(), body: JSON.stringify({ padding: "x".repeat(256 * 1024) }) });
    expect(tooLarge.status).toBe(413);
    expect((await json(tooLarge)).error.code).toBe("BODY_TOO_LARGE");

    const crossOrigin = await fetch(`${server.origin}/api/sessions/session%2Fa/settings`, { method: "PATCH", headers: { ...jsonAuth(), Origin: "http://evil.example" }, body: JSON.stringify({ revision: 4, settings: {} }) });
    expect(crossOrigin.status).toBe(403);
    expect((await json(crossOrigin)).error.code).toBe("CROSS_ORIGIN");
  });

  it("maps optimistic revision conflicts to HTTP 409", async () => {
    const response = await fetch(`${server.origin}/api/sessions/session%2Fa/settings`, { method: "PATCH", headers: jsonAuth(), body: JSON.stringify({ revision: 3, settings: {} }) });
    expect(response.status).toBe(409);
    const body = await json(response);
    expect(body.error.code).toBe("REVISION_CONFLICT");
    expect(body.error.details.actualRevision).toBe(4);
  });

  it("serves required UI labels and avoids untrusted innerHTML rendering", async () => {
    const response = await fetch(`${server.origin}/`, { headers: auth() });
    const html = await response.text();
    expect(html).not.toContain('id="timeline-section"');
    expect(html).toContain("messages / ");
    expect(html).toContain("HOT / WARM / COLD CONTENTS");
    expect(html).toContain("EDITABLE SETTINGS");
    expect(html).toContain("Automatic pruning");
    expect(html).toContain("Model-called compression");
    expect(html).toContain("disables the mechanical hard cap");
    expect(html).toContain("MESSAGE PROJECTION OVERRIDE");
    expect(html).toContain("ARCHIVED CONTENT SEARCH");
    expect(html).toContain("textContent");
    expect(html).not.toContain("innerHTML");
    // Staged-batch affordance and the next-request contract must be visible.
    expect(html).toContain("staged edit");
    expect(html).toContain("Save &amp; use at next request");
    expect(html).toContain("cached tokens");
    // The embedded script must not carry unresolved template interpolation.
    expect(html).not.toContain("${");
  });
});
