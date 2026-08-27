import { describe, it, expect } from "vitest";
import { priceUsage } from "./pricing.js";

const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 };

describe("priceUsage", () => {
  it("prices a known Anthropic model to a positive number", () => {
    const cost = priceUsage("anthropic", "claude-sonnet-4-5-20250929", usage);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
  it("prices a known OpenAI model to a positive number", () => {
    const cost = priceUsage("openai", "gpt-5", usage);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
  it("returns null for an unknown model (unpriced, not zero)", () => {
    expect(priceUsage("openai", "totally-made-up-model", usage)).toBeNull();
  });
});
