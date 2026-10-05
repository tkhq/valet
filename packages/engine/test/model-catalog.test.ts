import { afterEach, describe, expect, it, vi } from "vitest";
import * as builtinCatalog from "@earendil-works/pi-ai/providers/all";
import { getSupportedThinkingLevels, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { bundledModel, bundledModels } from "../src/model-catalog.js";

vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/providers/all")>();
  return { ...actual, getBuiltinModels: vi.fn(actual.getBuiltinModels) };
});

afterEach(() => vi.resetAllMocks());

describe("bundled model catalog", () => {
  it("preserves upstream model metadata", () => {
    const upstream = builtinCatalog.getBuiltinModels("anthropic");
    expect(bundledModels("anthropic").slice(0, upstream.length)).toEqual(upstream);
    for (const model of upstream) {
      expect(bundledModel("anthropic", model.id)).toBe(model);
    }
  });

  it("includes Claude Opus 5.5 from the upstream catalog", () => {
    expect(bundledModel("anthropic", "claude-opus-5-5")).toMatchObject({
      id: "claude-opus-5-5",
      api: "anthropic-messages",
      provider: "anthropic",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
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

  it.each([["openai", "gpt-6.1-sol"], ["anthropic", "claude-sonnet-5-5"]] as const)("uses upstream metadata and deduplicates %s/%s", (provider, id) => {
    const upstream = {
      ...builtinCatalog.getBuiltinModel("openai", "gpt-5.4"),
      id,
      name: "Upstream replacement",
      contextWindow: 400000,
    };
    vi.mocked(builtinCatalog.getBuiltinModels).mockReturnValue([upstream]);

    expect(bundledModels(provider)).toEqual([upstream]);
    expect(bundledModel(provider, id)).toBe(upstream);
  });

  it.each([["openai", "gpt-6.1-sol", 1_050_000], ["anthropic", "claude-sonnet-5-5", 1_000_000]] as const)(
    "adds %s/%s with its supported effort levels", (provider, id, contextWindow) => {
      const model = bundledModel(provider, id);
      expect(model).toMatchObject({ id, provider, contextWindow, maxTokens: 128_000, cost: { input: 2, output: 10 } });
      if (!model) throw new Error("Missing supplemental model");
      expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(bundledModels(provider).filter((entry) => entry.id === id)).toHaveLength(1);
    },
  );

  it("records Sol's long-context cache and token prices", () => {
    expect(bundledModel("openai", "gpt-6.1-sol")?.cost).toEqual({
      input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
    });
  });

  it.each(["openai", "anthropic"] as const)("serializes compatible %s requests without network access", async (provider) => {
    const model = bundledModel(provider, provider === "openai" ? "gpt-6.1-sol" : "claude-sonnet-5-5");
    if (!model) throw new Error("Missing supplemental model");
    const requests: Request[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "test response" } }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    };
    const context: TranscriptContext = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
    const options = { apiKey: "test-key", reasoning: "low" as const, temperature: 0.3, fetch: fetchMock };
    if (provider === "openai") {
      expect(model.api).toBe("openai-responses");
      await streamOpenAI({ ...model, api: "openai-responses" }, context, options).result();
    } else {
      expect(model.api).toBe("anthropic-messages");
      await streamAnthropic({ ...model, api: "anthropic-messages" }, context, options).result();
    }
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    const body = await request.json();
    if (provider === "openai") {
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(body.reasoning.effort).toBe("low");
    } else {
      expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
      expect(body.thinking.type).toBe("adaptive");
      expect(body.output_config.effort).toBe("low");
      expect(body.temperature).toBeUndefined();
    }
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
