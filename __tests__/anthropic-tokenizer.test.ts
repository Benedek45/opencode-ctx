// PolyForm Noncommercial License 1.0.0 — see LICENSE
// The exact Anthropic tokenizer must stay cheap enough for per-turn re-estimation.

import { describe, it, expect } from "bun:test";
import { countTokens } from "@anthropic-ai/tokenizer";
import { AnthropicTokenizer } from "../adapters/opencode/services.js";

describe("AnthropicTokenizer", () => {
  it("matches the package's exact counts", async () => {
    const tokenizer = new AnthropicTokenizer();
    await tokenizer.init();
    expect(tokenizer.isAvailable).toBe(true);
    const samples = [
      "",
      "hello world",
      "Ünïcödé ﬁ ligature ①②",
      "x".repeat(5_000),
      JSON.stringify({ a: [1, 2, 3], b: "<ctx-message-id>m0001</ctx-message-id>" }),
      "def f(x):\n    return x**2  # comment\n".repeat(200),
    ];
    for (const sample of samples) {
      expect(tokenizer.countTokens(sample)).toBe(countTokens(sample));
      // Memoized second call returns the same value.
      expect(tokenizer.countTokens(sample)).toBe(countTokens(sample));
    }
  });

  it("does not rebuild the encoder per call", async () => {
    const tokenizer = new AnthropicTokenizer();
    await tokenizer.init();
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) tokenizer.countTokens(`short text ${i}`);
    // Rebuilding the WASM encoder per call costs ~10ms each (>20s here).
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
