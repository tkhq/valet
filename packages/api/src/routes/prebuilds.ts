/**
 * `/api/org/prebuilds` — org-admin CRUD for prebuild configs + build
 * lifecycle (sandbox images v2 plan, Task 3). Same DB-backed
 * `requireOrgAdmin` gate as `routes/image-catalog.ts`. Rows are always
 * scoped to the caller's own org; a config belonging to another org 404s
 * exactly like a nonexistent id.
 *
 * `POST /configs/:id/rebuild` and the poll/scheduler loop (wired from
 * `main.ts`) both delegate to `prebuilds/service.ts`'s `PrebuildService` —
 * this file has no build-orchestration logic of its own beyond mapping the
 * service's typed errors to HTTP status codes.
 *
 * `GET /meta` is registered before the generic `configs`/`:id` shape so it
 * never risks being shadowed (though today it doesn't share a path
 * segment) — mirrors the `llm-providers` router's "static path before
 * `/:id`" convention.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { prebuildConfigs, prebuilds, type PrebuildConfigRow } from "../schema/index.js";
import { GitHubAuthError } from "../services/github-tokens.js";
import { PrebuildConfigNotFoundError, PrebuildUnavailableError } from "../prebuilds/service.js";

export const prebuildsRouter = new Hono<AppEnv>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newPrebuildConfigId(): string {
  return `pbc_${randomUUID()}`;
}

async function getOwnedConfig(
  db: AppEnv["Variables"]["providers"]["db"],
  id: string,
  orgId: string,
): Promise<PrebuildConfigRow | undefined> {
  const rows = await db
    .select()
    .from(prebuildConfigs)
    .where(and(eq(prebuildConfigs.id, id), eq(prebuildConfigs.orgId, orgId)))
    .limit(1);
  return rows[0];
}

prebuildsRouter.get("/meta", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const { prebuildService } = c.var.providers;
  return c.json({ builder: prebuildService.builderBackend });
});

prebuildsRouter.get("/configs", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const { db } = c.var.providers;
  const rows = await db.select().from(prebuildConfigs).where(eq(prebuildConfigs.orgId, c.var.user.orgId));
  return c.json({ configs: rows });
});

prebuildsRouter.post("/configs", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const body: unknown = await c.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.repoFullName !== "string" ||
    body.repoFullName.trim() === "" ||
    typeof body.cloneUrl !== "string" ||
    body.cloneUrl.trim() === ""
  ) {
    return c.json({ error: "repoFullName and cloneUrl are required" }, 400);
  }
  const repoHost = typeof body.repoHost === "string" && body.repoHost.trim() !== "" ? body.repoHost : "github";
  const schedule: "nightly" | "off" = body.schedule === "off" ? "off" : "nightly";
  const enabled = typeof body.enabled === "boolean" ? body.enabled : true;
  const baseImageId = typeof body.baseImageId === "string" && body.baseImageId.trim() !== "" ? body.baseImageId : null;

  const { db } = c.var.providers;
  const now = Date.now();
  const row = {
    id: newPrebuildConfigId(),
    orgId: c.var.user.orgId,
    repoHost,
    repoFullName: body.repoFullName,
    cloneUrl: body.cloneUrl,
    baseImageId,
    schedule,
    enabled,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(prebuildConfigs).values(row);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      return c.json({ error: "a prebuild config for this repo already exists" }, 409);
    }
    throw err;
  }
  return c.json({ config: row }, 201);
});

prebuildsRouter.patch("/configs/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedConfig(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "prebuild config not found" }, 404);

  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const patch: Partial<typeof prebuildConfigs.$inferInsert> = { updatedAt: Date.now() };
  if (body.cloneUrl !== undefined) {
    if (typeof body.cloneUrl !== "string" || body.cloneUrl.trim() === "") {
      return c.json({ error: "cloneUrl must be a non-empty string" }, 400);
    }
    patch.cloneUrl = body.cloneUrl;
  }
  if (body.schedule !== undefined) {
    if (body.schedule !== "nightly" && body.schedule !== "off") {
      return c.json({ error: "schedule must be 'nightly' or 'off'" }, 400);
    }
    patch.schedule = body.schedule;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    patch.enabled = body.enabled;
  }
  if (body.baseImageId !== undefined) {
    if (body.baseImageId !== null && typeof body.baseImageId !== "string") {
      return c.json({ error: "baseImageId must be a string or null" }, 400);
    }
    patch.baseImageId = body.baseImageId;
  }

  await db.update(prebuildConfigs).set(patch).where(eq(prebuildConfigs.id, id));
  const updated = await getOwnedConfig(db, id, c.var.user.orgId);
  return c.json({ config: updated });
});

prebuildsRouter.delete("/configs/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedConfig(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "prebuild config not found" }, 404);

  await db.delete(prebuildConfigs).where(eq(prebuildConfigs.id, id));
  return c.json({ ok: true });
});

prebuildsRouter.post("/configs/:id/rebuild", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, prebuildService } = c.var.providers;
  const id = c.req.param("id");
  const config = await getOwnedConfig(db, id, c.var.user.orgId);
  if (!config) return c.json({ error: "prebuild config not found" }, 404);

  try {
    const row = await prebuildService.startBuild(id);
    return c.json({ prebuild: row }, 202);
  } catch (err) {
    if (err instanceof PrebuildUnavailableError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof PrebuildConfigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof GitHubAuthError) {
      return c.json({ error: err.message }, 502);
    }
    throw err;
  }
});

prebuildsRouter.get("/configs/:id/builds", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const config = await getOwnedConfig(db, id, c.var.user.orgId);
  if (!config) return c.json({ error: "prebuild config not found" }, 404);

  const rows = await db.select().from(prebuilds).where(eq(prebuilds.configId, id)).orderBy(desc(prebuilds.createdAt));
  return c.json({ builds: rows });
});
