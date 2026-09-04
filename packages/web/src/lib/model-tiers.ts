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
