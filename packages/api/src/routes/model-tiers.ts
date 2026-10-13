/**
 * `GET /api/org/model-tiers`  — returns the effective tier map (stored or
 *   defaults) and the org default tier.
 * `PATCH /api/org/model-tiers` — updates `orgs.model_tiers` and
 *   `orgs.default_tier`. Org-admin gated.
 *
 * Each spec in a tier's list must exist in the org catalog and be approved.
 * `defaultTier` takes a tier token, or null to clear it.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import {
  getOrgDefaultTier,
  getOrgTierMap,
  isSizeTier,
  setOrgDefaultTier,
  setOrgTierMap,
  TIER_TOKENS,
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

export const modelTiersRouter = new Hono<AppEnv>();

modelTiersRouter.get("/", async (c) => {
  const user = c.var.user;
  const { db } = c.var.providers;
  const tierMap = await getOrgTierMap(db, user.orgId);
  const defaultTier = await getOrgDefaultTier(db, user.orgId);
  return c.json<GetModelTiersResponse>({ ...tierMap, defaultTier });
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

  // Validate every spec against the org catalog. A body with only
  // `defaultTier` leaves the stored tier map alone, so it skips this.
  const changesTiers = TIER_TOKENS.some((tier) => tier in validated);
  const validIds = changesTiers ? catalogValidIds(await buildOrgCatalog(db, engineCredentials, user.orgId)) : null;

  const result = await db.transaction(async (tx) => {
    await lockOrgModelPolicy(tx, user.orgId);
    // Build the merged tier map under the same row lock used by approved
    // model writes, so neither policy can validate against stale state.
    const current = await getOrgTierMap(tx, user.orgId);
    const merged: TierMap = { ...current };
    for (const tier of TIER_TOKENS) {
      const replacement = patch[tier];
      if (replacement) merged[tier] = replacement;
    }

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

      await setOrgTierMap(tx, user.orgId, merged);
    }
    if (defaultTier !== undefined) await setOrgDefaultTier(tx, user.orgId, defaultTier);
    return { tierMap: merged, defaultTier: await getOrgDefaultTier(tx, user.orgId) };
  });
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json<GetModelTiersResponse>({ ...result.tierMap, defaultTier: result.defaultTier });
});
