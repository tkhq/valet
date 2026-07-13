/**
 * Teams — org membership structure (orchestrator spec, "Identity").
 *
 *   GET    /api/teams                       → list teams the caller belongs to
 *   POST   /api/teams                       → create a team (caller auto-admitted as admin)
 *   DELETE /api/teams/:id                   → delete a team (blocked-on-workflows guard is a no-op this phase)
 *   POST   /api/teams/:id/members           → add/update a member
 *   PATCH  /api/teams/:id/members/:userId   → change a member's role
 *   DELETE /api/teams/:id/members/:userId   → remove a member
 *
 * Org-membership-gated: every route requires the team to belong to the
 * caller's org (`c.var.user.orgId`) — cross-org teams 404 rather than 403,
 * so a caller can't distinguish "not your org" from "doesn't exist".
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { NotFoundError, ValetError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { teams, type TeamRow } from "../schema/index.js";
import {
  addMember,
  createTeam,
  deleteTeam,
  LastAdminError,
  listTeamsForUser,
  NotTeamMemberError,
  removeMember,
  setRole,
  TeamNameConflictError,
} from "../services/teams.js";
import type {
  AddTeamMemberRequest,
  CreateTeamRequest,
  CreateTeamResponse,
  ListTeamsResponse,
  SetTeamMemberRoleRequest,
  TeamRole,
  TeamSummary,
} from "../wire/types.js";

export const teamsRouter = new Hono<AppEnv>();

function rowToSummary(row: TeamRow): TeamSummary {
  return { id: row.id, orgId: row.orgId, name: row.name, createdAt: row.createdAt };
}

function isTeamRole(v: unknown): v is TeamRole {
  return v === "admin" || v === "member";
}

/** Maps service errors to the route's JSON error response. Rethrows unknowns. */
function handleServiceError(err: unknown): { body: { error: string; code?: string }; status: 404 | 409 } | null {
  if (err instanceof TeamNameConflictError || err instanceof LastAdminError) {
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
  const row = await db.select().from(teams).where(eq(teams.id, teamId)).get();
  if (!row || row.orgId !== orgId) return undefined;
  return row;
}

// ── List ──────────────────────────────────────────────────────────────────

teamsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const rows = await listTeamsForUser(db, user.id);
  const body: ListTeamsResponse = {
    teams: rows.filter((r) => r.orgId === user.orgId).map(rowToSummary),
  };
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
    const resp: CreateTeamResponse = { team: rowToSummary(team) };
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
