/**
 * `/api/code-review` — what the PR review plugin (`@valet/plugin-pr-review`)
 * did for one workspace, for the Code review page. The plugin keeps one
 * record per pull request in its plugin store (`POINTERS_COLLECTION`), scoped
 * to the workspace that owns the line, and does the work in a plugin thread
 * keyed by the same `owner/repo#N`.
 *
 * Read-only. The lines that turn reviews on are ordinary event subscriptions
 * (`routes/events.ts`).
 */
import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { POINTERS_COLLECTION, type PullPointers } from "@valet/plugin-pr-review";
import type { AppEnv } from "../env.js";
import { pluginThreadKey } from "../plugins/plugin-thread-key.js";
import { assistantExecutions, assistants } from "../schema/index.js";
import { pluginStore } from "../services/plugin-store.js";
import { canViewTeam, getTeamInOrg } from "../services/teams.js";
import type { CodeReviewWire, ListCodeReviewsResponse } from "../wire/types.js";

export const PR_REVIEW_PLUGIN = "pr-review";

/** Records read per request: the page shows the newest few. */
const MAX_REVIEWS = 200;
const SLUG = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/;

export const codeReviewRouter = new Hono<AppEnv>();

codeReviewRouter.get("/reviews", async (c) => {
  const { db, engineStore } = c.var.providers;
  const user = c.var.user;
  const teamId = c.req.query("teamId");
  if (teamId) {
    const team = await getTeamInOrg(db, user.orgId, teamId);
    if (!team || !(await canViewTeam(db, teamId, user.id))) return c.json({ error: "Team not found." }, 404);
  }
  const owner = teamId ? { type: "team" as const, id: teamId } : { type: "user" as const, id: user.id };
  const store = pluginStore(db, PR_REVIEW_PLUGIN);
  const scoped = owner.type === "team" ? store.team(owner.id) : store.user(owner.id);
  const page = await scoped.list<PullPointers>(POINTERS_COLLECTION, { limit: MAX_REVIEWS });

  const records = page.items.flatMap((item) => {
    const match = SLUG.exec(item.key);
    return match ? [{ item, repo: match[1]!, number: Number(match[2]) }] : [];
  });

  // Each plugin thread is the governing key of an isolated execution session
  // of the owner's assistant (`plugins/plugin-threads.ts`). Its link opens
  // the thread inside that session.
  const keys = records.map((r) => pluginThreadKey(PR_REVIEW_PLUGIN, r.item.key));
  const executions = keys.length === 0 ? [] : await db
    .select({ sessionId: assistantExecutions.sessionId, key: assistantExecutions.conversationKey })
    .from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistants.orgId, user.orgId), eq(assistants.ownerType, owner.type), eq(assistants.ownerId, owner.id), inArray(assistantExecutions.conversationKey, keys)));
  const threads = await engineStore.listThreadsForSessions(executions.map((e) => e.sessionId));
  const threadByKey = new Map(threads.map((t) => [t.key, t.id]));

  const reviews: CodeReviewWire[] = records.map(({ item, repo, number }) => {
    const findings = item.doc.findings ?? [];
    const threadId = threadByKey.get(pluginThreadKey(PR_REVIEW_PLUGIN, item.key));
    return {
      repo,
      number,
      ...(item.doc.reviewId !== undefined ? { reviewId: item.doc.reviewId } : {}),
      ...(item.doc.lastReviewedHead !== undefined ? { head: item.doc.lastReviewedHead } : {}),
      openFindings: findings.filter((f) => f.status === "open").length,
      resolvedFindings: findings.filter((f) => f.status === "resolved").length,
      updatedAt: item.updatedAt,
      ...(threadId !== undefined ? { threadId } : {}),
    };
  });
  reviews.sort((a, b) => b.updatedAt - a.updatedAt);
  const resp: ListCodeReviewsResponse = { reviews };
  return c.json(resp);
});
