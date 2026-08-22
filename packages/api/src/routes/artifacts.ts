/**
 * Artifact routes (2026-08-22 artifacts design).
 *
 * Two routers over one table, split by trust:
 *
 *   - `buildArtifactsPublicRouter` — `GET /:token`, mounted BEFORE
 *     `buildAuthMiddleware` in app.ts (the webhook-mount pattern). The
 *     token is the capability; the handler resolves the caller itself via
 *     `resolveOptionalUser` because `org`-visibility artifacts serve
 *     logged-in org members and 401 everyone else, while `public` ones
 *     (org opt-in) serve anonymously. A factory, not a module-level
 *     router, because it needs the `ValetAuth` instance and its own
 *     per-IP rate limiter.
 *   - `artifactsRouter` — share/list/manage, mounted behind the normal
 *     auth middleware. `POST /share` also serves the `mem_share` tool via
 *     the internal-token header pair, resolved through the memory routes'
 *     `resolveScope` chokepoint.
 *
 * Share authorization is READ-level (`resolveScope(c, "read")`): sharing
 * needs no more authority than reading, because a reader can already copy
 * the content anywhere. Managing an existing artifact (widen/revoke)
 * requires being its sharer or an org admin.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { NotFoundError, ValidationError, ValetError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { ValetAuth } from "../auth/index.js";
import type { AppDb } from "../lib/drizzle.js";
import { resolveOrgId } from "../lib/org.js";
import { users } from "../schema/index.js";
import { requireUser, resolveOptionalUser, type AuthUser } from "../middleware/auth.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { WorkflowWebhookRateLimiter } from "../workflows/webhook-service.js";
import { isOrgAdmin } from "../services/org.js";
import { resolveScope } from "./memory.js";
import type { MemoryScope } from "../services/memory.js";
import {
  decideArtifactAccess,
  getAllowPublicArtifacts,
  getArtifactById,
  getArtifactByToken,
  listArtifacts,
  revokeArtifactById,
  revokeArtifactByPath,
  setArtifactVisibility,
  shareArtifact,
  type ArtifactRow,
} from "../services/artifacts.js";
import type {
  ArtifactListItem,
  GetArtifactResponse,
  ListArtifactsResponse,
  PatchArtifactRequest,
  ShareArtifactRequest,
  ShareArtifactResponse,
} from "../wire/types.js";

/** Share-link base: the deployment's public URL when one is configured
 * (`VALET_PUBLIC_URL` / public https `BETTER_AUTH_URL` — the same chain
 * webhook registration uses), else the origin the request itself arrived
 * on, which is what a dev stack's browser can actually reach. */
function shareUrlBase(c: Context<AppEnv>): string {
  return publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin;
}

function shareUrl(c: Context<AppEnv>, token: string): string {
  return `${shareUrlBase(c)}/a/${token}`;
}

function toListItem(c: Context<AppEnv>, row: ArtifactRow): ArtifactListItem {
  return {
    id: row.id,
    path: row.sourceMemoryPath,
    title: row.title,
    url: shareUrl(c, row.token),
    visibility: row.visibility,
    revoked: row.revokedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Same service-error mapping the memory routes use — shares fail with the
 * memory service's own error shapes (reserved path, not found, etc.). */
function mapServiceError(err: unknown): { body: { error: string; code?: string }; status: 400 | 404 } | null {
  if (err instanceof NotFoundError) {
    return { body: { error: err.message, code: "not_found" }, status: 404 };
  }
  if (err instanceof ValidationError) {
    return { body: { error: err.message, code: "validation_error" }, status: 400 };
  }
  if (err instanceof ValetError && (err.statusCode === 404 || err.statusCode === 400)) {
    return { body: { error: err.message, code: err.code }, status: err.statusCode };
  }
  return null;
}

// ─── Public read ───────────────────────────────────────────────────────

/** Generous per-IP bound on token guessing. 128-bit tokens make guessing
 * hopeless anyway; the limiter just keeps a scanner from being free. */
const PUBLIC_READ_LIMIT = 120;
const PUBLIC_READ_WINDOW_MS = 60_000;

export function buildArtifactsPublicRouter(auth: ValetAuth | null): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  // The workflow-webhook limiter is a generic per-key sliding window —
  // reused here keyed by client IP rather than duplicating the class.
  const limiter = new WorkflowWebhookRateLimiter({
    windowMs: PUBLIC_READ_WINDOW_MS,
    limit: PUBLIC_READ_LIMIT,
  });

  router.get("/:token", async (c) => {
    // Never index a share URL, whatever the outcome.
    c.header("X-Robots-Tag", "noindex");

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
    if (!limiter.allow(ip, Date.now())) {
      return c.json({ error: "rate limited" }, 429);
    }

    const { db } = c.var.providers;
    const artifact = await getArtifactByToken(db, c.req.param("token"));
    const allowPublic = artifact ? await getAllowPublicArtifacts(db, artifact.orgId) : false;
    const user = await resolveOptionalUser(c, { auth, db });

    const access = decideArtifactAccess({ artifact, allowPublicArtifacts: allowPublic, user });
    if (access.kind === "not_found") {
      return c.json({ error: "not found" }, 404);
    }
    if (access.kind === "login") {
      return c.json({ error: "This document is shared with a Valet organization. Log in to view it." }, 401);
    }

    // `artifact` is non-null on every `serve` branch — `decideArtifactAccess`
    // returns `not_found` for an undefined artifact.
    if (!artifact) return c.json({ error: "not found" }, 404);

    // Sharer attribution only for logged-in org viewers (spec: yes for
    // `org`, no for `public`) — an anonymous reader learns no names.
    let sharedBy: string | undefined;
    if (user && user.orgId === artifact.orgId) {
      const sharerRows = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, artifact.actorUserId))
        .limit(1);
      sharedBy = sharerRows[0]?.name || sharerRows[0]?.email || undefined;
    }

    const body: GetArtifactResponse = {
      title: artifact.title,
      content: artifact.content,
      visibility: artifact.visibility,
      updatedAt: artifact.updatedAt,
      ...(sharedBy !== undefined ? { sharedBy } : {}),
    };
    return c.json(body);
  });

  return router;
}

// ─── Share + management (authed) ───────────────────────────────────────

export const artifactsRouter = new Hono<AppEnv>();

artifactsRouter.post("/share", async (c) => {
  let scope: MemoryScope;
  try {
    scope = await resolveScope(c, "read");
  } catch (err) {
    const mapped = mapServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }

  let body: ShareArtifactRequest;
  try {
    body = await c.req.json<ShareArtifactRequest>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.path || typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  const { db } = c.var.providers;
  try {
    if (body.revoke === true) {
      await revokeArtifactByPath(db, scope, body.path);
      return c.json({ ok: true });
    }
    const row = await shareArtifact(db, scope, {
      path: body.path,
      orgId: await orgIdForShare(c, db),
      sourceSessionId: c.req.header("x-valet-session-id"),
    });
    const resp: ShareArtifactResponse = {
      id: row.id,
      path: row.sourceMemoryPath,
      url: shareUrl(c, row.token),
      visibility: row.visibility,
      updatedAt: row.updatedAt,
    };
    return c.json(resp);
  } catch (err) {
    const mapped = mapServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/** The artifact's auth boundary. A session caller's own org; internal
 * (tool) callers carry no user, so this deployment's single org resolves
 * the same way the auth middleware resolves it for everyone. */
function orgIdForShare(c: Context<AppEnv>, db: AppDb): Promise<string> | string {
  const user = requireUser(c);
  if (user) return user.orgId;
  return resolveOrgId(db);
}

artifactsRouter.get("/", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const { db } = c.var.providers;
  const orgAdmin = await isOrgAdmin(db, user.orgId, user.id);
  const rows = await listArtifacts(db, { id: user.id, orgId: user.orgId, orgAdmin });
  const body: ListArtifactsResponse = { artifacts: rows.map((row) => toListItem(c, row)) };
  return c.json(body);
});

/** Sharer-or-admin gate for managing one artifact. Wrong org or no row →
 * 404 (existence-hiding); right org but neither sharer nor admin → 403. */
async function loadManagedArtifact(
  c: Context<AppEnv>,
  user: AuthUser,
): Promise<{ row: ArtifactRow } | { error: Response }> {
  const { db } = c.var.providers;
  const row = await getArtifactById(db, c.req.param("id"));
  if (!row || row.orgId !== user.orgId) {
    return { error: c.json({ error: "not found" }, 404) };
  }
  if (row.actorUserId !== user.id && !(await isOrgAdmin(db, user.orgId, user.id))) {
    return { error: c.json({ error: "only the sharer or an org admin can manage this artifact" }, 403) };
  }
  return { row };
}

artifactsRouter.patch("/:id", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  let body: PatchArtifactRequest;
  try {
    body = await c.req.json<PatchArtifactRequest>();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.visibility !== "org" && body.visibility !== "public") {
    return c.json({ error: "visibility must be 'org' or 'public'" }, 400);
  }

  const loaded = await loadManagedArtifact(c, user);
  if ("error" in loaded) return loaded.error;

  const { db } = c.var.providers;
  if (body.visibility === "public" && !(await getAllowPublicArtifacts(db, user.orgId))) {
    return c.json(
      {
        error:
          "Public sharing is off for this organization. An org admin can enable it in Settings → Organization.",
      },
      400,
    );
  }

  const row = await setArtifactVisibility(db, loaded.row.id, body.visibility, user.id);
  return c.json(toListItem(c, row));
});

artifactsRouter.delete("/:id", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const loaded = await loadManagedArtifact(c, user);
  if ("error" in loaded) return loaded.error;

  const { db } = c.var.providers;
  await revokeArtifactById(db, loaded.row.id);
  return c.json({ ok: true });
});
