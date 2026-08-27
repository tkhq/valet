import { getModel, calculateCost } from "@mariozechner/pi-ai";
import type { ProviderKind, ProxyUsage } from "../proxy/types.js";

/** pi-ai provider key for our two proxy kinds. Codex talks the Responses
 * API but its models live under the "openai" provider in pi-ai's registry. */
function piProvider(kind: ProviderKind): "anthropic" | "openai" {
  return kind;
}

/**
 * Prices a proxied turn using the SAME table the engine's cost comes from
 * (pi-ai `calculateCost`). Returns null — UNPRICED, never 0 — when the model
 * is not in pi-ai's registry, so the caller stores NULL and a later
 * reprocess can price it. See spec finding 3.
 */
export function priceUsage(kind: ProviderKind, modelId: string, usage: ProxyUsage): number | null {
  let model;
  try {
    // getModel is generically typed on literal ids; at runtime it indexes
    // MODELS[provider][id]. Cast the id to the index type — a genuine
    // third-party-typing narrowing (CLAUDE.md rule 3), commented here.
    model = getModel(piProvider(kind), modelId as never);
  } catch {
    return null;
  }
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
}
