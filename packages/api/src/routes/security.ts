/**
 * Valet Security routes (docs/specs/2026-08-27-valet-security-design.md,
 * threat 10: every route resolves session → engagement → owner and applies
 * the session's existing access checks).
 *
 * Reads (M2):
 *   GET /api/sessions/:id/security               → engagement + cells (+ running
 *                                                  cell progress)
 *   GET /api/sessions/:id/security/findings      → filtered, cursor-paginated
 *
 * Runner tool backends (M3):
 *   GET  /api/sessions/:id/security/status        → the sec_status resume primitive
 *   GET  /api/sessions/:id/security/start-preview → repo + resolved SHA + plan cells
 *   GET  /api/sessions/:id/security/files         → one engagement-tree path
 *   GET  /api/sessions/:id/security/files/list    → tree listing
 *   POST /api/sessions/:id/security/plan          → replace the plan (planning only)
 *   POST /api/sessions/:id/security/start         → materialize cells, pin the SHA
 *   POST /api/sessions/:id/security/dispatch      → claim + spawn one cell's child
 *   POST /api/sessions/:id/security/cells/:cellId/complete
 *   POST /api/sessions/:id/security/cells/:cellId/fail
 *   POST /api/sessions/:id/security/close         → manifest
 *   POST /api/sessions/:id/security/handoff       → spawn a fix session from a finding
 *
 * Persona tool backends (M4 — the acting session is a cell-claimed child):
 *   POST /api/sessions/:id/security/files         → append one revision (write claim)
 *   POST /api/sessions/:id/security/findings      → report a finding for the cell
 *   POST /api/sessions/:id/security/findings/:findingId/review
 *                                                 → verified/refuted (review cells only)
 *
 * Human triage routes (M6 — Decision 10: human-only, the internal token is
 * REFUSED on all four):
 *   POST /api/sessions/:id/security/findings/:findingId/status
 *                                                 → human verify/refute (canAdministerSession)
 *   GET  /api/sessions/:id/security/export        → md | sarif | json (canViewSession)
 *   POST /api/sessions/:id/security/findings/:findingId/issues
 *                                                 → file one GitHub/Linear issue (canViewSession)
 *   POST /api/sessions/:id/security/issues/digest → one digest issue (canViewSession)
 *
 * Dual auth, the memory-routes ladder: a valid `x-valet-internal` token is
 * the `sec_*` engine tools' path; otherwise the caller is the session user.
 * The M2 reads keep the plain internal bypass. The M3 tool routes bind the
 * internal path to an ACTING session (`x-valet-session-id`): mutations
 * require the acting session to BE the engagement's session — one runner
 * cannot drive another engagement — and tool reads additionally admit a
 * session a cell of this engagement claims (`child_session_id`, the M4
 * persona seam). User-path mutations require `canAdministerSession`.
 * Unknown/unreachable sessions answer 404, the existence-hiding convention.
 *
 * The persona routes and tool reads resolve the engagement FROM the claim
 * (`security_cells.child_session_id` = the acting session, one indexed
 * query): a dispatched child names only its OWN session id — it never
 * learns the runner's. A claimless acting session gets a corrective 403.
 * The persona routes never take the user path; M6 adds the human review
 * surface separately.
 */
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { cellDir, KNOWN_PERSONAS, parsePlan, serializePlan } from "@valet/plugin-security";
import type { PlanCell } from "@valet/plugin-security";
import type { Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { requireUser, type AuthUser } from "../middleware/auth.js";
import { publicUrlFromEnv } from "../channels/host.js";
import { buildActionInvoker } from "../plugins/action-invoker.js";
import { persistInvocationAudit } from "../policies/service.js";
import {
  agentSessions,
  childWatches,
  securityCells,
  securityFindingComments,
  securityFindingLinks,
  securityFindings,
  securityHandoffs,
  sessionRepos,
  type SecurityCellRow,
  type SecurityEngagementRow,
  type SecurityFindingCommentRow,
  type SecurityFindingLinkRow,
  type SecurityFindingRow,
  type SecurityHandoffRow,
} from "../schema/index.js";
import { canAdministerSession, canViewSession } from "../services/session-access.js";
import { routeAttention, type AttentionDeps } from "../orchestrator/attention.js";
import { parseAssistantSessionId } from "@valet/engine";
import { loadSessionMeta } from "../engine/session-meta.js";
import { resolveApiTokenOrNull, resolveChangedFiles, resolveRefSha } from "../bakes/source-service.js";
import { buildChildStatusReader, ChildLimitError } from "../orchestrator/children.js";
import {
  createSecurityEngagementService,
  type CellProgress,
  type FindingSeverity,
  type FindingStatus,
  type SpawnCellChild,
} from "../services/security-engagements.js";
import {
  buildJsonExport,
  buildMarkdownReport,
  buildSarif,
  type SecurityExportInput,
} from "../services/security-export.js";
import {
  fileDigestIssue,
  fileFindingIssue,
  IssueRequestError,
  MissingIntegrationError,
  type IssueProvider,
  type SecurityIssuesDeps,
} from "../services/security-issues.js";
import type {
  GetSecurityStatusResponse,
  GetSessionSecurityResponse,
  ListSecurityFilesResponse,
  ListSecurityFindingsResponse,
  SecurityCellWire,
  SecurityCloseResponse,
  SecurityCompleteCellResponse,
  SecurityDigestIssueResponse,
  SecurityDispatchResponse,
  SecurityEngagementWire,
  SecurityAddFindingCommentResponse,
  SecurityFailCellResponse,
  SecurityFileIssueResponse,
  SecurityFindingCommentWire,
  SecurityFindingLinkWire,
  SecurityFindingWire,
  SecurityHandoffResponse,
  SecurityHandoffWire,
  SecurityReportFindingResponse,
  SecurityPlanCellWire,
  SecurityReviewFindingResponse,
  SecuritySetConfigResponse,
  SecuritySetPlanResponse,
  SecurityStartPreviewResponse,
  SecurityTreeFileResponse,
  SecurityWriteFileResponse,
} from "../wire/types.js";

export const securityRouter = new Hono<AppEnv>();

const SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low", "info"]);
const STATUSES: ReadonlySet<string> = new Set(["open", "verified", "refuted"]);

/**
 * Resolve the session and answer whether the caller may read it. Internal
 * token first (the tools' path — the auth middleware admitted the request
 * without a user, so `c.var.user` is unset on that branch); session user
 * with view access otherwise. `null` means the caller already got a 404.
 */
async function resolveViewableSession(
  c: Context<AppEnv>,
  sessionId: string,
): Promise<typeof agentSessions.$inferSelect | null> {
  const { db } = c.var.providers;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (isValidInternalToken(c.req.header("x-valet-internal"))) return row;
  const user = c.var.user;
  if (!user || !(await canViewSession(db, row, user.id))) return null;
  return row;
}

/** The engagement wire shape, shared by every route that returns it. Parses
 * `changed_paths` (the diff-scoped re-scan changed-file list) to a string[] |
 * null; both `baseRef` and `changedPaths` are null on a first review or a
 * full-scan fallback. */
function engagementToWire(e: SecurityEngagementRow): SecurityEngagementWire {
  let changedPaths: string[] | null = null;
  if (e.changedPaths !== null) {
    try {
      const parsed: unknown = JSON.parse(e.changedPaths);
      if (Array.isArray(parsed)) changedPaths = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      // A malformed value renders as null — the panel shows "Full re-scan".
    }
  }
  return {
    id: e.id,
    sessionId: e.sessionId,
    status: e.status,
    repoFullName: e.repoFullName,
    repoRef: e.repoRef,
    plan: e.plan,
    baseRef: e.baseRef,
    changedPaths,
    hasRepoConfig: e.hasRepoConfig,
    focus: e.focus,
    invariants: parseJsonStringArray(e.invariants),
    categories: parseJsonStringArray(e.categories),
    configPersonas: parseJsonStringRecord(e.configPersonas),
    configTools: parseJsonStringArray(e.configTools),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Parse a stored JSON string[] column; null on absent or malformed. */
function parseJsonStringArray(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // A malformed value renders as null.
  }
  return null;
}

/** Parse a stored JSON Record<string,string> column; null on absent/malformed. */
function parseJsonStringRecord(raw: string | null): Record<string, string> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // A malformed value renders as null.
  }
  return null;
}

/**
 * The persona set a plan may name for this engagement: the bundled registry
 * plus any repo-declared persona keys stored on the engagement
 * (`config_personas`, dynamic-config M-F1). The step editor and the structured
 * plan-edit route validate against this union, so a repo-defined persona stays
 * valid after the config seeded it.
 */
function engagementPersonas(e: SecurityEngagementRow): string[] {
  const configKeys = Object.keys(parseJsonStringRecord(e.configPersonas) ?? {});
  return [...KNOWN_PERSONAS, ...configKeys];
}

/**
 * Parse the engagement's `plan` YAML into the wire step shape (dynamic-config
 * M-F2), the editor's read model. A malformed plan yields [] rather than a
 * throw — the plan is validated on every write, so this only guards a legacy
 * or hand-broken row. `mode` is dropped: the editor writes `fresh` steps.
 */
function planCellsToWire(e: SecurityEngagementRow): SecurityPlanCellWire[] {
  let cells: PlanCell[];
  try {
    cells = parsePlan(e.plan, engagementPersonas(e)).cells;
  } catch {
    return [];
  }
  return cells.map((cell) => ({
    ordinal: cell.ordinal,
    persona: cell.persona,
    ...(cell.name !== undefined ? { name: cell.name } : {}),
    goal: cell.goal,
    ...(cell.playbook !== undefined ? { playbook: cell.playbook } : {}),
    ...(cell.paths !== undefined ? { paths: cell.paths } : {}),
    reads: cell.reads,
    review: cell.review === true,
  }));
}

function cellToWire(cell: SecurityCellRow, progress: CellProgress | null): SecurityCellWire {
  let reads: number[] = [];
  try {
    const parsed: unknown = JSON.parse(cell.reads);
    if (Array.isArray(parsed)) reads = parsed.filter((n): n is number => typeof n === "number");
  } catch {
    // Stamped from a validated plan; an unparseable value renders as [].
  }
  return {
    id: cell.id,
    ordinal: cell.ordinal,
    persona: cell.persona,
    mode: cell.mode,
    goal: cell.goal,
    dir: cell.dir,
    reads,
    review: cell.review,
    status: cell.status,
    attempts: cell.attempts,
    compactedAt: cell.compactedAt,
    childSessionId: cell.childSessionId,
    dispatchedAt: cell.dispatchedAt,
    settledAt: cell.settledAt,
    createdAt: cell.createdAt,
    ...(cell.status === "running" && progress !== null ? { progress } : {}),
  };
}

function findingToWire(f: SecurityFindingRow): SecurityFindingWire {
  return {
    id: f.id,
    cellId: f.cellId,
    fingerprint: f.fingerprint,
    severity: f.severity,
    title: f.title,
    file: f.file,
    line: f.line,
    body: f.body,
    status: f.status,
    statusReason: f.statusReason,
    statusActor: f.statusActor,
    createdAt: f.createdAt,
  };
}

function linkToWire(link: SecurityFindingLinkRow): SecurityFindingLinkWire {
  return {
    id: link.id,
    findingId: link.findingId,
    provider: link.provider,
    externalId: link.externalId,
    url: link.url,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
  };
}

function handoffToWire(h: SecurityHandoffRow): SecurityHandoffWire {
  return {
    childSessionId: h.childSessionId,
    title: h.title,
    ...(h.task != null ? { task: h.task } : {}),
    createdAt: h.createdAt,
  };
}

function commentToWire(c: SecurityFindingCommentRow): SecurityFindingCommentWire {
  return {
    id: c.id,
    body: c.body,
    authorUserId: c.authorUserId,
    createdAt: c.createdAt,
  };
}

const NO_ENGAGEMENT =
  "This session has no security engagement. Create the session with kind 'security' to start one.";

securityRouter.get("/:id/security", async (c) => {
  const sessionId = c.req.param("id");
  const row = await resolveViewableSession(c, sessionId);
  if (!row) return c.json({ error: "session not found" }, 404);

  const { db } = c.var.providers;
  const security = createSecurityEngagementService({ db });
  const result = await security.getEngagementBySession(sessionId);
  if (!result) return c.json({ error: NO_ENGAGEMENT }, 404);

  const progress = await security.getRunningCellProgress(result.engagement.id);
  // One extra query per poll: the runner + cell-children spend (spec
  // §engagement cost). Kept live during the run and after close.
  const cost = await security.getEngagementCost(result.engagement.id);
  // The re-scan diff (re-scan / iterate) — null unless this engagement
  // re-scans a prior one. `fixedCount` stays null until the scan is terminal.
  const diff = await security.diffEngagement(result.engagement.id);
  const body: GetSessionSecurityResponse = {
    engagement: engagementToWire(result.engagement),
    cells: result.cells.map((cell) => cellToWire(cell, progress)),
    cost,
    planCells: planCellsToWire(result.engagement),
    ...(diff ? { diff } : {}),
  };
  return c.json(body);
});

securityRouter.get("/:id/security/findings", async (c) => {
  const sessionId = c.req.param("id");
  const row = await resolveViewableSession(c, sessionId);
  if (!row) return c.json({ error: "session not found" }, 404);

  const severity = c.req.query("severity");
  if (severity !== undefined && !SEVERITIES.has(severity)) {
    return c.json({ error: "severity must be critical, high, medium, low, or info." }, 400);
  }
  const status = c.req.query("status");
  if (status !== undefined && !STATUSES.has(status)) {
    return c.json({ error: "status must be open, verified, or refuted." }, 400);
  }
  const limitParam = c.req.query("limit");
  const limit = limitParam !== undefined ? Number(limitParam) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return c.json({ error: "limit must be a positive integer." }, 400);
  }

  const { db } = c.var.providers;
  const security = createSecurityEngagementService({ db });
  const result = await security.getEngagementBySession(sessionId);
  if (!result) return c.json({ error: NO_ENGAGEMENT }, 404);

  try {
    const page = await security.listFindings(result.engagement.id, {
      cellId: c.req.query("cellId"),
      // Set membership just proved these; the service takes the narrow type.
      severity: severity as FindingSeverity | undefined,
      status: status as FindingStatus | undefined,
      path: c.req.query("path"),
      cursor: c.req.query("cursor"),
      limit,
    });
    // Filed-issue link chips (M6): one grouped query for the page.
    const findingIds = page.findings.map((f) => f.id);
    const linkRows =
      findingIds.length > 0
        ? await db
            .select()
            .from(securityFindingLinks)
            .where(
              and(
                eq(securityFindingLinks.engagementId, result.engagement.id),
                inArray(securityFindingLinks.findingId, findingIds),
              ),
            )
        : [];
    const linksByFinding = new Map<string, SecurityFindingLinkWire[]>();
    for (const link of linkRows) {
      const list = linksByFinding.get(link.findingId) ?? [];
      list.push(linkToWire(link));
      linksByFinding.set(link.findingId, list);
    }
    // Fix sessions (sec_handoff): one grouped query for the page, mirroring
    // the link-chip block. Newest first within each finding.
    const handoffRows =
      findingIds.length > 0
        ? await db
            .select()
            .from(securityHandoffs)
            .where(
              and(
                eq(securityHandoffs.engagementId, result.engagement.id),
                inArray(securityHandoffs.findingId, findingIds),
              ),
            )
            .orderBy(desc(securityHandoffs.createdAt), desc(securityHandoffs.id))
        : [];
    const handoffsByFinding = new Map<string, SecurityHandoffWire[]>();
    for (const h of handoffRows) {
      const list = handoffsByFinding.get(h.findingId) ?? [];
      list.push(handoffToWire(h));
      handoffsByFinding.set(h.findingId, list);
    }
    // Human triage notes (M-F4): one grouped query for the page, oldest-first
    // within each finding — a thread reads top to bottom.
    const commentRows =
      findingIds.length > 0
        ? await db
            .select()
            .from(securityFindingComments)
            .where(
              and(
                eq(securityFindingComments.engagementId, result.engagement.id),
                inArray(securityFindingComments.findingId, findingIds),
              ),
            )
            .orderBy(asc(securityFindingComments.createdAt), asc(securityFindingComments.id))
        : [];
    const commentsByFinding = new Map<string, SecurityFindingCommentWire[]>();
    for (const cm of commentRows) {
      const list = commentsByFinding.get(cm.findingId) ?? [];
      list.push(commentToWire(cm));
      commentsByFinding.set(cm.findingId, list);
    }
    // Re-scan / iterate: mark a finding `recurring` when its fingerprint
    // existed in the parent engagement. Empty set (no parent) → the field
    // stays undefined, so a first review's wire shape is unchanged.
    const parentFps = await security.parentFingerprints(result.engagement.id);
    const isRescan = parentFps.size > 0 || result.engagement.parentEngagementId !== null;
    const body: ListSecurityFindingsResponse = {
      findings: page.findings.map((f) => ({
        ...findingToWire(f),
        links: linksByFinding.get(f.id) ?? [],
        handoffs: handoffsByFinding.get(f.id) ?? [],
        comments: commentsByFinding.get(f.id) ?? [],
        ...(isRescan ? { recurring: parentFps.has(f.fingerprint) } : {}),
      })),
      nextCursor: page.nextCursor,
    };
    return c.json(body);
  } catch (err) {
    // The service's only thrown shape reachable from a read is the bad
    // cursor; its message names the fix.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// ── M3: runner tool backends ───────────────────────────────────────────────

type SessionRow = typeof agentSessions.$inferSelect;

type ToolAccess = "read" | "mutate";

type ResolveToolSessionResult = { ok: SessionRow } | { failure: Response };

/**
 * Resolve the session for a `sec_*` tool route and authorize the caller.
 *
 * Internal-token path: the ACTING session rides in `x-valet-session-id`
 * (the tools stamp `ctx.sessionId`). A mutation requires the acting session
 * to BE `:id` — one runner cannot drive another engagement. A read also
 * admits a session a cell of this engagement claims (`child_session_id`),
 * the M4 persona seam. Anything else answers 403 naming the rule.
 *
 * User path: `canViewSession` for reads, `canAdministerSession` for
 * mutations; refusals answer the existence-hiding 404.
 */
async function resolveToolSession(
  c: Context<AppEnv>,
  sessionId: string,
  access: ToolAccess,
): Promise<ResolveToolSessionResult> {
  const { db } = c.var.providers;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row) return { failure: c.json({ error: "session not found" }, 404) };

  if (isValidInternalToken(c.req.header("x-valet-internal"))) {
    const acting = c.req.header("x-valet-session-id");
    if (!acting) {
      return {
        failure: c.json(
          { error: "Missing acting session. Send the x-valet-session-id header with the calling session id." },
          401,
        ),
      };
    }
    if (acting === sessionId) return { ok: row };
    if (access === "read") {
      // A cell-claimed child may read its engagement's tool routes (M4
      // persona seam): the claim is the `child_session_id` stamp, the same
      // shape as the sandbox gateway's `sid` check.
      const security = createSecurityEngagementService({ db });
      const engagement = await security.getEngagementBySession(sessionId);
      const claimed = engagement?.cells.some((cell) => cell.childSessionId === acting) ?? false;
      if (claimed) return { ok: row };
    }
    return {
      failure: c.json(
        { error: "The acting session does not own this engagement. A runner drives only its own engagement." },
        403,
      ),
    };
  }

  const user = c.var.user;
  if (!user) return { failure: c.json({ error: "session not found" }, 404) };
  const allowed =
    access === "mutate"
      ? await canAdministerSession(db, row, user.id)
      : await canViewSession(db, row, user.id);
  if (!allowed) return { failure: c.json({ error: "session not found" }, 404) };
  return { ok: row };
}

/** The engagement session's owner principal, from the app row. Legacy rows
 * default `owner_id` to "" — fall back to the creating user. */
function sessionOwner(row: SessionRow): Principal {
  const type = row.ownerType === "team" || row.ownerType === "org" ? row.ownerType : "user";
  return { type, id: row.ownerId !== "" ? row.ownerId : row.userId };
}

/**
 * Where a person lands to open this session (mirrors attention-wiring's
 * `attentionHref`): an assistant's conversation lives at `/chat`, every other
 * session keeps the direct `/sessions/:id` link.
 */
function attentionHref(sessionId: string): string {
  const assistantId = parseAssistantSessionId(sessionId);
  return assistantId === null
    ? `/sessions/${encodeURIComponent(sessionId)}`
    : `/chat?assistant=${encodeURIComponent(assistantId)}`;
}

/**
 * The completion notification's AttentionDeps: the same db + channel deliverer
 * the boot-time `wireAttentionRouter` uses (main.ts), so a close/cancel ping
 * reaches web and any wired channel by the one router path.
 */
function attentionDepsFrom(c: Context<AppEnv>): AttentionDeps {
  const { db, channelHost } = c.var.providers;
  return { db, channels: [channelHost.attentionDeliverer()] };
}

/** A short severity roll-up for the completion body, e.g. "12 findings — 2
 * critical, 3 high". Counts are distinct fingerprints from the close manifest.
 * "No findings" when the engagement produced none. */
function findingSummary(distinctBySeverity: Record<FindingSeverity, number>): string {
  const order: FindingSeverity[] = ["critical", "high", "medium", "low", "info"];
  const total = order.reduce((sum, sev) => sum + distinctBySeverity[sev], 0);
  if (total === 0) return "No findings.";
  const parts = order.filter((sev) => distinctBySeverity[sev] > 0).map((sev) => `${distinctBySeverity[sev]} ${sev}`);
  const noun = total === 1 ? "finding" : "findings";
  return `${total} ${noun} — ${parts.join(", ")}.`;
}

/** The runner's resolved session model, read from the live engine session so
 * every persona child inherits it. The runner is live while it dispatches, so
 * this reads its own model rather than re-resolving one — a security runner
 * defaults to a capable model, and its personas do the actual review, so they
 * must not fall to the haiku floor. Best-effort: an unmaterialized runner (no
 * live session) yields undefined, and the child then resolves normally. Mirrors
 * the GET /:id derivation: the canonical spec, not the wire id. */
async function runnerModel(
  c: Context<AppEnv>,
  row: SessionRow,
): Promise<string | undefined> {
  const { db, engineHost } = c.var.providers;
  if (!engineHost.isLive(row.id)) return undefined;
  try {
    const session = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));
    return session.options.modelSpec ?? session.options.model.id;
  } catch {
    return undefined;
  }
}

/** Service-thrown transition refusals become corrective route errors: 429
 * for spawn-limit hits (the `task` tool convention), 409 otherwise. */
function serviceError(c: Context<AppEnv>, err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ChildLimitError) return c.json({ error: message }, 429);
  return c.json({ error: message }, 409);
}

async function readJsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function loadEngagementOr404(c: Context<AppEnv>, sessionId: string) {
  const { db } = c.var.providers;
  const security = createSecurityEngagementService({ db });
  const result = await security.getEngagementBySession(sessionId);
  if (!result) return { security, failure: c.json({ error: NO_ENGAGEMENT }, 404) };
  return { security, result };
}

/** The RUNNING cell (if any) whose dispatch claims `sessionId` as its child
 * — one indexed query (`security_cells_child_session`). Running only: the
 * write claim lives exactly as long as the attempt — a settled cell's child
 * must not keep writing, and a yielded cell's replacement child holds the
 * next claim. */
async function claimedCellOf(db: AppDb, sessionId: string): Promise<SecurityCellRow | null> {
  const rows = await db
    .select()
    .from(securityCells)
    .where(and(eq(securityCells.childSessionId, sessionId), eq(securityCells.status, "running")))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Engagement resolution for tool READS: the session's own engagement first
 * (the runner path), else the engagement of the cell that claims `:id` (the
 * persona path — `sec_fs_read`/`sec_fs_list` name the child's own session
 * id; the child never learns the engagement id). NEVER use this for the
 * runner mutation routes: the claim must not let a persona child drive
 * `plan`/`start`/`dispatch`/`close` (spec threat 8).
 */
async function loadEngagementForRead(c: Context<AppEnv>, sessionId: string) {
  const { db } = c.var.providers;
  const security = createSecurityEngagementService({ db });
  let result = await security.getEngagementBySession(sessionId);
  if (!result) {
    const cell = await claimedCellOf(db, sessionId);
    if (cell) result = await security.getEngagement(cell.engagementId);
  }
  if (!result) return { security, failure: c.json({ error: NO_ENGAGEMENT }, 404) };
  return { security, result };
}

interface PersonaActor {
  security: ReturnType<typeof createSecurityEngagementService>;
  engagement: SecurityEngagementRow;
  cell: SecurityCellRow;
}

type ResolvePersonaActorResult = { ok: PersonaActor } | { failure: Response };

/**
 * Resolve + authorize a persona tool route (M4). Internal-token only —
 * personas exist only behind the engine tool seam, and the human triage
 * surface (M6) is a separate route family. The ACTING session's cell claim
 * is the authority: no claim → corrective 403; the claim names the cell
 * (the service's actor) and the engagement. `:id` must be the acting
 * session itself (the persona tools name their own id) or the engagement's
 * runner session.
 */
async function resolvePersonaActor(
  c: Context<AppEnv>,
  sessionId: string,
): Promise<ResolvePersonaActorResult> {
  if (!isValidInternalToken(c.req.header("x-valet-internal"))) {
    return { failure: c.json({ error: "session not found" }, 404) };
  }
  const acting = c.req.header("x-valet-session-id");
  if (!acting) {
    return {
      failure: c.json(
        { error: "Missing acting session. Send the x-valet-session-id header with the calling session id." },
        401,
      ),
    };
  }
  const { db } = c.var.providers;
  const cell = await claimedCellOf(db, acting);
  if (!cell) {
    return { failure: c.json({ error: "This session is not a dispatched persona cell." }, 403) };
  }
  const security = createSecurityEngagementService({ db });
  const result = await security.getEngagement(cell.engagementId);
  if (!result) return { failure: c.json({ error: NO_ENGAGEMENT }, 404) };
  if (sessionId !== acting && sessionId !== result.engagement.sessionId) {
    return {
      failure: c.json(
        { error: "The acting session does not own this engagement. A persona acts only on its own cell." },
        403,
      ),
    };
  }
  return { ok: { security, engagement: result.engagement, cell } };
}

const HEX_SHA_RE = /^[0-9a-f]{40}$/i;

securityRouter.get("/:id/security/status", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "read");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;
  const { db, engineHost, engineStore, prebuildService } = c.var.providers;

  const progress = await security.getRunningCellProgress(result.engagement.id);

  const countRows = await db
    .select({ severity: securityFindings.severity, n: count() })
    .from(securityFindings)
    .where(eq(securityFindings.engagementId, result.engagement.id))
    .groupBy(securityFindings.severity);
  const findingCounts: Record<FindingSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const row of countRows) {
    if (row.severity in findingCounts) {
      findingCounts[row.severity as FindingSeverity] = Number(row.n ?? 0);
    }
  }

  // Child settled/liveness through the same seam the child_status built-in
  // uses — never a session wake, never a sandbox touch.
  let runningChild: GetSecurityStatusResponse["runningChild"] = null;
  const running = result.cells.find((cell) => cell.status === "running");
  if (running?.childSessionId) {
    const statusReader = buildChildStatusReader({ db, engineHost, engineStore, prebuildService });
    const status = await statusReader(
      { childSessionId: running.childSessionId },
      { parentSessionId: sessionId },
    );
    runningChild = {
      cellId: running.id,
      childSessionId: running.childSessionId,
      settled: status?.settled ?? false,
      lastActivityAt: status?.lastActivityAt ?? null,
      // `null` from the reader means the child session is gone (deleted or
      // missing) — the runner should sec_cell_fail and re-dispatch.
      childGone: status === null,
    };
  }

  const body: GetSecurityStatusResponse = {
    engagement: engagementToWire(result.engagement),
    cells: result.cells.map((cell) => cellToWire(cell, progress)),
    findingCounts,
    runningChild,
  };
  return c.json(body);
});

securityRouter.get("/:id/security/start-preview", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "read");
  if ("failure" in resolved) return resolved.failure;
  const row = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { result } = loaded;

  let plan;
  try {
    plan = parsePlan(result.engagement.plan, KNOWN_PERSONAS);
  } catch (err) {
    return serviceError(c, err);
  }

  const { db, engineCredentials, encryptionKey } = c.var.providers;
  const bindingRows = await db
    .select()
    .from(sessionRepos)
    .where(eq(sessionRepos.sessionId, sessionId))
    .orderBy(sessionRepos.position)
    .limit(1);
  const binding = bindingRows[0];
  if (!binding) {
    return c.json(
      { error: "This session has no repository binding. Create the security session with a repository." },
      409,
    );
  }

  // Resolve the binding's ref to a commit SHA. An already-pinned 40-hex ref
  // needs no lookup — the engagement is deterministic offline.
  let resolvedSha: string;
  const ref = binding.ref ?? undefined;
  if (ref !== undefined && HEX_SHA_RE.test(ref)) {
    resolvedSha = ref.toLowerCase();
  } else {
    const [owner, repo] = binding.fullName.split("/");
    if (!owner || !repo) {
      return c.json({ error: `Repository name "${binding.fullName}" is not owner/repo shaped.` }, 409);
    }
    const tokenDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
    try {
      const token = await resolveApiTokenOrNull(tokenDeps, row.orgId, owner, repo);
      resolvedSha = await resolveRefSha(tokenDeps, token, owner, repo, ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          error:
            `Could not resolve ${binding.fullName}@${ref ?? "default branch"} to a commit: ${message}. ` +
            "Check the repository name and the GitHub connection in Settings.",
        },
        502,
      );
    }
  }

  const body: SecurityStartPreviewResponse = {
    repoFullName: result.engagement.repoFullName,
    resolvedSha,
    cells: plan.cells.map((cell) => ({
      ordinal: cell.ordinal,
      persona: cell.persona,
      name: cellDir(cell),
      goal: cell.goal,
    })),
  };
  return c.json(body);
});

securityRouter.get("/:id/security/files", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "read");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementForRead(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const path = c.req.query("path");
  if (!path) return c.json({ error: "Pass ?path= with the tree path to read." }, 400);
  const revisionParam = c.req.query("revision");
  const revision = revisionParam !== undefined ? Number(revisionParam) : undefined;
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) {
    return c.json({ error: "revision must be a positive integer." }, 400);
  }

  try {
    const file = await security.readFile(result.engagement.id, path, revision);
    const body: SecurityTreeFileResponse = file;
    return c.json(body);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 404);
  }
});

securityRouter.get("/:id/security/files/list", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "read");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementForRead(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const files = await security.listFiles(result.engagement.id, c.req.query("prefix"));
  const body: ListSecurityFilesResponse = { files };
  return c.json(body);
});

securityRouter.post("/:id/security/plan", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  if (typeof body.plan !== "string" || body.plan.trim() === "") {
    return c.json({ error: "Send { plan } with the engagement plan YAML." }, 400);
  }

  try {
    const updated = await security.setPlan(result.engagement.id, body.plan);
    const plan = parsePlan(updated.plan, KNOWN_PERSONAS);
    const response: SecuritySetPlanResponse = { cellCount: plan.cells.length };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

/**
 * A route-level error for a malformed structured plan cell. Carries a
 * corrective message the step editor shows inline.
 */
class PlanCellInputError extends Error {}

/**
 * Convert one structured plan-cell input (dynamic-config M-F2) to a PlanCell,
 * assigning `ordinal`. Shape-only validation with corrective messages; the
 * plan-level rules (dense ordinals, earlier-only reads, known personas and
 * playbooks) run later in `serializePlan` → `parsePlan`. `mode` is always
 * `fresh`: the editor writes fresh steps.
 */
function planCellInputToCell(raw: unknown, ordinal: number): PlanCell {
  const at = `Step ${ordinal}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PlanCellInputError(`${at} must be an object with persona and goal.`);
  }
  const input = raw as Record<string, unknown>;

  if (typeof input.persona !== "string" || input.persona.trim() === "") {
    throw new PlanCellInputError(`${at} needs a persona. Pick one from the persona list.`);
  }
  if (typeof input.goal !== "string" || input.goal.trim() === "") {
    throw new PlanCellInputError(`${at} needs a goal. Write what the step must accomplish.`);
  }

  const cell: PlanCell = {
    ordinal,
    persona: input.persona,
    mode: "fresh",
    goal: input.goal,
    reads: [],
  };

  if (input.name !== undefined) {
    if (typeof input.name !== "string") {
      throw new PlanCellInputError(`${at} has a non-text name. Write a short label, or omit it.`);
    }
    if (input.name.trim() !== "") cell.name = input.name;
  }

  if (input.playbook !== undefined && input.playbook !== null) {
    if (typeof input.playbook !== "string") {
      throw new PlanCellInputError(`${at} has a non-text playbook. Pick one from the playbook list.`);
    }
    if (input.playbook.trim() !== "") cell.playbook = input.playbook;
  }

  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths) || input.paths.some((p) => typeof p !== "string")) {
      throw new PlanCellInputError(`${at} has a non-text paths list. List include globs as text.`);
    }
    const paths = input.paths.filter((p): p is string => typeof p === "string" && p.trim() !== "");
    if (paths.length > 0) cell.paths = paths;
  }

  if (input.reads !== undefined) {
    if (!Array.isArray(input.reads) || input.reads.some((r) => typeof r !== "number")) {
      throw new PlanCellInputError(`${at} has a non-numeric reads list. List earlier step numbers.`);
    }
    cell.reads = input.reads.filter((r): r is number => typeof r === "number");
  }

  if (input.review !== undefined) {
    if (typeof input.review !== "boolean") {
      throw new PlanCellInputError(`${at} has a non-boolean review flag. Use true or false.`);
    }
    if (input.review) cell.review = true;
  }

  return cell;
}

/**
 * Structured plan-edit route (dynamic-config M-F2, spec §Dynamic configuration).
 * Accepts `{ cells: SecurityPlanCellInput[] }` — the step editor's write path,
 * so the web never has to build plan YAML. The server assigns dense ordinals
 * 1..N in array order, serializes the cells, and validates the plan against the
 * bundled personas ∪ the engagement's repo-declared personas. Human-admin auth
 * rides the same `resolveToolSession` "mutate" ladder as the YAML route. The
 * plan stays immutable once the engagement runs — `setPlan` surfaces that.
 */
securityRouter.post("/:id/security/plan/cells", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  if (!Array.isArray(body.cells) || body.cells.length === 0) {
    return c.json({ error: "Send { cells } with at least one plan step." }, 400);
  }

  let planYaml: string;
  try {
    // Dense ordinals 1..N follow array order; the editor never sends ordinals.
    const cells = body.cells.map((raw, i) => planCellInputToCell(raw, i + 1));
    planYaml = serializePlan(cells);
  } catch (err) {
    if (err instanceof PlanCellInputError) return c.json({ error: err.message }, 400);
    throw err;
  }

  try {
    // Validate + persist against the union so a repo-declared persona stays
    // valid. setPlan re-parses the YAML with this same set and refuses a
    // running engagement with a corrective message.
    const updated = await security.setPlan(
      result.engagement.id,
      planYaml,
      engagementPersonas(result.engagement),
    );
    const plan = parsePlan(updated.plan, engagementPersonas(updated));
    const response: SecuritySetPlanResponse = { cellCount: plan.cells.length };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

/**
 * Structured focus + invariants edit route (dynamic-config M-F3, spec §Dynamic
 * configuration). Accepts `{ focus?, invariants? }` — the panel's config editor
 * write path. Repo config seeds these at create; this lets an admin add or edit
 * them before start. `focus` of `null` or `""` clears the note; `invariants`
 * of `[]` clears the list; an omitted field leaves it. Human-admin auth rides
 * the same `resolveToolSession` "mutate" ladder as the plan routes, and the
 * service refuses a running engagement with the immutable-config error. Returns
 * the saved values so the editor reflects the server's cleaned form.
 */
securityRouter.post("/:id/security/config", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  const args: { focus?: string | null; invariants?: string[] } = {};
  if ("focus" in body) {
    if (body.focus !== null && typeof body.focus !== "string") {
      return c.json({ error: "focus must be a text note or null." }, 400);
    }
    args.focus = body.focus;
  }
  if ("invariants" in body) {
    if (
      !Array.isArray(body.invariants) ||
      !body.invariants.every((v): v is string => typeof v === "string")
    ) {
      return c.json({ error: "invariants must be a list of strings." }, 400);
    }
    args.invariants = body.invariants;
  }
  if (args.focus === undefined && args.invariants === undefined) {
    return c.json({ error: "Send { focus } or { invariants } to edit." }, 400);
  }

  try {
    const updated = await security.setEngagementConfig(result.engagement.id, args);
    const response: SecuritySetConfigResponse = {
      focus: updated.focus,
      invariants: parseJsonStringArray(updated.invariants) ?? [],
    };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

/**
 * Diff-scoped re-scan (re-scan / iterate): resolve the changed files between
 * the parent engagement's pinned SHA (base) and the new HEAD, so the start
 * route can scope the sweeps to the delta. Returns `{ baseRef, changedFiles }`:
 *   - Not a re-scan (no parent) → both null; a full scan.
 *   - A parent with no pinned SHA → both null; a full scan.
 *   - A compare failure → `baseRef` set (for the record), `changedFiles` null;
 *     a full scan. Never throws — a diff error must not fail the start.
 * The GitHub token resolves the same way `start-preview` does.
 */
async function resolveRescanDiff(
  c: Context<AppEnv>,
  engagement: SecurityEngagementRow,
  headSha: string,
): Promise<{ baseRef: string | null; changedFiles: string[] | null }> {
  if (!engagement.parentEngagementId) return { baseRef: null, changedFiles: null };

  const { db, engineCredentials, encryptionKey } = c.var.providers;
  const security = createSecurityEngagementService({ db });
  const parent = await security.getEngagement(engagement.parentEngagementId);
  const baseRef = parent?.engagement.repoRef ?? "";
  if (baseRef === "") {
    // The prior review never pinned a commit — nothing to diff against.
    console.log(`security start: re-scan of ${engagement.parentEngagementId} has no base SHA; full scan`);
    return { baseRef: null, changedFiles: null };
  }

  const [owner, repo] = engagement.repoFullName.split("/");
  if (!owner || !repo) return { baseRef, changedFiles: null };

  // The owning session's org scopes the GitHub token, mirroring start-preview.
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, engagement.sessionId)).limit(1);
  const orgId = rows[0]?.orgId ?? "";
  const tokenDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
  try {
    const token = await resolveApiTokenOrNull(tokenDeps, orgId, owner, repo);
    const changedFiles = await resolveChangedFiles(tokenDeps, token, owner, repo, baseRef, headSha);
    return { baseRef, changedFiles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      `security start: compare ${baseRef}...${headSha} for ${engagement.repoFullName} failed (${message}); full scan`,
    );
    return { baseRef, changedFiles: null };
  }
}

securityRouter.post("/:id/security/start", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  if (typeof body.resolvedSha !== "string" || !HEX_SHA_RE.test(body.resolvedSha)) {
    return c.json(
      { error: "Send { resolvedSha } with the 40-hex commit SHA from GET .../security/start-preview." },
      400,
    );
  }
  const resolvedSha = body.resolvedSha.toLowerCase();

  // Diff-scoped re-scan (re-scan / iterate): when this engagement re-scans a
  // prior one, compute the changed files between the parent's pinned SHA (base)
  // and the new HEAD (resolvedSha), so `startEngagement` scopes the sweeps to
  // the delta. The diff is known only here — the new SHA arrives in this
  // request. Graceful fallback: a compare failure (a force-pushed base, an API
  // error, or an empty base) leaves `changedFiles` null and the re-scan runs a
  // full scan. The start never fails on a diff error.
  const rescan = await resolveRescanDiff(c, result.engagement, resolvedSha);

  try {
    const started = await security.startEngagement(result.engagement.id, {
      resolvedSha,
      baseRef: rescan.baseRef,
      changedFiles: rescan.changedFiles,
    });
    const response: GetSessionSecurityResponse = {
      engagement: engagementToWire(started.engagement),
      cells: started.cells.map((cell) => cellToWire(cell, null)),
      // Just started: the runner may have spent tokens, cell children none yet.
      cost: await security.getEngagementCost(started.engagement.id),
      planCells: planCellsToWire(started.engagement),
    };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/dispatch", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;
  const row = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  const cellId = typeof body.cellId === "string" ? body.cellId : undefined;
  const mode = body.mode;
  if (mode !== undefined && mode !== "fresh" && mode !== "resume") {
    return c.json({ error: "mode must be 'fresh' or 'resume'." }, 400);
  }
  // The acting thread: settlement signals land here. The sec_dispatch tool
  // passes ctx.threadId; a direct caller must name a thread the same way.
  const threadId = body.threadId;
  if (typeof threadId !== "string" || threadId === "") {
    return c.json({ error: "Send { threadId } with the dispatching thread's id." }, 400);
  }

  // The spawn seam: the SAME children.ts machinery the task tool uses —
  // limits, agent_sessions row, child_watches row, armed watcher — so the
  // child's settlement signals the runner thread. Never bypass it.
  const { childSpawner } = c.var.providers;
  // Personas inherit the runner's model, so a capable security default reaches
  // the sessions that do the actual review.
  const model = await runnerModel(c, row);
  const spawn: SpawnCellChild = async (req) => {
    const spawned = await childSpawner(
      {
        prompt: req.message,
        title: req.title,
        repo: req.repo,
        // The engagement's pinned commit SHA — every persona reads an
        // identical tree.
        branch: req.ref,
        profile: "headless",
        // The pre-stamped cell claim names this id, so the child-session
        // build attaches the persona toolset + role (M4).
        sessionId: req.childSessionId,
        // Per-turn role overlay for the dispatch prompt.
        role: req.role,
        ...(model ? { model } : {}),
      },
      {
        parentSessionId: sessionId,
        parentThreadId: threadId,
        actorUserId: row.userId,
        owner: sessionOwner(row),
      },
    );
    return { childSessionId: spawned.childSessionId };
  };

  try {
    const { cell } = await security.dispatchCell(result.engagement.id, { cellId, mode, spawn });
    const response: SecurityDispatchResponse = { cell: cellToWire(cell, null) };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/cells/:cellId/complete", async (c) => {
  const sessionId = c.req.param("id");
  const cellId = c.req.param("cellId");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;
  const { db } = c.var.providers;

  // `settled` comes from the durable child watch, not from the agent's
  // narration: the watch row is the same signal the settlement watcher
  // marks after admitting child.settled.
  const cell = result.cells.find((candidate) => candidate.id === cellId);
  if (!cell) {
    return c.json({ error: `No cell ${cellId} in this engagement. Check the id with sec_status.` }, 404);
  }
  let settled = false;
  if (cell.childSessionId) {
    const watchRows = await db
      .select({ settled: childWatches.settled })
      .from(childWatches)
      .where(
        and(
          eq(childWatches.childSessionId, cell.childSessionId),
          eq(childWatches.parentSessionId, sessionId),
        ),
      )
      .limit(1);
    settled = watchRows[0]?.settled === true;
  }

  try {
    const ruling = await security.completeCell(result.engagement.id, cellId, { settled });
    const response: SecurityCompleteCellResponse =
      ruling.outcome === "violation"
        ? { outcome: "violation", violation: ruling.violation }
        : { outcome: ruling.outcome, cell: cellToWire(ruling.cell, null) };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/cells/:cellId/fail", async (c) => {
  const sessionId = c.req.param("id");
  const cellId = c.req.param("cellId");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  if (typeof body.reason !== "string" || body.reason.trim() === "") {
    return c.json({ error: "Send { reason } naming why the cell failed." }, 400);
  }

  try {
    const failed = await security.failCell(result.engagement.id, cellId, body.reason);
    const response: SecurityFailCellResponse = {
      cell: cellToWire(failed.cell, null),
      reason: failed.reason,
    };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/close", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;
  const row = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  try {
    const manifest = await security.closeEngagement(result.engagement.id);
    // Completion ping: the human OR the runner (via sec_close) closes, so the
    // owner learns the review ended either way. The dedupe key makes a re-close
    // or retry a no-op — routeAttention inserts once per engagement close.
    const ended = manifest.status === "completed" ? "complete" : "ended";
    await routeAttention(attentionDepsFrom(c), {
      kind: "notification",
      owner: sessionOwner(row),
      sessionId,
      title: manifest.status === "completed" ? "Security review complete" : "Security review ended",
      body: `${manifest.repoFullName} review ${ended}. ${findingSummary(manifest.findings.distinctBySeverity)}`,
      href: attentionHref(sessionId),
      dedupeKey: `security-close:${result.engagement.id}`,
    }).catch((err) => {
      // Best-effort: a notification failure must not fail the close.
      console.error(`security close: attention route failed for ${result.engagement.id}:`, err);
    });
    const response: SecurityCloseResponse = { manifest };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/handoff", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveToolSession(c, sessionId, "mutate");
  if ("failure" in resolved) return resolved.failure;
  const row = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;
  const { db, childSpawner } = c.var.providers;

  const body = await readJsonBody(c);
  if (typeof body.findingId !== "string" || body.findingId === "") {
    return c.json({ error: "Send { findingId } with the finding to hand off." }, 400);
  }
  const task = typeof body.task === "string" && body.task.trim() !== "" ? body.task : undefined;
  const threadId = body.threadId;
  if (typeof threadId !== "string" || threadId === "") {
    return c.json({ error: "Send { threadId } with the requesting thread's id." }, 400);
  }

  const findingRows = await db
    .select()
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.engagementId, result.engagement.id),
        eq(securityFindings.id, body.findingId),
      ),
    )
    .limit(1);
  const finding = findingRows[0];
  if (!finding) {
    return c.json(
      { error: `No finding ${body.findingId} in this engagement. List findings with sec_findings_list.` },
      404,
    );
  }

  const title = `Fix: ${finding.title}`;
  const location = finding.file ? `${finding.file}${finding.line != null ? `:${finding.line}` : ""}` : "(no file)";
  const brief = [
    `Fix this security finding in ${result.engagement.repoFullName}.`,
    "",
    `Severity: ${finding.severity}`,
    `Title: ${finding.title}`,
    `Location: ${location}`,
    "",
    "Evidence:",
    finding.body,
    ...(task ? ["", `Task: ${task}`] : []),
  ].join("\n");

  // The fix session inherits the runner's model, same as a dispatched persona.
  const model = await runnerModel(c, row);

  try {
    // Same children.ts seam as dispatch: the fix session is an ordinary
    // coding child, bound to the engagement repo at the pinned SHA.
    const spawned = await childSpawner(
      {
        prompt: brief,
        title,
        repo: result.engagement.repoFullName,
        ...(result.engagement.repoRef !== "" ? { branch: result.engagement.repoRef } : {}),
        profile: "headless",
        ...(model ? { model } : {}),
      },
      {
        parentSessionId: sessionId,
        parentThreadId: threadId,
        actorUserId: row.userId,
        owner: sessionOwner(row),
      },
    );
    // Record the link so the finding can surface and open its fix session.
    // The child already exists; a lost link row must not 500 the tool, so a
    // failed insert logs and still returns the child id.
    try {
      await security.recordHandoff({
        engagementId: result.engagement.id,
        findingId: body.findingId,
        childSessionId: spawned.childSessionId,
        title,
        task,
        createdBy: row.userId,
      });
    } catch (recordErr) {
      console.error(
        `security handoff: spawned ${spawned.childSessionId} for finding ${body.findingId} but link insert failed:`,
        recordErr,
      );
    }
    const response: SecurityHandoffResponse = { childSessionId: spawned.childSessionId, title };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

// ── M4: persona tool backends ──────────────────────────────────────────────

securityRouter.post("/:id/security/files", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolvePersonaActor(c, sessionId);
  if ("failure" in resolved) return resolved.failure;
  const { security, engagement, cell } = resolved.ok;

  const body = await readJsonBody(c);
  if (typeof body.path !== "string" || body.path === "") {
    return c.json({ error: "Send { path } with the tree path to write." }, 400);
  }
  if (typeof body.content !== "string") {
    return c.json({ error: "Send { content } with the file content." }, 400);
  }

  try {
    // The service enforces the write claim (the path prefix IS the claim)
    // and the state.yml validation; its messages are corrective — relay
    // them verbatim.
    const written = await security.writeFile(engagement.id, {
      actorCellId: cell.id,
      path: body.path,
      content: body.content,
    });
    const response: SecurityWriteFileResponse = written;
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/findings", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolvePersonaActor(c, sessionId);
  if ("failure" in resolved) return resolved.failure;
  const { security, engagement, cell } = resolved.ok;

  const body = await readJsonBody(c);
  const severity = body.severity;
  if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
    return c.json({ error: "severity must be critical, high, medium, low, or info." }, 400);
  }
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return c.json({ error: "Send { title } naming the finding." }, 400);
  }
  if (typeof body.body !== "string") {
    return c.json({ error: "Send { body } with the finding's evidence." }, 400);
  }
  if (body.file !== undefined && typeof body.file !== "string") {
    return c.json({ error: "file must be a repo path string." }, 400);
  }
  if (body.line !== undefined && (typeof body.line !== "number" || !Number.isInteger(body.line) || body.line < 1)) {
    return c.json({ error: "line must be a positive integer." }, 400);
  }

  try {
    const reported = await security.reportFinding(engagement.id, {
      cellId: cell.id,
      // The set membership above proved the narrow type.
      severity: severity as FindingSeverity,
      title: body.title,
      file: typeof body.file === "string" ? body.file : undefined,
      line: typeof body.line === "number" ? body.line : undefined,
      body: body.body,
    });
    const response: SecurityReportFindingResponse = {
      finding: findingToWire(reported.finding),
      siblings: reported.siblings.map(findingToWire),
      ...(reported.carriedFrom ? { carriedFrom: reported.carriedFrom } : {}),
    };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

securityRouter.post("/:id/security/findings/:findingId/review", async (c) => {
  const sessionId = c.req.param("id");
  const findingId = c.req.param("findingId");
  const resolved = await resolvePersonaActor(c, sessionId);
  if ("failure" in resolved) return resolved.failure;
  const { security, engagement, cell } = resolved.ok;

  const body = await readJsonBody(c);
  if (body.status !== "verified" && body.status !== "refuted") {
    return c.json({ error: "status must be 'verified' or 'refuted'." }, 400);
  }
  if (typeof body.reason !== "string" || body.reason.trim() === "") {
    return c.json({ error: "Send { reason } naming what the evidence shows or what it missed." }, 400);
  }

  try {
    // Actor = the claiming CELL id: the service enforces review-cell gating
    // (only review cells flip statuses) and forward-only transitions.
    const finding = await security.reviewFinding(engagement.id, {
      findingId,
      status: body.status,
      reason: body.reason,
      actor: cell.id,
    });
    const response: SecurityReviewFindingResponse = { finding: findingToWire(finding) };
    return c.json(response);
  } catch (err) {
    return serviceError(c, err);
  }
});

// ── M6: human triage routes ────────────────────────────────────────────────
//
// Decision 10 (spec §Filing issues, threat 11): review, export, and issue
// filing are HUMAN actions. A valid internal token — the runner's and the
// personas' path — is refused outright on all four routes, so content
// derived from hostile code leaves Valet only on a person's click.

const HUMAN_ONLY =
  "This is a human action. Sign in and call it as a user — the internal token is refused here.";

type HumanAccess = "view" | "administer";

interface HumanCaller {
  row: SessionRow;
  user: AuthUser;
}

type ResolveHumanSessionResult = { ok: HumanCaller } | { failure: Response };

/**
 * Resolve + authorize a triage route. Named checks per the explicit-authz
 * rule: `canViewSession` for export and filing (view-gated, spec §Export /
 * §Filing issues), `canAdministerSession` for verify/refute — never
 * inherited from view access. A viewer without the admin right gets a 403
 * that names the required right; a non-viewer gets the existence-hiding 404.
 */
async function resolveHumanSession(
  c: Context<AppEnv>,
  sessionId: string,
  access: HumanAccess,
): Promise<ResolveHumanSessionResult> {
  if (isValidInternalToken(c.req.header("x-valet-internal"))) {
    return { failure: c.json({ error: HUMAN_ONLY }, 403) };
  }
  // The internal-token rung sets no user; every other rung does. Read the
  // variable through its true runtime type.
  const user = requireUser(c);
  if (!user) return { failure: c.json({ error: "session not found" }, 404) };

  const { db } = c.var.providers;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row) return { failure: c.json({ error: "session not found" }, 404) };

  // Named check: canViewSession — the view gate every triage route holds.
  if (!(await canViewSession(db, row, user.id))) {
    return { failure: c.json({ error: "session not found" }, 404) };
  }
  if (access === "administer" && !(await canAdministerSession(db, row, user.id))) {
    return {
      failure: c.json(
        {
          error:
            "Only a session admin can verify or refute findings (canAdministerSession). " +
            "Ask the session owner or a team admin to review.",
        },
        403,
      ),
    };
  }
  return { ok: { row, user } };
}

/**
 * POST /:id/security/findings/:findingId/status — the human review action
 * (spec §Findings review). Forward-only; the service stamps
 * `status_actor: user:<id>`.
 */
securityRouter.post("/:id/security/findings/:findingId/status", async (c) => {
  const sessionId = c.req.param("id");
  const findingId = c.req.param("findingId");
  const resolved = await resolveHumanSession(c, sessionId, "administer");
  if ("failure" in resolved) return resolved.failure;
  const { user } = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;

  const body = await readJsonBody(c);
  if (body.status !== "verified" && body.status !== "refuted") {
    return c.json({ error: "status must be 'verified' or 'refuted'." }, 400);
  }
  if (typeof body.reason !== "string" || body.reason.trim() === "") {
    return c.json({ error: "Send { reason } naming what the evidence shows or what it missed." }, 400);
  }

  try {
    const finding = await security.reviewFinding(result.engagement.id, {
      findingId,
      status: body.status,
      reason: body.reason,
      actor: `user:${user.id}`,
    });
    const response: SecurityReviewFindingResponse = { finding: findingToWire(finding) };
    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Unknown finding → 404; forward-only refusals → 409.
    if (message.startsWith("No finding")) return c.json({ error: message }, 404);
    return c.json({ error: message }, 409);
  }
});

/**
 * POST /:id/security/findings/:findingId/comments { body } — add a human note
 * to a finding (spec §Re-scan / iterate). VIEW-gated: any viewer may comment —
 * commenting is collaboration, not an admin action. HUMAN-only: the internal
 * token is refused (the runner and personas do not comment through this route),
 * so `resolveHumanSession(.., "view")` holds both rules. `author_user_id` is the
 * acting user. On a re-scan these notes ride into `/prior/findings.md`.
 */
securityRouter.post("/:id/security/findings/:findingId/comments", async (c) => {
  const sessionId = c.req.param("id");
  const findingId = c.req.param("findingId");
  // View-gated + human-only: the named check is canViewSession, inside
  // resolveHumanSession; the internal token is refused there.
  const resolved = await resolveHumanSession(c, sessionId, "view");
  if ("failure" in resolved) return resolved.failure;
  const { user } = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;
  const { db } = c.var.providers;

  const body = await readJsonBody(c);
  if (typeof body.body !== "string" || body.body.trim() === "") {
    return c.json({ error: "Send { body } with the note text." }, 400);
  }

  // Scoped to THIS engagement: a finding id from another engagement is not
  // reachable here.
  const findingRows = await db
    .select()
    .from(securityFindings)
    .where(
      and(eq(securityFindings.engagementId, result.engagement.id), eq(securityFindings.id, findingId)),
    )
    .limit(1);
  if (!findingRows[0]) {
    return c.json({ error: `No finding ${findingId} in this engagement.` }, 404);
  }

  try {
    const comment = await security.addFindingComment(result.engagement.id, {
      findingId,
      body: body.body,
      authorUserId: user.id,
    });
    const response: SecurityAddFindingCommentResponse = { comment: commentToWire(comment) };
    return c.json(response);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /:id/security/cancel — stop a planning or running engagement (spec
 * §Cancel). HUMAN action: `resolveHumanSession(.., "administer")` refuses the
 * internal token (403) so the runner cannot cancel itself, and gates on
 * `canAdministerSession`. The service flips the engagement to 'cancelled' and
 * fails every unsettled cell; if a cell had a running child, this route tears
 * it down through the session-terminate seam (`engineHost.destroy` +
 * soft-delete, the same path DELETE /api/sessions/:id runs). Teardown is
 * best-effort — the status flip is the source of truth, so a destroy failure
 * logs and the route still returns the cancelled engagement.
 */
securityRouter.post("/:id/security/cancel", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveHumanSession(c, sessionId, "administer");
  if ("failure" in resolved) return resolved.failure;
  const { row } = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;
  const { db, engineHost } = c.var.providers;

  let cancelled;
  try {
    cancelled = await security.cancelEngagement(result.engagement.id);
  } catch (err) {
    return serviceError(c, err);
  }

  // Tear the in-flight persona child down, if any — the same seam DELETE
  // /api/sessions/:id uses: engine + sandbox destroy, then soft-delete the
  // session row. Best-effort: a failure logs and the cancel still succeeds.
  const childId = cancelled.terminatedChildSessionId;
  if (childId) {
    try {
      await engineHost.destroy(childId);
      await db
        .update(agentSessions)
        .set({ status: "deleted", updatedAt: Date.now() })
        .where(eq(agentSessions.id, childId));
    } catch (err) {
      console.error(`security cancel: child ${childId} teardown failed:`, err);
    }
  }

  // Cancellation ping: the owner learns the review ended (spec §Cancel). Dedupe
  // shares the close key — a review ends once, whether closed or cancelled.
  await routeAttention(attentionDepsFrom(c), {
    kind: "notification",
    owner: sessionOwner(row),
    sessionId,
    title: "Security review cancelled",
    body: `${result.engagement.repoFullName} review cancelled.`,
    href: attentionHref(sessionId),
    dedupeKey: `security-close:${result.engagement.id}`,
  }).catch((err) => {
    console.error(`security cancel: attention route failed for ${result.engagement.id}:`, err);
  });

  // Re-read cells so the response reflects the cancel's failed-cell writes.
  const after = await security.getEngagement(cancelled.engagement.id);
  const response: GetSessionSecurityResponse = {
    engagement: engagementToWire(cancelled.engagement),
    cells: (after?.cells ?? []).map((cell) => cellToWire(cell, null)),
    // The review's spend to the point of cancel — the panel keeps showing it.
    cost: await security.getEngagementCost(cancelled.engagement.id),
    planCells: planCellsToWire(cancelled.engagement),
  };
  return c.json(response);
});

const EXPORT_FORMATS = {
  md: { contentType: "text/markdown; charset=utf-8", ext: "md" },
  // The convention GitHub code scanning and the SARIF tooling ecosystem
  // use for SARIF payloads.
  sarif: { contentType: "application/sarif+json", ext: "sarif" },
  json: { contentType: "application/json", ext: "json" },
} as const;

/**
 * GET /:id/security/export?format=md|sarif|json&severity=&status=&cellId=
 * (spec §Export). View-gated, human-only, generated from rows — no sandbox
 * involvement. Every export writes an audit row with actor, format, and
 * row count.
 */
securityRouter.get("/:id/security/export", async (c) => {
  const sessionId = c.req.param("id");
  const resolved = await resolveHumanSession(c, sessionId, "view");
  if ("failure" in resolved) return resolved.failure;
  const { user } = resolved.ok;

  const format = c.req.query("format");
  if (format !== "md" && format !== "sarif" && format !== "json") {
    return c.json({ error: "format must be md, sarif, or json." }, 400);
  }
  const severity = c.req.query("severity");
  if (severity !== undefined && !SEVERITIES.has(severity)) {
    return c.json({ error: "severity must be critical, high, medium, low, or info." }, 400);
  }
  const status = c.req.query("status");
  if (status !== undefined && !STATUSES.has(status)) {
    return c.json({ error: "status must be open, verified, or refuted." }, 400);
  }

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { security, result } = loaded;
  const { db } = c.var.providers;

  // Page through EVERY matching row — export scope is the full filtered
  // set, not one cursor page.
  const findings: SecurityFindingRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await security.listFindings(result.engagement.id, {
      cellId: c.req.query("cellId"),
      // Set membership just proved these; the service takes the narrow type.
      severity: severity as FindingSeverity | undefined,
      status: status as FindingStatus | undefined,
      cursor,
      limit: 500,
    });
    findings.push(...page.findings);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  const input: SecurityExportInput = {
    engagement: result.engagement,
    cells: result.cells,
    findings,
    repoFullName: result.engagement.repoFullName,
    repoRef: result.engagement.repoRef,
  };
  const payload =
    format === "md"
      ? buildMarkdownReport(input)
      : JSON.stringify(format === "sarif" ? buildSarif(input) : buildJsonExport(input), null, 2);

  // Audit event (spec §Export): actor, format, row count. There is no
  // dedicated user-audit table today; the `action_invocations` audit sink
  // (the same fire-and-forget writer the policy audit uses) is the durable
  // audit surface, so the export event lands there.
  await persistInvocationAudit(db, {
    invocationId: `sec:export:${randomUUID()}`,
    service: "valet-security",
    actionId: "security.export",
    status: "completed",
    sessionId,
    userId: user.id,
    orgId: user.orgId,
    params: { format, rowCount: findings.length, engagementId: result.engagement.id },
  });

  const meta = EXPORT_FORMATS[format];
  c.header("Content-Type", meta.contentType);
  c.header(
    "Content-Disposition",
    `attachment; filename="valet-security-${result.engagement.id}.${meta.ext}"`,
  );
  return c.body(payload);
});

/** The invoker seam issue filing rides (Decision 11): the SAME
 * `buildActionInvoker` a workflow tool node dispatches through, scoped to
 * the acting user's credentials. `webBaseUrl` prefers the configured public
 * URL (the channels' rule); dev and tests fall back to the request origin. */
function buildIssuesDeps(c: Context<AppEnv>): SecurityIssuesDeps {
  const { db, engineCredentials, actionPluginByService, plugins, encryptionKey } = c.var.providers;
  const invokeAction = buildActionInvoker({
    db,
    credentials: engineCredentials,
    actionPluginByService,
    plugins,
    githubTokenDeps: { key: deriveSecretKey(encryptionKey) },
  });
  const webBaseUrl = publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin;
  return { db, invokeAction, webBaseUrl };
}

/** Filing failures → HTTP: corrective 400s for a missing integration or a
 * bad request shape; 502 for a provider-side failure. */
function issueError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof MissingIntegrationError || err instanceof IssueRequestError) {
    return c.json({ error: err.message }, 400);
  }
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
}

function parseIssueProvider(value: unknown): IssueProvider | null {
  return value === "github" || value === "linear" ? value : null;
}

/**
 * POST /:id/security/findings/:findingId/issues { provider, repo?, teamId? }
 * — file ONE issue for ONE finding (spec §Filing issues). Idempotent by the
 * `(finding, provider)` unique index: a repeat answers 200 with the
 * existing link and `created: false`.
 */
securityRouter.post("/:id/security/findings/:findingId/issues", async (c) => {
  const sessionId = c.req.param("id");
  const findingId = c.req.param("findingId");
  // View-gated (spec §Filing issues): the named check is canViewSession,
  // inside resolveHumanSession.
  const resolved = await resolveHumanSession(c, sessionId, "view");
  if ("failure" in resolved) return resolved.failure;
  const { user } = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { result } = loaded;
  const { db } = c.var.providers;

  const body = await readJsonBody(c);
  const provider = parseIssueProvider(body.provider);
  if (!provider) return c.json({ error: "provider must be 'github' or 'linear'." }, 400);
  if (body.repo !== undefined && typeof body.repo !== "string") {
    return c.json({ error: "repo must be an owner/name string." }, 400);
  }
  if (body.teamId !== undefined && typeof body.teamId !== "string") {
    return c.json({ error: "teamId must be a Linear team id string." }, 400);
  }

  // Scoped to THIS engagement: a finding id from another engagement is not
  // reachable here.
  const findingRows = await db
    .select()
    .from(securityFindings)
    .where(
      and(eq(securityFindings.engagementId, result.engagement.id), eq(securityFindings.id, findingId)),
    )
    .limit(1);
  const finding = findingRows[0];
  if (!finding) {
    return c.json({ error: `No finding ${findingId} in this engagement.` }, 404);
  }

  try {
    const filed = await fileFindingIssue(buildIssuesDeps(c), {
      engagement: result.engagement,
      finding,
      provider,
      actor: { userId: user.id, orgId: user.orgId },
      repo: typeof body.repo === "string" ? body.repo : undefined,
      teamId: typeof body.teamId === "string" ? body.teamId : undefined,
    });
    const response: SecurityFileIssueResponse = {
      link: linkToWire(filed.link),
      created: filed.created,
    };
    return c.json(response);
  } catch (err) {
    return issueError(c, err);
  }
});

/**
 * POST /:id/security/issues/digest { provider, findingIds, repo?, teamId? }
 * — ONE digest issue from many findings (spec §Filing issues: a tracker
 * flooded with forty auto-filed tickets is worse than no integration).
 * Writes no link rows.
 */
securityRouter.post("/:id/security/issues/digest", async (c) => {
  const sessionId = c.req.param("id");
  // View-gated (spec §Filing issues): the named check is canViewSession,
  // inside resolveHumanSession.
  const resolved = await resolveHumanSession(c, sessionId, "view");
  if ("failure" in resolved) return resolved.failure;
  const { user } = resolved.ok;

  const loaded = await loadEngagementOr404(c, sessionId);
  if ("failure" in loaded) return loaded.failure;
  const { result } = loaded;
  const { db } = c.var.providers;

  const body = await readJsonBody(c);
  const provider = parseIssueProvider(body.provider);
  if (!provider) return c.json({ error: "provider must be 'github' or 'linear'." }, 400);
  if (
    !Array.isArray(body.findingIds) ||
    body.findingIds.length === 0 ||
    !body.findingIds.every((id): id is string => typeof id === "string")
  ) {
    return c.json({ error: "Send { findingIds } with at least one finding id." }, 400);
  }
  if (body.repo !== undefined && typeof body.repo !== "string") {
    return c.json({ error: "repo must be an owner/name string." }, 400);
  }
  if (body.teamId !== undefined && typeof body.teamId !== "string") {
    return c.json({ error: "teamId must be a Linear team id string." }, 400);
  }

  const requestedIds = [...new Set(body.findingIds)];
  const findings = await db
    .select()
    .from(securityFindings)
    .where(
      and(
        eq(securityFindings.engagementId, result.engagement.id),
        inArray(securityFindings.id, requestedIds),
      ),
    );
  if (findings.length !== requestedIds.length) {
    return c.json(
      { error: "Every finding in { findingIds } must belong to this engagement." },
      400,
    );
  }

  try {
    const digest = await fileDigestIssue(buildIssuesDeps(c), {
      engagement: result.engagement,
      findings,
      provider,
      actor: { userId: user.id, orgId: user.orgId },
      repo: typeof body.repo === "string" ? body.repo : undefined,
      teamId: typeof body.teamId === "string" ? body.teamId : undefined,
    });
    const response: SecurityDigestIssueResponse = { url: digest.url };
    return c.json(response);
  } catch (err) {
    return issueError(c, err);
  }
});
