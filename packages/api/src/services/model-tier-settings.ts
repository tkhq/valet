/** Shared tier validation keeps conversational changes on the same policy lock as HTTP changes. */
import type { CredentialStore } from "@valet/engine";
import type { AppDb, AppQueryable, AppTx } from "../lib/drizzle.js";
import {
  getOrgDefaultTier,
  getOrgTierMap,
  isSizeTier,
  orgKeySnapshot,
  resolvableTiers,
  setOrgDefaultTier,
  setOrgTierMap,
  TIER_TOKENS,
  type SizeTier,
  type TierMap,
} from "../services/model-tiers.js";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import { getApprovedModels, isApproved, lockOrgModelPolicy } from "../services/approved-models.js";
import type { GetModelTiersResponse, PatchModelTiersRequest } from "../wire/types.js";
import type { CredentialReader } from "./model-resolution.js";

interface PreparedModelTierPatch {
  patch: PatchModelTiersRequest;
  defaultTier: SizeTier | null | undefined;
  validIds: ReadonlySet<string> | null;
  keys: CredentialReader | null;
}

/**
 * Pure validation: every spec in a tier map must be in the approved list,
 * or the function returns an error message naming the corrective action.
 * A null approved list (unrestricted catalog) returns null.
 * Tier tokens always pass the approval check (resolved at runtime).
 */
export function tierTargetsNotApproved(merged: TierMap, approved: string[] | null): string | null {
  if (approved === null) return null;
  for (const tier of TIER_TOKENS) {
    for (const spec of merged[tier]) {
      if (!isApproved(approved, spec)) {
        return `Model "${spec}" in tier "${tier}" is not approved. Approve it first in Settings → Organization → Models.`;
      }
    }
  }
  return null;
}

/** `current` with each tier that `patch` names replaced. */
function applyTierPatch(current: TierMap, patch: PatchModelTiersRequest): TierMap {
  const merged: TierMap = { ...current };
  for (const tier of TIER_TOKENS) {
    const replacement = patch[tier];
    if (replacement) merged[tier] = replacement;
  }
  return merged;
}

/**
 * The response body for both verbs. `defaultTierResolvable` uses the test
 * that `EngineHost` applies at session start, so the web labels never claim
 * a default tier that new sessions skip.
 */
export async function tiersResponse(
  db: AppQueryable,
  credentials: CredentialStore,
  orgId: string,
  tierMap: TierMap,
  defaultTier: SizeTier | null,
): Promise<GetModelTiersResponse> {
  const defaultTierResolvable =
    defaultTier !== null && (await resolvableTiers(db, credentials, orgId, tierMap)).has(defaultTier);
  return { ...tierMap, defaultTier, defaultTierResolvable };
}

export async function patchModelTiers(db: AppDb, engineCredentials: CredentialStore, user: { orgId: string }, parsed: unknown): Promise<GetModelTiersResponse | { error: string }> {
  const prepared = await prepareModelTierPatch(db, engineCredentials, user.orgId, parsed);
  if ("error" in prepared) return prepared;
  const result = await db.transaction((tx) => saveModelTierPatch(tx, user.orgId, prepared));
  if ("error" in result) return result;
  return await tiersResponse(db, engineCredentials, user.orgId, result.tierMap, result.defaultTier);
}

/** Validate input and copy credentials before the caller opens a transaction. */
export async function prepareModelTierPatch(db: AppDb, engineCredentials: CredentialStore, orgId: string, parsed: unknown): Promise<PreparedModelTierPatch | { error: string }> {
  if (!isRecord(parsed)) return { error: "Send a JSON object with tier settings." };
  const raw: Record<string, unknown> = parsed;
  // Validate: only known tier keys and `defaultTier`, each tier value an
  // array of strings.
  const unknownKeys = Object.keys(raw).filter(
    (k) => k !== "defaultTier" && !TIER_TOKENS.some(tier => tier === k),
  );
  if (unknownKeys.length > 0) {
    return { error: `unknown tier(s): ${unknownKeys.join(", ")}. Valid tiers: ${TIER_TOKENS.join(", ")}` };
  }
  const defaultTier = raw.defaultTier;
  if (defaultTier !== undefined && defaultTier !== null && !isSizeTier(defaultTier)) {
    return { error: `defaultTier must be one of ${TIER_TOKENS.join(", ")}, or null to clear it.` };
  }

  // Validate and narrow to PatchModelTiersRequest.
  const validated: Record<string, string[]> = {};
  for (const tier of TIER_TOKENS) {
    if (tier in raw) {
      const val = raw[tier];
      if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) {
        return { error: `${tier} must be an array of model spec strings` };
      }
      if (val.length === 0) {
        return { error: `${tier} must have at least one model spec` };
      }
      validated[tier] = val;
    }
  }
  const patch: PatchModelTiersRequest = validated;

  // These reads use the credential store, so they run before the
  // transaction: PGlite runs one query at a time, and a credential read
  // inside the transaction would wait for the transaction to end. A body
  // with only `defaultTier` leaves the stored tier map alone, so it skips
  // the catalog check. The key copy serves the default-tier check below.
  const changesTiers = TIER_TOKENS.some((tier) => tier in validated);
  const validIds = changesTiers ? catalogValidIds(await buildOrgCatalog(db, engineCredentials, orgId)) : null;
  const keys = changesTiers || isSizeTier(defaultTier) ? await orgKeySnapshot(db, engineCredentials, orgId) : null;
  return { patch, defaultTier, validIds, keys };
}

/** Check current policy and save tiers within the caller's transaction. */
export async function saveModelTierPatch(tx: AppTx, orgId: string, prepared: PreparedModelTierPatch): Promise<{ tierMap: TierMap; defaultTier: SizeTier | null } | { error: string }> {
  const { patch, defaultTier, validIds, keys } = prepared;
  await lockOrgModelPolicy(tx, orgId);
  // Every check reads the tier map and the default tier under the same
  // row lock that approved-model writes use. A request that another save
  // overtook checks that save's result, not the state it first read.
  const current = await getOrgTierMap(tx, orgId);

  // The catalog accepts tier tokens as model specs, so this check comes
  // first. Without it, `{ "m": ["m"] }` saves a tier with no model.
  // A map saved before this check can hold a tier token. The tier that
  // holds it can keep it, so the Models page can add a model to that
  // tier and then remove the token. This adds no new tier-to-tier link.
  for (const tier of TIER_TOKENS) {
    const tierTarget = patch[tier]?.find((v) => isSizeTier(v.trim().toLowerCase()) && !current[tier].includes(v));
    if (tierTarget !== undefined) {
      return {
        error: `Tier "${tier}" cannot target the tier token "${tierTarget}". Pick a model from the model list (GET /api/models) for each target.`,
      };
    }
  }
  const merged = applyTierPatch(current, patch);

  if (validIds) {
    for (const tier of TIER_TOKENS) {
      for (const spec of merged[tier]) {
        if (!validIds.has(spec)) {
          return { error: `unknown model spec "${spec}" in tier "${tier}". Pick a model from the model list (GET /api/models).` };
        }
      }
    }

    const approvalErr = tierTargetsNotApproved(merged, await getApprovedModels(tx, orgId));
    if (approvalErr) return { error: approvalErr };
  }

  // The default tier must resolve in the tier map this request leaves
  // behind, or new sessions skip it. The check covers a new default, and
  // the saved default on every tier edit: a saved default can resolve
  // through another tier when a map saved before the tier-token rule
  // holds one. An edit that breaks a working saved default is refused,
  // not saved with the default cleared: clearing would move every new
  // thread to "s" as a side effect of a tier edit, with no sign to the
  // admin. A saved default that a key or provider change already broke
  // does not block tier edits. The response reports it as unusable.
  const effectiveDefault = defaultTier === undefined ? await getOrgDefaultTier(tx, orgId) : defaultTier;
  if (keys && effectiveDefault !== null) {
    const mustBeUsable =
      defaultTier !== undefined || (await resolvableTiers(tx, keys, orgId, current)).has(effectiveDefault);
    if (mustBeUsable && !(await resolvableTiers(tx, keys, orgId, merged)).has(effectiveDefault)) {
      return {
        error: defaultTier === undefined
          ? `This change leaves tier "${effectiveDefault}", the organization default tier, with no provider this ` +
            `organization holds a key for. Put a target whose provider has a key first in the tier, ` +
            `or choose another default tier before you change it.`
          : `No provider this organization holds a key for serves tier "${effectiveDefault}". ` +
            `Point the tier's first target at a provider with a key in Settings → Organization → Models, ` +
            `or choose another default tier.`,
      };
    }
  }

  if (validIds) await setOrgTierMap(tx, orgId, merged);
  if (defaultTier !== undefined) await setOrgDefaultTier(tx, orgId, defaultTier);
  return { tierMap: merged, defaultTier: effectiveDefault };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
