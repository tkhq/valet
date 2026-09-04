/**
 * `GET /api/org/approved-models`  — returns the org's approved model list.
 * `PUT /api/org/approved-models`  — sets or clears the list. Org-admin gated.
 *
 * Every id in a non-null list must exist in the org catalog
 * (`buildOrgCatalog` / `catalogValidIds`, same validation model-tiers uses).
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { getApprovedModels, setApprovedModels, validateApprovedModelsList } from "../services/approved-models.js";
import { buildOrgCatalog, catalogValidIds } from "../services/model-catalog.js";
import type { GetApprovedModelsResponse, PutApprovedModelsResponse } from "../wire/types.js";

export const approvedModelsRouter = new Hono<AppEnv>();

approvedModelsRouter.get("/", async (c) => {
  const user = c.var.user;
  const { db } = c.var.providers;
  const approved = await getApprovedModels(db, user.orgId);
  const body: GetApprovedModelsResponse = { approved };
  return c.json(body);
});

approvedModelsRouter.put("/", async (c) => {
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

  const approvedRaw = raw.approved;
  let approved: string[] | null;
  if (approvedRaw === null) {
    approved = null;
  } else if (Array.isArray(approvedRaw) && approvedRaw.every((v): v is string => typeof v === "string")) {
    approved = approvedRaw;
  } else {
    return c.json({ error: "approved must be an array of model ids, or null to clear the restriction" }, 400);
  }

  const catalog = await buildOrgCatalog(db, engineCredentials, user.orgId);
  const validIds = catalogValidIds(catalog);
  const error = validateApprovedModelsList(approved, validIds);
  if (error) return c.json({ error }, 400);

  await setApprovedModels(db, user.orgId, approved);
  const body: PutApprovedModelsResponse = { approved };
  return c.json(body);
});
