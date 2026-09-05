/** Bundled model metadata shared by the engine and its hosts. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** Manual models that pi has not released. Pi bundled entries win by id. */
const MANUAL_BUNDLED_MODELS: Partial<Record<string, Model<Api>[]>> = {
  openai: [
    // Source: generated openai.json at unreleased pi commit 17de82d7, after v0.85.0.
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
      },
      contextWindow: 272000,
      maxTokens: 128000,
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
    } satisfies Model<"openai-responses">,
  ],
};

/** Pi's catalog plus manual entries. Pi entries win when an id exists in both. */
export function bundledModels(provider: string): Model<Api>[] {
  const builtinProvider = getBuiltinProviders().find((id) => id === provider);
  const builtin = builtinProvider ? [...getBuiltinModels(builtinProvider)] : [];
  const manual = Object.hasOwn(MANUAL_BUNDLED_MODELS, provider) ? MANUAL_BUNDLED_MODELS[provider] : undefined;
  if (!manual) return builtin;
  const builtinIds = new Set(builtin.map((model) => model.id));
  return [...builtin, ...manual.filter((model) => !builtinIds.has(model.id))];
}

/** One bundled model by provider and wire id, or undefined when unknown. */
export function bundledModel(provider: string, modelId: string): Model<Api> | undefined {
  return bundledModels(provider).find((model) => model.id === modelId);
}
