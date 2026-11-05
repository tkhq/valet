/** Read-only review chains for the selected personal or team workspace. */
import { Hono } from "hono";
import type { Principal } from "@valet/engine";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { POINTERS_COLLECTION, pullTarget, type PullPointers, type ReviewRound } from "@valet/plugin-pr-review";
import type { AppEnv } from "../env.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { pluginThreadKey } from "../plugins/plugin-thread-key.js";
import { assistantExecutions, assistants, eventDeliveries, events, eventSubscriptions, pluginStore } from "../schema/index.js";
import { resolveGithubApiUrl } from "../services/github-env.js";
import { resolveGitHubToken } from "../services/github-tokens.js";
import { canViewTeam, getTeamInOrg } from "../services/teams.js";
import type { CodeReviewWire, ListCodeReviewsResponse } from "../wire/types.js";

export const PR_REVIEW_PLUGIN = "pr-review";

/** Bound database reads, provider requests, and response size. */
const MAX_REVIEWS = 200;
const GITHUB_CONCURRENCY = 4;
const STATE_COLLECTION = "pr-review-state";
const SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;

type ReviewDocument = Pick<PullPointers, "lastReviewedHead"> & {
  reviewId?: number;
  findings: Array<{ status: string }>;
  rounds?: ReviewRound[];
};
interface ReviewRecord {
  key: string;
  repo: string;
  owner: string;
  name: string;
  number: number;
  updatedAt: number;
  pointers?: ReviewDocument;
  legacy?: ReviewDocument;
  deliveryStatus?: "pending" | "delivered" | "failed" | "dead";
}

function recordFor(key: string, updatedAt: number): ReviewRecord | undefined {
  const match = SLUG.exec(key);
  const owner = match?.[1], name = match?.[2], number = Number(match?.[3]);
  return owner && name && Number.isSafeInteger(number)
    ? { key, repo: `${owner}/${name}`, owner, name, number, updatedAt }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stop waiting without cancelling a credential refresh shared by other callers. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

export const codeReviewRouter = new Hono<AppEnv>();

codeReviewRouter.get("/reviews", async (c) => {
  const { db, engineStore, engineCredentials, encryptionKey } = c.var.providers;
  const user = c.var.user;
  const principal = c.var.principal;
  const teamId = c.req.query("teamId") ?? (principal.type === "team" ? principal.id : undefined);
  if (principal.type === "team" && teamId !== principal.id) return c.json({ error: "Team not found. Select an accessible team." }, 404);
  if (teamId) {
    const team = await getTeamInOrg(db, user.orgId, teamId);
    if (!team || (principal.type !== "team" && !(await canViewTeam(db, teamId, user.id)))) return c.json({ error: "Team not found. Select an accessible team." }, 404);
  }
  const owner: Principal = teamId ? { type: "team", id: teamId } : { type: "user", id: user.id };

  const stored = await db.select({
    key: pluginStore.key,
    collection: pluginStore.collection,
    // These plugin-owned documents have the same shape as scoped.get<T>.
    doc: sql<ReviewDocument>`${pluginStore.doc}`,
    updatedAt: pluginStore.updatedAt,
  }).from(pluginStore).where(and(
    eq(pluginStore.plugin, PR_REVIEW_PLUGIN), eq(pluginStore.scopeType, owner.type), eq(pluginStore.scopeId, owner.id),
    inArray(pluginStore.collection, [POINTERS_COLLECTION, STATE_COLLECTION]),
  )).orderBy(desc(pluginStore.updatedAt), desc(pluginStore.key)).limit(MAX_REVIEWS * 2);

  // Deliveries expose first reviews before the handler saves its pointers.
  // Both joins stay in the authenticated org and selected workspace.
  const deliveries = await db.select({
    refs: events.refs, payload: events.payload, status: eventDeliveries.status,
    createdAt: eventDeliveries.createdAt, deliveredAt: eventDeliveries.deliveredAt,
  }).from(eventDeliveries)
    .innerJoin(events, eq(events.id, eventDeliveries.eventId))
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .where(and(
      eq(events.orgId, user.orgId), eq(eventSubscriptions.orgId, user.orgId),
      eq(eventSubscriptions.ownerType, owner.type), eq(eventSubscriptions.ownerId, owner.id),
      sql`${eventSubscriptions.target}->>'kind' = 'plugin'`,
      sql`${eventSubscriptions.target}->>'plugin' = ${PR_REVIEW_PLUGIN}`,
      sql`${eventSubscriptions.target}->>'handler' = 'review-pull-request'`,
      ne(eventDeliveries.status, "skipped"),
    )).orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id)).limit(MAX_REVIEWS);

  const byKey = new Map<string, ReviewRecord>();
  for (const row of stored) {
    const record = byKey.get(row.key) ?? recordFor(row.key, row.updatedAt);
    if (!record) continue;
    if (row.collection === POINTERS_COLLECTION) record.pointers = row.doc;
    else record.legacy = row.doc;
    record.updatedAt = Math.max(record.updatedAt, row.updatedAt);
    byKey.set(row.key, record);
  }
  for (const delivery of deliveries) {
    const repo = isRecord(delivery.refs) && typeof delivery.refs.repo === "string" ? delivery.refs.repo : "";
    const target = pullTarget({ refs: { repo }, payload: delivery.payload });
    if (!target) continue;
    const key = `${target.owner}/${target.repo}#${target.number}`;
    const record = byKey.get(key) ?? recordFor(key, delivery.createdAt);
    if (!record) continue;
    // Rows arrive newest first. A later delivery governs this chain's status.
    if (record.deliveryStatus === undefined && delivery.status !== "skipped") record.deliveryStatus = delivery.status;
    record.updatedAt = Math.max(record.updatedAt, delivery.createdAt, delivery.deliveredAt ?? 0);
    byKey.set(key, record);
  }
  const records = [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)).slice(0, MAX_REVIEWS);
  if (records.length === 0) return c.json({ reviews: [] } satisfies ListCodeReviewsResponse);

  const tokenDeps = { db, credentials: engineCredentials, key: deriveSecretKey(encryptionKey) };
  const tokens = new Map<string, ReturnType<typeof resolveGitHubToken>>();
  const cancellation = new AbortController();
  const signal = AbortSignal.any([c.req.raw.signal, cancellation.signal, AbortSignal.timeout(30_000)]);
  const open = new Map<string, { title: string; url: string }>();
  let next = 0;
  try {
    await Promise.all(Array.from({ length: Math.min(GITHUB_CONCURRENCY, records.length) }, async () => {
      while (next < records.length) {
        const record = records[next++];
        if (!record) return;
        signal.throwIfAborted();
        let resolved = tokens.get(record.repo);
        if (!resolved) {
          resolved = resolveGitHubToken(tokenDeps, {
            orgId: user.orgId, ...(owner.type === "user" ? { userId: owner.id } : {}),
            purpose: "api", repo: { owner: record.owner, name: record.name },
          });
          tokens.set(record.repo, resolved);
        }
        const { token } = await untilAborted(resolved, signal);
        if (!token) throw new Error("GitHub access is missing");
        const response = await fetch(`${resolveGithubApiUrl(process.env)}/repos/${record.repo}/pulls/${record.number}`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal,
        });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        const pr: unknown = await response.json();
        if (!isRecord(pr) || (pr.state !== "open" && pr.state !== "closed")) throw new Error("GitHub returned no pull request state");
        if (pr.state === "closed") continue;
        if (typeof pr.title !== "string" || typeof pr.html_url !== "string") throw new Error("GitHub returned no pull request title or URL");
        open.set(record.key, { title: pr.title, url: pr.html_url });
      }
    }));
  } catch {
    cancellation.abort();
    return c.json({ error: "Could not verify pull request state with GitHub. Check GitHub access in Settings, then try again." }, 503);
  }

  const active = records.filter(r => open.has(r.key));
  const keys = active.map(r => pluginThreadKey(PR_REVIEW_PLUGIN, r.key));
  const executions = keys.length === 0 ? [] : await db
    .select({ sessionId: assistantExecutions.sessionId, key: assistantExecutions.conversationKey })
    .from(assistantExecutions)
    .innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistants.orgId, user.orgId), eq(assistants.ownerType, owner.type), eq(assistants.ownerId, owner.id), inArray(assistantExecutions.conversationKey, keys)))
    .limit(MAX_REVIEWS);
  const threads = await engineStore.listThreadsForSessions(executions.map(e => e.sessionId));
  const threadByKey = new Map(threads.map(t => [t.key, t.id]));
  const reviews: CodeReviewWire[] = active.flatMap(record => {
    const pr = open.get(record.key);
    if (!pr) return [];
    const doc = record.pointers ?? record.legacy;
    const findings = doc?.findings ?? [];
    const rounds = [...new Map([...(record.legacy?.rounds ?? []), ...(record.pointers?.rounds ?? [])]
      .map(round => [`${round.head}:${round.at}`, round])).values()]
      .sort((a, b) => a.at.localeCompare(b.at)).slice(-100);
    const threadId = threadByKey.get(pluginThreadKey(PR_REVIEW_PLUGIN, record.key));
    return [{
      repo: record.repo, number: record.number, title: pr.title, url: pr.url, state: "open",
      status: record.deliveryStatus === "pending" || record.deliveryStatus === "failed" ? "running" : record.deliveryStatus === "dead" ? "failed" : "complete",
      rounds: rounds.map(round => ({
        head: round.head, mode: round.mode, at: round.at, newFindings: round.newFindings.length, resolved: round.resolved.length,
      })),
      ...(doc?.reviewId !== undefined ? { reviewId: doc.reviewId } : {}),
      ...(doc?.lastReviewedHead !== undefined ? { head: doc.lastReviewedHead } : {}),
      openFindings: findings.filter(f => f.status === "open").length,
      resolvedFindings: findings.filter(f => f.status === "resolved").length,
      updatedAt: record.updatedAt,
      ...(threadId !== undefined ? { threadId } : {}),
    }];
  });
  return c.json({ reviews } satisfies ListCodeReviewsResponse);
});
