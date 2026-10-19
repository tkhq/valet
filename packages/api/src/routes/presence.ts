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
import { and, eq, inArray } from "drizzle-orm";
import { parsePrincipal, type Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, eventSubscriptions } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { orgSlackCredential, storedThreadRef } from "../services/thread-access.js";
import { getPresencePlace, listPresencePlaces, listThreadFeeders, type PresenceAccess } from "../services/presence-places.js";
import { channelsVisibleTo, spawnedFromVisibleThread, threadsVisibleTo } from "./_thread-access.js";
import { slackChannelNames, threadsShownTo } from "./workspace-channels.js";
import { authorizedWorkspaceOwner } from "./workspace-runtime.js";
import { rowToEventSummary, rowToSubscription, subscriptionProblems } from "./events.js";
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

/** The refusal for a channel-only Slack key the api cannot place in one Slack workspace. */
export const CHANNEL_KEY_REFUSAL = "That Slack channel has no workspace in its link. Pick the channel from Presence.";

/**
 * The place key to read. An old `/channel?key=slack:<channel>` link and a
 * thread's channel chip name a Slack channel without its workspace. The org
 * connects one Slack workspace, so the channel resolves to
 * `slack:<team>/<channel>`. A key that names the workspace itself stays as
 * sent. Null when the org has no Slack workspace to resolve against.
 */
export async function resolvePlaceKey(subject: string, slackTeamId: () => Promise<string | null>): Promise<string | null> {
  const channelOnly = /^slack:([^/]+)$/.exec(subject);
  if (!channelOnly) return subject;
  const teamId = await slackTeamId();
  if (!teamId) return null;
  return channelOnly[1] === teamId ? subject : `slack:${teamId}/${channelOnly[1]}`;
}

presenceRouter.get("/places/:subject", async (c) => {
  const owner = await scopeOwner(c);
  if (owner instanceof Response) return owner;
  const access = presenceAccess(c, owner);
  const subject = await resolvePlaceKey(c.req.param("subject"), access.slackTeamId);
  if (!subject) return c.json({ error: CHANNEL_KEY_REFUSAL }, 404);
  const detail = await getPresencePlace(c.var.providers, c.var.user.orgId, owner, access, subject);
  if (!detail) return c.json({ error: "Valet is not present in that place in this workspace. Open Places to see where it is." }, 404);
  // Each listener carries its open problem, as the list route reads it, so
  // the place page shows the problem under the line (spec Part C step 5).
  const ids = detail.listeners.map((row) => row.id);
  const problems = ids.length === 0 ? new Map<string, string>()
    : await subscriptionProblems(c.var.providers.db, [eq(eventSubscriptions.orgId, c.var.user.orgId), inArray(eventSubscriptions.id, ids)]);
  const body: PresencePlaceDetailResponse = {
    place: detail.place,
    listeners: detail.listeners.map((row) => {
      const problem = problems.get(row.id);
      return problem ? { ...rowToSubscription(row), problem } : rowToSubscription(row);
    }),
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
