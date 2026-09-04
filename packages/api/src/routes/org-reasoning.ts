/**
 * `GET /api/org/reasoning`   — returns the org's effective reasoning settings.
 * `PATCH /api/org/reasoning` — updates default/max reasoning levels. Org-admin gated.
 *
 * Values are normalized (trim + lowercase) before validation, so "Medium"
 * and "medium" are equivalent (`mergeReasoningSettings`). Passing null for
 * a field clears it; omitting the key leaves the stored value untouched.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { getOrgReasoningSettings, setOrgReasoningSettings, mergeReasoningSettings } from "../services/reasoning.js";
import type { GetOrgReasoningResponse, PatchOrgReasoningRequest, PatchOrgReasoningResponse } from "../wire/types.js";

export const orgReasoningRouter = new Hono<AppEnv>();

orgReasoningRouter.get("/", async (c) => {
  const user = c.var.user;
  const { db } = c.var.providers;
  const settings = await getOrgReasoningSettings(db, user.orgId);
  const body: GetOrgReasoningResponse = settings;
  return c.json(body);
});

orgReasoningRouter.patch("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const user = c.var.user;
  const { db } = c.var.providers;

  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const patch: PatchOrgReasoningRequest = {};
  for (const key of ["default", "max"] as const) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== "string") {
      return c.json({ error: `${key} must be a string reasoning level, or null to clear it` }, 400);
    }
    patch[key] = value;
  }

  const current = await getOrgReasoningSettings(db, user.orgId);
  const merged = mergeReasoningSettings(current, patch);
  if (typeof merged === "string") {
    return c.json({ error: merged }, 400);
  }

  await setOrgReasoningSettings(db, user.orgId, merged);
  const body: PatchOrgReasoningResponse = merged;
  return c.json(body);
});
