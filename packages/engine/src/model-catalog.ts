/** Bundled model metadata shared by the engine and its hosts. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

// Metadata for releases newer than the pinned SDK. Built-in entries win by ID.
// Sources and compatibility scope: docs/specs/2026-08-24-thread-model-pinning-and-compaction-design.md.
// GPT-6.2 copies pi 1.5.2's GPT-6.1 Sol entry with the GPT-6.2 prices from pi's
// unreleased catalog. Remove both entries when the pinned pi includes them.
const gpt62 = {
  provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1",
  reasoning: true, input: ["text", "image"], contextWindow: 272_000, maxTokens: 128_000,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  compat: {
    supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true,
    supportsMidConvoSystemMessages: true, supportsExplicitPromptCacheMode: true, supportsMidConvoEffort: true,
  },
  inputLimits: {
    maxRequestBytes: 536_870_912,
    images: { maxPerRequest: 1500, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
  },
} satisfies Omit<Model<"openai-responses">, "id" | "name" | "cost">;

const supplementalModels: Model<Api>[] = [
  {
    ...gpt62, id: "gpt-6.2-sol", name: "GPT-6.2 Sol",
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
  },
  {
    ...gpt62, id: "gpt-6.2-astra", name: "GPT-6.2 Astra",
    cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
      tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] },
  },
];

function bundledMetadata(provider: string): Model<Api>[] {
  const builtinProvider = getBuiltinProviders().find((id) => id === provider);
  const upstream = builtinProvider ? [...getBuiltinModels(builtinProvider)] : [];
  const ids = new Set(upstream.map((model) => model.id));
  return [...upstream, ...supplementalModels.filter((model) => model.provider === provider && !ids.has(model.id))];
}

/** Retired choices remain resolvable for existing sessions, but cannot be selected anew. */
export function isCatalogModel(provider: string, modelId: string): boolean {
  return !(provider === "openai" && modelId === "gpt-5.6-sol");
}

/** Selectable bundled models. Retired metadata remains available for billing. */
export function bundledModels(provider: string): Model<Api>[] {
  return bundledMetadata(provider).filter((model) => isCatalogModel(provider, model.id));
}

/** Historical usage pricing only; this lookup does not authorize execution. */
export function bundledPricingModel(provider: string, modelId: string): Model<Api> | undefined {
  return bundledMetadata(provider).find((model) => model.id === modelId);
}

/** One bundled model by provider and wire id, or undefined when unknown. */
export function bundledModel(provider: string, modelId: string): Model<Api> | undefined {
  return bundledMetadata(provider).find((model) => model.id === modelId);
}

// Official OpenAI model pages and image-generation guide verified 2026-10-09.
const NATIVE_IMAGE_MODELS = new Set(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano"]);

/** Unknown models and other providers always use the plugin fallback. */
export function supportsNativeImageGeneration(model: { provider: string; api: string; id: string }): boolean {
  return model.provider === "openai" && model.api === "openai-responses" && NATIVE_IMAGE_MODELS.has(model.id);
}
