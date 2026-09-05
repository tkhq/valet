import { afterEach, describe, expect, it, vi } from "vitest";
import * as builtinCatalog from "@earendil-works/pi-ai/providers/all";
import { bundledModel, bundledModels } from "../src/model-catalog.js";

vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/providers/all")>();
  return { ...actual, getBuiltinModels: vi.fn(actual.getBuiltinModels) };
});

afterEach(() => vi.resetAllMocks());

describe("bundled model catalog", () => {
  it("preserves upstream model metadata", () => {
    const upstream = builtinCatalog.getBuiltinModels("anthropic");
    expect(bundledModels("anthropic")).toEqual(upstream);
    for (const model of upstream) {
      expect(bundledModel("anthropic", model.id)).toBe(model);
    }
  });

  it("includes Astra with the Responses capabilities and tiered prices", () => {
    const astra = bundledModel("openai", "gpt-6-astra");
    expect(astra).toMatchObject({
      id: "gpt-6-astra",
      api: "openai-responses",
      provider: "openai",
      contextWindow: 272000,
      maxTokens: 128000,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
      },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: {
        supportsStrictMode: true,
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsExplicitPromptCacheMode: true,
      },
    });
    expect(bundledModels("openai").filter((model) => model.id === "gpt-6-astra")).toEqual([astra]);
  });

  it("uses the upstream entry when pi adds a supplemental model id", () => {
    const upstream = {
      ...builtinCatalog.getBuiltinModel("openai", "gpt-5.4"),
      id: "gpt-6-astra",
      name: "Upstream Astra",
      contextWindow: 400000,
    };
    vi.mocked(builtinCatalog.getBuiltinModels).mockReturnValue([upstream]);

    expect(bundledModels("openai")).toEqual([upstream]);
    expect(bundledModel("openai", "gpt-6-astra")).toBe(upstream);
  });

  it("returns no models for unknown providers or ids", () => {
    for (const provider of ["unknown-provider", "toString", "__proto__"]) {
      expect(bundledModels(provider)).toEqual([]);
      expect(bundledModel(provider, "gpt-6-astra")).toBeUndefined();
    }
    expect(bundledModel("openai", "unknown-model")).toBeUndefined();
    expect(bundledModel("anthropic", "gpt-6-astra")).toBeUndefined();
  });
});
