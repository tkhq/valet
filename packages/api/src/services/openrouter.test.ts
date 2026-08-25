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
  parseOpenrouterLiveModels,
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

  it("the curated selection is latest frontier models from Anthropic and OpenAI", () => {
    // All models should be from Anthropic or OpenAI
    const validPrefixes = ["anthropic/", "openai/"];
    for (const id of OPENROUTER_DEFAULT_MODEL_IDS) {
      const hasValidPrefix = validPrefixes.some((prefix) => id.startsWith(prefix));
      expect(hasValidPrefix).toBe(true);
    }
    // Should include latest major versions
    expect(OPENROUTER_DEFAULT_MODEL_IDS.some((id) => id.startsWith("anthropic/claude-opus"))).toBe(true);
    expect(OPENROUTER_DEFAULT_MODEL_IDS.some((id) => id.startsWith("anthropic/claude-sonnet"))).toBe(true);
    expect(OPENROUTER_DEFAULT_MODEL_IDS.some((id) => id.startsWith("anthropic/claude-") && id.includes("haiku"))).toBe(true);
    expect(OPENROUTER_DEFAULT_MODEL_IDS.some((id) => id.startsWith("openai/"))).toBe(true);
  });

  it("parseOpenrouterLiveModels maps the live payload, scales per-token pricing to per-million, skips malformed", () => {
    const parsed = parseOpenrouterLiveModels({
      data: [
        {
          id: "moonshotai/kimi-k3",
          name: "MoonshotAI: Kimi K3",
          context_length: 1_048_576,
          pricing: { prompt: "0.000003", completion: "0.000015" },
        },
        { id: "vendor/no-frills" }, // minimal entry — name falls back to id
        { name: "no id — skipped" },
        "not-an-object",
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      id: "moonshotai/kimi-k3",
      name: "MoonshotAI: Kimi K3",
      contextWindow: 1_048_576,
      pricing: { input: 3, output: 15 },
    });
    expect(parsed[1]).toEqual({
      id: "vendor/no-frills",
      name: "vendor/no-frills",
      contextWindow: undefined,
      pricing: undefined,
    });
  });

  it("parseOpenrouterLiveModels returns [] on garbage payloads", () => {
    expect(parseOpenrouterLiveModels(null)).toEqual([]);
    expect(parseOpenrouterLiveModels("nope")).toEqual([]);
    expect(parseOpenrouterLiveModels({ data: "nope" })).toEqual([]);
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
