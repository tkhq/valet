import { and, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionThreads, workflowRuns, workflowDefinitions } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { spawnedFromVisibleThread, threadsVisibleTo } from "./_thread-access.js";
import { ensureDefaultAssistantSession, findDefaultAssistant } from "../assistants/service.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import {
  abortThread, createThread, getThreadChannelActivity, listDecisions, listMessages,
  listThreads, loadDecisionSession, patchThread, readThreads, resolveDecision, resumeThread,
  sendPrompt, withdrawDecision,
} from "./messages.js";

export const threadsRouter = new Hono<AppEnv>();

/** Both address families call the same operations. Only address resolution lives here. */
async function inWorkspace(c: Context<AppEnv>, operation: (c: Context<AppEnv>, sessionId: string) => Promise<Response>) {
  const workspace = c.req.query("workspace") ?? (c.var.principal.type === "team" ? c.var.principal.id : "user");
  const owner = await authorizedWorkspaceOwner(c, workspace);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const existing = await findDefaultAssistant(c.var.providers.db, c.var.user.orgId, owner);
  if (c.req.method === "GET") {
    if (!existing) return c.json({ threads: [] });
    const [runtime] = await c.var.providers.db.select({ id: agentSessions.id }).from(agentSessions)
      .where(and(eq(agentSessions.id, existing.sessionId), eq(agentSessions.orgId, c.var.user.orgId))).limit(1);
    if (!runtime) return c.json({ threads: [] });
    return operation(c, existing.sessionId);
  }
  const { sessionId } = await ensureDefaultAssistantSession(c.var.providers, owner, { actorUserId: c.var.user.id, orgId: c.var.user.orgId });
  return operation(c, sessionId);
}

threadsRouter.get("/", c => inWorkspace(c, listThreads));
threadsRouter.post("/", c => inWorkspace(c, createThread));
threadsRouter.post("/read", c => inWorkspace(c, readThreads));

type ThreadOperation = (c: Context<AppEnv>, sessionId: string, threadId: string) => Promise<Response>;

async function inThread(c: Context<AppEnv>, operation: ThreadOperation, purpose: "content" | "metadata" | "decision" = "content") {
  const threadId = c.req.param("threadId");
  const { db, engineStore } = c.var.providers;
  const [appSession] = await db.select().from(agentSessions)
    .where(and(eq(agentSessions.orgId, c.var.user.orgId), sql`exists (
      select 1 from engine_threads where engine_threads.session_id = ${agentSessions.id} and engine_threads.id = ${threadId}
    )`)).limit(1);
  let sessionId = appSession?.id;
  if (appSession) {
    if (purpose === "decision") {
      const authorized = await loadDecisionSession(c, appSession.id, threadId);
      if ("error" in authorized) return authorized.error;
    } else if (!await canViewSession(db, appSession, c.var.principal) || !await spawnedFromVisibleThread(c, appSession)) {
      return c.json({ error: "Thread not found." }, 404);
    }
  } else {
    // Workflow threads permit metadata and decisions only, never prompts or sandbox access.
    if (purpose === "content") return c.json({ error: "Thread not found." }, 404);
    const [workflowThread] = await db.select({ sessionId: sql<string>`t.session_id` })
      .from(sql`engine_threads t`)
      .innerJoin(workflowRuns, sql`${workflowRuns.id} = split_part(t.session_id, ':', 2)`)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
      .where(and(eq(workflowDefinitions.orgId, c.var.user.orgId), sql`t.id = ${threadId} and t.session_id LIKE 'wf:%'`)).limit(1);
    if (!workflowThread) return c.json({ error: "Thread not found." }, 404);
    sessionId = workflowThread.sessionId;
    const authorized = await loadDecisionSession(c, sessionId, threadId);
    if ("error" in authorized) return authorized.error;
    if (purpose !== "decision" && "decisionApproverOnly" in authorized.session && authorized.session.decisionApproverOnly) return c.json({ error: "Thread not found." }, 404);
  }
  if (!sessionId) return c.json({ error: "Thread not found." }, 404);
  const thread = await engineStore.getThread(sessionId, threadId);
  if (!thread || (appSession && purpose !== "decision" && !await threadsVisibleTo(c, appSession)(thread.key))) return c.json({ error: "Thread not found." }, 404);
  if (c.req.query("threadId") !== undefined && c.req.query("threadId") !== threadId) {
    return c.json({ error: "threadId must match the URL." }, 400);
  }
  if (c.req.method !== "GET") {
    const body = await readOptionalJsonObject(c);
    if (!body) return c.json({ error: "Send a JSON object." }, 400);
    if (body.threadId !== undefined && body.threadId !== threadId) return c.json({ error: "threadId must match the URL." }, 400);
  }
  return operation(c, sessionId, threadId);
}

threadsRouter.get("/:threadId", c => inThread(c, async (c, sessionId, threadId) => {
  const thread = await c.var.providers.engineStore.getThread(sessionId, threadId);
  if (!thread) return c.json({ error: "Thread not found." }, 404);
  const [meta] = await c.var.providers.db.select().from(sessionThreads)
    .where(and(eq(sessionThreads.id, threadId), eq(sessionThreads.sessionId, sessionId))).limit(1);
  // The turn a Stop targets: running, else blocked on a decision. A client
  // without the live socket (the CLI) sends it to /abort as targetItemId.
  const unsettled = (await c.var.providers.engineStore.listUnsettledSubmissions(sessionId)).filter((item) => item.threadId === threadId);
  const active = unsettled.find((item) => item.status === "running") ?? unsettled.find((item) => item.status === "blocked_on_decision_gate");
  return c.json({
    id: threadId, sessionId, title: meta?.title ?? null, createdAt: thread.createdAt, archivedAt: meta?.archivedAt ?? null,
    ...(active ? { activeItemId: active.id } : {}),
  });
}, "metadata"));
threadsRouter.patch("/:threadId", c => inThread(c, patchThread));
threadsRouter.get("/:threadId/messages", c => inThread(c, listMessages));
threadsRouter.post("/:threadId/messages", c => inThread(c, sendPrompt));
threadsRouter.get("/:threadId/channel-activity", c => inThread(c, getThreadChannelActivity));
threadsRouter.post("/:threadId/abort", c => inThread(c, abortThread));
threadsRouter.post("/:threadId/resume", c => inThread(c, resumeThread));
threadsRouter.get("/:threadId/decisions", c => inThread(c, listDecisions, "decision"));
threadsRouter.post("/:threadId/decisions/:gateId/resolve", c => inThread(c, resolveDecision, "decision"));
threadsRouter.post("/:threadId/decisions/:gateId/withdraw", c => inThread(c, withdrawDecision, "decision"));
