/**
 * Teams — org membership structure (orchestrator spec, "Identity").
 *
 *   GET    /api/teams                       → list teams the caller belongs to
 *   POST   /api/teams                       → create a team (caller auto-admitted as admin)
 *   DELETE /api/teams/:id                   → delete a team (409s while it owns any workflow)
 *   POST   /api/teams/:id/members           → add/update a member
 *   PATCH  /api/teams/:id/members/:userId   → change a member's role
 *   DELETE /api/teams/:id/members/:userId   → remove a member
 *   POST   /api/teams/:id/orchestrator      → get-or-create the team's default assistant session
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
 *
 * Origin-gated: those same four routes refuse a team whose `origin` is
 * `idp` WHILE the org's `ssoTeamSync` feature gate is on. Such a team
 * mirrors an identity-provider group, and the login-time sync owns it. With
 * the gate off no sync runs, so the same team is a dormant mirror and the
 * four routes work on it again — see `isLiveIdpMirror`
 * (`services/teams.ts`).
 *
 * A `config` team — declared in `valet.yaml` — is gated for DELETE only. The
 * file asserts its declared members at each boot but never removes anybody,
 * so a membership edit here is real work that survives until the next
 * restart, and refusing it would be stricter than the file's own semantics.
 * A delete is different: the next boot recreates the team empty, which reads
 * as data loss, so the route refuses it and names the file instead.
 *
 * There is no rename route today. Whoever adds one must refuse BOTH `idp`
 * and `config`: the reconciler identifies a declared team by name, so a
 * rename orphans the row and the next boot creates a second team beside it.
 */
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { NotFoundError, ValetError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import type { AuthUser } from "../middleware/auth.js";
import { agentSessions, childWatches, teamMembers, teams, type TeamRow } from "../schema/index.js";
import { isOrgAdmin } from "../services/org.js";
import { ensureDefaultAssistantSession, listAssistantsForOwners } from "../assistants/service.js";
import {
  addMember,
  canAdministerTeam,
  ConfigManagedTeamError,
  createTeam,
  deleteTeam,
  IdpManagedTeamError,
  type IdpManagedMutation,
  isLiveIdpMirror,
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
  GetTeamChildrenResponse,
  TeamChildSummary,
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
    origin: row.origin,
    externalId: row.externalId,
    createdAt: row.createdAt,
    memberCount: members.length,
    // null = the caller is not on this team (they see it as an org admin).
    callerRole: mine?.role ?? null,
  };
}

function isTeamRole(v: unknown): v is TeamRole {
  return v === "admin" || v === "member";
}

/**
 * Builds the refusal body for a mutation on a team that mirrors an
 * identity-provider group, or null when the team is Valet's own.
 *
 * The status is 409, not 403 and not 404. The caller has already passed both
 * the org gate and the team-admin gate, and the team plainly exists — what
 * stops the write is the team's own state, exactly like `team_name_conflict`
 * and `team_owns_workflows` above it. 403 in this API means "your role is too
 * low", which is not the problem and would send an admin looking for a
 * permission to grant. 404 is reserved for cross-org and unauthorized
 * callers, where hiding existence is the point; here the caller may see the
 * team, so a 404 would be a lie they cannot act on.
 *
 * The message comes from `IdpManagedTeamError`, the same class the service
 * throws, so the route and the service never word the fix differently.
 *
 * `isLiveIdpMirror` is what decides, not `origin` alone. A mirror whose org
 * has `ssoTeamSync` off is dormant: nothing reasserts it, so refusing the
 * mutation would leave a team nobody can change. Asking the service keeps
 * the route and the service on ONE rule — a route that tested `origin` here
 * would refuse writes the service is willing to make.
 */
async function idpManagedRefusal(
  db: AppEnv["Variables"]["providers"]["db"],
  row: TeamRow,
  mutation: IdpManagedMutation,
): Promise<{ error: string; code: string } | null> {
  if (!(await isLiveIdpMirror(db, row))) return null;
  const err = new IdpManagedTeamError(row, mutation);
  return { error: err.message, code: err.code };
}

/**
 * Builds the refusal body for a DELETE of a team declared in `valet.yaml`,
 * or null for any other team.
 *
 * Delete only. Membership on a config team stays editable — see the file
 * header. Same 409 reasoning as `idpManagedRefusal`, and the message comes
 * from the class the service throws for the same reason.
 */
function configManagedDeleteRefusal(row: TeamRow): { error: string; code: string } | null {
  if (row.origin !== "config") return null;
  const err = new ConfigManagedTeamError(row.name);
  return { error: err.message, code: err.code };
}

/** Maps service errors to the route's JSON error response. Rethrows unknowns. */
function handleServiceError(err: unknown): { body: { error: string; code?: string }; status: 404 | 409 } | null {
  if (
    err instanceof TeamNameConflictError ||
    err instanceof LastAdminError ||
    err instanceof TeamOwnsWorkflowsError ||
    err instanceof IdpManagedTeamError ||
    err instanceof ConfigManagedTeamError
  ) {
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
 * The team's DEFAULT assistant session. Mirrors `POST /api/orchestrator`
 * (`routes/orchestrator.ts`), which explicitly documents team/org
 * assistants as "created via other paths" — this is that path. Any team
 * member can reach it, same gate as `GET /:id/members`; there's no
 * team-admin-only tier for talking to the team's own assistant.
 *
 * A team owns any number of assistants. This route resolves the default,
 * which is what a caller that names only the team can mean. Use
 * `GET /api/assistants?ownerType=team&ownerId={id}` to reach the others.
 *
 * `ensureDefaultAssistantSession` is idempotent and safe to call from every
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

  const { sessionId } = await ensureDefaultAssistantSession(
    { db, engineHost },
    { type: "team", id },
    { actorUserId: user.id, orgId: user.orgId },
  );

  const body: EnsureOrchestratorResponse = { sessionId };
  return c.json(body);
});

// ── Children (team dashboard) ───────────────────────────────────────────

/**
 * `GET /api/teams/:id/children` — the team mirror of
 * `GET /api/orchestrator/children`: child runs spawned by EVERY assistant
 * the team owns, newest first, capped at 20 (a dashboard feed, not a
 * history — /sessions is the history). Rows carry the spawning assistant
 * so the feed can attribute a run. Same member-or-org-admin gate as the
 * roster; non-members get 404 (existence-hiding).
 */
teamsRouter.get("/:id/children", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const team = await loadTeamInOrg(db, id, user.orgId);
  if (!team) return c.json({ error: "team not found" }, 404);
  if (!(await canViewTeam(db, id, user))) return c.json({ error: "team not found" }, 404);

  const assistants = await listAssistantsForOwners(db, user.orgId, [{ type: "team", id }]);
  const bySessionId = new Map(assistants.map((a) => [a.sessionId, a]));
  if (bySessionId.size === 0) {
    const empty: GetTeamChildrenResponse = { children: [] };
    return c.json(empty);
  }

  const rows = await db
    .select({
      sessionId: childWatches.childSessionId,
      parentSessionId: childWatches.parentSessionId,
      parentThreadId: childWatches.parentThreadId,
      settled: childWatches.settled,
      createdAt: childWatches.createdAt,
      title: agentSessions.title,
    })
    .from(childWatches)
    .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
    .where(
      and(
        inArray(childWatches.parentSessionId, [...bySessionId.keys()]),
        isNull(childWatches.dismissedAt),
      ),
    )
    .orderBy(desc(childWatches.createdAt))
    .limit(20);

  const children: TeamChildSummary[] = rows.map((r) => {
    const assistant = bySessionId.get(r.parentSessionId);
    return {
      sessionId: r.sessionId,
      title: r.title ?? r.sessionId,
      parentThreadId: r.parentThreadId,
      status: r.settled ? "settled" : "running",
      createdAt: r.createdAt,
      assistantId: assistant?.id ?? "",
      ...(assistant?.name != null ? { assistantName: assistant.name } : {}),
    };
  });

  const body: GetTeamChildrenResponse = { children };
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

  const refusal = (await idpManagedRefusal(db, team, "delete")) ?? configManagedDeleteRefusal(team);
  if (refusal) return c.json(refusal, 409);

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

  const refusal = await idpManagedRefusal(db, team, "membership");
  if (refusal) return c.json(refusal, 409);

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

  const refusal = await idpManagedRefusal(db, team, "membership");
  if (refusal) return c.json(refusal, 409);

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

  const refusal = await idpManagedRefusal(db, team, "membership");
  if (refusal) return c.json(refusal, 409);

  try {
    await removeMember(db, { teamId: id, userId: targetUserId });
    return c.json({ ok: true });
  } catch (err) {
    const mapped = handleServiceError(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    throw err;
  }
});
