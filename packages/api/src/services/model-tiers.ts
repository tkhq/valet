/**
 * Model size tiers (TKAI-285): the tier map and resolution helpers.
 *
 * A tier (`xs`, `s`, `m`, `l`, `xl`) maps to an ordered list of concrete
 * model specs. Resolution walks the list and returns the first spec whose
 * provider is active — the same active-provider walk `firstActivePreference`
 * in `engine/host.ts` applies to the team-default cascade tier. Org model
 * preferences are removed; these per-tier lists are the org's fallback now.
 *
 * The org's tier map lives in `orgs.model_tiers` (jsonb, nullable). A null
 * column means "use built-in defaults".
 */
import { eq } from "drizzle-orm";
import type { CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";
import { listLlmProviders, parseModelId, providerNamespace } from "./llm-providers.js";
import { hasOrgKey } from "./model-catalog.js";

/** The five size tiers, in order. */
export const TIER_TOKENS = ["xs", "s", "m", "l", "xl"] as const;
export type SizeTier = (typeof TIER_TOKENS)[number];
export const TIER_SET: ReadonlySet<string> = new Set(TIER_TOKENS);

/** Tier → ordered list of concrete namespaced model specs. */
export type TierMap = Record<SizeTier, string[]>;

/** Built-in defaults when the org has no `model_tiers` set. */
export const DEFAULT_TIER_MAP: TierMap = {
  xs: ["anthropic/claude-haiku-4-5"],
  s: ["anthropic/claude-haiku-4-5"],
  m: ["anthropic/claude-sonnet-4-6"],
  l: ["anthropic/claude-opus-4-7"],
  xl: ["anthropic/claude-opus-4-7"],
};

/**
 * Read the org's tier map from `orgs.model_tiers`, falling back to defaults
 * when the column is null or not a valid object.
 */
export async function getOrgTierMap(db: AppQueryable, orgId: string): Promise<TierMap> {
  const rows = await db
    .select({ modelTiers: orgs.modelTiers })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  const raw = rows[0]?.modelTiers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_TIER_MAP };
  // Merge stored tiers over defaults: a partial stored map fills only the
  // tiers it names; missing tiers keep the default.
  const stored = raw as Record<string, unknown>;
  const merged: TierMap = { ...DEFAULT_TIER_MAP };
  for (const tier of TIER_TOKENS) {
    const entry = stored[tier];
    if (Array.isArray(entry) && entry.every((v) => typeof v === "string")) {
      merged[tier] = entry as string[];
    }
  }
  return merged;
}

/**
 * Persist the org's tier map. Callers must validate specs before calling.
 */
export async function setOrgTierMap(db: AppQueryable, orgId: string, tierMap: TierMap): Promise<void> {
  await db.update(orgs).set({ modelTiers: tierMap }).where(eq(orgs.id, orgId));
}

/**
 * Walk a tier's spec list and return the first spec whose provider is active.
 * Returns `undefined` when no active provider exists for any entry — the
 * host surfaces that case with a corrective, tier-specific error rather
 * than a generic "unknown model" message.
 *
 * "Active" mirrors the catalog/active-provider-walk logic in `engine/host.ts`:
 *   - Known kind with no row → active (zero-config env-key path).
 *   - Known kind with a row → active iff `row.enabled`.
 *   - Custom (`openai_compatible`) → active iff `row.enabled` AND org key
 *     exists (no env fallback for custom providers).
 */
export async function resolveTier(
  db: AppQueryable,
  credentials: CredentialStore,
  orgId: string,
  tier: string,
): Promise<string | undefined> {
  const tierMap = await getOrgTierMap(db, orgId);
  const specs = tierMap[tier as SizeTier];
  if (!specs || specs.length === 0) return undefined;

  const rows = await listLlmProviders(db, orgId);

  for (const spec of specs) {
    const { namespace } = parseModelId(spec);
    const row = rows.find((r) => providerNamespace(r) === namespace);
    let active: boolean;
    if (!row) {
      // Zero-config path: known kinds with an env key are always active.
      active = namespace === "anthropic" || namespace === "openai" || namespace === "google";
    } else if (row.kind === "openai_compatible") {
      active = row.enabled && (await hasOrgKey(credentials, orgId, row.id));
    } else {
      active = row.enabled;
    }
    if (active) return spec;
  }
  return undefined;
}

