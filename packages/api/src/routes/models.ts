/**
 * `/api/models` — the org model catalog (split-settings design, decision 9,
 * superseded by the llm-providers design doc). Returns only ACTIVE catalog
 * entries — configured-but-inactive providers (disabled, or no resolvable
 * key) are visible in `GET /api/org/llm-providers` (admin CRUD), not here;
 * pickers only ever see usable models. See `services/model-catalog.ts`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { buildOrgCatalog } from "../services/model-catalog.js";
import { getModelRegistryStatus } from "../services/model-registry.js";
import type { ListModelsResponse, ModelInfo, ModelRegistryStatusResponse } from "../wire/types.js";

export const modelsRouter = new Hono<AppEnv>();

modelsRouter.get("/", async (c) => {
  const { db, engineCredentials } = c.var.providers;
  const user = c.var.user;
  const entries = await buildOrgCatalog(db, engineCredentials, user.orgId);
  const models: ModelInfo[] = entries
    .filter((e) => e.active)
    .map(({ resolvable: _resolvable, ...model }) => model);
  const resp: ListModelsResponse = { models };
  return c.json(resp);
});

/**
 * Last-refresh state of the runtime model registry (TKAI-327). The catalog
 * degrades silently by design — a failed fetch keeps serving the bundled
 * list — so this route is how an operator sees that the upstream check is
 * stuck. It reports metadata only (counts, timestamps, error text) and no
 * org data, so it needs no admin gate beyond the router's auth.
 */
modelsRouter.get("/registry-status", async (c) => {
  const status = await getModelRegistryStatus();
  const resp: ModelRegistryStatusResponse = status;
  return c.json(resp);
});
