/**
 * `GET /api/org/model-tiers`  — returns the effective tier map (stored or defaults).
 * `PATCH /api/org/model-tiers` — updates `orgs.model_tiers`. Org-admin gated.
 *
 * Each spec in a tier's list must exist in the org catalog.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { getOrgTierMap, setOrgTierMap, TIER_TOKENS, type TierMap } from "../services/model-tiers.js";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";

export const modelTiersRouter = new Hono<AppEnv>();

modelTiersRouter.get("/", async (c) => {
  const user = c.var.user;
  const { db } = c.var.providers;
  const tierMap = await getOrgTierMap(db, user.orgId);
  return c.json(tierMap);
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

  // Validate: only known tier keys, each value an array of strings.
  const unknownKeys = Object.keys(raw).filter(
    (k) => !(TIER_TOKENS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return c.json({ error: `unknown tier(s): ${unknownKeys.join(", ")}. Valid tiers: ${TIER_TOKENS.join(", ")}` }, 400);
  }

  // Build the merged tier map: start from stored/defaults, overlay the patch.
  const current = await getOrgTierMap(db, user.orgId);
  const merged: TierMap = { ...current };
  for (const tier of TIER_TOKENS) {
    if (tier in raw) {
      const val = raw[tier];
      if (!Array.isArray(val) || !val.every((v) => typeof v === "string")) {
        return c.json({ error: `${tier} must be an array of model spec strings` }, 400);
      }
      if (val.length === 0) {
        return c.json({ error: `${tier} must have at least one model spec` }, 400);
      }
      merged[tier] = val as string[];
    }
  }

  // Validate every spec against the org catalog.
  const catalog = await buildOrgCatalog(db, engineCredentials, user.orgId);
  const validIds = catalogValidIds(catalog);
  for (const tier of TIER_TOKENS) {
    for (const spec of merged[tier]) {
      if (!validIds.has(spec)) {
        return c.json({ error: `unknown model spec "${spec}" in tier "${tier}". Pick a model from the model list (GET /api/models).` }, 400);
      }
    }
  }

  await setOrgTierMap(db, user.orgId, merged);
  return c.json(merged);
});
