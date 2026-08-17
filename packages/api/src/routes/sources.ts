/**
 * `/api/org/sources` — org-admin CRUD for all image sources (kind='external',
 * kind='base', kind='repo') and their bake history. Replaces the split
 * `routes/image-catalog.ts` (kind='external') and `routes/prebuilds.ts`
 * (kind='repo') route files.
 *
 * All routes require `requireOrgAdmin` except `GET /api/sources/for-repo`,
 * which is mounted on a separate public router at `/api/sources` — any authed
 * org member can hit it. Response is deliberately narrow (no `imageRef`,
 * `error`, `logTail`) to avoid leaking build internals.
 *
 * kind='repo' rows are auto-created when a session binds a repo (Task 15).
 * POST rejects kind='repo' with 400; kind='base' is limited to one per org
 * (partial unique index in migrations/pg/0000_app.sql). POST /:id/bake
 * delegates to SourceService and maps its typed errors to HTTP codes.
 *
 * SETUP_COMMANDS validation: reject entries that contain newlines or carriage
 * returns (Dockerfile structural-injection guard, Task 15 spec review).
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newExternalSourceId(): string {
  return `img_${randomUUID()}`;
}

function newBaseSourceId(): string {
  return `base_${randomUUID()}`;
}

/** Fetch a source owned by the org, optionally filtered by kind. Returns
 * undefined if not found or kind doesn't match — callers return 404. */
async function getOwnedSource(
  db: AppEnv["Variables"]["providers"]["db"],
  id: string,
  orgId: string,
  kind?: ImageSourceRow["kind"],
): Promise<ImageSourceRow | undefined> {
  const conditions = [eq(imageSources.id, id), eq(imageSources.orgId, orgId)];
  if (kind) conditions.push(eq(imageSources.kind, kind));
  const rows = await db
    .select()
    .from(imageSources)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}

/** Validate that all entries in a setupCommands array are single-line strings.
 * Returns an error message string if invalid, undefined if valid. */
function validateSetupCommands(cmds: unknown): string | undefined {
  if (!Array.isArray(cmds)) return "setupCommands must be an array";
  for (const cmd of cmds) {
    if (typeof cmd !== "string") return "setupCommands entries must be strings";
    if (/[\r\n]/.test(cmd)) {
      return "Setup commands must be single lines. Split multi-line steps into separate commands.";
    }
  }
  return undefined;
}

// ── Admin router (/api/org/sources) ──────────────────────────────────────────

export const sourcesRouter = new Hono<AppEnv>();

// GET / — list all sources for the org (all kinds)
sourcesRouter.get("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;
  const { db, prebuildService } = c.var.providers;
  const rows = await db
    .select()
    .from(imageSources)
    .where(eq(imageSources.orgId, c.var.user.orgId));
  return c.json({ sources: rows, builderAvailable: prebuildService.builderBackend !== null });
});

// POST / — create kind='external' or kind='base'; reject kind='repo'
sourcesRouter.post("/", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const { kind } = body;

  if (kind === "repo") {
    return c.json(
      {
        error:
          "Repository sources are created automatically when a session binds the repo. Submit kind='external' or kind='base' instead.",
      },
      400,
    );
  }

  const { db } = c.var.providers;
  const now = Date.now();

  if (kind === "external") {
    if (
      typeof body.name !== "string" ||
      body.name.trim() === "" ||
      typeof body.externalRef !== "string" ||
      body.externalRef.trim() === ""
    ) {
      return c.json({ error: "Provide name and externalRef when you create an external image source." }, 400);
    }
    const pullSecretName =
      typeof body.pullSecretName === "string" && body.pullSecretName.trim() !== ""
        ? body.pullSecretName
        : null;
    const row = {
      id: newExternalSourceId(),
      orgId: c.var.user.orgId,
      kind: "external" as const,
      parentId: null,
      name: body.name as string,
      externalRef: body.externalRef as string,
      pullSecretName,
      setupCommands: null,
      // profile is only meaningful for kind='base' rows; null for external.
      profile: null,
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
    return c.json({ source: row }, 201);
  }

  if (kind === "base") {
    if (typeof body.name !== "string" || body.name.trim() === "") {
      return c.json({ error: "name is required" }, 400);
    }
    // profile is required for base sources and must be 'headless' or 'full'.
    if (body.profile !== "headless" && body.profile !== "full") {
      return c.json({ error: "profile must be 'headless' or 'full' for kind='base' sources" }, 400);
    }
    const setupCommands = body.setupCommands ?? [];
    const cmdErr = validateSetupCommands(setupCommands);
    if (cmdErr) return c.json({ error: cmdErr }, 400);

    const row = {
      id: newBaseSourceId(),
      orgId: c.var.user.orgId,
      kind: "base" as const,
      parentId: null,
      name: body.name as string,
      externalRef: null,
      pullSecretName: null,
      setupCommands: setupCommands as string[],
      profile: body.profile as "headless" | "full",
      repoHost: null,
      repoFullName: null,
      cloneUrl: null,
      schedule: "nightly" as const,
      enabled: true,
      lastBoundAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.insert(imageSources).values(row);
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        return c.json({ error: "a base source already exists for this org and profile" }, 409);
      }
      throw err;
    }
    return c.json({ source: row }, 201);
  }

  return c.json({ error: "kind must be 'external' or 'base'" }, 400);
});

// PATCH /:id — kind-scoped field updates
sourcesRouter.patch("/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedSource(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "source not found" }, 404);

  const body: unknown = await c.req.json().catch(() => null);
  if (!isRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const patch: Partial<typeof imageSources.$inferInsert> = { updatedAt: Date.now() };

  // shared fields — all kinds
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    patch.enabled = body.enabled;
  }
  if (body.schedule !== undefined) {
    if (body.schedule !== "nightly" && body.schedule !== "off") {
      return c.json({ error: "schedule must be 'nightly' or 'off'" }, 400);
    }
    patch.schedule = body.schedule;
  }

  // profile is immutable — reject any attempt to change it.
  if (body.profile !== undefined) {
    return c.json({ error: "profile is immutable and cannot be changed after creation" }, 400);
  }

  // kind-scoped fields
  if (body.setupCommands !== undefined) {
    if (existing.kind !== "base") {
      return c.json({ error: "setupCommands can only be set on kind='base' sources" }, 400);
    }
    const cmdErr = validateSetupCommands(body.setupCommands);
    if (cmdErr) return c.json({ error: cmdErr }, 400);
    patch.setupCommands = body.setupCommands as string[];
  }

  if (body.externalRef !== undefined) {
    if (existing.kind !== "external") {
      return c.json({ error: "externalRef can only be set on kind='external' sources" }, 400);
    }
    if (typeof body.externalRef !== "string" || body.externalRef.trim() === "") {
      return c.json({ error: "externalRef must be a non-empty string" }, 400);
    }
    patch.externalRef = body.externalRef;
  }

  if (body.parentId !== undefined) {
    if (existing.kind !== "repo") {
      return c.json({ error: "parentId can only be set on kind='repo' sources" }, 400);
    }
    if (body.parentId !== null && typeof body.parentId !== "string") {
      return c.json({ error: "parentId must be a string or null" }, 400);
    }
    // Validate parentId belongs to same org (if provided)
    if (body.parentId !== null) {
      const parent = await getOwnedSource(db, body.parentId as string, c.var.user.orgId);
      if (!parent) return c.json({ error: "parentId not found in this org" }, 400);
      if (parent.kind !== "base" && parent.kind !== "external") {
        return c.json({ error: "parentId must reference a kind='base' or kind='external' source" }, 400);
      }
    }
    patch.parentId = body.parentId as string | null;
  }

  await db.update(imageSources).set(patch).where(eq(imageSources.id, id));
  const updated = await getOwnedSource(db, id, c.var.user.orgId);
  return c.json({ source: updated });
});

// DELETE /:id — kind-aware delete; bakes CASCADE
sourcesRouter.delete("/:id", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const existing = await getOwnedSource(db, id, c.var.user.orgId);
  if (!existing) return c.json({ error: "source not found" }, 404);

  await db.delete(imageSources).where(eq(imageSources.id, id));
  return c.json({ ok: true });
});

// POST /:id/bake — manual build trigger (admin)
sourcesRouter.post("/:id/bake", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db, prebuildService } = c.var.providers;
  const id = c.req.param("id");
  const source = await getOwnedSource(db, id, c.var.user.orgId);
  if (!source) return c.json({ error: "source not found" }, 404);

  try {
    const row = await prebuildService.startBuild(id);
    return c.json({ bake: row }, 202);
  } catch (err) {
    if (err instanceof PrebuildUnavailableError) return c.json({ error: err.message }, 409);
    if (err instanceof PrebuildConfigNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof GitHubAuthError) return c.json({ error: err.message }, 502);
    throw err;
  }
});

// GET /:id/bakes — bake history (admin)
sourcesRouter.get("/:id/bakes", async (c) => {
  const gate = await requireOrgAdmin(c);
  if (gate) return gate;

  const { db } = c.var.providers;
  const id = c.req.param("id");
  const source = await getOwnedSource(db, id, c.var.user.orgId);
  if (!source) return c.json({ error: "source not found" }, 404);

  const rows = await db
    .select({
      id: bakes.id,
      sourceId: bakes.sourceId,
      identityHash: bakes.identityHash,
      commitSha: bakes.commitSha,
      imageRef: bakes.imageRef,
      status: bakes.status,
      builderBackend: bakes.builderBackend,
      error: bakes.error,
      logTail: bakes.logTail,
      startedAt: bakes.startedAt,
      finishedAt: bakes.finishedAt,
      createdAt: bakes.createdAt,
    })
    .from(bakes)
    .where(eq(bakes.sourceId, id))
    .orderBy(desc(bakes.createdAt));
  return c.json({ bakes: rows });
});

// ── Public member router (/api/sources) ───────────────────────────────────────
//
// No requireOrgAdmin gate. Any authed org member can hit GET /for-repo.
// Response is deliberately narrow (only commitSha + finishedAt) to avoid
// leaking build internals to non-admin members.

export const sourcesPublicRouter = new Hono<AppEnv>();

sourcesPublicRouter.get("/for-repo", async (c) => {
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
