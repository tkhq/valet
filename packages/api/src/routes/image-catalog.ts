/**
 * `/api/org/image-catalog` — org-admin CRUD for the admin-registered base
 * images a prebuild config can pin to (sandbox images v2 plan, Task 3).
 * Same DB-backed `requireOrgAdmin` gate (`routes/_org-admin.ts`) as
 * `llm-providers`/`org-invites` — every route below 403s
 * `{ error: "org admin required" }` for non-admins. Rows are always scoped
 * to the caller's own org.
 *
 * `ref` is validated non-empty only — this route does not attempt to
 * verify the ref resolves to a pullable image (no registry credentials are
 * available here, and a docker-backend prebuild build would surface a bad
 * ref as a clear build failure anyway).
 *
 * `pullSecretName` is a kubernetes-only field (the name of an
 * imagePullSecret Task 5's k8s builder references when pulling a private
 * base image); it's accepted and stored here so the row shape is stable
 * across backends, but the docker builder (Task 2) ignores it entirely.
 *
 * IMPORTANT (T2 finding, disclosed here since this is where base images get
 * registered): every base image used for a prebuild MUST have `git`
 * installed — `recipe.ts`'s `generateDockerfile` clones the repo as the
 * FIRST step of the generated Dockerfile, so a git-less base image fails
 * the build immediately on that step.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { imageSources } from "../schema/index.js";

export const imageCatalogRouter = new Hono<AppEnv>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newImageSourceId(): string {
  return `img_${randomUUID()}`;
}

imageCatalogRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const { db } = c.var.providers;
  // Return external-type sources — these are the admin-registered base images
  // that were previously in image_catalog (kind='external' replaces 'base'
  // in the old single-kind catalog).
  const rows = await db
    .select()
    .from(imageSources)
    .where(and(eq(imageSources.orgId, c.var.user.orgId), eq(imageSources.kind, "external")));
  return c.json({ images: rows });
});

imageCatalogRouter.post("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const body: unknown = await c.req.json().catch(() => null);
  if (
    !isRecord(body) ||
    typeof body.name !== "string" ||
    body.name.trim() === "" ||
    typeof body.ref !== "string" ||
    body.ref.trim() === ""
  ) {
    return c.json({ error: "name and ref are required" }, 400);
  }
  const pullSecretName =
    typeof body.pullSecretName === "string" && body.pullSecretName.trim() !== "" ? body.pullSecretName : null;

  const { db } = c.var.providers;
  const now = Date.now();
  const row = {
    id: newImageSourceId(),
    orgId: c.var.user.orgId,
    kind: "external" as const,
    parentId: null,
    name: body.name as string,
    externalRef: body.ref as string,
    pullSecretName,
    setupCommands: null,
    repoHost: null,
    repoFullName: null,
    cloneUrl: null,
    schedule: "nightly" as const,
    enabled: true,
    lastBoundAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(imageSources).values(row);
  return c.json({ image: row }, 201);
});

imageCatalogRouter.delete("/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await db
    .select()
    .from(imageSources)
    .where(and(eq(imageSources.id, id), eq(imageSources.orgId, c.var.user.orgId), eq(imageSources.kind, "external")))
    .limit(1);
  if (existing.length === 0) return c.json({ error: "image not found" }, 404);

  await db.delete(imageSources).where(eq(imageSources.id, id));
  return c.json({ ok: true });
});
