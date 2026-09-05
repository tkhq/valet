import { calculateCost } from "@earendil-works/pi-ai/compat";
import { bundledModel } from "@valet/engine/model-catalog";
import type { ProviderKind, ProxyUsage } from "../proxy/types.js";

/** pi-ai provider key for our two proxy kinds. Codex talks the Responses
 * API but its models live under the "openai" provider in pi-ai's registry. */
function piProvider(kind: ProviderKind): "anthropic" | "openai" {
  return kind;
}

function inRegistry(kind: ProviderKind, id: string): boolean {
  try {
    return !!bundledModel(piProvider(kind), id);
  } catch {
    return false;
  }
}

/**
 * Resolves a provider model id to the bundled catalog key whose rate prices it,
 * or null if unpriceable. The id itself when the catalog knows it; else its
 * date-suffix-stripped form if THAT is known — providers return a dated id in
 * responses (`gpt-4o-mini-2024-07-18`, `gpt-5-2025-08-07`,
 * `claude-haiku-4-5-20251001`) that is not a registry key, while the base id
 * (`gpt-4o-mini`, `gpt-5`, `claude-haiku-4-5`) is. Centralizing the fallback
 * here keeps every caller from re-implementing the strip-and-retry.
 */
export function resolveCanonicalModel(kind: ProviderKind, id: string): string | null {
  if (inRegistry(kind, id)) return id;
  // Strip only a trailing PLAUSIBLE calendar date so an id whose base name
  // merely ends in digits isn't mis-stripped onto a different model. OpenAI
  // dates are `-YYYY-MM-DD`; Anthropic dates are `-YYYYMMDD`. Month 01-12,
  // day 01-31. The `inRegistry` guard below is the real safety net.
  const date = "(?:20\\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])|20\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01]))";
  const stripped = id.match(new RegExp(`^(.*?)-${date}$`))?.[1];
  if (stripped && inRegistry(kind, stripped)) return stripped;
  return null;
}

/**
 * Prices a proxied turn with bundled model metadata and pi-ai `calculateCost`.
 * If the bundled catalog has no matching model, returns null so the caller
 * stores an unpriced record for later reprocessing. See spec finding 3.
 */
export function priceUsage(kind: ProviderKind, modelId: string, usage: ProxyUsage): number | null {
  // The WHOLE computation is guarded: an unknown model OR a throw from pi-ai's
  // pricing returns null (UNPRICED), never propagates. The recorder prices
  // inside its row build, so a pricing throw escaping here would abort the
  // insert and LOSE the entire recording (raw bodies included).
  try {
    const canonical = resolveCanonicalModel(kind, modelId);
    if (!canonical) return null;
    const model = bundledModel(piProvider(kind), canonical);
    if (!model) return null;
    const cost = calculateCost(model, {
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      totalTokens: usage.total,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    return cost.total;
  } catch {
    return null;
  }
}
