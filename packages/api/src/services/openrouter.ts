/**
 * OpenRouter provider support (llm-providers design, openrouter extension).
 *
 * OpenRouter is a known provider kind backed by pi-ai's `openrouter`
 * registry (~274 models, `openai-completions` API, baseUrl preset, env key
 * `OPENROUTER_API_KEY`). Unlike the other known kinds, the full registry is
 * far too large for pickers, so the org's catalog exposure is a **curated
 * selection** stored on the provider row's `models` column (the same column
 * custom providers use for their declared list):
 *
 *   - Row create seeds `models` with `OPENROUTER_DEFAULT_MODEL_IDS`.
 *   - Admins edit the selection in settings via the full-registry picker
 *     (`GET /api/org/llm-providers/openrouter/models`).
 *   - Zero-config boot (env key, no row) synthesizes the curated set only.
 *
 * The selection governs catalog/picker visibility ONLY — model RESOLUTION
 * accepts any registry model (`services/model-resolution.ts`), so a session
 * persisted on a de-selected model keeps resolving, mirroring the
 * live-vs-picker split used everywhere else.
 *
 * Registry model ids contain slashes (`deepseek/deepseek-v4-pro`), so the
 * namespaced catalog id nests: `openrouter/deepseek/deepseek-v4-pro`.
 * `parseModelId` splits on the FIRST slash, so the round-trip holds.
 */
import { getModels, type Api, type Model } from "@mariozechner/pi-ai";
import type { LlmProviderModel } from "../schema/index.js";

/** Registry entry type — openrouter models are all `openai-completions`,
 * but `getModels` returns the wider `Model<Api>`; keep the wider type. */
export type OpenrouterRegistryModel = Model<Api>;

/**
 * Default selection seeded onto a new openrouter provider row and exposed
 * on zero-config env-key boots. Every id must exist in pi-ai's openrouter
 * registry — pinned by `openrouter.test.ts` so a registry bump that drops
 * one fails loudly instead of silently shrinking the catalog.
 */
export const OPENROUTER_DEFAULT_MODEL_IDS: readonly string[] = [
  "anthropic/claude-opus-4.6",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-4.1",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-r1",
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2-thinking",
  "x-ai/grok-4",
  "meta-llama/llama-3.3-70b-instruct",
];

/** The full pi-ai openrouter registry, keyed by model id. */
export function openrouterRegistry(): Map<string, OpenrouterRegistryModel> {
  return new Map(getModels("openrouter").map((m) => [m.id, m]));
}

/** Registry model → the row/catalog `LlmProviderModel` shape. */
export function toProviderModel(m: OpenrouterRegistryModel): LlmProviderModel {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    pricing: { input: m.cost.input, output: m.cost.output },
  };
}

/** The curated default selection as row-ready entries (registry-resolved;
 * ids missing from the registry are dropped rather than invented). */
export function curatedOpenrouterModels(): LlmProviderModel[] {
  const registry = openrouterRegistry();
  const out: LlmProviderModel[] = [];
  for (const id of OPENROUTER_DEFAULT_MODEL_IDS) {
    const m = registry.get(id);
    if (m) out.push(toProviderModel(m));
  }
  return out;
}
