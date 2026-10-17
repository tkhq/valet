/**
 * The presence hub's reads (spec 2026-10-16: presence hub, Parts B and G):
 *
 * - `GET /api/presence/places?scope=<workspace>`: the places a workspace is present in.
 * - `GET /api/presence/places/:subject?scope=<workspace>`: one place and its page rows.
 * - `GET /api/presence/feeders?sessionId=<id>&threadId=<id>`: the listeners and routines that feed a thread.
 *
 * `scope` is `user` or a team id, resolved as the Channels reads resolve it.
 */
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { parsePrincipal, type Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { orgSlackCredential, storedThreadRef } from "../services/thread-access.js";
import { getPresencePlace, listPresencePlaces, listThreadFeeders, type PresenceAccess } from "../services/presence-places.js";
import { channelsVisibleTo, spawnedFromVisibleThread, threadsVisibleTo } from "./_thread-access.js";
import { slackChannelNames, threadsShownTo } from "./workspace-channels.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { rowToEventSummary, rowToSubscription } from "./events.js";
import type { PresencePlaceDetailResponse } from "../wire/types.js";

export const presenceRouter = new Hono<AppEnv>();

/** The same text for a missing thread and one the viewer may not read, so the answer never shows that a thread exists. */
export const FEEDERS_THREAD_REFUSAL = "This thread belongs to another owner. Open a thread in your workspace.";

function presenceAccess(c: Context<AppEnv>, owner: Principal): PresenceAccess {
  return {
    names: slackChannelNames(c),
    canSee: channelsVisibleTo(c),
    threadsShown: threadsShownTo(c, owner),
    slackTeamId: async () => {
      const teamId = (await orgSlackCredential(c.var.providers, c.var.user.orgId))?.metadata?.teamId;
      return typeof teamId === "string" && teamId !== "" ? teamId : null;
    },
  };
}

/** The workspace `scope` names, or the response that refuses the request. */
async function scopeOwner(c: Context<AppEnv>): Promise<Principal | Response> {
  const scope = c.req.query("scope");
  if (!scope) return c.json({ error: "Send the workspace scope, such as ?scope=user or ?scope=<team id>." }, 400);
  const owner = await authorizedWorkspaceOwner(c, scope);
  return owner ?? c.json({ error: "Workspace not found. Select an accessible workspace." }, 404);
}

presenceRouter.get("/places", async (c) => {
  const owner = await scopeOwner(c);
  if (owner instanceof Response) return owner;
  return c.json(await listPresencePlaces(c.var.providers, c.var.user.orgId, owner, presenceAccess(c, owner)));
});

presenceRouter.get("/places/:subject", async (c) => {
  const owner = await scopeOwner(c);
  if (owner instanceof Response) return owner;
  const detail = await getPresencePlace(c.var.providers, c.var.user.orgId, owner, presenceAccess(c, owner), c.req.param("subject"));
  if (!detail) return c.json({ error: "Valet is not present in that place in this workspace. Open Places to see where it is." }, 404);
  const body: PresencePlaceDetailResponse = {
    place: detail.place,
    listeners: detail.listeners.map(rowToSubscription),
    threads: detail.threads,
    activity: detail.activity.map(rowToEventSummary),
  };
  return c.json(body);
});

presenceRouter.get("/feeders", async (c) => {
  const sessionId = c.req.query("sessionId");
  const threadId = c.req.query("threadId");
  if (!sessionId || !threadId) return c.json({ error: "Send sessionId and threadId, such as ?sessionId=<id>&threadId=<id>." }, 400);
  const { db, engineStore } = c.var.providers;
  const [session] = await db.select({
    id: agentSessions.id, userId: agentSessions.userId, ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId,
    status: agentSessions.status,
  }).from(agentSessions).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, c.var.user.orgId))).limit(1);
  if (!session || session.status === "deleted" || !(await canViewSession(db, session, c.var.principal))
    || !(await spawnedFromVisibleThread(c, session))) {
    return c.json({ error: FEEDERS_THREAD_REFUSAL }, 404);
  }
  const thread = await engineStore.getThread(sessionId, threadId);
  if (!thread || !(await threadsVisibleTo(c, session)(await storedThreadRef(db, sessionId, threadId, thread.key)))) {
    return c.json({ error: FEEDERS_THREAD_REFUSAL }, 404);
  }
  // A row from before owner columns reads as owned by its user.
  const owner = parsePrincipal(`${session.ownerType}:${session.ownerId}`) ?? { type: "user", id: session.userId };
  return c.json(await listThreadFeeders(db, c.var.user.orgId, owner, { sessionId, threadId, key: thread.key }));
});
