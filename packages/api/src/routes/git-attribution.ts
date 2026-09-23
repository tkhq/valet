import { Hono, type Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { requireOrgAdmin } from "./_org-admin.js";
import { canAdministerTeam, canViewTeam } from "../services/teams.js";
import { canAdministerSession, canViewSession } from "../services/session-access.js";
import {
  ensureGitSnapshot,
  previewGitSnapshot,
  readSettingsForScope,
  writeSettingsForScope,
} from "../services/git-attribution.js";
import {
  agentSessions,
  gitPushOperations,
} from "../schema/index.js";
import type { GitSettingsResponse, PatchGitSettingsRequest, SessionGitAttributionResponse } from "../wire/types.js";

export const gitAttributionRouter = new Hono<AppEnv>();

async function readPatch(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object with the Git settings to change.");
  return body as Record<string, unknown>;
}

function response(scope: GitSettingsResponse["scope"], value: Awaited<ReturnType<typeof readSettingsForScope>>): GitSettingsResponse {
  return { scope, ...value };
}

// Mounted at /api so exact issue paths remain visible in one router.
gitAttributionRouter.get("/me/git-settings", async (c) => {
  const user = c.var.user;
  return c.json(response("user", await readSettingsForScope(c.var.providers.db, { scope: "user", id: user.id, orgId: user.orgId })));
});
gitAttributionRouter.patch("/me/git-settings", async (c) => {
  try {
    const user = c.var.user; const patch = await readPatch(c) as PatchGitSettingsRequest;
    return c.json(response("user", await writeSettingsForScope(c.var.providers.db, { scope: "user", id: user.id, orgId: user.orgId, patch })));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Git settings could not be saved." }, 400); }
});

gitAttributionRouter.get("/teams/:id/git-settings", async (c) => {
  const { db } = c.var.providers; const user = c.var.user; const id = c.req.param("id");
  if (!(await canViewTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);
  return c.json(response("team", await readSettingsForScope(db, { scope: "team", id, orgId: user.orgId })));
});
gitAttributionRouter.patch("/teams/:id/git-settings", async (c) => {
  const { db } = c.var.providers; const user = c.var.user; const id = c.req.param("id");
  if (!(await canAdministerTeam(db, id, user.id))) return c.json({ error: "team not found" }, 404);
  try { const patch = await readPatch(c); return c.json(response("team", await writeSettingsForScope(db, { scope: "team", id, orgId: user.orgId, patch }))); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Git settings could not be saved." }, 400); }
});

gitAttributionRouter.get("/org/git-settings", async (c) => {
  const user = c.var.user;
  return c.json(response("organization", await readSettingsForScope(c.var.providers.db, { scope: "organization", id: user.orgId, orgId: user.orgId })));
});
gitAttributionRouter.patch("/org/git-settings", async (c) => {
  const gate = await requireOrgAdmin(c); if (gate) return gate;
  try { const user = c.var.user; const patch = await readPatch(c); return c.json(response("organization", await writeSettingsForScope(c.var.providers.db, { scope: "organization", id: user.orgId, orgId: user.orgId, patch }))); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Git settings could not be saved." }, 400); }
});

async function accessibleSession(c: Context<AppEnv>, id: string, administer = false) {
  const { db } = c.var.providers; const user = c.var.user;
  const rows = await db.select().from(agentSessions).where(and(eq(agentSessions.id, id), eq(agentSessions.orgId, user.orgId))).limit(1);
  const row = rows[0]; if (!row) return null;
  const allowed = administer
    ? await canAdministerSession(db, row, c.var.principal)
    : await canViewSession(db, row, c.var.principal);
  if (!allowed) return null;
  return row;
}

async function sessionResponse(c: Context<AppEnv>, id: string): Promise<SessionGitAttributionResponse | null> {
  const row = await accessibleSession(c, id); if (!row) return null;
  const snapshot = await previewGitSnapshot(c.var.providers.db, row);
  const scope = row.ownerType === "team" ? "team" : row.ownerType === "org" ? "organization" : "user";
  const current = await readSettingsForScope(c.var.providers.db, { scope, id: row.ownerId || row.userId, orgId: row.orgId });
  return { sessionId: id, generation: snapshot.generation, mode: snapshot.mode, coAuthoredBy: snapshot.coAuthoredBy, correlationTrailers: snapshot.correlationTrailers, ownerType: snapshot.ownerType, ownerId: snapshot.ownerId, counterpartUserId: snapshot.counterpartUserId, counterpartName: snapshot.counterpartName, counterpartEmail: snapshot.counterpartEmail, valetName: snapshot.valetName, valetEmail: snapshot.valetEmail, settingsFingerprint: snapshot.settingsFingerprint, createdAt: snapshot.createdAt, currentValues: current.values, updateAvailable: snapshot.mode !== current.values.mode || snapshot.coAuthoredBy !== current.values.coAuthoredBy || snapshot.correlationTrailers !== current.values.correlationTrailers };
}

gitAttributionRouter.get("/sessions/:id/git-attribution", async (c) => {
  const value = await sessionResponse(c, c.req.param("id"));
  return value ? c.json(value) : c.json({ error: "session not found" }, 404);
});
gitAttributionRouter.post("/sessions/:id/git-attribution/apply", async (c) => {
  const id = c.req.param("id"); const row = await accessibleSession(c, id, true);
  if (!row) return c.json({ error: "session not found" }, 404);
  const unsettled = await c.var.providers.engineStore.listUnsettledSubmissions(id);
  const operations = await c.var.providers.db.select({ id: gitPushOperations.id }).from(gitPushOperations)
    .where(and(eq(gitPushOperations.sessionId, id), inArray(gitPushOperations.state, ["capturing", "replaying", "publishing"]))).limit(1);
  if (unsettled.length || operations.length) return c.json({ error: "Wait for the current queue item or Git operation to finish, then apply the settings." }, 409);
  await ensureGitSnapshot(c.var.providers.db, id, row.userId, true);
  c.var.providers.engineHost.evictCache(id);
  const value = await sessionResponse(c, id); return c.json(value!);
});
