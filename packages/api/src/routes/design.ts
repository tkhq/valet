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
import {
  extractTokenRefs,
  injectDeckRuntime,
  inlineDesignTokens,
  isDesignTemplate,
  parseDesignTokens,
  parseHeader,
  DEFAULT_DESIGN_TOKENS,
} from "@valet/plugin-design/lib";
import { handleServiceError } from "./memory.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionRepos, type AgentSessionRow } from "../schema/index.js";
import { canAdministerSession, canViewSession } from "../services/session-access.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { resolveUserApiToken } from "../services/github-tokens.js";
import { GitHubSkillRepoReader } from "../services/skill-repo-reader.js";
import {
  addComment,
  emitDesignEvent,
  updateScratchpad,
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
  DesignExportsResponse,
  DesignRevisionSummary,
} from "../wire/types.js";

export const designRouter = new Hono<AppEnv>();

/** Per-process cache of parsed design-tokens.json, keyed by repo@ref:user.
 * design_render_token hits the tokens route once per lookup; without this,
 * every lookup is a credential resolve plus a GitHub contents round trip
 * inside the agent loop. 60s TTL: a pushed token change shows up within a
 * minute, which matches how often design systems actually change. */
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_CAP = 500;
const tokenCache = new Map<string, { tokens: Record<string, string>; at: number }>();

/**
 * LRU touch: re-insert the key so Map iteration order puts it last (newest).
 * A Map deletes+re-inserts in O(1), so eviction (delete the first key) always
 * drops the least-recently-used entry, not the least-recently-written one.
 */
function touchTokenCache(key: string, value: { tokens: Record<string, string>; at: number }): void {
  tokenCache.delete(key);
  tokenCache.set(key, value);
  if (tokenCache.size > TOKEN_CACHE_CAP) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
}

/**
 * Latest canvas render-health report per session, in memory. The canvas
 * measures what ACTUALLY renders (hidden/blank slides, stripped scripts)
 * and posts it here; design_read serves it back to the agent — the only
 * feedback path that can catch "the markup looks fine but the user sees
 * blank slides". In-memory is deliberate: it is a freshness signal from a
 * live canvas, not durable state; an api restart just waits for the next
 * report.
 */
interface RenderHealthReport {
  revision: string;
  totalSlides: number;
  hiddenSlides: number[];
  overflowingSlides: number[];
  sparseSlides: number[];
  scriptsStripped: number;
  reportedAt: number;
}

/**
 * Stored health report plus attribution. Any viewer may post a report and the
 * agent trusts the content, so we record WHO reported it (`reporterId`) and
 * WHEN the server received it (`reportedAt`, server epoch ms — never a
 * client-supplied clock). Internal (canvas) posts use "canvas".
 */
interface StoredHealthReport {
  report: RenderHealthReport;
  reportedAt: number;
  reporterId: string;
}
const healthReports = new Map<string, StoredHealthReport>();
const HEALTH_REPORT_CAP = 500;

/**
 * LRU touch for the health-report map (mirrors `touchTokenCache`): the canvas
 * re-posts a heartbeat about every 60s, so the hottest session must survive
 * eviction, not be dropped for being the oldest INSERT.
 */
function touchHealthReport(sessionId: string, value: StoredHealthReport): void {
  healthReports.delete(sessionId);
  healthReports.set(sessionId, value);
  if (healthReports.size > HEALTH_REPORT_CAP) {
    const oldest = healthReports.keys().next().value;
    if (oldest !== undefined) healthReports.delete(oldest);
  }
}

/** Health-report body caps (threat: any viewer posts, the agent trusts it). */
const HEALTH_MAX_ISSUES = 50;
const HEALTH_MAX_STRING = 500;
const HEALTH_MAX_REVISION = 120;

/**
 * Last successful export listing per session, in memory (LRU, cap 200). When
 * the sandbox is cold (hibernated / not attached), the exports route serves
 * this instead of waking the sandbox — the panel shows the cached names greyed
 * with wake copy. Empty is a valid cached listing.
 */
const EXPORTS_CACHE_CAP = 200;
const exportsListingCache = new Map<string, Array<{ name: string; size: number }>>();

function touchExportsCache(sessionId: string, files: Array<{ name: string; size: number }>): void {
  exportsListingCache.delete(sessionId);
  exportsListingCache.set(sessionId, files);
  if (exportsListingCache.size > EXPORTS_CACHE_CAP) {
    const oldest = exportsListingCache.keys().next().value;
    if (oldest !== undefined) exportsListingCache.delete(oldest);
  }
}

interface DesignAccess {
  row: AgentSessionRow;
  actorUserId: string;
  /**
   * True when this request holds full authority: an internal-token request
   * (the design_* tools run inside the session), or a user who may administer
   * the session. View-gated mutations (comment create/resolve) ignore this;
   * destructive/administrative mutations (revert, rename, delete, scratchpad)
   * require it.
   */
  canAdminister: boolean;
  /** True for a trusted internal-token request (never reduce its access). */
  internal: boolean;
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
  // A deleted session's design surface goes with it (soft delete keeps the
  // rows for audit, not for continued use) — 404, same existence-hiding
  // shape as a missing session.
  if (row.status === "deleted") return null;

  if (isValidInternalToken(c.req.header("x-valet-internal"))) {
    return {
      row,
      actorUserId: c.req.header("x-valet-actor") ?? row.userId,
      canAdminister: true,
      internal: true,
    };
  }
  const user = c.var.user;
  if (!user || !(await canViewSession(db, row, user.id))) return null;
  // Administer authority follows the same rule the session-admin routes use:
  // the direct owner, or a team admin of a team-owned session. View-only
  // members pass `canViewSession` above but not this.
  const canAdminister = await canAdministerSession(db, row, user.id);
  return { row, actorUserId: user.id, canAdminister, internal: false };
}

/**
 * Standard denied-mutation response. Named so every administrative mutation
 * uses one wording, and so the copy names the corrective action.
 */
function denyMutation(c: Context<AppEnv>) {
  return c.json(
    { error: "You do not have permission to change this session. Ask the session owner to make this change." },
    403,
  );
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
    scratchpad: detail.artifact.scratchpad,
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
  // Revert rewrites the artifact's current revision — administrative, not
  // collaborative. A view-only member must not roll back another owner's work.
  if (!access.canAdminister) return denyMutation(c);
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
    // Heal template drift: an import can legitimately change the artifact's
    // template (document -> slides via a Marp import). The canvas trusts
    // the session row; keep it in lockstep with the stored header.
    const header = parseHeader(result.revision.content);
    if (header && header.template !== access.row.template && isDesignTemplate(header.template)) {
      await db
        .update(agentSessions)
        .set({ template: header.template, updatedAt: Date.now() })
        .where(eq(agentSessions.id, access.row.id));
    }

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
/** Resolve the session's design tokens: the Valet defaults, overlaid by
 * the first session repo's design-tokens.json / _ds_manifest.json when one
 * exists. Shared by the tokens route and the export/download paths (an
 * export renders outside the canvas, so tokens must travel inlined). */
async function resolveSessionTokens(c: Context<AppEnv>, access: DesignAccess): Promise<Record<string, string>> {
  const { db, engineCredentials, encryptionKey } = c.var.providers;

  // The Valet default design system is always present; repository tokens
  // overlay it (same-name wins), so a team system replaces defaults
  // token-by-token instead of all-or-nothing.
  let tokens: Record<string, string> = { ...DEFAULT_DESIGN_TOKENS };
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
      let ok = true;
      try {
        const file = await reader.readFile(repo.fullName, "design-tokens.json", repo.ref ?? "");
        if (file) tokens = { ...tokens, ...parseDesignTokens(file.text) };
        // Claude-Design-style manifest at the repo root: tokens as a typed
        // array ({name, value, kind, scope}); unscoped tokens overlay.
        const manifest = await reader.readFile(repo.fullName, "_ds_manifest.json", repo.ref ?? "");
        if (manifest) {
          const parsed: unknown = JSON.parse(manifest.text);
          const list =
            typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { tokens?: unknown }).tokens)
              ? ((parsed as { tokens: unknown[] }).tokens as Array<Record<string, unknown>>)
              : [];
          for (const t of list) {
            if (typeof t.name === "string" && typeof t.value === "string" && t.scope === undefined) {
              tokens[t.name.startsWith("--") ? t.name : `--${t.name}`] = t.value;
            }
          }
        }
      } catch {
        // Unreachable repo (or malformed manifest) degrades to defaults;
        // the canvas renders with the artifact's own fallback values.
        ok = false;
      }
      // Cache SUCCESSES only (60s TTL). A failed read (a GitHub hiccup) must
      // NOT be cached — caching it showed "no design system" for a full minute
      // after a transient error. LRU touch keeps the hottest repo alive.
      if (ok) touchTokenCache(cacheKey, { tokens, at: Date.now() });
    }
  }
  return tokens;
}

designRouter.get("/:id/design/tokens", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  let tokens = await resolveSessionTokens(c, access);

  if (c.req.query("subset") === "artifact") {
    const detail = await getArtifactBySession(c.var.providers.db, access.row.id);
    const refs = new Set(detail ? extractTokenRefs(detail.content) : []);
    tokens = Object.fromEntries(Object.entries(tokens).filter(([name]) => refs.has(name)));
  }
  return c.json({ tokens });
});

designRouter.post("/:id/design/health", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  let body: {
    revision?: string;
    totalSlides?: number;
    hiddenSlides?: number[];
    overflowingSlides?: number[];
    sparseSlides?: number[];
    scriptsStripped?: number;
  };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.revision !== "string" || typeof body.totalSlides !== "number") {
    return c.json({ error: "revision and totalSlides are required" }, 400);
  }
  // Any viewer may post and the agent trusts the content, so validate strictly
  // and reject over-cap payloads instead of silently truncating — a report
  // that names 10,000 hidden slides is not a report, it is an attack surface.
  if (body.revision.length > HEALTH_MAX_REVISION) {
    return c.json({ error: `revision must be ${HEALTH_MAX_REVISION} characters or fewer` }, 400);
  }
  // The slide-index arrays are the "issues" the report names. Each is capped,
  // and their combined length is capped, at HEALTH_MAX_ISSUES.
  const issueArrays: Array<[keyof RenderHealthReport, number[] | undefined]> = [
    ["hiddenSlides", body.hiddenSlides],
    ["overflowingSlides", body.overflowingSlides],
    ["sparseSlides", body.sparseSlides],
  ];
  let issueCount = 0;
  for (const [name, arr] of issueArrays) {
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      return c.json({ error: `${String(name)} must be an array of slide indexes` }, 400);
    }
    issueCount += arr.length;
  }
  if (issueCount > HEALTH_MAX_ISSUES) {
    return c.json({ error: `a health report may name at most ${HEALTH_MAX_ISSUES} issues; report fewer` }, 400);
  }

  const report: RenderHealthReport = {
    revision: body.revision.slice(0, HEALTH_MAX_STRING),
    totalSlides: body.totalSlides,
    hiddenSlides: (body.hiddenSlides ?? []).filter((n): n is number => typeof n === "number"),
    overflowingSlides: (body.overflowingSlides ?? []).filter((n): n is number => typeof n === "number"),
    sparseSlides: (body.sparseSlides ?? []).filter((n): n is number => typeof n === "number"),
    scriptsStripped: typeof body.scriptsStripped === "number" ? body.scriptsStripped : 0,
    reportedAt: Date.now(),
  };
  // Attribution: the authenticated user, or "canvas" for a trusted internal
  // post. Last-write-wins is correct — the canvas re-posts a heartbeat ~60s.
  touchHealthReport(access.row.id, {
    report,
    reportedAt: report.reportedAt,
    reporterId: access.internal ? "canvas" : access.actorUserId,
  });
  return c.json({ ok: true });
});

designRouter.get("/:id/design/health", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const stored = healthReports.get(access.row.id);
  if (!stored) return c.json({ report: null });
  // LRU: a GET is a read touch, so the served session survives eviction.
  touchHealthReport(access.row.id, stored);
  return c.json({ report: stored.report, reportedAt: stored.reportedAt, reporterId: stored.reporterId });
});

designRouter.post("/:id/design/scratchpad", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  // The scratchpad is the agent's persistent project notes; a rewrite is an
  // administrative change, not collaboration. Comments stay view-gated.
  if (!access.canAdminister) return denyMutation(c);
  let body: { content?: string };
  try {
    body = (await c.req.json()) as { content?: string };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "content is required (the full scratchpad text; empty string clears it)" }, 400);
  }
  try {
    await updateScratchpad(c.var.providers.db, { sessionId: access.row.id, content: body.content });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Sandbox export downloads ─────────────────────────────────────────────
// design_export pdf/pptx/html writes into the sandbox's /workspace/exports.
// These routes are the ONLY path from that directory to the user's machine
// — without them the agent's "grab it from the Export menu" advice loops
// back to another agent export.

const EXPORTS_DIR = "/workspace/exports";
/** No leading dot (hides the marp intermediate), no slashes (no traversal). */
const SAFE_EXPORT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,120}$/;
const EXPORT_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
};

/**
 * "This session's sandbox exists but is not attached here" — a hibernated
 * row, or an api restart that evicted a still-running docker sandbox from the
 * host cache. Used only to distinguish `cold` (a sandbox is out there, do not
 * wake it) from `none` (nothing to wake). A cached previous listing is a
 * stronger `cold` signal and is checked first by the caller.
 */
function sessionHasColdSandbox(row: AgentSessionRow): boolean {
  return row.status === "hibernated" || row.hibernatedSandboxId != null;
}

/**
 * The exports listing NEVER wakes, resumes, or provisions a sandbox (a
 * download listing must not spend a cold start). It reads only a sandbox that
 * is already attached AND ready in THIS process. Every other case serves the
 * last cached listing with `sandbox: "cold"`, or `"none"` when no sandbox
 * exists.
 *
 * The "never wake" rule is why this reads through `attachment.current()` (the
 * raw handle, null unless `ready`) and NOT `session.sandbox` — the latter is
 * the PolicySandbox wrapper, whose ops call `ensureReady` and would resume a
 * hibernated sandbox out from under this read-only path.
 */
designRouter.get("/:id/design/exports", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const { db, engineHost } = c.var.providers;

  const respondCold = (): Response => {
    const cached = exportsListingCache.get(access.row.id);
    if (cached) touchExportsCache(access.row.id, cached); // read touch keeps it hot
    const body: DesignExportsResponse = { files: cached ?? [], sandbox: "cold" };
    return c.json(body);
  };

  if (!engineHost.isLive(access.row.id)) {
    // Not cached here. Do not build (a build would provision). Report cold
    // when a sandbox exists somewhere (or we have a cached listing), else none.
    if (sessionHasColdSandbox(access.row) || exportsListingCache.has(access.row.id)) {
      return respondCold();
    }
    const body: DesignExportsResponse = { files: [], sandbox: "none" };
    return c.json(body);
  }

  // Cached in this process: `sessionFor` returns the existing Session without
  // building or resuming. `attachment.current()` gives the raw sandbox ONLY
  // when it is ready — null for a suspended/provisioning attachment, which we
  // must not wake.
  const session = await engineHost.sessionFor(access.row.id, await loadSessionMeta(db, access.row));
  const sandbox = session.attachment.current();
  if (!sandbox) return respondCold();

  let names: string[];
  try {
    names = await sandbox.readdir(EXPORTS_DIR);
  } catch {
    // Live sandbox, no exports directory yet — an empty LIVE listing. Cache it
    // so a later hibernation still reports "cold, no files" rather than "none".
    touchExportsCache(access.row.id, []);
    const body: DesignExportsResponse = { files: [], sandbox: "live" };
    return c.json(body);
  }
  const files: Array<{ name: string; size: number }> = [];
  for (const name of names) {
    if (!SAFE_EXPORT_NAME.test(name)) continue;
    const st = await sandbox.stat(`${EXPORTS_DIR}/${name}`).catch(() => null);
    if (st?.isFile) files.push({ name, size: st.size });
  }
  touchExportsCache(access.row.id, files);
  const body: DesignExportsResponse = { files, sandbox: "live" };
  return c.json(body);
});

/** Max download size (bytes). A larger export must be fetched another way. */
const EXPORT_MAX_BYTES = 100 * 1024 * 1024;

designRouter.get("/:id/design/exports/:name", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const name = c.req.param("name");
  if (!SAFE_EXPORT_NAME.test(name)) return c.json({ error: "file not found" }, 404);
  const { db, engineHost } = c.var.providers;
  // Read only a sandbox already attached and ready in this process — never
  // wake one for a download. `attachment.current()` is null unless ready.
  const session = engineHost.isLive(access.row.id)
    ? await engineHost.sessionFor(access.row.id, await loadSessionMeta(db, access.row))
    : null;
  const sandbox = session?.attachment.current() ?? null;
  if (!sandbox) {
    // On docker the sandbox IS running; this api is just not attached to it
    // (a restart evicted it). "Wake it" was false — sending a message
    // reattaches. Keep 409.
    return c.json(
      {
        error:
          "The session is not attached to its sandbox. Send the session a message to reconnect, then retry the download.",
      },
      409,
    );
  }

  // Symlink-escape guard (docker `readBinary` resolves a HOST path and follows
  // symlinks, so `/workspace/exports/leak -> /etc/passwd` would leak a host
  // file). Validate INSIDE the sandbox before reading: a regular file, not a
  // symlink, whose realpath stays under EXPORTS_DIR, at or under the size cap.
  // The name already passed SAFE_EXPORT_NAME (no slashes, shell-safe), but it
  // is still single-quoted defensively.
  const target = `${EXPORTS_DIR}/${name}`;
  const q = `'${target}'`;
  const guard = `if [ -L ${q} ]; then echo SYMLINK; elif [ ! -f ${q} ]; then echo NOFILE; else rp="$(realpath ${q})"; case "$rp" in ${EXPORTS_DIR}/*) stat -c %s ${q} 2>/dev/null || echo STATFAIL ;; *) echo ESCAPE ;; esac; fi`;
  let verdict: string;
  try {
    const res = await sandbox.exec(guard);
    verdict = res.stdout.trim();
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  // A symlink, a missing file, or an escaped realpath is indistinguishable
  // from "no such file" to the caller — 404, no information leak.
  if (verdict === "SYMLINK" || verdict === "NOFILE" || verdict === "ESCAPE" || verdict === "STATFAIL") {
    return c.json({ error: "file not found" }, 404);
  }
  const size = Number.parseInt(verdict, 10);
  if (!Number.isFinite(size)) return c.json({ error: "file not found" }, 404);
  if (size > EXPORT_MAX_BYTES) {
    return c.json(
      {
        error:
          "This export is larger than the 100 MB download limit. Export a smaller format, or fetch the file from the session's sandbox terminal.",
      },
      413,
    );
  }

  let data: Uint8Array;
  try {
    data = await sandbox.readBinary(target);
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  c.header("Content-Type", EXPORT_CONTENT_TYPES[ext] ?? "application/octet-stream");
  c.header("Content-Disposition", `attachment; filename="${name}"`);
  // Copy into a plain ArrayBuffer: Uint8Array's own .buffer types as
  // ArrayBufferLike, which Hono's body() refuses.
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  return c.body(buf);
});

/**
 * Instant browser download of the artifact — the user downloading their
 * own design needs no approval gate (they ARE the approver; nothing
 * leaves their browser). `format=dc` is the raw document; `format=html`
 * injects the standalone deck viewer for slides artifacts.
 */
designRouter.get("/:id/design/download", async (c) => {
  const access = await resolveAccess(c);
  if (!access) return c.json({ error: "session not found" }, 404);
  const detail = await getArtifactBySession(c.var.providers.db, access.row.id);
  if (!detail) return c.json({ error: "this session has no design artifact" }, 404);

  const format = c.req.query("format") === "html" ? "html" : "dc";
  // Print view: serve the viewer INLINE so it renders in a tab and opens
  // the print dialog (the runtime watches ?vd-print=1) — Save as PDF is
  // the instant PDF path, no Chromium or sandbox involved.
  const printView = c.req.query("vd-print") === "1";
  const isDeck = parseHeader(detail.content)?.template === "slides";
  // format=html renders OUTSIDE the canvas, so the session tokens ride
  // inlined. format=dc stays byte-faithful — it is the re-import source.
  let body = detail.content;
  if (format === "html") {
    body = inlineDesignTokens(body, await resolveSessionTokens(c, access));
    if (isDeck) body = injectDeckRuntime(body);
  }
  const name = (access.row.title ?? "design").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "design";
  const filename = format === "html" ? `${name}.html` : `${name}.dc.html`;

  c.header("Content-Type", "text/html; charset=utf-8");
  if (!printView) {
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
  }
  return c.body(body);
});
