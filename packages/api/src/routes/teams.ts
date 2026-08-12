/**
 * Teams — org membership structure (orchestrator spec, "Identity").
 *
 *   GET    /api/teams                       → list teams the caller belongs to
 *   POST   /api/teams                       → create a team (caller auto-admitted as admin)
 *   DELETE /api/teams/:id                   → delete a team (409s while it owns any workflow)
 *   POST   /api/teams/:id/members           → add/update a member
 *   PATCH  /api/teams/:id/members/:userId   → change a member's role
 *   DELETE /api/teams/:id/members/:userId   → remove a member
 *   POST   /api/teams/:id/orchestrator      → get-or-create the team's orchestrator session
 *
 * Org-membership-gated: every route requires the team to belong to the
 * caller's org (`c.var.user.orgId`) — cross-org teams 404 rather than 403,
 * so a caller can't distinguish "not your org" from "doesn't exist".
 *
 * Mutation-gated: DELETE /:id and the three /members routes additionally
 * require the caller to be a team admin of *that* team, or an org admin
 * (a deliberate recovery path so org admins can always untangle a team even
 * if they're not on it). That rule lives in `canAdministerTeam`
 * (`services/teams.ts`), which also gates administration of the resources a
 * team owns — one definition, no forks. A caller who fails the check gets
 * 404, same as a caller outside the org — existence-hiding applies to
 * authz, not just org membership.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { NotFoundError, ValetError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { AuthUser } from "../middleware/auth.js";
import { teamMembers, teams, type TeamRow } from "../schema/index.js";
import { isOrgAdmin } from "../services/org.js";
import { ensureOrchestratorSession } from "../orchestrator/ensure.js";
import {
  addMember,
  canAdministerTeam,
  createTeam,
  deleteTeam,
  LastAdminError,
  listTeamMembers,
  listTeamsForOrg,
  listTeamsForUser,
  NotTeamMemberError,
  removeMember,
  setRole,
  TeamNameConflictError,
  TeamOwnsWorkflowsError,
} from "../services/teams.js";
import type {
  AddTeamMemberRequest,
  CreateTeamRequest,
  CreateTeamResponse,
  EnsureOrchestratorResponse,
  ListTeamMembersResponse,
  ListTeamsResponse,
  SetTeamMemberRoleRequest,
  TeamRole,
  TeamSummary,
} from "../wire/types.js";

export const teamsRouter = new Hono<AppEnv>();

async function rowToSummary(
  db: AppEnv["Variables"]["providers"]["db"],
  row: TeamRow,
  callerUserId: string,
): Promise<TeamSummary> {
  const members = await listTeamMembers(db, row.id);
  const mine = members.find((m) => m.userId === callerUserId);
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    createdAt: row.createdAt,
    memberCount: members.length,
    // null = the caller is not on this team (they see it as an org admin).
    callerRole: mine?.role ?? null,
  };
}

function isTeamRole(v: unknown): v is TeamRole {
  return v === "admin" || v === "member";
}

/** Maps service errors to the route's JSON error response. Rethrows unknowns. */
function handleServiceError(err: unknown): { body: { error: string; code?: string }; status: 404 | 409 } | null {
  if (err instanceof TeamNameConflictError || err instanceof LastAdminError || err instanceof TeamOwnsWorkflowsError) {
    return { body: { error: err.message, code: err.code }, status: 409 };
  }
  if (err instanceof NotTeamMemberError || err instanceof NotFoundError) {
    return { body: { error: err.message, code: "not_found" }, status: 404 };
  }
  if (err instanceof ValetError) {
    // Any other ValetError subclass — surface its own status if 404/409,
    // otherwise let the caller rethrow to the global error handler.
    if (err.statusCode === 404 || err.statusCode === 409) {
      return { body: { error: err.message, code: err.code }, status: err.statusCode };
    }
  }
  return null;
}

async function loadTeamInOrg(db: AppEnv["Variables"]["providers"]["db"], teamId: string, orgId: string) {
  const rows = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  const row = rows[0];
  if (!row || row.orgId !== orgId) return undefined;
  return row;
}

/**
 * Gates read access to a team's member roster: any member of the team, or
 * any org admin (admins manage the whole org's teams, not just ones they're
 * on) — looser than `canAdministerTeam`, which requires *team*-admin.
 */
async function canViewTeam(
  db: AppEnv["Variables"]["providers"]["db"],
  teamId: string,
  user: AuthUser,
): Promise<boolean> {
  if (await isOrgAdmin(db, user.orgId, user.id)) return true;
  const members = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, user.id)))
    .limit(1);
  return members.length > 0;
}

// ── List ──────────────────────────────────────────────────────────────────

teamsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  // Org admins manage every team in the org, not just ones they belong to;
  // plain members still only see their own memberships.
  const admin = await isOrgAdmin(db, user.orgId, user.id);
  const rows = admin
    ? await listTeamsForOrg(db, user.orgId)
    : (await listTeamsForUser(db, user.id)).filter((r) => r.orgId === user.orgId);

  const body: ListTeamsResponse = {
    teams: await Promise.all(rows.map((r) => rowToSummary(db, r, user.id))),
  };
  return c.json(body);
});

// ── Orchestrator (get-or-create) ────────────────────────────────────────────

/**
 * The team's own orchestrator session — same "assistant" concept as a
 * user's, scoped to the team instead. Mirrors `POST /api/orchestrator`
 * (`routes/orchestrator.ts`), which explicitly documents team/org
 * orchestrators as "created via other paths" — this is that path. Any
 * team member can reach it, same gate as `GET /:id/members`; there's no
 * team-admin-only tier for talking to the team's own assistant.
 *
 * `ensureOrchestratorSession` is idempotent and safe to call from every
 * member: the underlying engine session may already exist (a team-owned
 * workflow's `orchestrator` node can wake one before any human ever views
 * it — see `workflows/engine-deps.ts`'s `promptOrchestrator`), in which
 * case this only backfills the `agent_sessions` app row the viewing routes
 * (`GET /api/sessions/:id`, messages, the WS) need, rather than creating a
 * second session.
 */
teamsRouter.post("/:id/orchestrator", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canViewTeam(db, id, user))) return c.json({ error: "team not found" }, 404);

  const { sessionId } = await ensureOrchestratorSession(
    { db, engineHost },
    { type: "team", id },
    { actorUserId: user.id, orgId: user.orgId },
  );

  const body: EnsureOrchestratorResponse = { sessionId };
  return c.json(body);
});

// ── Members: list ────────────────────────────────────────────────────────

teamsRouter.get("/:id/members", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canViewTeam(db, id, user))) return c.json({ error: "team not found" }, 404);

  const members = await listTeamMembers(db, id);
  const body: ListTeamMembersResponse = { members };
  return c.json(body);
});

// ── Create ────────────────────────────────────────────────────────────────

teamsRouter.post("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  let body: CreateTeamRequest;
  try {
    body = (await c.req.json()) as CreateTeamRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }

  try {
    const team = await createTeam(db, { orgId: user.orgId, name: body.name, creatorUserId: user.id });
    const resp: CreateTeamResponse = { team: await rowToSummary(db, team, user.id) };
    return c.json(resp, 201);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Delete ────────────────────────────────────────────────────────────────

teamsRouter.delete("/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  try {
    await deleteTeam(db, { teamId: id });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Members: add/update ─────────────────────────────────────────────────

teamsRouter.post("/:id/members", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  let body: AddTeamMemberRequest;
  try {
    body = (await c.req.json()) as AddTeamMemberRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.userId || typeof body.userId !== "string") {
    return c.json({ error: "userId is required" }, 400);
  }
  if (!isTeamRole(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

  try {
    await addMember(db, { teamId: id, userId: body.userId, role: body.role });
    return c.json({ ok: true }, 201);
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Members: change role ────────────────────────────────────────────────

teamsRouter.patch("/:id/members/:userId", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  let body: SetTeamMemberRoleRequest;
  try {
    body = (await c.req.json()) as SetTeamMemberRoleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!isTeamRole(body.role)) {
    return c.json({ error: "role must be 'admin' or 'member'" }, 400);
  }

  try {
    await setRole(db, { teamId: id, userId: targetUserId, role: body.role });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

// ── Members: remove ──────────────────────────────────────────────────────

teamsRouter.delete("/:id/members/:userId", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");
  const targetUserId = c.req.param("userId");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);

  try {
    await removeMember(db, { teamId: id, userId: targetUserId });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});

export type TeamsRouter = typeof teamsRouter;
