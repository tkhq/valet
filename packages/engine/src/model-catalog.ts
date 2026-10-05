/** Bundled model metadata shared by the engine and its hosts. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

// Metadata for releases newer than the pinned SDK. Built-in entries win by ID.
// Sources and compatibility scope: docs/specs/2026-10-05-model-catalog-refresh-design.md.
const supplementalModels: Model<Api>[] = [
  {
    id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", api: "openai-responses",
    baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"],
    contextWindow: 1_050_000, maxTokens: 128_000,
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  },
  {
    id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com", reasoning: true, input: ["text", "image"],
    contextWindow: 1_000_000, maxTokens: 128_000,
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
  },
];

/** Astra is excluded across providers, aliases, and dated model IDs. */
export function isDisabledModel(spec: string): boolean {
  const id = spec.trim().toLowerCase().split("/").at(-1) ?? "";
  return /(^|[^a-z0-9])astra($|[^a-z0-9])/.test(id);
}

export function assertModelEnabled(spec: string): void {
  if (isDisabledModel(spec)) {
    throw new Error("Astra is disabled in Valet. Choose GPT-6.1 Sol or Claude Opus 5.5.");
  }
}

function bundledMetadata(provider: string): Model<Api>[] {
  const builtinProvider = getBuiltinProviders().find((id) => id === provider);
  const upstream = builtinProvider ? [...getBuiltinModels(builtinProvider)] : [];
  const ids = new Set(upstream.map((model) => model.id));
  return [...upstream, ...supplementalModels.filter((model) => model.provider === provider && !ids.has(model.id))];
}

/** Selectable bundled models. Disabled metadata remains available for billing. */
export function bundledModels(provider: string): Model<Api>[] {
  return bundledMetadata(provider).filter((model) => !isDisabledModel(model.id));
}

/** Historical usage pricing only; this lookup does not authorize execution. */
export function bundledPricingModel(provider: string, modelId: string): Model<Api> | undefined {
  return bundledMetadata(provider).find((model) => model.id === modelId);
}

/** One bundled model by provider and wire id, or undefined when unknown. */
export function bundledModel(provider: string, modelId: string): Model<Api> | undefined {
  return bundledModels(provider).find((model) => model.id === modelId);
}
