/** Bundled model metadata shared by the engine and its hosts. */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

/** Pi's bundled catalog. */
export function bundledModels(provider: string): Model<Api>[] {
  const builtinProvider = getBuiltinProviders().find((id) => id === provider);
  return builtinProvider ? [...getBuiltinModels(builtinProvider)] : [];
}

/** One bundled model by provider and wire id, or undefined when unknown. */
export function bundledModel(provider: string, modelId: string): Model<Api> | undefined {
  return bundledModels(provider).find((model) => model.id === modelId);
}
