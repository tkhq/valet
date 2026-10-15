/**
 * `GET /api/org/model-tiers`  — returns the effective tier map (stored or
 *   defaults), the org default tier, and whether new sessions can use it.
 * `PATCH /api/org/model-tiers` — updates `orgs.model_tiers` and
 *   `orgs.default_tier`. Org-admin gated.
 *
 * Each spec in a tier's list must exist in the org catalog and be approved.
 * A tier token is not a valid target: a tier that names itself, or two
 * tiers that name each other, have no model to resolve to. A tier can keep
 * a tier token that its stored list already holds.
 * `defaultTier` takes a tier token, or null to clear it. The default tier
 * must resolve to a model that new sessions can run (`resolvableTiers`), in
 * the tier map that the request leaves behind. The PATCH runs these checks
 * under the org policy lock, against the state that it then writes over.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import type { CredentialStore } from "@valet/engine";
import type { AppQueryable } from "../lib/drizzle.js";
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
async function tiersResponse(
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

export const modelTiersRouter = new Hono<AppEnv>();

modelTiersRouter.get("/", async (c) => {
  const user = c.var.user;
  const { db, engineCredentials } = c.var.providers;
  const tierMap = await getOrgTierMap(db, user.orgId);
  const defaultTier = await getOrgDefaultTier(db, user.orgId);
  return c.json<GetModelTiersResponse>(await tiersResponse(db, engineCredentials, user.orgId, tierMap, defaultTier));
});

modelTiersRouter.patch("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const user = c.var.user;
  const { db, engineCredentials } = c.var.providers;

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Validate: only known tier keys and `defaultTier`, each tier value an
  // array of strings.
  const unknownKeys = Object.keys(raw).filter(
    (k) => k !== "defaultTier" && !(TIER_TOKENS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return c.json({ error: `unknown tier(s): ${unknownKeys.join(", ")}. Valid tiers: ${TIER_TOKENS.join(", ")}` }, 400);
  }
  const defaultTier = raw.defaultTier;
  if (defaultTier !== undefined && defaultTier !== null && !isSizeTier(defaultTier)) {
    return c.json({ error: `defaultTier must be one of ${TIER_TOKENS.join(", ")}, or null to clear it.` }, 400);
  }

  // Validate and narrow to PatchModelTiersRequest.
  const validated: Record<string, string[]> = {};
  for (const tier of TIER_TOKENS) {
    if (tier in raw) {
      const val = raw[tier];
      if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) {
        return c.json({ error: `${tier} must be an array of model spec strings` }, 400);
      }
      if (val.length === 0) {
        return c.json({ error: `${tier} must have at least one model spec` }, 400);
      }
      validated[tier] = val as string[];
    }
  }
  const patch = validated as PatchModelTiersRequest;

  // These reads use the credential store, so they run before the
  // transaction: PGlite runs one query at a time, and a credential read
  // inside the transaction would wait for the transaction to end. A body
  // with only `defaultTier` leaves the stored tier map alone, so it skips
  // the catalog check. The key copy serves the default-tier check below.
  const changesTiers = TIER_TOKENS.some((tier) => tier in validated);
  const validIds = changesTiers ? catalogValidIds(await buildOrgCatalog(db, engineCredentials, user.orgId)) : null;
  const keys = changesTiers || isSizeTier(defaultTier) ? await orgKeySnapshot(db, engineCredentials, user.orgId) : null;

  const result = await db.transaction(async (tx) => {
    await lockOrgModelPolicy(tx, user.orgId);
    // Every check reads the tier map and the default tier under the same
    // row lock that approved-model writes use. A request that another save
    // overtook checks that save's result, not the state it first read.
    const current = await getOrgTierMap(tx, user.orgId);

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

      const approvalErr = tierTargetsNotApproved(merged, await getApprovedModels(tx, user.orgId));
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
    const effectiveDefault = defaultTier === undefined ? await getOrgDefaultTier(tx, user.orgId) : defaultTier;
    if (keys && effectiveDefault !== null) {
      const mustBeUsable =
        defaultTier !== undefined || (await resolvableTiers(tx, keys, user.orgId, current)).has(effectiveDefault);
      if (mustBeUsable && !(await resolvableTiers(tx, keys, user.orgId, merged)).has(effectiveDefault)) {
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

    if (validIds) await setOrgTierMap(tx, user.orgId, merged);
    if (defaultTier !== undefined) await setOrgDefaultTier(tx, user.orgId, defaultTier);
    return { tierMap: merged, defaultTier: effectiveDefault };
  });
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json<GetModelTiersResponse>(
    await tiersResponse(db, engineCredentials, user.orgId, result.tierMap, result.defaultTier),
  );
});
