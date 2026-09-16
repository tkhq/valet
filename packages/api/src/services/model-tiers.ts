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
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs, type LlmProviderRow } from "../schema/index.js";
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

/** The known kinds the catalog synthesizes from a deployment env key alone. */
const ENV_FALLBACK_KINDS: readonly string[] = ["anthropic", "openai", "google"];

/**
 * The walk both tier callers share: the first spec in `specs` whose provider
 * is ACTIVE. "Active" mirrors the active-provider walk in `engine/host.ts`:
 *   - Known kind with no row → active (zero-config env-key path).
 *   - Known kind with a row → active iff `row.enabled`.
 *   - Custom (`openai_compatible`) → active iff `row.enabled` AND org key
 *     exists (no env fallback for custom providers).
 *
 * The test asks nothing about keys for a known kind. A run therefore stops
 * at the first ACTIVE entry whether or not a key exists for it, which is why
 * `resolvableTiers` key-tests that one spec rather than searching the list
 * for any spec that would work.
 */
async function firstActiveSpec(
  credentials: CredentialStore,
  orgId: string,
  rows: LlmProviderRow[],
  specs: string[] | undefined,
): Promise<string | undefined> {
  for (const spec of specs ?? []) {
    const { namespace } = parseModelId(spec);
    const row = rows.find((r) => providerNamespace(r) === namespace);
    let active: boolean;
    if (!row) {
      active = ENV_FALLBACK_KINDS.includes(namespace);
    } else if (row.kind === "openai_compatible") {
      active = row.enabled && (await hasOrgKey(credentials, orgId, row.id));
    } else {
      active = row.enabled;
    }
    if (active) return spec;
  }
  return undefined;
}

/**
 * Walk a tier's spec list and return the first spec whose provider is active.
 * Returns `undefined` when no active provider exists for any entry — the
 * host surfaces that case with a corrective, tier-specific error rather
 * than a generic "unknown model" message.
 *
 * This deliberately ignores whether a key exists for a known kind. The
 * session cascade bottoms out here, and it wants a model object even on an
 * org that has configured no key yet, so the run can ask for one instead of
 * failing to build a session. Save-time validation needs the stricter
 * question — can this org RUN the tier today — and asks `resolvableTiers`.
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
  return firstActiveSpec(credentials, orgId, rows, specs);
}

/**
 * Can this org reach the provider behind `namespace` with a key right now?
 * The test mirrors `buildOrgCatalog`'s own `active` rule:
 *   - Known kind with no row → usable only when the deployment env holds a
 *     key for it (the zero-config path).
 *   - Known kind with a row → usable when the row is enabled AND a key
 *     exists, either the org's own or the deployment env's.
 *   - Custom (`openai_compatible`) → usable when the row is enabled AND the
 *     org holds a key (no env fallback for custom providers).
 */
async function isNamespaceUsable(
  credentials: CredentialStore,
  orgId: string,
  rows: LlmProviderRow[],
  namespace: string,
): Promise<boolean> {
  const row = rows.find((r) => providerNamespace(r) === namespace);
  if (!row) return ENV_FALLBACK_KINDS.includes(namespace) && Boolean(getEnvApiKey(namespace));
  if (!row.enabled) return false;
  if (row.kind === "openai_compatible") return hasOrgKey(credentials, orgId, row.id);
  return (await hasOrgKey(credentials, orgId, row.id)) || Boolean(getEnvApiKey(row.kind));
}

/**
 * Every tier this org can run today, mapped to the spec it would use. A tier
 * token is always "approved", so save-time validation asks this before it
 * accepts one: without the check a preset stores a tier that resolves to a
 * provider the org holds no key for, and the run fails with no credentials.
 *
 * The key test applies to the ONE spec `resolveTier` would pick, not to the
 * list. A run never walks past an active-but-keyless entry to a later usable
 * one, so neither does the gate. One tier-map read, one provider-row read
 * and at most one key test per namespace serve all five tiers.
 */
export async function resolvableTiers(
  db: AppQueryable,
  credentials: CredentialStore,
  orgId: string,
): Promise<Map<SizeTier, string>> {
  const tierMap = await getOrgTierMap(db, orgId);
  const rows = await listLlmProviders(db, orgId);
  const usableByNamespace = new Map<string, boolean>();
  const usable = new Map<SizeTier, string>();
  for (const tier of TIER_TOKENS) {
    const spec = await firstActiveSpec(credentials, orgId, rows, tierMap[tier]);
    if (spec === undefined) continue;
    const { namespace } = parseModelId(spec);
    let ok = usableByNamespace.get(namespace);
    if (ok === undefined) {
      ok = await isNamespaceUsable(credentials, orgId, rows, namespace);
      usableByNamespace.set(namespace, ok);
    }
    if (ok) usable.set(tier, spec);
  }
  return usable;
}
