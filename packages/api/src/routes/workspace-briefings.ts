import { and, eq, inArray, lt } from "drizzle-orm";
import { readOptionalJsonObject } from "../lib/optional-json-body.js";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { agentSessions, briefingDismissals, sessionThreads } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { getWorkspaceBriefings } from "../services/workspace-briefings.js";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { DismissWorkspaceBriefingResponse, WorkspaceBriefingsResponse } from "../wire/types.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";

/** Dismissals stop mattering once their brief ids stop appearing. */
const DISMISSAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DISMISS_THREADS = 30;

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
  return c.json(await hideDismissedBriefings(db,c.var.user.id,owner,await getWorkspaceBriefings(db,c.var.user.orgId,owner)));
});

/**
 * Hides one brief for the caller, and archives the brief's threads so the
 * sidebar clears with it. A thread waiting on an approval stays open:
 * archiving would withdraw an approval someone may still answer.
 */
workspaceBriefingsRouter.post("/:workspace/briefings/:briefingId/dismiss", async c => {
  const owner = await authorizedWorkspaceOwner(c);
  if (!owner) return c.json({ error: "Workspace not found." }, 404);
  const briefingId = c.req.param("briefingId");
  if (!/^brief:[a-f0-9]{24}$/.test(briefingId)) return c.json({ error: "Unknown brief. Reload the page and try again." }, 400);
  // An empty body dismisses without archiving. A malformed one is refused before
  // any state changes, so a truncated request cannot hide the brief.
  const body = await readOptionalJsonObject(c);
  if (!body) return c.json({ error: "Send a JSON object with a threads array, or an empty body. Reload the page and try again." }, 400);
  const rawThreads = body.threads;
  const threads = Array.isArray(rawThreads)
    ? rawThreads.flatMap(item => typeof item === "object" && item !== null && "sessionId" in item && "threadId" in item
      && typeof item.sessionId === "string" && typeof item.threadId === "string" ? [{ sessionId: item.sessionId, threadId: item.threadId }] : [])
    : [];
  if (threads.length > MAX_DISMISS_THREADS) return c.json({ error: `Send at most ${MAX_DISMISS_THREADS} threads.` }, 400);

  const { db, engineStore } = c.var.providers;
  const now = Date.now();
  await db.insert(briefingDismissals).values({ userId: c.var.user.id, orgId: c.var.user.orgId, ownerType: owner.type, ownerId: owner.id, briefingId, dismissedAt: now })
    .onConflictDoNothing();
  await db.delete(briefingDismissals).where(and(eq(briefingDismissals.userId,c.var.user.id), lt(briefingDismissals.dismissedAt,now - DISMISSAL_RETENTION_MS)));

  let archived = 0;
  let keptWaiting = 0;
  for (const { sessionId, threadId } of threads) {
    const [session] = await db.select().from(agentSessions).where(and(eq(agentSessions.id,sessionId), eq(agentSessions.orgId,c.var.user.orgId))).limit(1);
    // Only a thread in this workspace that the caller may see.
    if (!session || session.ownerType !== owner.type || (session.ownerId || session.userId) !== owner.id) continue;
    if (!await canViewSession(db,session,c.var.principal)) continue;
    const thread = await engineStore.getThread(sessionId,threadId);
    if (!thread) continue;
    if ((await engineStore.listDecisionGates(sessionId,threadId,"pending")).length > 0) { keptWaiting += 1; continue; }
    await db.insert(sessionThreads).values({ id: threadId, sessionId, createdAt: thread.createdAt, archivedAt: now })
      .onConflictDoUpdate({ target: sessionThreads.id, set: { archivedAt: now } });
    archived += 1;
  }
  const response: DismissWorkspaceBriefingResponse = { dismissed: true, archived, keptWaiting };
  return c.json(response);
});
