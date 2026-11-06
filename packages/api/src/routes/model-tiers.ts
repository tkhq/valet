import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { auditRequest } from "./_admin-audit.js";
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
  if ("error" in result) return c.json(result, 400);
  await auditRequest(c, { action: "model_policy.tiers_update", targetType: "model_policy", targetId: "model_tiers", targetName: "Model tiers", changes: { request: raw } });
  return c.json(result);
});
