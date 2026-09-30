import type { EventStream, Principal } from "@valet/engine";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, threadPullRequests, threadReads } from "../schema/index.js";
import type { ThreadPullRequest, WaitingThread } from "../wire/types.js";
import { resolveGithubApiUrl, resolveGithubUrl } from "./github-env.js";
import { resolveGitHubToken, type GitHubTokenDeps } from "./github-tokens.js";

/** An open pull request is checked against GitHub at most this often. */
export const PULL_REQUEST_RECHECK_MS = 10 * 60_000;
const RECHECK_BATCH = 5;

export interface ThreadActivity {
  readAt?: number;
  lastAgentActivityAt?: number;
  pullRequests?: ThreadPullRequest[];
}

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

/** Read state, the last agent message, and pull requests for the threads the viewer lists. */
export async function listThreadActivity(
  db: AppDb, userId: string, sessionId: string, threadIds: string[],
): Promise<Map<string, ThreadActivity>> {
  const activity = new Map<string, ThreadActivity>();
  if (threadIds.length === 0) return activity;
  const entry = (id: string) => {
    let value = activity.get(id);
    if (!value) { value = {}; activity.set(id, value); }
    return value;
  };
  const [reads, latest, pulls] = await Promise.all([
    db.select({ threadId: threadReads.threadId, readAt: threadReads.readAt }).from(threadReads)
      .where(and(eq(threadReads.userId, userId), inArray(threadReads.threadId, threadIds))),
    // One index probe per thread on engine_entries(session_id, thread_id, created_at).
    db.execute(sql`SELECT ids.id AS thread_id, e.created_at
      FROM unnest(ARRAY[${sql.join(threadIds.map(id => sql`${id}`), sql`,`)}]::text[]) AS ids(id)
      JOIN LATERAL (SELECT created_at FROM engine_entries
        WHERE session_id = ${sessionId} AND thread_id = ids.id AND entry_type = 'message' AND role = 'assistant'
        ORDER BY created_at DESC LIMIT 1) e ON true`) as Promise<{ rows: Array<{ thread_id: string; created_at: string | number }> }>,
    db.select().from(threadPullRequests)
      .where(and(eq(threadPullRequests.sessionId, sessionId), inArray(threadPullRequests.threadId, threadIds))),
  ]);
  for (const row of reads) entry(row.threadId).readAt = row.readAt;
  for (const row of latest.rows) entry(row.thread_id).lastAgentActivityAt = Number(row.created_at);
  for (const row of pulls.sort((a, b) => a.createdAt - b.createdAt)) {
    const value = entry(row.threadId);
    (value.pullRequests ??= []).push({ url: row.url, repo: row.repo, number: row.number, state: row.state });
  }
  return activity;
}

/** Records that the person read the thread. A later timestamp never moves back. */
export async function markThreadsRead(
  db: AppDb, userId: string, sessionId: string, threadIds: string[], at = Date.now(),
): Promise<void> {
  if (threadIds.length === 0) return;
  await db.insert(threadReads)
    .values(threadIds.map(threadId => ({ userId, sessionId, threadId, readAt: at })))
    .onConflictDoUpdate({
      target: [threadReads.userId, threadReads.threadId],
      set: { readAt: sql`GREATEST(${threadReads.readAt}, excluded.read_at)`, sessionId: sql`excluded.session_id` },
    });
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

/** Applies a state GitHub reported for a pull request to every thread that created it. */
export async function setPullRequestState(
  db: AppDb, url: string, state: ThreadPullRequest["state"], at = Date.now(),
): Promise<void> {
  await db.update(threadPullRequests).set({ state, updatedAt: at, checkedAt: at })
    .where(eq(threadPullRequests.url, url));
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
    if (event.type !== "tool_end" || event.outcome?.kind !== "pull_request_created" || !event.outcome.url) return;
    void recordThreadPullRequest(db, { sessionId, threadId: event.threadId, url: event.outcome.url })
      .catch(err => console.error("[thread-activity] could not record a pull request", err));
  });
}

/**
 * Checks open pull requests that GitHub has not reported on recently. A
 * webhook usually updates the state first; this covers orgs without one.
 * Bounded per call, and a pull request that cannot be read waits for the
 * next window instead of retrying.
 */
export async function recheckOpenPullRequests(
  deps: GitHubTokenDeps, db: AppDb, sessionId: string, now = Date.now(),
): Promise<void> {
  const stale = await db.select({ url: threadPullRequests.url, repo: threadPullRequests.repo, number: threadPullRequests.number })
    .from(threadPullRequests)
    .where(and(eq(threadPullRequests.sessionId, sessionId), eq(threadPullRequests.state, "open"),
      lt(threadPullRequests.checkedAt, now - PULL_REQUEST_RECHECK_MS)))
    .limit(RECHECK_BATCH);
  if (stale.length === 0) return;
  const [session] = await db.select({ orgId: agentSessions.orgId }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!session) return;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiUrl = deps.apiUrl ?? resolveGithubApiUrl(process.env);
  for (const pr of stale) {
    // Claim the window first, so parallel list requests do not repeat the call.
    await db.update(threadPullRequests).set({ checkedAt: now }).where(eq(threadPullRequests.url, pr.url));
    const [owner, repo] = pr.repo.split("/");
    if (!owner || !repo) continue;
    // No usable credential means no check; the webhook can still update the row.
    const token = await resolveGitHubToken(deps, { orgId: session.orgId, purpose: "api", repo: { owner, name: repo } })
      .then((resolved) => resolved.token, () => null);
    if (!token) continue;
    const res = await fetchImpl(`${apiUrl}/repos/${owner}/${repo}/pulls/${pr.number}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    }).catch(() => null);
    if (!res?.ok) continue;
    const state = pullRequestWebhookState({ pull_request: await res.json() });
    if (state && state.state !== "open") await setPullRequestState(db, pr.url, state.state, now);
  }
}

/** A thread counts as waiting only while its newest agent message is this recent. */
export const WAITING_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * Threads that wait on a reply: a person took part, the agent answered after
 * their last action, and nobody replied or archived the thread since. A thread
 * with queued, running, or gated work is excluded; active work lists it.
 */
export async function listWaitingThreads(
  db: AppDb, orgId: string, owner: Principal, viewerId: string, now = Date.now(), limit = 50,
): Promise<WaitingThread[]> {
  const result = await db.execute(sql`
    SELECT t.session_id, t.id AS thread_id,
      COALESCE(NULLIF(t.title,''),w.name,NULLIF(s.title,'')) AS title,
      e.created_at AS agent_at, e.tail, r.read_at
    FROM session_threads t JOIN agent_sessions s ON s.id = t.session_id
    LEFT JOIN engine_threads et ON et.session_id = t.session_id AND et.id = t.id
    -- A workflow editor conversation takes its workflow's name.
    LEFT JOIN workflow_definitions w ON et.key LIKE 'workflow:%' AND w.id = split_part(et.key, ':', 2)
    JOIN LATERAL (SELECT created_at, right(content, 2000) AS tail FROM engine_entries
      WHERE session_id = t.session_id AND thread_id = t.id AND entry_type = 'message' AND role = 'assistant'
      ORDER BY created_at DESC LIMIT 1) e ON true
    LEFT JOIN thread_reads r ON r.user_id = ${viewerId} AND r.thread_id = t.id
    WHERE s.status <> 'deleted' AND s.org_id = ${orgId} AND s.owner_type = ${owner.type}
      AND COALESCE(NULLIF(s.owner_id,''),CASE WHEN s.owner_type='user' THEN s.user_id END) = ${owner.id}
      AND t.archived_at IS NULL AND t.last_user_activity_at IS NOT NULL
      -- The sidebar hides each person's app-assistant helper thread; so does this list.
      AND (et.key IS NULL OR et.key NOT LIKE 'app-assistant:%')
      -- A workflow editor conversation belongs to one viewer, and the editor of a
      -- deleted workflow has nothing left to answer.
      AND (et.key IS NULL OR et.key NOT LIKE 'workflow:%'
        OR (w.id IS NOT NULL AND split_part(et.key, ':', 3) IN ('', ${viewerId})))
      AND e.created_at > t.last_user_activity_at AND e.created_at > ${now - WAITING_WINDOW_MS}
      AND NOT EXISTS (SELECT 1 FROM engine_queue_items q
        WHERE q.session_id = t.session_id AND q.thread_id = t.id AND q.status <> 'settled')
    ORDER BY e.created_at DESC LIMIT ${limit}`) as {
      rows: Array<{ session_id: string; thread_id: string; title: string | null; agent_at: string | number; tail: string | null; read_at: string | number | null }>;
    };
  return result.rows.map(row => {
    const lastAgentActivityAt = Number(row.agent_at);
    const ask = lastAgentAsk(row.tail ?? "");
    return {
      sessionId: row.session_id, threadId: row.thread_id, title: row.title || "Conversation",
      lastAgentActivityAt, unread: row.read_at === null || Number(row.read_at) < lastAgentActivityAt,
      ...ask,
    };
  });
}

const PREVIEW_CHARS = 160;

/**
 * What the agent's last message asks of the reader. The question is the last
 * sentence that ends with a question mark. Without one, the preview is the
 * message's last sentence. Markdown markers are removed, so the text reads as
 * plain prose in a list row.
 */
export function lastAgentAsk(text: string): { question?: string; preview?: string } {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return {};
  // A sentence ends at punctuation followed by a space, so "gpt-5.6" and URLs stay whole.
  const sentences = plain.split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()).filter(Boolean);
  const clip = (value: string) => value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : value;
  const question = [...sentences].reverse().find(sentence => sentence.endsWith("?"));
  if (question) return { question: clip(question) };
  const last = sentences.at(-1);
  return last ? { preview: clip(last) } : {};
}
