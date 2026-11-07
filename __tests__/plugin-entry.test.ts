// PolyForm Noncommercial License 1.0.0 — see LICENSE
//
// Guards the host plugin-loading contract. Both invariants below caused a real
// production failure: the opencode desktop app (Electron/Node) silently failed to
// load the plugin, so no hook ran, every migrated compression decision was
// bypassed, and full raw history was sent to the provider.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const readRepoFile = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("host plugin entry contract", () => {
  it("exposes exactly one export so a host cannot register the plugin twice", async () => {
    const entry = await import("../adapters/opencode/plugin-entry.js");
    // opencode v1 treats every exported function as its own plugin factory.
    expect(Object.keys(entry)).toEqual(["default"]);
    expect(typeof entry.default).toBe("function");
  });

  it("is the same factory the library exports by name", async () => {
    const [entry, plugin] = await Promise.all([
      import("../adapters/opencode/plugin-entry.js"),
      import("../adapters/opencode/plugin.js"),
    ]);
    expect(entry.default).toBe(plugin.CtxPlugin);
  });

  it("no longer publishes the duplicate-registration alias", async () => {
    const plugin = await import("../adapters/opencode/plugin.js");
    expect("server" in plugin).toBe(false);
  });

  it("ships a build target, because sources need Bun-only .js -> .ts resolution", () => {
    // The desktop app runs Node, which cannot resolve our `.js` specifiers to
    // `.ts` files. Host config must therefore point at the compiled entry.
    const source = readRepoFile("../adapters/opencode/plugin-entry.ts");
    expect(source).toContain("dist/adapters/opencode/plugin-entry.js");

    const tsconfig = readRepoFile("../tsconfig.build.json");
    expect(tsconfig).toContain("outDir");
  });
});
