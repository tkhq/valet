import type { Principal } from "@valet/engine";
import { and, count, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { ensureDefaultAssistantSession, findDefaultAssistant, resolveDefaultAssistant } from "../assistants/service.js";
import { canViewAssistantOwner } from "../assistants/access.js";
import { childWatches } from "../schema/index.js";
import { canAdministerTeam, getTeamInOrg } from "../services/teams.js";
import { clearIntegrationLimit, loadIntegrationLimit } from "../assistants/integration-limit.js";
import type { WorkspaceRuntimeInfoResponse, EnsureWorkspaceRuntimeResponse, WorkspaceIntegrationLimitResponse } from "../wire/types.js";

export const workspaceRuntimeRouter = new Hono<AppEnv>();

export async function authorizedWorkspaceOwner(c: Context<AppEnv>, workspace = c.req.param("workspace")): Promise<Principal | null> {
  const principal = c.var.principal;
  const { db } = c.var.providers;
  if (workspace === "user") return principal.type === "user" ? principal : null;
  if (!workspace || !await getTeamInOrg(db, c.var.user.orgId, workspace)) return null;
  const allowed = await canViewAssistantOwner(db, { type: "team", id: workspace }, principal);
  return allowed ? { type: "team", id: workspace } : null;
}

async function ensureWorkspaceRuntime(c: Context<AppEnv>, workspace = c.req.param("workspace")) {
  const owner = await authorizedWorkspaceOwner(c, workspace);
  if (!owner) return c.json({ error: "Workspace not found. Select an accessible workspace." }, 404);
  const { sessionId } = await ensureDefaultAssistantSession(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId });
  const body: EnsureWorkspaceRuntimeResponse = { sessionId };
  return c.json(body);
}

workspaceRuntimeRouter.post("/:workspace/runtime", c => ensureWorkspaceRuntime(c));

workspaceRuntimeRouter.get("/:workspace/integration-limit", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const limit = await loadIntegrationLimit(c.var.providers.db, c.var.user.orgId, owner);
  const body: WorkspaceIntegrationLimitResponse = { services: limit ? [...limit.keys()].sort() : null };
  return c.json(body);
});

// Clearing widens what every session of the workspace can call, so it takes a
// workspace admin. The cached runtime is evicted so its next turn sees it.
workspaceRuntimeRouter.delete("/:workspace/integration-limit", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { db, engineHost } = c.var.providers;
  if (owner.type === "team" && !await canAdministerTeam(db, owner.id, c.var.user.id)) {
    return c.json({ error: "Only a team admin can clear the integration limit. Ask a team admin." }, 403);
  }
  await clearIntegrationLimit(db, c.var.user.orgId, owner);
  const assistant = await findDefaultAssistant(db, c.var.user.orgId, owner);
  if (assistant) engineHost.evictCache(assistant.sessionId);
  return c.body(null, 204);
});

// A durable app-assistant Thread per viewer in this workspace. Opening it is
// idempotent and never submits a model turn. Team threads retain team visibility.
workspaceRuntimeRouter.post("/:workspace/conversation", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { sessionId, session } = await ensureDefaultAssistantSession(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId });
  // A new helper thread starts from the viewer's current model and reasoning
  // defaults, as every other new thread does, not the runtime's stored model.
  const data = await session.toData();
  const thread = await c.var.providers.engineHost.ensureFreshThread(session, `app-assistant:${c.var.user.id}`,
    { userId: data.userId, orgId: data.orgId, workspace: data.workspace }, c.var.user.id);
  return c.json({ sessionId, threadId: thread.id });
});

workspaceRuntimeRouter.get("/:workspace/runtime/info", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { db, engineHost } = c.var.providers;
  // Resolve the identity only: presence reads never start the runtime or a sandbox.
  const row = await resolveDefaultAssistant(db, c.var.user.orgId, owner);
  const [children] = await db.select({ n: count() }).from(childWatches)
    .where(and(eq(childWatches.parentSessionId, row.sessionId), eq(childWatches.settled, false)));
  const activeChildren = children?.n ?? 0;
  const live = engineHost.liveSession(row.sessionId);
  const presence = activeChildren > 0 ? "working" : live?.listThreads().some(thread => thread.runningItemId() !== undefined) ? "thinking" : "idle";
  const body: WorkspaceRuntimeInfoResponse = { sessionId: row.sessionId, presence, activeChildren };
  return c.json(body);
});

/** Retain these aliases until the supported CLI floor uses workspace runtime URLs. */
export const legacyOrchestratorRouter = new Hono<AppEnv>();
legacyOrchestratorRouter.post("/orchestrator", c => ensureWorkspaceRuntime(c, "user"));
legacyOrchestratorRouter.post("/teams/:workspace/orchestrator", c => ensureWorkspaceRuntime(c));
