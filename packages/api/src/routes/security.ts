/**
 * Valet Security read routes (docs/specs/2026-08-27-valet-security-design.md,
 * threat 10: every route resolves session → engagement → owner and applies
 * the session's existing access checks).
 *
 *   GET /api/sessions/:id/security           → engagement + cells (+ running
 *                                              cell progress)
 *   GET /api/sessions/:id/security/findings  → filtered, cursor-paginated
 *
 * Dual auth, the memory-routes ladder: a valid `x-valet-internal` token is
 * the `sec_*` engine tools' path and bypasses the session check; otherwise
 * the caller is the session user and must pass `canViewSession`. Refusals
 * answer 404, the existence-hiding convention every session route follows.
 *
 * Mutations (plan/start/dispatch/complete/fail/close, human review, export,
 * issue filing) land in later milestones — reads only here.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { isValidInternalToken } from "../lib/internal-auth.js";
import { agentSessions, type SecurityCellRow, type SecurityFindingRow } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import {
  createSecurityEngagementService,
  type CellProgress,
  type FindingSeverity,
  type FindingStatus,
} from "../services/security-engagements.js";
import type {
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
  SecurityCellWire,
  SecurityFindingWire,
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
  const body: GetSessionSecurityResponse = {
    engagement: {
      id: result.engagement.id,
      sessionId: result.engagement.sessionId,
      status: result.engagement.status,
      repoFullName: result.engagement.repoFullName,
      repoRef: result.engagement.repoRef,
      plan: result.engagement.plan,
      createdAt: result.engagement.createdAt,
      updatedAt: result.engagement.updatedAt,
    },
    cells: result.cells.map((cell) => cellToWire(cell, progress)),
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
    const body: ListSecurityFindingsResponse = {
      findings: page.findings.map(findingToWire),
      nextCursor: page.nextCursor,
    };
    return c.json(body);
  } catch (err) {
    // The service's only thrown shape reachable from a read is the bad
    // cursor; its message names the fix.
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});
