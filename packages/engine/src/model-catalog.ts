/** Bundled model metadata shared by the engine and its hosts. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** Deprecated model ids must not be selectable from any catalog source. */
const HIDDEN_MODEL_IDS: ReadonlySet<string> = new Set(["openai/gpt-5.6-sol"]);

/** True when a provider model may appear in Valet's catalog. */
export function isCatalogModel(provider: string, modelId: string): boolean {
  return !HIDDEN_MODEL_IDS.has(`${provider}/${modelId}`);
}

/** Pi's bundled catalog, filtered through Valet's catalog policy. */
export function bundledModels(provider: string): Model<Api>[] {
  const builtinProvider = getBuiltinProviders().find((id) => id === provider);
  return builtinProvider
    ? getBuiltinModels(builtinProvider).filter((model) => isCatalogModel(provider, model.id))
    : [];
}

/**
 * One bundled model by provider and wire id, or undefined when unknown.
 *
 * This lookup intentionally bypasses catalog visibility. A retired model is
 * not selectable, but sessions and defaults persisted before its retirement
 * must keep resolving while the provider continues to serve it.
 */
export function bundledModel(provider: string, modelId: string): Model<Api> | undefined {
  const builtinProvider = getBuiltinProviders().find((id) => id === provider);
  return builtinProvider
    ? getBuiltinModels(builtinProvider).find((model) => model.id === modelId)
    : undefined;
}
