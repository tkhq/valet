/**
 * Design artifact routes (docs/specs/2026-08-23-valet-design-design.md).
 * Mounted at /api/sessions, session-scoped:
 *
 *   GET  /api/sessions/:id/design/artifact                → current content + metadata
 *   GET  /api/sessions/:id/design/revisions               → revision history (no content)
 *   GET  /api/sessions/:id/design/revisions/:rev          → one revision's content
 *   POST /api/sessions/:id/design/revert                  → append a revision from an old one
 *   POST /api/sessions/:id/design/edit                    → write a new revision (design_edit's seam)
 *   GET  /api/sessions/:id/design/comments                → element comments
 *   POST /api/sessions/:id/design/comments                → add a comment (web UI)
 *   POST /api/sessions/:id/design/comments/:cid/resolve   → resolve (design_comment_resolve's seam)
 *   GET  /api/sessions/:id/design/tokens                  → design-system tokens for the session
 *
 * Dual auth, the memory-routes ladder: a valid `x-valet-internal` header
 * (the design_* ToolDefs' HTTP seam) is trusted with `x-valet-actor`;
 * otherwise the session user must pass `canViewSession`. Mutations emit
 * `design.*` events on the session's event stream; REST stays the
 * authoritative read path.
 */
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { extractTokenRefs, parseDesignTokens } from "@valet/plugin-design/lib";
import { handleServiceError } from "./memory.js";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionRepos, type AgentSessionRow } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { resolveUserApiToken } from "../services/github-tokens.js";
import { GitHubSkillRepoReader } from "../services/skill-repo-reader.js";
import {
  addComment,
  emitDesignEvent,
  getArtifactBySession,
  getArtifactRowBySession,
  getRevision,
  listComments,
  listRevisions,
  resolveComment,
  revertToRevision,
  updateArtifact,
} from "../services/design-artifacts.js";
import type {
  DesignArtifactResponse,
  DesignCommentWire,
  DesignRevisionSummary,
} from "../wire/types.js";

export const designRouter = new Hono<AppEnv>();

/** Per-process cache of parsed design-tokens.json, keyed by repo@ref:user.
 * design_render_token hits the tokens route once per lookup; without this,
 * every lookup is a credential resolve plus a GitHub contents round trip
 * inside the agent loop. 60s TTL: a pushed token change shows up within a
 * minute, which matches how often design systems actually change. */
const TOKEN_CACHE_TTL_MS = 60_000;
const tokenCache = new Map<string, { tokens: Record<string, string>; at: number }>();

interface DesignAccess {
  row: AgentSessionRow;
  actorUserId: string;
}

/**
 * Load the session and resolve the caller. Internal token → trusted (the
 * tool already runs inside the session). Otherwise the request user needs
 * view access. `null` → respond 404 (existence-hiding, same as sessions).
 */
async function resolveAccess(c: Context<AppEnv>): Promise<DesignAccess | null> {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  if (isValidInternalToken(c.req.header("x-valet-internal"))) {
    return { row, actorUserId: c.req.header("x-valet-actor") ?? row.userId };
  }
  const user = c.var.user;
  if (!user || !(await canViewSession(db, row, user.id))) return null;
  return { row, actorUserId: user.id };
}

designRouter.get("/:id/design/artifact", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const detail = await getArtifactBySession(c.var.providers.db, access.row.id);
  if (!detail) return c.json({ error: "this session has no design artifact" }, 404);
  const body: DesignArtifactResponse = {
    artifactId: detail.artifact.id,
    sessionId: access.row.id,
    template: access.row.template,
    revision: detail.artifact.currentRevision,
    sizeBytes: detail.artifact.sizeBytes,
    updatedAt: detail.artifact.updatedAt,
    content: detail.content,
  };
  return c.json(body);
});

designRouter.get("/:id/design/revisions", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db } = c.var.providers;
  const artifact = await getArtifactRowBySession(db, access.row.id);
  if (!artifact) return c.json({ error: "this session has no design artifact" }, 404);
  const revisions: DesignRevisionSummary[] = (await listRevisions(db, artifact.id)).map((r) => ({
    revision: r.revision,
    summary: r.summary,
    turnId: r.turnId,
    createdAt: r.createdAt,
  }));
  return c.json({ revisions, current: artifact.currentRevision });
});

designRouter.get("/:id/design/revisions/:rev", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db } = c.var.providers;
  const artifact = await getArtifactRowBySession(db, access.row.id);
  if (!artifact) return c.json({ error: "this session has no design artifact" }, 404);
  const revision = await getRevision(db, artifact.id, c.req.param("rev"));
  if (!revision) return c.json({ error: `no revision ${c.req.param("rev")}` }, 404);
  return c.json({
    revision: revision.revision,
    summary: revision.summary,
    createdAt: revision.createdAt,
    content: revision.content,
  });
});

designRouter.post("/:id/design/revert", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db, eventStream } = c.var.providers;
  let body: { revision?: string };
  try {
    body = (await c.req.json()) as { revision?: string };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.revision) return c.json({ error: "revision is required" }, 400);
  try {
    const result = await revertToRevision(db, { sessionId: access.row.id, revision: body.revision });
    await emitDesignEvent(eventStream, {
      sessionId: access.row.id,
      name: "design.artifact.updated",
      eventKey: `${result.artifact.id}:${result.revision.revision}`,
      payload: {
        artifactId: result.artifact.id,
        revision: result.revision.revision,
        summary: result.revision.summary,
        sizeBytes: result.artifact.sizeBytes,
      },
    });
    return c.json({ revision: result.revision.revision, summary: result.revision.summary });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

designRouter.post("/:id/design/edit", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db, eventStream } = c.var.providers;
  let body: {
    content?: string;
    summary?: string;
    turnId?: string;
    parentRevision?: string;
    queueItemId?: string;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.content !== "string" || body.content.length === 0) {
    return c.json({ error: "content is required (the full .dc.html document)" }, 400);
  }
  try {
    const result = await updateArtifact(db, {
      sessionId: access.row.id,
      content: body.content,
      summary: body.summary ?? "",
      // The turn linkage: tools send their queue item id; an explicit
      // turnId (tests) wins. UI callers send neither -> null, which is
      // what marks a revision agent-invisible for staleness detection.
      turnId: body.turnId ?? body.queueItemId ?? null,
      template: access.row.template,
      ...(body.parentRevision ? { parentRevision: body.parentRevision } : {}),
    });
    await emitDesignEvent(eventStream, {
      sessionId: access.row.id,
      name: "design.artifact.updated",
      eventKey: `${result.artifact.id}:${result.revision.revision}`,
      // Ties the durable event row to the submission's retention window
      // (design_* tools pass their turn's queueItemId through).
      ...(typeof body.queueItemId === "string" && body.queueItemId
        ? { queueItemId: body.queueItemId }
        : {}),
      payload: {
        artifactId: result.artifact.id,
        revision: result.revision.revision,
        summary: result.revision.summary,
        sizeBytes: result.artifact.sizeBytes,
      },
    });
    const notes = [
      ...result.notes,
      ...(result.interleaved
        ? [
            `the artifact had been changed outside this conversation before your edit (${result.interleaved.revision}: "${result.interleaved.summary}") — your view of the document may have been stale; use design_read to see the current state`,
          ]
        : []),
    ];
    return c.json({ revision: result.revision.revision, sizeBytes: result.artifact.sizeBytes, notes });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

designRouter.get("/:id/design/comments", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const comments: DesignCommentWire[] = (await listComments(c.var.providers.db, access.row.id)).map(
    (r) => ({
      id: r.id,
      vdid: r.vdid,
      revision: r.revision,
      body: r.body,
      authorUserId: r.authorUserId,
      resolvedAt: r.resolvedAt,
      createdAt: r.createdAt,
    }),
  );
  return c.json({ comments });
});

designRouter.post("/:id/design/comments", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db, eventStream } = c.var.providers;
  let body: { vdid?: string; body?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.vdid) return c.json({ error: "vdid is required (the element's data-vdid)" }, 400);
  if (!body.body) return c.json({ error: "body is required (the comment text)" }, 400);
  try {
    const row = await addComment(db, {
      sessionId: access.row.id,
      vdid: body.vdid,
      body: body.body,
      authorUserId: access.actorUserId,
    });
    await emitDesignEvent(eventStream, {
      sessionId: access.row.id,
      name: "design.comment.added",
      eventKey: `comment:${row.id}`,
      payload: { commentId: row.id, vdid: row.vdid },
    });
    return c.json({ id: row.id, vdid: row.vdid, createdAt: row.createdAt }, 201);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

designRouter.post("/:id/design/comments/:cid/resolve", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db, eventStream } = c.var.providers;
  try {
    const row = await resolveComment(db, { sessionId: access.row.id, commentId: c.req.param("cid") });
    await emitDesignEvent(eventStream, {
      sessionId: access.row.id,
      name: "design.comment.resolved",
      eventKey: `comment:${row.id}:resolved`,
      payload: { commentId: row.id, vdid: row.vdid },
    });
    return c.json({ id: row.id, resolvedAt: row.resolvedAt });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

/**
 * Design-system tokens for this session (spec §Ports, codebase provider):
 * `design-tokens.json` read from the session's primary repo binding with
 * the session user's GitHub credential. No repo binding, no credential, or
 * no file → empty map — a design session without a design system is fine.
 * `?subset=artifact` limits the response to tokens the artifact references
 * (the share-link stripping rule).
 */
designRouter.get("/:id/design/tokens", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db, engineCredentials, encryptionKey } = c.var.providers;

  let tokens: Record<string, string> = {};
  const repoRows = await db
    .select()
    .from(sessionRepos)
    .where(and(eq(sessionRepos.sessionId, access.row.id), eq(sessionRepos.position, 0)))
    .limit(1);
  const repo = repoRows[0];
  if (repo) {
    const cacheKey = `${repo.fullName}@${repo.ref ?? ""}:${access.row.userId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() - cached.at < TOKEN_CACHE_TTL_MS) {
      tokens = cached.tokens;
    } else {
      const deps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
      const userToken = await resolveUserApiToken(deps, access.row.orgId, access.row.userId);
      const reader = new GitHubSkillRepoReader({
        credential: userToken
          ? { kind: "user", token: userToken.token, ownerScope: "user" }
          : { kind: "none" },
      });
      try {
        const file = await reader.readFile(repo.fullName, "design-tokens.json", repo.ref ?? "");
        if (file) tokens = parseDesignTokens(file.text);
      } catch {
        // Unreachable repo degrades to no tokens; the canvas renders with
        // the artifact's own fallback values.
      }
      tokenCache.set(cacheKey, { tokens, at: Date.now() });
      // Bound the map: evict the oldest entries past the cap.
      if (tokenCache.size > 500) {
        const oldest = [...tokenCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) tokenCache.delete(oldest[0]);
      }
    }
  }

  if (c.req.query("subset") === "artifact") {
    const detail = await getArtifactBySession(db, access.row.id);
    const refs = new Set(detail ? extractTokenRefs(detail.content) : []);
    tokens = Object.fromEntries(Object.entries(tokens).filter(([name]) => refs.has(name)));
  }
  return c.json({ tokens });
});
