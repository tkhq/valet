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
import type { AppEnv } from "../env.js";
import type { ValetAuth } from "../auth/index.js";
import type { AppDb } from "../lib/drizzle.js";
import { resolveOrgId } from "../lib/org.js";
import { users } from "../schema/index.js";
import { requireUser, resolveOptionalUser, type AuthUser } from "../middleware/auth.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { WorkflowWebhookRateLimiter } from "../workflows/webhook-service.js";
import { isOrgAdmin } from "../services/org.js";
import { handleServiceError, resolveScope } from "./memory.js";
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
  type ArtifactSummaryRow,
} from "../services/artifacts.js";
import type {
  ArtifactListItem,
  GetArtifactResponse,
  ListArtifactsResponse,
  PatchArtifactRequest,
  ShareArtifactRequest,
  ShareArtifactResponse,
} from "../wire/types.js";

/** `BETTER_AUTH_URL`'s origin, even when `publicUrlFromEnv` rejects it
 * (http, localhost, `*.localdev`). Those are still the address users load
 * the app FROM in dev and localdev deploys — unlike the request origin. */
function authUrlOrigin(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.BETTER_AUTH_URL) return undefined;
  try {
    return new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return undefined;
  }
}

/** Share-link base, in trust order: the deployment's public URL
 * (`VALET_PUBLIC_URL` / public https `BETTER_AUTH_URL` — the chain
 * webhook registration uses), else `BETTER_AUTH_URL`'s origin verbatim,
 * else the origin the request arrived on. The last resort is only right
 * for browser-originated requests; a `mem_share` tool call reaches this
 * process over its own loopback (`apiBaseUrl` in `main.ts`), so without
 * the `BETTER_AUTH_URL` rung every helm/localdev deploy would mint
 * unreachable `http://127.0.0.1:8788/a/…` links. */
function shareUrlBase(c: Context<AppEnv>): string {
  return publicUrlFromEnv(process.env) ?? authUrlOrigin(process.env) ?? new URL(c.req.url).origin;
}

function shareUrl(c: Context<AppEnv>, token: string): string {
  return `${shareUrlBase(c)}/a/${token}`;
}

function toListItem(c: Context<AppEnv>, row: ArtifactSummaryRow): ArtifactListItem {
  return {
    id: row.id,
    path: row.sourceMemoryPath,
    title: row.title,
    url: shareUrl(c, row.token),
    visibility: row.visibility,
    actorUserId: row.actorUserId,
    revoked: row.revokedAt !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Public read ───────────────────────────────────────────────────────

/** Generous per-IP bound on token guessing. 128-bit tokens make guessing
 * hopeless anyway; the limiter just keeps a scanner from being free. */
const PUBLIC_READ_LIMIT = 120;
const PUBLIC_READ_WINDOW_MS = 60_000;

/** The socket peer address, when the runtime exposes it. `@hono/node-server`
 * hands the raw `IncomingMessage` through `c.env.incoming`; other adapters
 * (Bun) don't, and this narrows to `undefined` there. */
function socketAddress(c: Context<AppEnv>): string | undefined {
  const env: unknown = c.env;
  if (typeof env !== "object" || env === null || !("incoming" in env)) return undefined;
  const incoming = (env as { incoming: unknown }).incoming;
  if (typeof incoming !== "object" || incoming === null || !("socket" in incoming)) return undefined;
  const socket = (incoming as { socket: unknown }).socket;
  if (typeof socket !== "object" || socket === null || !("remoteAddress" in socket)) return undefined;
  const addr = (socket as { remoteAddress: unknown }).remoteAddress;
  return typeof addr === "string" ? addr : undefined;
}

/**
 * Rate-limit key for one client. `x-forwarded-for` is client-supplied, so
 * it is only trusted when `VALET_TRUST_PROXY=1` says a proxy that strips
 * inbound XFF (the helm ingress) fronts this process — otherwise a direct
 * caller could rotate spoofed values for a fresh bucket per request.
 * Untrusted mode keys on the socket peer address, which a client cannot
 * choose. "direct" is the last resort when neither exists (non-node
 * adapters), collapsing to one shared bucket — safe, but coarse.
 */
function clientKey(c: Context<AppEnv>): string {
  if (process.env.VALET_TRUST_PROXY === "1") {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return socketAddress(c) ?? "direct";
}

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

    if (!limiter.allow(clientKey(c), Date.now())) {
      return c.json({ error: "rate limited" }, 429);
    }

    const { db } = c.var.providers;
    // Independent lookups — overlap them; this is the anonymous hot path.
    const [artifact, user] = await Promise.all([
      getArtifactByToken(db, c.req.param("token")),
      resolveOptionalUser(c, { auth, db }),
    ]);
    if (!artifact) return c.json({ error: "not found" }, 404);
    // The opt-in only matters for `public` rows — skip the orgs read for
    // the default `org` visibility (`decideArtifactAccess` ignores it).
    const allowPublic =
      artifact.visibility === "public" ? await getAllowPublicArtifacts(db, artifact.orgId) : false;

    const access = decideArtifactAccess({ artifact, allowPublicArtifacts: allowPublic, user });
    if (access.kind === "not_found") {
      return c.json({ error: "not found" }, 404);
    }
    if (access.kind === "login") {
      return c.json({ error: "This document is shared with a Valet organization. Log in to view it." }, 401);
    }

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
    const mapped = handleServiceError(err);
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
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/** The artifact's auth boundary. A session caller's own org; internal
 * (tool) callers carry no user, so this deployment's single org resolves
 * the same way the auth middleware resolves it for everyone. */
async function orgIdForShare(c: Context<AppEnv>, db: AppDb): Promise<string> {
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
