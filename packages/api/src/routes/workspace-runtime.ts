import { decryptSecret, deriveSecretKey, encryptSecret } from "../lib/secret-crypto.js";
import type { Principal } from "@valet/engine";
import { and, count, desc, eq, inArray, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { ensureAssistantExecution, ensureDefaultAssistantSession, findDefaultAssistant, resolveDefaultAssistant, workspaceSessionIds } from "../assistants/service.js";
import { canViewAssistantOwner } from "../assistants/access.js";
import { threadVisibility } from "../services/thread-access.js";
import { viewerOf } from "./_thread-access.js";
import { agentSessions, assistantExecutions, assistants, childWatches } from "../schema/index.js";
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
  const meta = { actorUserId: c.var.user.id, orgId: c.var.user.orgId };
  const runtime = owner.type === "team"
    ? await ensureAssistantExecution(c.var.providers, owner, meta,
      c.var.principal.type === "user" ? `app-assistant:${c.var.principal.id}` : "web:default")
    : await ensureDefaultAssistantSession(c.var.providers, owner, meta);
  await runtime.session.ensureDefaultThread();
  const root = owner.type === "team" ? await findDefaultAssistant(c.var.providers.db, meta.orgId, owner) : undefined;
  const body: EnsureWorkspaceRuntimeResponse = { sessionId: runtime.sessionId,
    ...(root ? { workspaceSessionId: root.sessionId } : {}) };
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
// workspace admin. Evict the root and every isolated conversation so their
// next turns rebuild the tool catalog from the cleared limit.
workspaceRuntimeRouter.delete("/:workspace/integration-limit", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { db, engineHost } = c.var.providers;
  if (owner.type === "team" && !await canAdministerTeam(db, owner.id, c.var.user.id)) {
    return c.json({ error: "Only a team admin can clear the integration limit. Ask a team admin." }, 403);
  }
  await clearIntegrationLimit(db, c.var.user.orgId, owner);
  const assistant = await findDefaultAssistant(db, c.var.user.orgId, owner);
  if (assistant) {
    for (const id of await workspaceSessionIds(db, c.var.user.orgId, assistant.sessionId)) engineHost.evictCache(id);
  }
  return c.body(null, 204);
});

// A durable app-assistant Thread per viewer in this workspace. Opening it is
// idempotent and never submits a model turn. Team threads retain team visibility.
workspaceRuntimeRouter.post("/:workspace/conversation", async (c) => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { sessionId, session } = await ensureAssistantExecution(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId }, `app-assistant:${c.var.user.id}`);
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
  const runningIds = engineHost.sessionsWithActiveRuns();
  const busy = (id: typeof agentSessions.id) => or(
    runningIds.length ? inArray(id, runningIds) : sql`false`,
    sql`EXISTS (SELECT 1 FROM child_watches w WHERE w.parent_session_id = ${id} AND w.settled = false)`);
  const candidates = await db.select({ id: agentSessions.id }).from(agentSessions)
    .leftJoin(assistantExecutions, eq(assistantExecutions.sessionId, agentSessions.id))
    .where(and(eq(agentSessions.orgId, row.orgId), sql`${agentSessions.status} <> 'deleted'`,
      or(eq(agentSessions.id, row.sessionId), eq(assistantExecutions.assistantId, row.id)), busy(agentSessions.id)));
  const visibleIds = [];
  for (const id of new Set([row.sessionId, ...candidates.map(candidate => candidate.id)])) {
    if (await threadVisibility(c.var.providers, { ownerType: owner.type, id }, viewerOf(c))(null)) visibleIds.push(id);
  }
  const [children] = await db.select({ n: count() }).from(childWatches)
    .where(and(inArray(childWatches.parentSessionId, visibleIds), eq(childWatches.settled, false)));
  const activeChildren = children?.n ?? 0;
  const thinking = visibleIds.some(id => engineHost.liveSession(id)?.listThreads().some(thread => thread.runningItemId() !== undefined));
  const presence = activeChildren > 0 ? "working" : thinking ? "thinking" : "idle";
  const body: WorkspaceRuntimeInfoResponse = { sessionId: row.sessionId, presence, activeChildren };
  return c.json(body);
});

/** Retain these aliases until the supported CLI floor uses workspace runtime URLs. */
export const legacyOrchestratorRouter = new Hono<AppEnv>();
legacyOrchestratorRouter.post("/orchestrator", c => ensureWorkspaceRuntime(c, "user"));
legacyOrchestratorRouter.post("/teams/:workspace/orchestrator", c => ensureWorkspaceRuntime(c));

/** Read retained history without restoring an archived assistant or opening its sandbox. */
workspaceRuntimeRouter.get("/:workspace/history", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { db } = c.var.providers;
  const sessionId = c.req.query("sessionId");
  const threadId = c.req.query("threadId");
  const rawCursor = c.req.query("before");
  const cursorKey = deriveSecretKey(JSON.stringify(["retained-history", c.var.providers.encryptionKey,
    c.var.user.orgId, c.var.principal, owner, sessionId, threadId]));
  let before: string | undefined;
  try {
    if (rawCursor !== undefined) {
      if (rawCursor.length > 4096) throw new Error("Cursor exceeds limit");
      before = decryptSecret(Buffer.from(rawCursor, "base64url").toString("utf8"), cursorKey);
    }
  } catch { return c.json({ error: "Invalid cursor. Reload the retained history." }, 400); }
  const sealCursor = (value: string) => Buffer.from(encryptSecret(value, cursorKey)).toString("base64url");
  const scope = and(eq(assistants.orgId, c.var.user.orgId), eq(assistants.ownerType, owner.type),
    sql`(${assistants.ownerId} = ${owner.id} OR ${assistants.ownerId} = ${owner.id} || ':retired:' || ${assistants.id})`);
  if (!sessionId && !threadId) {
    const rows = await db.select({ sessionId: sql<string>`t.session_id`, threadId: sql<string>`t.id`,
      key: sql<string>`t.key`, title: sql<string | null>`m.title` }).from(assistants)
      .innerJoin(sql`engine_threads t`, sql`t.session_id = ${assistants.sessionId}`)
      .leftJoin(sql`session_threads m`, sql`m.session_id = t.session_id AND m.id = t.id`)
      .where(and(scope, before ? sql`t.id < ${before}` : undefined)).orderBy(desc(sql`t.id`)).limit(101);
    const visible = [];
    for (const row of rows.slice(0, 100)) {
      if (await threadVisibility(c.var.providers, { id: row.sessionId, ownerType: owner.type }, viewerOf(c))(row.key)) visible.push(row);
    }
    return c.json({ threads: visible, nextCursor: rows.length > 100 ? sealCursor(rows[99].threadId) : null });
  }
  if (!sessionId || !threadId || (before !== undefined && (!/^[0-9]{1,19}$/.test(before) || BigInt(before) > 9223372036854775807n))) {
    return c.json({ error: "Supply sessionId and threadId. Use the returned cursor for older entries." }, 400);
  }
  const [source] = await db.select({ key: sql<string>`t.key` }).from(assistants)
    .innerJoin(sql`engine_threads t`, sql`t.session_id = ${assistants.sessionId}`)
    .where(and(scope, eq(assistants.sessionId, sessionId), sql`t.id = ${threadId}`)).limit(1);
  if (!source || !await threadVisibility(c.var.providers, { id: sessionId, ownerType: owner.type }, viewerOf(c))(source.key)) {
    return c.json({ error: "Thread not found." }, 404);
  }
  const rows = await db.select({ entry: sql<Record<string, unknown>>`row_to_json(e)`, cursor: sql<string>`e.seq::text` })
    .from(sql`engine_entries e`).where(sql`e.session_id = ${sessionId} AND e.thread_id = ${threadId}
      ${before ? sql`AND e.seq < ${before}::bigint` : sql``}`).orderBy(desc(sql`e.seq`)).limit(101);
  return c.json({ entries: rows.slice(0, 100).map(row => row.entry), nextCursor: rows.length > 100 ? sealCursor(rows[99].cursor) : null });
});
