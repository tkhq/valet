import type { Principal } from "@valet/engine";
import { sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { encodePageCursor } from "../lib/page-cursor.js";
import { sharedBriefingRun } from "./workspace-briefing-visibility.js";
import { governingThreadKeySql } from "./thread-access.js";
import type { WorkspaceOutcome, WorkspaceOutcomesResponse } from "../wire/types.js";

export interface OutcomeCursor { at: number; id: string; }
interface OutcomeRow {
  id: string;
  kind: WorkspaceOutcome["kind"];
  occurred_at: string | number;
  session_id: string | null;
  thread_id: string | null;
  workflow_run_id: string | null;
  title: string | null;
  url: string | null;
}

/** Only source links are exposed. Credentials and non-web schemes are rejected. */
export function safeOutcomeUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** `shared`, when given, keeps only outcomes from threads it accepts, by thread key. */
export async function listWorkspaceOutcomes(
  db: AppDb, orgId: string, owner: Principal, limit: number, cursor?: OutcomeCursor,
  shared?: (threadKey: SQL) => SQL,
): Promise<WorkspaceOutcomesResponse> {
  // A run carries its org, so its outcomes outlive the workflow's deletion.
  const owned = sql`(s.id IS NULL OR s.status<>'deleted') AND COALESCE(s.org_id,r.org_id) = ${orgId}
    AND COALESCE(s.owner_type,r.owner_type) = ${owner.type}
    AND COALESCE(NULLIF(s.owner_id,''), CASE WHEN s.owner_type='user' THEN s.user_id END,r.owner_id) = ${owner.id}`;
  const conditions = [
    ...(cursor ? [sql`(occurred_at,id) < (${cursor.at},${cursor.id})`] : []),
    // A write from a session with no recorded thread cannot be judged, so a
    // shared view leaves it out.
    ...(shared ? [sql`(outcomes.session_id IS NULL OR (outcomes.thread_id IS NOT NULL
      AND ${shared(governingThreadKeySql(sql`outcomes.session_id`, sql`outcomes.thread_id`, "parent link"))}))`] : []),
  ];
  const sharedRun = shared && owner.type === "team"
    ? sql`(r.id IS NULL OR ${sharedBriefingRun(orgId, owner.id, sql`r.params`)})` : sql`true`;
  const after = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
  // Compact usage facts identify confirmed writes before touching source results.
  // Terminal parts are read only for entries that already have outcome markers.
  const result = await db.execute(sql`WITH outcomes AS (
    SELECT 'action:' || a.invocation_id AS id,
      CASE f.outcome_kind WHEN 'pull_request_created' THEN 'pull_request'
        WHEN 'review_submitted' THEN 'review' ELSE 'message' END AS kind,
      -- The thread the write came from: the channel record's, the action's own,
      -- or, for a workflow run, the thread that started it. Thread access
      -- needs it, so a private thread's work stays out of shared feeds.
      f.created_at AS occurred_at,COALESCE(s.id,r.params->'origin'->>'assistantSessionId') AS session_id,
      -- A workflow session's own thread is not the runtime's, so a run's write
      -- takes the thread that started the run.
      CASE WHEN s.id IS NOT NULL THEN COALESCE(cm.thread_id,a.thread_id) ELSE r.params->'origin'->>'threadId' END AS thread_id,
      r.id AS workflow_run_id,
      CASE WHEN f.outcome_kind='pull_request_created' THEN a.result->'data'->>'title'
        WHEN f.outcome_kind='slack_dm_sent' THEN 'Direct message sent'
        WHEN f.outcome_kind='slack_message_sent' THEN st.title END AS title,
      COALESCE(a.result->'data'->>'html_url',a.result->'data'->>'permalink',cm.url,a.result->'data'->>'url',a.result->>'url') AS url
    FROM usage_action_facts f JOIN action_invocations a ON a.invocation_id=f.invocation_id
    -- A Slack send's channel record names its thread and the message's link. The
    -- row is titled by that thread, never by the message: every workspace member
    -- sees this feed, and the message may sit in a private channel.
    LEFT JOIN channel_messages cm ON f.outcome_kind='slack_message_sent' AND cm.session_id=f.session_id
      AND cm.direction='out' AND cm.provider_message_id=a.result->'data'->>'ts'
      -- A Slack message is its channel and its ts; two channels can share a ts.
      AND cm.channel_key='slack:' || (a.result->'data'->>'channel')
    LEFT JOIN session_threads st ON st.session_id=cm.session_id AND st.id=cm.thread_id
    LEFT JOIN agent_sessions s ON s.id=f.session_id
    LEFT JOIN workflow_runs r ON r.id=COALESCE(f.workflow_execution_id,
      CASE WHEN f.session_id LIKE 'wf:%' THEN split_part(f.session_id,':',2) END)
    WHERE f.org_id=${orgId}
      AND f.outcome_kind IN ('pull_request_created','review_submitted','slack_message_sent','slack_dm_sent') AND ${owned} AND ${sharedRun}
    UNION ALL
    SELECT 'terminal:' || e.id || ':' || p.ordinality::text,
      CASE p.part->'result'->'details'->'outcome'->>'kind'
        WHEN 'pull_request_created' THEN 'pull_request' ELSE 'review' END,
      f.created_at,COALESCE(s.id,r.params->'origin'->>'assistantSessionId'),
      CASE WHEN s.id IS NOT NULL THEN e.thread_id ELSE r.params->'origin'->>'threadId' END,r.id,NULL::text,
      p.part->'result'->'details'->'outcome'->>'url'
    FROM usage_entry_facts f
    JOIN engine_entries e ON e.id=f.entry_id
    -- The session that ran the turn, not the billing key: a Thread step's
    -- turn bills to its step but ran in a workspace session and thread.
    LEFT JOIN agent_sessions s ON s.id=e.session_id
    LEFT JOIN workflow_runs r ON r.id=f.workflow_run_id
    CROSS JOIN LATERAL jsonb_array_elements(replace(e.parts,chr(92)||'u0000',chr(92)||'uFFFD')::jsonb)
      WITH ORDINALITY AS p(part,ordinality)
    WHERE (f.pull_requests>0 OR f.reviews>0) AND ${owned} AND ${sharedRun}
      AND p.part->>'type'='tool_call' AND p.part->>'toolName'='bash' AND p.part->>'status'='completed'
      AND p.part->'result'->'details'->'outcome'->>'kind' IN ('pull_request_created','review_submitted')
  ) SELECT * FROM outcomes ${after} ORDER BY occurred_at DESC,id DESC LIMIT ${limit + 1}`) as { rows: OutcomeRow[] };
  const page = result.rows.slice(0, limit);
  const items = page.map((row): WorkspaceOutcome => {
    const url = safeOutcomeUrl(row.url);
    return {
      id: row.id, kind: row.kind, occurredAt: Number(row.occurred_at),
      title: row.title?.trim().slice(0, 300) || ({ pull_request: "Pull request opened", review: "Review submitted", message: "Slack message sent" }[row.kind]),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(row.workflow_run_id ? { workflowRunId: row.workflow_run_id } : {}),
      ...(url ? { url } : {}),
    };
  });
  const last = items.at(-1);
  return { items, nextCursor: result.rows.length > limit && last
    ? encodePageCursor({ feed: "outcomes", orgId, ownerType: owner.type, ownerId: owner.id, at: last.occurredAt, id: last.id }) : null };
}
