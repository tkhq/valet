import type { EventStream } from "@valet/engine";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, threadPullRequests } from "../schema/index.js";
import type { ThreadPullRequest } from "../wire/types.js";
import { resolveGithubApiUrl, resolveGithubUrl } from "./github-env.js";
import { resolveGitHubToken, type GitHubTokenDeps } from "./github-tokens.js";
import { recordTerminalPullRequestWrite } from "./channel-messages.js";

export const PULL_REQUEST_RECHECK_MS = 10 * 60_000;
const RECHECK_BATCH = 5;

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Parses a pull request URL on the configured GitHub host (`GITHUB_URL`,
 * github.com by default). Other hosts and shapes return null. */
export function parsePullRequestUrl(
  url: string, githubUrl = resolveGithubUrl(process.env),
): { owner: string; repo: string; number: number } | null {
  let parsed: URL, host: URL;
  try { parsed = new URL(url.trim()); host = new URL(githubUrl); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.host !== host.host || parsed.search || parsed.hash) return null;
  const base = host.pathname.replace(/\/+$/, "");
  if (base && !parsed.pathname.startsWith(`${base}/`)) return null;
  const [owner, repo, kind, number, ...rest] = parsed.pathname.slice(base.length).split("/").filter(Boolean);
  if (rest.length || kind !== "pull" || !owner || !repo || !NAME.test(owner) || !NAME.test(repo) || !number || !/^\d+$/.test(number)) return null;
  return { owner, repo, number: Number(number) };
}

/** How far up the delegation chain a pull request is recorded. */
const MAX_DELEGATION_DEPTH = 5;

/**
 * Records a pull request on the thread that opened it and on each thread that
 * delegated that work. A child's pull request then shows on the workspace
 * thread that asked for it, and its comments route back to that thread.
 */
export async function recordDelegatedPullRequest(db: AppDb, input: { sessionId: string; threadId: string; url: string }): Promise<void> {
  let current: { sessionId: string; threadId: string } | undefined = { sessionId: input.sessionId, threadId: input.threadId };
  for (let depth = 0; current && depth <= MAX_DELEGATION_DEPTH; depth++) {
    if (!(await recordThreadPullRequest(db, { ...current, url: input.url }))) return;
    const [parent] = await db.select({ sessionId: childWatches.parentSessionId, threadId: childWatches.parentThreadId })
      .from(childWatches).where(eq(childWatches.childSessionId, current.sessionId)).limit(1);
    current = parent;
  }
}

/** Records a pull request the thread created. A repeat of the same URL is ignored. */
export async function recordThreadPullRequest(
  db: AppDb, input: { sessionId: string; threadId: string; url: string }, at = Date.now(),
): Promise<boolean> {
  const parsed = parsePullRequestUrl(input.url);
  if (!parsed) return false;
  await db.insert(threadPullRequests).values({
    sessionId: input.sessionId, threadId: input.threadId, url: input.url.trim(),
    repo: `${parsed.owner}/${parsed.repo}`, number: parsed.number, state: "open",
    createdAt: at, updatedAt: at, checkedAt: at,
  }).onConflictDoNothing();
  return true;
}

/** Applies GitHub state to the organization's associated threads. */
export async function setPullRequestState(
  db: AppDb, orgId: string, url: string, state: ThreadPullRequest["state"], at = Date.now(),
): Promise<void> {
  await db.update(threadPullRequests).set({ state, updatedAt: at, checkedAt: at })
    .where(and(eq(threadPullRequests.url, url), sql`${threadPullRequests.sessionId} IN (SELECT id FROM agent_sessions WHERE org_id = ${orgId})`));
}

/** The pull request state named by a GitHub `pull_request` webhook payload, if any. */
export function pullRequestWebhookState(payload: unknown): { url: string; state: ThreadPullRequest["state"] } | null {
  if (typeof payload !== "object" || payload === null || !("pull_request" in payload)) return null;
  const pr = payload.pull_request;
  if (typeof pr !== "object" || pr === null || !("html_url" in pr) || typeof pr.html_url !== "string") return null;
  const merged = "merged" in pr && pr.merged === true;
  const closed = "state" in pr && pr.state === "closed";
  return { url: pr.html_url, state: merged ? "merged" : closed ? "closed" : "open" };
}

/**
 * Records pull requests as threads create them. A `gh pr create` in the
 * terminal and the GitHub `create_pull_request` action both report a
 * `pull_request_created` outcome on the engine's `tool_end` event.
 */
export function wireThreadPullRequests(eventStream: EventStream, db: AppDb): () => void {
  return eventStream.subscribe({ eventTypes: ["tool_end"] }, (delivered) => {
    const { event, sessionId } = delivered;
    if (event.type !== "tool_end" || !event.outcome) return;
    const { kind, url, startedAt } = event.outcome;
    if (kind === "pull_request_created" && url) {
      void recordDelegatedPullRequest(db, { sessionId, threadId: event.threadId, url })
        .catch(err => console.error("[thread-activity] could not record a pull request", err));
      return;
    }
    // A comment or review posted from the terminal is Valet's own: record it,
    // so its webhook does not wake the thread that posted it.
    if (kind === "pull_request_comment" || kind === "review_submitted") {
      void (async () => {
        const [session] = await db.select({ orgId: agentSessions.orgId }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
        if (session) await recordTerminalPullRequestWrite(db, { orgId: session.orgId, sessionId, threadId: event.threadId, kind, ...(url ? { url } : {}), ...(startedAt !== undefined ? { startedAt } : {}) });
      })().catch(err => console.error("[thread-activity] could not record a terminal pull request write", err));
    }
  });
}

/** Claims stale org/URL groups before any provider work. Webhooks remain primary. */
export async function recheckOpenPullRequests(
  deps: GitHubTokenDeps, db: AppDb, now = Date.now(),
): Promise<void> {
  const candidates = await db.execute(sql`
    SELECT s.org_id, p.url
    FROM thread_pull_requests p JOIN agent_sessions s ON s.id = p.session_id
    WHERE p.state = 'open' AND s.status <> 'deleted'
    GROUP BY s.org_id, p.url
    HAVING max(p.checked_at) < ${now - PULL_REQUEST_RECHECK_MS}
    ORDER BY min(p.checked_at), s.org_id, p.url LIMIT ${RECHECK_BATCH}`) as { rows: Array<{ org_id: string; url: string }> };
  for (const pr of candidates.rows) {
    const claimed = await db.transaction(async tx => {
      // The org row serializes claims for all copies of one URL, including ancestors.
      // Release the lock before credential resolution or network I/O.
      await tx.execute(sql`SELECT id FROM orgs WHERE id = ${pr.org_id} FOR UPDATE`);
      const result = await tx.execute(sql`UPDATE thread_pull_requests p SET checked_at = ${now}
        FROM agent_sessions s WHERE s.id = p.session_id AND s.org_id = ${pr.org_id}
          AND s.status <> 'deleted' AND p.url = ${pr.url} AND p.state = 'open'
          AND NOT EXISTS (SELECT 1 FROM thread_pull_requests fresh
            JOIN agent_sessions fs ON fs.id = fresh.session_id
            WHERE fs.org_id = ${pr.org_id} AND fresh.url = ${pr.url} AND fresh.state = 'open'
              AND fresh.checked_at >= ${now - PULL_REQUEST_RECHECK_MS})
        RETURNING p.url`) as { rows: Array<{ url: string }> };
      return result.rows.length > 0;
    });
    if (!claimed) continue;
    const parsed = parsePullRequestUrl(pr.url);
    if (!parsed) continue;
    try {
      const { token } = await resolveGitHubToken(deps, {
        orgId: pr.org_id, purpose: "api", repo: { owner: parsed.owner, name: parsed.repo },
      });
      if (!token) continue;
      const response = await (deps.fetchImpl ?? fetch)(
        `${deps.apiUrl ?? resolveGithubApiUrl(process.env)}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
        { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) continue;
      const state = pullRequestWebhookState({ pull_request: await response.json() });
      if (!state || state.url !== pr.url || state.state === "open") continue;
      // A webhook delivered during the fetch wins over this older snapshot.
      await db.update(threadPullRequests).set({ state: state.state, updatedAt: now })
        .where(and(eq(threadPullRequests.url, pr.url), eq(threadPullRequests.state, "open"),
          eq(threadPullRequests.checkedAt, now), sql`${threadPullRequests.updatedAt} < ${now}`,
          sql`${threadPullRequests.sessionId} IN (SELECT id FROM agent_sessions WHERE org_id = ${pr.org_id})`));
    } catch {
      // Missing credentials, provider errors, and malformed JSON consume this window.
    }
  }
}

/** Owns fallback checks independently of HTTP reads. Stop drains the current pass. */
export function startPullRequestSweep(deps: GitHubTokenDeps, db: AppDb): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = recheckOpenPullRequests(deps, db)
      .catch(err => console.error("[thread-pull-requests] reconciliation failed; the next sweep retries", err))
      .finally(() => { inFlight = undefined; });
  }, 60_000);
  timer.unref();
  return { stop() { clearInterval(timer); return inFlight ?? Promise.resolve(); } };
}
