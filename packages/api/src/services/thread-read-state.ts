import type { Principal } from "@valet/engine";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { threadPullRequests, threadReads } from "../schema/index.js";
import type { ThreadPullRequest, WaitingThread } from "../wire/types.js";
export interface ThreadActivity {
  readAt?: number;
  lastAgentActivityAt?: number;
  agentQuestion?: string;
  pullRequests?: ThreadPullRequest[];
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
    db.execute(sql`SELECT ids.id AS thread_id, e.created_at, e.tail
      FROM unnest(ARRAY[${sql.join(threadIds.map(id => sql`${id}`), sql`,`)}]::text[]) AS ids(id)
      JOIN LATERAL (SELECT created_at, right(content, 2000) AS tail FROM engine_entries
        WHERE session_id = ${sessionId} AND thread_id = ids.id AND entry_type = 'message' AND role = 'assistant'
        ORDER BY created_at DESC LIMIT 1) e ON true`) as Promise<{ rows: Array<{ thread_id: string; created_at: string | number; tail: string | null }> }>,
    db.select().from(threadPullRequests)
      .where(and(eq(threadPullRequests.sessionId, sessionId), inArray(threadPullRequests.threadId, threadIds))),
  ]);
  for (const row of reads) entry(row.threadId).readAt = row.readAt;
  for (const row of latest.rows) {
    const value = entry(row.thread_id);
    value.lastAgentActivityAt = Number(row.created_at);
    const { question } = lastAgentAsk(row.tail ?? "");
    if (question) value.agentQuestion = question;
  }
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
  // One upsert cannot touch a row twice, so a repeated id must not reach it.
  const unique = [...new Set(threadIds)];
  if (unique.length === 0) return;
  await db.insert(threadReads)
    .values(unique.map(threadId => ({ userId, sessionId, threadId, readAt: at })))
    .onConflictDoUpdate({
      target: [threadReads.userId, threadReads.threadId],
      set: { readAt: sql`GREATEST(${threadReads.readAt}, excluded.read_at)`, sessionId: sql`excluded.session_id` },
    });
}

/**
 * True for a thread every member of a workspace sees in a shared list. Each
 * person's app-assistant helper thread is left out of shared lists, as the
 * sidebar leaves it out. A workflow editor conversation
 * (`workflow:<id>:<viewer>`) is listed only for its viewer; without a viewer,
 * as in workspace briefs, every editor conversation is left out. This is a
 * display rule, not access control: team members share one runtime, and the
 * thread API still reaches these threads.
 */
export function isSharedThreadKey(key: string | null | undefined, viewerId?: string): boolean {
  if (!key) return true;
  if (key.startsWith("app-assistant:")) return false;
  if (!key.startsWith("workflow:")) return true;
  const viewer = key.split(":")[2] ?? "";
  return viewerId !== undefined && (viewer === "" || viewer === viewerId);
}

/** `isSharedThreadKey` as SQL, for filtering inside a query. */
export function sharedThreadKey(key: SQL, viewerId?: string): SQL {
  return sql`(${key} IS NULL OR (${key} NOT LIKE 'app-assistant:%' AND (${key} NOT LIKE 'workflow:%'
    OR ${viewerId === undefined ? sql`false` : sql`split_part(${key}, ':', 3) IN ('', ${viewerId})`})))`;
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
      AND ${sharedThreadKey(sql`et.key`, viewerId)}
      -- The editor of a deleted workflow has nothing left to answer.
      AND (et.key IS NULL OR et.key NOT LIKE 'workflow:%' OR w.id IS NOT NULL)
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
