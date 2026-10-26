import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionThreads, users, workflowRuns, workflowDefinitions } from "../schema/index.js";
import { shareAllows, type ThreadShareNeed } from "../services/thread-share.js";
import type { ActiveViewersResponse, ThreadAddress, ThreadPlanResponse, ToolOutputResponse } from "../wire/types.js";
import { readStoredThreadPlan } from "../services/thread-plan.js";
import { activeViewers } from "../services/active-viewers.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { keepVisibleThreads, threadEntry, threadsVisibleTo } from "./_thread-access.js";
import { ensureDefaultAssistantSession, findDefaultAssistant } from "../assistants/service.js";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import {
  abortThread, branchPreview, cancelQueuedItem, createThread, editPreview, forkThread, getThreadChannelActivity, getThreadContext, getThreadRecap, listDecisions, listMessages,
  listThreads, loadDecisionSession, patchThread, readThreads, resolveDecision, resumeThread, returnToBranch,
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

/** Who has each thread of a workspace open now, for the thread list. Only
 * threads the caller may open are listed. */
threadsRouter.get("/viewers", async (c) => {
  const owner = await authorizedWorkspaceOwner(c, c.req.query("workspace") ?? (c.var.principal.type === "team" ? c.var.principal.id : "user"));
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const body: ActiveViewersResponse = { threads: {} };
  const active = activeViewers.activeThreads(c.var.user.orgId);
  if (active.size === 0) return c.json(body);
  const rows = await c.var.providers.db
    .select({ id: agentSessions.id, ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId, userId: agentSessions.userId })
    .from(agentSessions)
    .where(and(inArray(agentSessions.id, [...active.keys()]), eq(agentSessions.orgId, c.var.user.orgId)));
  // A personal session's owner id can be empty on older rows; its user is the owner.
  const owned = new Set(rows.filter((row) => row.ownerType === owner.type
    && (row.ownerId || (row.ownerType === "user" ? row.userId : "")) === owner.id).map((row) => row.id));
  const items = [...active].flatMap(([sessionId, threadIds]) =>
    owned.has(sessionId) ? [...threadIds].map((threadId) => ({ sessionId, threadId })) : []);
  for (const item of await keepVisibleThreads(c, owner, items)) {
    body.threads[item.threadId] = activeViewers.viewersOf(item.sessionId, item.threadId);
  }
  return c.json(body);
});

type ThreadOperation = (c: Context<AppEnv>, sessionId: string, threadId: string) => Promise<Response>;

/**
 * Resolves a thread address and authorizes the caller. `guest` names what a
 * person admitted only by the thread's share may do here
 * (`services/thread-share.ts`). An operation without it is the owner's alone.
 */
async function inThread(
  c: Context<AppEnv>, operation: ThreadOperation, purpose: "content" | "metadata" | "decision" = "content", guest?: ThreadShareNeed,
) {
  const threadId = c.req.param("threadId");
  const { db, engineStore } = c.var.providers;
  const [appSession] = await db.select().from(agentSessions)
    .where(and(eq(agentSessions.orgId, c.var.user.orgId), sql`exists (
      select 1 from engine_threads where engine_threads.session_id = ${agentSessions.id} and engine_threads.id = ${threadId}
    )`)).limit(1);
  let sessionId = appSession?.id;
  const entry = appSession ? await threadEntry(c, appSession, threadId) : null;
  if (appSession && entry?.as === "guest") {
    const share = entry.mode;
    if (!guest || !shareAllows(share, guest)) {
      const error = purpose === "decision"
        ? "Only the thread owner can answer approvals in a shared thread. Ask the owner to answer it."
        : share === "view" && guest === "reply"
          ? "This thread is shared to view only. Ask the owner to allow replies."
          : "Only the thread owner can change this thread.";
      return c.json({ error }, 403);
    }
    c.set("threadShareGuest", { sessionId: appSession.id, threadId, mode: share });
  } else if (appSession) {
    if (purpose === "decision") {
      const authorized = await loadDecisionSession(c, appSession.id, threadId);
      if ("error" in authorized) return authorized.error;
    } else if (!entry) {
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
  if (!thread || (appSession && purpose !== "decision" && !await threadsVisibleTo(c, appSession)(thread))) return c.json({ error: "Thread not found." }, 404);
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

/** The thread's owner, as a guest of a shared thread sees them. */
async function ownerName(c: Context<AppEnv>, sessionId: string): Promise<string> {
  const [row] = await c.var.providers.db.select({ name: users.name, email: users.email }).from(agentSessions)
    .innerJoin(users, eq(users.id, agentSessions.userId)).where(eq(agentSessions.id, sessionId)).limit(1);
  return row?.name || row?.email || "the owner";
}

threadsRouter.get("/:threadId", c => inThread(c, async (c, sessionId, threadId) => {
  const thread = await c.var.providers.engineStore.getThread(sessionId, threadId);
  if (!thread) return c.json({ error: "Thread not found." }, 404);
  const [meta] = await c.var.providers.db.select().from(sessionThreads)
    .where(and(eq(sessionThreads.id, threadId), eq(sessionThreads.sessionId, sessionId))).limit(1);
  const guest = c.var.threadShareGuest;
  const body: ThreadAddress = {
    id: threadId, sessionId, title: meta?.title ?? null, createdAt: thread.createdAt, archivedAt: meta?.archivedAt ?? null,
    ...(meta?.shareMode ? { share: meta.shareMode } : {}),
    ...(guest ? { guest: { mode: guest.mode, ownerName: await ownerName(c, sessionId) } } : {}),
  };
  return c.json(body);
}, "metadata", "read"));
threadsRouter.patch("/:threadId", c => inThread(c, patchThread));
threadsRouter.get("/:threadId/messages", c => inThread(c, listMessages, "content", "read"));
// The full result of one tool call that the transcript trimmed (`services/transcript-trim.ts`).
threadsRouter.get("/:threadId/tool-output", c => inThread(c, async (c, sessionId, threadId) => {
  const entryId = c.req.query("entryId");
  const callId = c.req.query("callId");
  if (!entryId || !callId) return c.json({ error: "Send entryId and callId." }, 400);
  // One row by id, as `channels/host.ts` reads a single entry. `execute` types its result loosely.
  const rows = (await c.var.providers.db.execute(sql`SELECT parts FROM engine_entries
    WHERE id = ${entryId} AND session_id = ${sessionId} AND thread_id = ${threadId} LIMIT 1`)) as { rows: Array<{ parts: string | null }> };
  const raw = rows.rows[0]?.parts;
  let parts: unknown;
  try { parts = raw ? JSON.parse(raw) : undefined; } catch { parts = undefined; }
  const part = Array.isArray(parts)
    ? parts.find((p: unknown) => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "tool_call" && (p as { callId?: unknown }).callId === callId)
    : undefined;
  if (!part) return c.json({ error: "This output is no longer in the thread. Reload the thread." }, 404);
  const body: ToolOutputResponse = { result: (part as { result?: unknown }).result };
  return c.json(body);
}, "content", "read"));
threadsRouter.post("/:threadId/messages", c => inThread(c, sendPrompt, "content", "reply"));
threadsRouter.get("/:threadId/channel-activity", c => inThread(c, getThreadChannelActivity, "content", "read"));
threadsRouter.get("/:threadId/context", c => inThread(c, getThreadContext));
threadsRouter.get("/:threadId/recap", c => inThread(c, getThreadRecap, "content", "read"));
threadsRouter.get("/:threadId/plan", c => inThread(c, async (c, sessionId, threadId) => {
  const body: ThreadPlanResponse = { plan: await readStoredThreadPlan(c.var.providers.engineStore, sessionId, threadId) ?? null };
  return c.json(body);
}, "content", "read"));
threadsRouter.post("/:threadId/abort", c => inThread(c, abortThread, "content", "reply"));
// A guest who may reply may go back past their own edit. A fork creates a
// thread in the owner's workspace, so it is the owner's (and members') alone.
threadsRouter.post("/:threadId/branch/return", c => inThread(c, returnToBranch, "content", "reply"));
threadsRouter.get("/:threadId/edit-preview", c => inThread(c, editPreview, "content", "reply"));
threadsRouter.get("/:threadId/branch-preview", c => inThread(c, branchPreview, "content", "read"));
threadsRouter.post("/:threadId/fork", c => inThread(c, forkThread, "content"));
threadsRouter.post("/:threadId/queue/:itemId/cancel", c => inThread(c, cancelQueuedItem, "content"));
threadsRouter.post("/:threadId/resume", c => inThread(c, resumeThread, "content", "reply"));
threadsRouter.get("/:threadId/decisions", c => inThread(c, listDecisions, "decision", "read"));
threadsRouter.post("/:threadId/decisions/:gateId/resolve", c => inThread(c, resolveDecision, "decision"));
threadsRouter.post("/:threadId/decisions/:gateId/withdraw", c => inThread(c, withdrawDecision, "decision"));
