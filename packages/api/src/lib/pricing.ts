// `getModel` is the compat catalog read; `calculateCost` is the same pricing
// table the engine's cost comes from. (The newer `getBuiltinModel` lives under
// `/providers/all`, not `/compat`, so the whole app stays on `/compat`.)
import { getModel, calculateCost } from "@earendil-works/pi-ai/compat";
import type { ProviderKind, ProxyUsage } from "../proxy/types.js";

/** pi-ai provider key for our two proxy kinds. Codex talks the Responses
 * API but its models live under the "openai" provider in pi-ai's registry. */
function piProvider(kind: ProviderKind): "anthropic" | "openai" {
  return kind;
}

function inRegistry(kind: ProviderKind, id: string): boolean {
  try {
    // getModel is generically typed on literal ids; at runtime it
    // indexes MODELS[provider][id]. Cast the id to the index type — a genuine
    // third-party-typing narrowing (CLAUDE.md rule 3), commented here.
    return !!getModel(piProvider(kind), id as never);
  } catch {
    return false;
  }
}

/**
 * Resolves a provider model id to the pi-ai REGISTRY KEY whose rate prices it,
 * or null if unpriceable. The id itself when pi-ai knows it; else its
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
 * Prices a proxied turn using the SAME table the engine's cost comes from
 * (pi-ai `calculateCost`). Returns null — UNPRICED, never 0 — when the model
 * is not in pi-ai's registry, so the caller stores NULL and a later
 * reprocess can price it. See spec finding 3.
 */
export function priceUsage(kind: ProviderKind, modelId: string, usage: ProxyUsage): number | null {
  // The WHOLE computation is guarded: an unknown model OR a throw from pi-ai's
  // pricing returns null (UNPRICED), never propagates. The recorder prices
  // inside its row build, so a pricing throw escaping here would abort the
  // insert and LOSE the entire recording (raw bodies included).
  try {
    const canonical = resolveCanonicalModel(kind, modelId);
    if (!canonical) return null;
    const model = getModel(piProvider(kind), canonical as never);
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
