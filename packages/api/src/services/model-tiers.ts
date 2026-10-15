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
import type { CredentialOwner, CredentialStore, StoredCredential } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs, type LlmProviderRow } from "../schema/index.js";
import { listLlmProviders, parseModelId, providerNamespace } from "./llm-providers.js";
import { hasOrgKey } from "./model-catalog.js";
import { canRunSpec, type CredentialReader } from "./model-resolution.js";

/** The five size tiers, in order. */
export const TIER_TOKENS = ["xs", "s", "m", "l", "xl"] as const;
export type SizeTier = (typeof TIER_TOKENS)[number];
export const TIER_SET: ReadonlySet<string> = new Set(TIER_TOKENS);

/** Narrows an unknown value to a tier token. */
export function isSizeTier(value: unknown): value is SizeTier {
  return typeof value === "string" && TIER_SET.has(value);
}

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
export async function getOrgTierMap(db: AppQueryable, orgId: string, proposedApproved?: string[] | null): Promise<TierMap> {
  const rows = await db
    .select({ modelTiers: orgs.modelTiers, approvedModels: orgs.approvedModels })
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
      // Upgrade retired recommendations only when the replacement is allowed.
      // Explicit session/workflow model IDs remain unchanged and resolvable.
      const approved = proposedApproved === undefined ? rows[0]?.approvedModels : proposedApproved;
      const canUseSol61 = approved == null || (Array.isArray(approved) && approved.includes("openai/gpt-6.1-sol"));
      merged[tier] = [...new Set(entry.map((spec: string) =>
        canUseSol61 && spec === "openai/gpt-5.6-sol" ? "openai/gpt-6.1-sol" : spec))];
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
 * The org's default tier for new sessions (`orgs.default_tier`), or null
 * when unset. A stored value that is not a tier token reads as null.
 */
export async function getOrgDefaultTier(db: AppQueryable, orgId: string): Promise<SizeTier | null> {
  const rows = await db
    .select({ defaultTier: orgs.defaultTier })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  const tier = rows[0]?.defaultTier;
  return isSizeTier(tier) ? tier : null;
}

/** Persist the org's default tier. Null clears it. */
export async function setOrgDefaultTier(db: AppQueryable, orgId: string, tier: SizeTier | null): Promise<void> {
  await db.update(orgs).set({ defaultTier: tier }).where(eq(orgs.id, orgId));
}

/** The known kinds the catalog synthesizes from a deployment env key alone. */
const ENV_FALLBACK_KINDS: readonly string[] = ["anthropic", "openai", "google"];

/**
 * The walk both tier callers share: the first spec in `tier`'s list whose
 * provider is ACTIVE. "Active" mirrors the active-provider walk in
 * `engine/host.ts`:
 *   - Known kind with no row → active (zero-config env-key path).
 *   - Known kind with a row → active iff `row.enabled`.
 *   - Custom (`openai_compatible`) → active iff `row.enabled` AND org key
 *     exists (no env fallback for custom providers).
 *
 * The test asks nothing about keys for a known kind. A run therefore stops
 * at the first ACTIVE entry whether or not a key exists for it, which is why
 * `resolvableTiers` tests that one spec rather than searching the list for
 * any spec that would work.
 *
 * A target that is itself a tier token continues the walk in that tier.
 * `PATCH /api/org/model-tiers` refuses such a target, but a map saved before
 * that check can hold one. `seen` holds every tier the walk has entered, so
 * a cycle such as `m` → [`m`] ends that branch instead of recursing forever.
 * The walk never returns a tier token, so `resolveModelSpec` recurses at
 * most once.
 */
async function firstActiveSpec(
  credentials: CredentialReader,
  orgId: string,
  rows: LlmProviderRow[],
  tierMap: TierMap,
  tier: SizeTier,
  seen: Set<SizeTier> = new Set(),
): Promise<string | undefined> {
  if (seen.has(tier)) return undefined;
  seen.add(tier);
  for (const spec of tierMap[tier]) {
    const token = spec.trim().toLowerCase();
    if (isSizeTier(token)) {
      const nested = await firstActiveSpec(credentials, orgId, rows, tierMap, token, seen);
      if (nested !== undefined) return nested;
      continue;
    }
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
 * Returns `undefined` when no active provider exists for any entry, or when
 * the tier's targets only lead back into a tier the walk already entered.
 * The host surfaces that case with a corrective, tier-specific error rather
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
  if (!isSizeTier(tier)) return undefined;
  const tierMap = await getOrgTierMap(db, orgId);
  const rows = await listLlmProviders(db, orgId);
  return firstActiveSpec(credentials, orgId, rows, tierMap, tier);
}

/**
 * Every tier this org can run today, mapped to the spec it would use. A tier
 * token is always "approved", so save-time validation asks this before it
 * accepts one: without the check a preset stores a tier that resolves to a
 * provider the org holds no key for, and the run fails with no credentials.
 *
 * The test applies to the ONE spec `resolveTier` would pick, not to the
 * list. A run never walks past an active-but-keyless entry to a later usable
 * one, so neither does the gate. The test is `canRunSpec`, which asks the
 * resolver itself: the model must still exist on its provider, and the key
 * must not be blank. The org default tier, the PATCH that saves it, and
 * workflow validation all ask this, so a tier that they accept is one that
 * session creation can resolve. One tier-map read, one provider-row read
 * and at most one resolver test per spec serve all five tiers.
 *
 * `proposed` replaces the stored tier map, so a save can check the map it
 * is about to write.
 */
export async function resolvableTiers(
  db: AppQueryable,
  credentials: CredentialReader,
  orgId: string,
  proposed?: TierMap,
): Promise<Map<SizeTier, string>> {
  const tierMap = proposed ?? (await getOrgTierMap(db, orgId));
  const rows = await listLlmProviders(db, orgId);
  const runnable = new Map<string, boolean>();
  const usable = new Map<SizeTier, string>();
  for (const tier of TIER_TOKENS) {
    const spec = await firstActiveSpec(credentials, orgId, rows, tierMap, tier);
    if (spec === undefined) continue;
    let ok = runnable.get(spec);
    if (ok === undefined) {
      ok = await canRunSpec(rows, credentials, orgId, spec);
      runnable.set(spec, ok);
    }
    if (ok) usable.set(tier, spec);
  }
  return usable;
}

/**
 * A copy of this org's provider keys that answers `get` from memory. A check
 * that runs inside an app-db transaction reads keys through it: PGlite runs
 * one query at a time, so a credential-store read inside the transaction
 * waits for the transaction to end. A provider added after the copy reads
 * as keyless.
 */
export async function orgKeySnapshot(
  db: AppQueryable,
  credentials: CredentialReader,
  orgId: string,
): Promise<CredentialReader> {
  const owner: CredentialOwner = { type: "org", id: orgId };
  const keys = new Map<string, StoredCredential | null>();
  for (const row of await listLlmProviders(db, orgId)) {
    keys.set(`llm:${row.id}`, await credentials.get(owner, `llm:${row.id}`));
  }
  return {
    get: async (o, service) => (o.type === owner.type && o.id === owner.id ? keys.get(service) ?? null : null),
  };
}
