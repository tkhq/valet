/**
 * `/api/org/prebuilds` — org-admin CRUD for prebuild configs + build
 * lifecycle (sandbox images v2 plan, Task 3). Same DB-backed
 * `requireOrgAdmin` gate as `routes/image-catalog.ts`. Rows are always
 * scoped to the caller's own org; a config belonging to another org 404s
 * exactly like a nonexistent id.
 *
 * `POST /configs/:id/rebuild` and the poll/scheduler loop (wired from
 * `main.ts`) both delegate to `bakes/source-service.ts`'s `SourceService` —
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
import { imageSources, bakes, type ImageSourceRow } from "../schema/index.js";
import { GitHubAuthError } from "../services/github-tokens.js";
import { PrebuildConfigNotFoundError, PrebuildUnavailableError } from "../bakes/source-service.js";

export const prebuildsRouter = new Hono<AppEnv>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newImageSourceId(): string {
  return `src_${randomUUID()}`;
}

async function getOwnedSource(
  db: AppEnv["Variables"]["providers"]["db"],
  id: string,
  orgId: string,
): Promise<ImageSourceRow | undefined> {
  const rows = await db
    .select()
    .from(imageSources)
    .where(and(eq(imageSources.id, id), eq(imageSources.orgId, orgId), eq(imageSources.kind, "repo")))
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
  const rows = await db
    .select()
    .from(imageSources)
    .where(and(eq(imageSources.orgId, c.var.user.orgId), eq(imageSources.kind, "repo")));
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
  const parentId = typeof body.baseImageId === "string" && body.baseImageId.trim() !== "" ? body.baseImageId : null;

  const { db } = c.var.providers;
  const now = Date.now();
  const row = {
    id: newImageSourceId(),
    orgId: c.var.user.orgId,
    kind: "repo" as const,
    parentId,
    name: body.repoFullName as string,
    externalRef: null,
    pullSecretName: null,
    setupCommands: null,
    repoHost,
    repoFullName: body.repoFullName as string,
    cloneUrl: body.cloneUrl as string,
    schedule,
    enabled,
    lastBoundAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(imageSources).values(row);
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
  const existing = await getOwnedSource(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "prebuild config not found" }, 404);

  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const patch: Partial<typeof imageSources.$inferInsert> = { updatedAt: Date.now() };
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
    patch.parentId = body.baseImageId;
  }

  await db.update(imageSources).set(patch).where(eq(imageSources.id, id));
  const updated = await getOwnedSource(db, id, c.var.user.orgId);
  return c.json({ config: updated });
});

prebuildsRouter.delete("/configs/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedSource(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "prebuild config not found" }, 404);

  await db.delete(imageSources).where(eq(imageSources.id, id));
  return c.json({ ok: true });
});

prebuildsRouter.post("/configs/:id/rebuild", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, prebuildService } = c.var.providers;
  const id = c.req.param("id");
  const source = await getOwnedSource(db, id, c.var.user.orgId);
  if (!source) return c.json({ error: "prebuild config not found" }, 404);

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
  const source = await getOwnedSource(db, id, c.var.user.orgId);
  if (!source) return c.json({ error: "prebuild config not found" }, 404);

  const rows = await db.select().from(bakes).where(eq(bakes.sourceId, id)).orderBy(desc(bakes.createdAt));
  return c.json({ builds: rows });
});

// ── Member-accessible read (Task 6) ─────────────────────────────────────
//
// Mounted separately at `/api/prebuilds` (not `/api/org/prebuilds`) — no
// `requireOrgAdmin` gate, any authed org member can hit it. Powers the
// new-session dialog's "prebuilt" badge. Response is deliberately narrow:
// only `commitSha`/`finishedAt`, never `imageRef`/`error`/`logTail`, which
// would leak build internals to non-admin members.

export const prebuildsPublicRouter = new Hono<AppEnv>();

prebuildsPublicRouter.get("/for-repo", async (c) => {
  const fullName = c.req.query("fullName");
  if (!fullName || fullName.trim() === "") {
    return c.json({ error: "fullName is required" }, 400);
  }

  const { db } = c.var.providers;
  const sourceRows = await db
    .select({ id: imageSources.id })
    .from(imageSources)
    .where(
      and(
        eq(imageSources.orgId, c.var.user.orgId),
        eq(imageSources.kind, "repo"),
        eq(imageSources.repoFullName, fullName),
      ),
    )
    .limit(1);
  const source = sourceRows[0];
  if (!source) return c.json({ prebuild: null });

  const buildRows = await db
    .select({ commitSha: bakes.commitSha, finishedAt: bakes.finishedAt })
    .from(bakes)
    .where(and(eq(bakes.sourceId, source.id), eq(bakes.status, "pushed")))
    .orderBy(desc(bakes.finishedAt))
    .limit(1);
  const build = buildRows[0];
  if (!build || build.finishedAt === null) return c.json({ prebuild: null });

  return c.json({ prebuild: { commitSha: build.commitSha, finishedAt: build.finishedAt } });
});
