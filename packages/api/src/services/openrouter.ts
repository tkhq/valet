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
  "anthropic/claude-opus-5",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-fable-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
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

/**
 * OpenRouter's live model catalog endpoint (public — no key required).
 * Env-overridable so tests can point it at a local fixture server instead
 * of the real network.
 */
export function openrouterModelsUrl(): string {
  return process.env.VALET_OPENROUTER_MODELS_URL ?? "https://openrouter.ai/api/v1/models";
}

/**
 * Parse OpenRouter's live `GET /api/v1/models` payload into row-ready
 * entries. Live pricing is per-TOKEN decimal strings ("0.000003"); the
 * catalog convention (matching pi-ai `Model.cost`) is per-MILLION tokens,
 * so values are scaled by 1e6. Malformed entries are skipped, never
 * guessed at. Pure — unit-tested against a fixture payload.
 */
export function parseOpenrouterLiveModels(payload: unknown): LlmProviderModel[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: LlmProviderModel[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || m.id.length === 0) continue;
    const name = typeof m.name === "string" && m.name.length > 0 ? m.name : m.id;
    const contextWindow = typeof m.context_length === "number" ? m.context_length : undefined;
    let pricing: LlmProviderModel["pricing"];
    const p = m.pricing;
    if (typeof p === "object" && p !== null) {
      const input = Number((p as Record<string, unknown>).prompt);
      const output = Number((p as Record<string, unknown>).completion);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        pricing = { input: input * 1e6, output: output * 1e6 };
      }
    }
    out.push({ id: m.id, name, contextWindow, pricing });
  }
  return out;
}

/**
 * The full pickable OpenRouter catalog: the LIVE catalog (fresh models the
 * pi-ai registry snapshot doesn't know yet — the reason this exists)
 * merged with the registry (fallback metadata + offline resilience). Live
 * entries win on id collisions. A live-fetch failure degrades to
 * registry-only rather than erroring — the picker must keep working
 * offline. Returns whether the live catalog contributed.
 */
export async function mergedOpenrouterModels(): Promise<{ models: LlmProviderModel[]; live: boolean }> {
  const byId = new Map<string, LlmProviderModel>();
  for (const m of openrouterRegistry().values()) byId.set(m.id, toProviderModel(m));

  let live = false;
  try {
    const res = await fetch(openrouterModelsUrl(), { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const parsed = parseOpenrouterLiveModels(await res.json());
      if (parsed.length > 0) {
        live = true;
        for (const m of parsed) byId.set(m.id, m);
      }
    }
  } catch {
    // Network/timeout — registry-only result is still useful.
  }

  const models = Array.from(byId.values());
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, live };
}
