import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { getOrgDefaultTier, getOrgTierMap } from "../services/model-tiers.js";
import { patchModelTiers, tiersResponse } from "../services/model-tier-settings.js";
export { tierTargetsNotApproved } from "../services/model-tier-settings.js";

export const modelTiersRouter = new Hono<AppEnv>();
modelTiersRouter.get("/", async c => {
  const { db, engineCredentials } = c.var.providers;
  const orgId = c.var.user.orgId;
  return c.json(await tiersResponse(db, engineCredentials, orgId, await getOrgTierMap(db, orgId), await getOrgDefaultTier(db, orgId)));
});
modelTiersRouter.patch("/", async c => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  let raw: unknown;
  try { raw = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const { db, engineCredentials } = c.var.providers;
  const result = await patchModelTiers(db, engineCredentials, c.var.user, raw);
  return "error" in result ? c.json(result, 400) : c.json(result);
});
