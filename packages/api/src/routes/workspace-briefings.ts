import { and, eq, inArray, lt, notLike } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { agentSessions, briefingDismissals, sessionThreads, workspaceBriefingCache } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { getWorkspaceBriefings } from "../services/workspace-briefings.js";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { DismissWorkspaceBriefingResponse, WorkspaceBriefing, WorkspaceBriefingsResponse } from "../wire/types.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { isSharedThreadKey } from "../services/thread-read-state.js";
import { keepVisibleThreads } from "./_thread-access.js";
import { listBackgroundWork, selectWork } from "../engine/wakeups-admin.js";

/** Dismissals stop mattering once their brief ids stop appearing. */
const DISMISSAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Removes the briefs this person dismissed in this workspace. */
export async function hideDismissedBriefings(
  db: AppDb, userId: string, owner: Principal, response: WorkspaceBriefingsResponse,
): Promise<WorkspaceBriefingsResponse> {
  if (response.briefings.length === 0) return response;
  const dismissed = new Set((await db.select({ id: briefingDismissals.briefingId }).from(briefingDismissals).where(and(
    eq(briefingDismissals.userId,userId), eq(briefingDismissals.ownerType,owner.type), eq(briefingDismissals.ownerId,owner.id),
    inArray(briefingDismissals.briefingId,response.briefings.map(brief => brief.id)),
  ))).map(row => row.id));
  return { ...response, briefings: response.briefings.filter(brief => !dismissed.has(brief.id)) };
}

export const workspaceBriefingsRouter = new Hono<AppEnv>();
workspaceBriefingsRouter.get("/:workspace/briefings", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const { db } = c.var.providers;
  const response = await hideDismissedBriefings(db,c.var.user.id,owner,await getWorkspaceBriefings(db,c.var.user.orgId,owner,c.var.providers.engineCredentials));
  // A team brief is cached once for everyone. Each viewer sees only briefs
  // whose threads they may see now (`thread-access.ts`), so a channel made
  // private, or a thread they lost access to, drops out at once.
  const threads = response.briefings.flatMap(briefThreads);
  const shown = new Set((await keepVisibleThreads(c, owner, threads)).map(t => `${t.sessionId}:${t.threadId}`));
  return c.json({ ...response, briefings: response.briefings.filter(brief => briefThreads(brief).every(t => shown.has(`${t.sessionId}:${t.threadId}`))) });
});

/**
 * Hides one brief for the caller. In a personal workspace it also archives the
 * brief's threads so the sidebar clears with it. A thread waiting on an approval stays open:
 * archiving would withdraw an approval someone may still answer.
 */
/** The threads a brief names: its conversation and its thread sources. */
export function briefThreads(brief: WorkspaceBriefing): Array<{ sessionId: string; threadId: string }> {
  const threads = new Map<string, { sessionId: string; threadId: string }>();
  const add = (sessionId?: string, threadId?: string) => { if (sessionId && threadId) threads.set(`${sessionId}:${threadId}`, { sessionId, threadId }); };
  add(brief.latestThread?.sessionId, brief.latestThread?.threadId);
  for (const source of brief.sources) if (source.kind === "thread") add(source.sessionId, source.threadId);
  return [...threads.values()];
}

workspaceBriefingsRouter.post("/:workspace/briefings/:briefingId/dismiss", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const briefingId = c.req.param("briefingId");
  if (!/^brief:[a-f0-9]{24}$/.test(briefingId)) return c.json({ error: "Unknown brief. Reload the page and try again." }, 400);
  const { db, engineStore } = c.var.providers;
  // The brief's threads come from the server's copy of the brief, never from
  // the request, so a dismissal can archive only threads that brief names.
  const [cached] = await db.select({ response: workspaceBriefingCache.response }).from(workspaceBriefingCache)
    .where(and(eq(workspaceBriefingCache.orgId, c.var.user.orgId), eq(workspaceBriefingCache.ownerType, owner.type), eq(workspaceBriefingCache.ownerId, owner.id))).limit(1);
  const brief = cached?.response?.briefings.find(candidate => candidate.id === briefingId);
  if (!brief) return c.json({ error: "Unknown brief. Reload the page and try again." }, 404);
  // A dismissal is one person's choice. In a team workspace the threads are
  // shared, so it hides the brief for the dismisser and archives nothing;
  // archiving there would clear other members' threads without notice.
  const threads = owner.type === "team" ? [] : briefThreads(brief);
  const now = Date.now();
  await db.insert(briefingDismissals).values({ userId: c.var.user.id, orgId: c.var.user.orgId, ownerType: owner.type, ownerId: owner.id, briefingId, dismissedAt: now })
    .onConflictDoNothing();
  // A dismissed failed run (`dismissWorkflowRun`) stays dismissed while it is
  // its workflow's latest run, so only brief dismissals expire.
  await db.delete(briefingDismissals).where(and(eq(briefingDismissals.userId,c.var.user.id), lt(briefingDismissals.dismissedAt,now - DISMISSAL_RETENTION_MS),
    notLike(briefingDismissals.briefingId, "run:%")));

  let archived = 0;
  let keptWaiting = 0;
  let keptRunning = 0;
  for (const { sessionId, threadId } of threads) {
    const [session] = await db.select().from(agentSessions).where(and(eq(agentSessions.id,sessionId), eq(agentSessions.orgId,c.var.user.orgId))).limit(1);
    // Only a thread in this workspace that the caller may see.
    if (!session || session.ownerType !== owner.type || (session.ownerId || session.userId) !== owner.id) continue;
    if (!await canViewSession(db,session,c.var.principal)) continue;
    const thread = await engineStore.getThread(sessionId,threadId);
    // A brief cached before private threads were left out may still name one.
    if (!thread || !isSharedThreadKey(thread.key, c.var.user.id)) continue;
    if ((await engineStore.listDecisionGates(sessionId,threadId,"pending")).length > 0) { keptWaiting += 1; continue; }
    // Background work still reports on the thread. A dismissal does not stop
    // it, so the thread stays open (fix wave 3, group C).
    if (selectWork(await listBackgroundWork(engineStore, sessionId), { threadId }).length > 0) { keptRunning += 1; continue; }
    await db.insert(sessionThreads).values({ id: threadId, sessionId, createdAt: thread.createdAt, archivedAt: now })
      .onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: now } });
    archived += 1;
  }
  const response: DismissWorkspaceBriefingResponse = { dismissed: true, archived, keptWaiting, keptRunning };
  return c.json(response);
});
