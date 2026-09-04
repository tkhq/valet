import { curatedForCatalogId, sameModelSpec } from "~/lib/models";
import type { GetModelTiersResponse, ModelInfo } from "@valet/api/wire";

/**
 * Size-tier vocabulary for the org model-tier settings
 * (`GET`/`PATCH /api/org/model-tiers`). A tier maps to an ordered list of
 * model specs the engine resolves at run time — see
 * `packages/api/src/services/model-tiers.ts` for the server-side tier map.
 */
export const SIZE_TIERS = ["xs", "s", "m", "l", "xl"] as const;

export type SizeTier = (typeof SIZE_TIERS)[number];

export const TIER_LABELS: Record<SizeTier, string> = {
  xs: "Extra Small",
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "X-Large",
};

/** Narrows a string to a known `SizeTier`. Rejects `null`/`undefined`. */
export function isSizeTier(id: string | null | undefined): id is SizeTier {
  return !!id && (SIZE_TIERS as readonly string[]).includes(id);
}

/** Human label for a tier id, or the id unchanged when it isn't a known tier. */
export function tierLabel(id: string): string {
  return isSizeTier(id) ? TIER_LABELS[id] : id;
}

/** Human label for a concrete catalog model id — the curated tier label
 * when the id matches a known Anthropic tier (bare or `anthropic/`-
 * namespaced), else the catalog's own `name`, else the id verbatim. Shared
 * by the chat `ModelPicker` and the settings `ModelCombobox` so a model's
 * label never drifts between the two surfaces. */
export function labelFor(id: string, models: ModelInfo[]): string {
  const curated = curatedForCatalogId(id);
  if (curated) return curated.label;
  return models.find((m) => m.id === id)?.name ?? id;
}

/** First active catalog model for a tier, in configured target order. */
export function resolveTierModel(
  tier: SizeTier,
  tierMap: GetModelTiersResponse | undefined,
  models: ModelInfo[],
): ModelInfo | undefined {
  for (const target of tierMap?.[tier] ?? []) {
    const model = models.find((entry) => entry.active && sameModelSpec(entry.id, target));
    if (model) return model;
  }
  return undefined;
}

/** Label for a closed model control. Tier labels remain picker helper text. */
export function selectionLabel(
  id: string,
  tierMap: GetModelTiersResponse | undefined,
  models: ModelInfo[],
): string {
  if (isSizeTier(id)) return resolveTierModel(id, tierMap, models)?.name ?? TIER_LABELS[id];
  return models.find((model) => sameModelSpec(model.id, id))?.name ?? labelFor(id, models);
}

/** Subtitle for a Size tier row: the catalog name of the tier's first
 * configured target, resolved against `models`. Falls back to the raw spec
 * string when the target isn't in the catalog (a stale/retired pin), and
 * to `undefined` when the tier has no configured targets or the tier map
 * hasn't loaded yet. */
export function tierSubtitle(
  tier: SizeTier,
  tierMap: GetModelTiersResponse | undefined,
  models: ModelInfo[],
): string | undefined {
  const resolved = resolveTierModel(tier, tierMap, models);
  if (resolved) return resolved.name;
  return tierMap?.[tier]?.[0];
}
