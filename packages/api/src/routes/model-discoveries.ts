import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import {
  listModelDiscoveries,
  reviewModelDiscovery,
} from "../services/model-discoveries.js";
import { getModelRegistryStatus } from "../services/model-registry.js";
import type {
  ListModelDiscoveriesResponse,
  ReviewModelDiscoveryResponse,
} from "../wire/types.js";

export const modelDiscoveriesRouter = new Hono<AppEnv>();

modelDiscoveriesRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const { db } = c.var.providers;
  const body: ListModelDiscoveriesResponse = {
    discoveries: await listModelDiscoveries(db, c.var.user.orgId),
    registry: await getModelRegistryStatus(),
  };
  return c.json(body);
});

modelDiscoveriesRouter.patch("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  let raw: Record<string, unknown>;
  try {
    raw = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body. Send an approved or rejected state." }, 400);
  }
  if (raw.state !== "approved" && raw.state !== "rejected") {
    return c.json({ error: "state must be approved or rejected" }, 400);
  }
  if (typeof raw.providerId !== "string" || typeof raw.modelId !== "string") {
    return c.json({ error: "providerId and modelId must be strings" }, 400);
  }
  const { db } = c.var.providers;
  const providerId = raw.providerId;
  const modelId = raw.modelId;
  const updated = await reviewModelDiscovery(
    db,
    c.var.user.orgId,
    c.var.user.id,
    providerId,
    modelId,
    raw.state,
  );
  if (!updated) return c.json({ error: "Discovered model not found. Refresh the registry and try again." }, 404);
  const discovery = (await listModelDiscoveries(db, c.var.user.orgId))
    .find((item) => item.providerId === providerId && item.modelId === modelId);
  if (!discovery) return c.json({ error: "Discovered model metadata is invalid. Refresh the registry and try again." }, 409);
  const body: ReviewModelDiscoveryResponse = { discovery };
  return c.json(body);
});
