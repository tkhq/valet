import { describe, it, expect } from "vitest";
import { priceUsage, resolveCanonicalModel } from "./pricing.js";

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
  it("prices a DATED response id by falling back to its registry key", () => {
    // OpenAI returns `gpt-4o-mini-2024-07-18` (not a registry key); the base id
    // `gpt-4o-mini` is. Without the canonical fallback this was unpriced.
    const cost = priceUsage("openai", "gpt-4o-mini-2024-07-18", usage);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
});

describe("resolveCanonicalModel", () => {
  it("returns the id unchanged when pi-ai already knows it", () => {
    expect(resolveCanonicalModel("openai", "gpt-4o-mini")).toBe("gpt-4o-mini");
  });
  it("strips an OpenAI -YYYY-MM-DD suffix to reach the registry key", () => {
    // OpenAI's dated response ids are NOT registry keys; the base id is.
    expect(resolveCanonicalModel("openai", "gpt-4o-mini-2024-07-18")).toBe("gpt-4o-mini");
  });
  it("returns an Anthropic dated id unchanged (it IS a registry key)", () => {
    // Anthropic's dated ids are registry keys, so no stripping is needed.
    expect(resolveCanonicalModel("anthropic", "claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });
  it("returns null when neither the id nor its stripped form is known", () => {
    expect(resolveCanonicalModel("openai", "totally-made-up-2024-01-01")).toBeNull();
  });
  it("does NOT strip a non-date 8-digit suffix (avoids mis-pricing)", () => {
    // 12345678 is not a valid YYYYMMDD (month 34), so no strip → unknown id.
    expect(resolveCanonicalModel("openai", "gpt-4o-mini-12345678")).toBeNull();
  });
});
