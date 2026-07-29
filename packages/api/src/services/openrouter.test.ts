/**
 * OpenRouter curated defaults (llm-providers openrouter extension). The
 * critical pin: every id in `OPENROUTER_DEFAULT_MODEL_IDS` must exist in
 * pi-ai's openrouter registry — a pi-ai bump that renames/drops one must
 * fail HERE, not silently shrink the seeded catalog.
 */
import { describe, expect, it } from "vitest";
import {
  OPENROUTER_DEFAULT_MODEL_IDS,
  curatedOpenrouterModels,
  openrouterRegistry,
  toProviderModel,
} from "./openrouter.js";

describe("openrouter curated defaults", () => {
  it("every curated id exists in the pi-ai openrouter registry", () => {
    const registry = openrouterRegistry();
    const missing = OPENROUTER_DEFAULT_MODEL_IDS.filter((id) => !registry.has(id));
    expect(missing).toEqual([]);
  });

  it("curatedOpenrouterModels returns one registry-resolved entry per curated id", () => {
    const models = curatedOpenrouterModels();
    expect(models.map((m) => m.id)).toEqual([...OPENROUTER_DEFAULT_MODEL_IDS]);
    for (const m of models) {
      expect(m.name.length).toBeGreaterThan(0);
      expect(m.pricing).toBeDefined();
    }
  });

  it("the user-requested picks are present", () => {
    expect(OPENROUTER_DEFAULT_MODEL_IDS).toContain("deepseek/deepseek-v4-pro");
    expect(OPENROUTER_DEFAULT_MODEL_IDS).toContain("moonshotai/kimi-k2.6");
  });

  it("toProviderModel carries pricing and context window", () => {
    const registry = openrouterRegistry();
    const reg = registry.get("deepseek/deepseek-v4-pro");
    expect(reg).toBeDefined();
    if (!reg) return;
    const m = toProviderModel(reg);
    expect(m.id).toBe("deepseek/deepseek-v4-pro");
    expect(typeof m.contextWindow).toBe("number");
    expect(typeof m.pricing?.input).toBe("number");
    expect(typeof m.pricing?.output).toBe("number");
  });
});
