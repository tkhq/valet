import type { D1Database } from '@cloudflare/workers-types';
import { SQL_BILLABLE_INPUT_EXPR, SQL_BILLABLE_OUTPUT_EXPR } from './analytics.js';

// Windowed queries for the admin "Value metrics" panel. Every function takes
// an [startIso, endIso) window so the route can compute the prior window for
// delta badges.
//
// Timestamp columns in these tables hold a mix of SQLite `datetime('now')`
// ("YYYY-MM-DD HH:MM:SS") and Drizzle-written ISO-8601 strings, which do not
// compare lexicographically across formats on the boundary date. Queries here
// normalise the column through `datetime()` (analytics_events is the
// exception: it is written exclusively as ISO by the DO flush, and its
// indexes cover the raw column).

async function medianVia(
  db: D1Database,
  countSql: string,
  valueSql: string,
  binds: (string | number)[],
): Promise<number | null> {
  const countRow = await db.prepare(countSql).bind(...binds).first<{ cnt: number }>();
  const count = countRow?.cnt ?? 0;
  if (count === 0) return null;
  const offset = Math.floor((count - 1) * 0.5);
  const row = await db.prepare(valueSql).bind(...binds, offset).first<{ v: number }>();
  return row?.v ?? null;
}

// ─── Workflow runs ──────────────────────────────────────────────────────────

export interface WorkflowResolutionStats {
  completed: number;
  failed: number;
  /** Runs that reached a terminal state in the window (completed/failed/cancelled). */
  terminal: number;
  medianCompletedMinutes: number | null;
}

const WORKFLOW_WINDOW_WHERE = `
  mode = 'production'
  AND status IN ('completed', 'failed', 'cancelled')
  AND datetime(started_at) >= datetime(?) AND datetime(started_at) < datetime(?)`;

export async function getWorkflowResolutionStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<WorkflowResolutionStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COUNT(*) AS terminal
      FROM workflow_executions
      WHERE ${WORKFLOW_WINDOW_WHERE}
    `)
    .bind(startIso, endIso)
    .first<{ completed: number; failed: number; terminal: number }>();

  const medianCompletedMinutes = await medianVia(
    db,
    `SELECT COUNT(*) AS cnt FROM workflow_executions
     WHERE ${WORKFLOW_WINDOW_WHERE} AND status = 'completed' AND completed_at IS NOT NULL`,
    `SELECT (julianday(completed_at) - julianday(started_at)) * 1440.0 AS v
     FROM workflow_executions
     WHERE ${WORKFLOW_WINDOW_WHERE} AND status = 'completed' AND completed_at IS NOT NULL
     ORDER BY v ASC LIMIT 1 OFFSET ?`,
    [startIso, endIso],
  );

  return {
    completed: row?.completed ?? 0,
    failed: row?.failed ?? 0,
    terminal: row?.terminal ?? 0,
    medianCompletedMinutes,
  };
}

// ─── Session resolution ─────────────────────────────────────────────────────

export interface SessionResolutionStats {
  /** Ended without error: status archived/terminated and no error_message. */
  resolved: number;
  errored: number;
  /** All interactive non-orchestrator sessions that ended in the window. */
  ended: number;
  /** Deduped: ended sessions that errored OR escalated to a human at least once. */
  reworkSessions: number;
  medianResolvedMinutes: number | null;
}

// "Ended" is proxied by last_active_at for sessions in a terminal status —
// sessions carry no explicit closed_at. Orchestrators are long-lived
// coordinators, and purpose='workflow' sessions are already counted through
// workflow_executions, so both are excluded to avoid double counting.
const SESSION_WINDOW_WHERE = `
  is_orchestrator = 0
  AND purpose = 'interactive'
  AND status IN ('archived', 'terminated', 'error')
  AND datetime(last_active_at) >= datetime(?) AND datetime(last_active_at) < datetime(?)`;

const SESSION_RESOLVED_COND = `status IN ('archived', 'terminated') AND error_message IS NULL`;

export async function getSessionResolutionStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<SessionResolutionStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ${SESSION_RESOLVED_COND} THEN 1 ELSE 0 END), 0) AS resolved,
        COALESCE(SUM(CASE WHEN status = 'error' OR error_message IS NOT NULL THEN 1 ELSE 0 END), 0) AS errored,
        COUNT(*) AS ended,
        COALESCE(SUM(CASE WHEN status = 'error' OR error_message IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM mailbox_messages m
            WHERE m.from_session_id = sessions.id AND m.message_type = 'escalation'
          ) THEN 1 ELSE 0 END), 0) AS rework
      FROM sessions
      WHERE ${SESSION_WINDOW_WHERE}
    `)
    .bind(startIso, endIso)
    .first<{ resolved: number; errored: number; ended: number; rework: number }>();

  const medianResolvedMinutes = await medianVia(
    db,
    `SELECT COUNT(*) AS cnt FROM sessions
     WHERE ${SESSION_WINDOW_WHERE} AND ${SESSION_RESOLVED_COND}`,
    `SELECT (julianday(last_active_at) - julianday(created_at)) * 1440.0 AS v
     FROM sessions
     WHERE ${SESSION_WINDOW_WHERE} AND ${SESSION_RESOLVED_COND}
     ORDER BY v ASC LIMIT 1 OFFSET ?`,
    [startIso, endIso],
  );

  return {
    resolved: row?.resolved ?? 0,
    errored: row?.errored ?? 0,
    ended: row?.ended ?? 0,
    reworkSessions: row?.rework ?? 0,
    medianResolvedMinutes,
  };
}

// ─── Escalations ────────────────────────────────────────────────────────────

export interface EscalationStats {
  escalationMessages: number;
  escalatedSessions: number;
}

export async function getEscalationStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<EscalationStats> {
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT from_session_id) AS sessions
      FROM mailbox_messages
      WHERE message_type = 'escalation'
        AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
    `)
    .bind(startIso, endIso)
    .first<{ total: number; sessions: number }>();

  return {
    escalationMessages: row?.total ?? 0,
    escalatedSessions: row?.sessions ?? 0,
  };
}

// ─── Approval decisions (accepted-output proxy) ─────────────────────────────

export interface ApprovalDecisionStats {
  /** User said yes: invocation approved/executed/failed-after-approval. */
  accepted: number;
  denied: number;
  expired: number;
}

// Since migration 0022 (unified action policies), action_invocations carries
// BOTH tool-action approvals and explicit workflow gates (migrated in as
// action_id='request_approval' rows), so one table covers every explicit
// accept/deny decision.
export async function getApprovalDecisionStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ApprovalDecisionStats> {
  // 'executed' and 'failed' both pass through an approval, so they count as
  // accepted — the user's decision is the signal, not whether the action
  // later succeeded.
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status IN ('approved', 'executed', 'failed') THEN 1 ELSE 0 END), 0) AS accepted,
        COALESCE(SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END), 0) AS denied,
        COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired
      FROM action_invocations
      WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
    `)
    .bind(startIso, endIso)
    .first<{ accepted: number; denied: number; expired: number }>();

  return {
    accepted: row?.accepted ?? 0,
    denied: row?.denied ?? 0,
    expired: row?.expired ?? 0,
  };
}

// ─── Agent-authored PR outcomes (review-burden proxy) ───────────────────────

export interface AgentPrStats {
  opened: number;
  merged: number;
  closedUnmerged: number;
  stillOpen: number;
  medianHoursToMerge: number | null;
}

const PR_WINDOW_WHERE = `
  agent_authored = 1
  AND pr_number IS NOT NULL
  AND pr_created_at IS NOT NULL
  AND datetime(pr_created_at) >= datetime(?) AND datetime(pr_created_at) < datetime(?)`;

export async function getAgentPrStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<AgentPrStats> {
  const row = await db
    .prepare(`
      SELECT
        COUNT(*) AS opened,
        COALESCE(SUM(CASE WHEN pr_state = 'merged' THEN 1 ELSE 0 END), 0) AS merged,
        COALESCE(SUM(CASE WHEN pr_state = 'closed' THEN 1 ELSE 0 END), 0) AS closed_unmerged,
        COALESCE(SUM(CASE WHEN pr_state IN ('open', 'draft') THEN 1 ELSE 0 END), 0) AS still_open
      FROM session_git_state
      WHERE ${PR_WINDOW_WHERE}
    `)
    .bind(startIso, endIso)
    .first<{ opened: number; merged: number; closed_unmerged: number; still_open: number }>();

  const medianHoursToMerge = await medianVia(
    db,
    `SELECT COUNT(*) AS cnt FROM session_git_state
     WHERE ${PR_WINDOW_WHERE} AND pr_state = 'merged' AND pr_merged_at IS NOT NULL`,
    `SELECT (julianday(pr_merged_at) - julianday(pr_created_at)) * 24.0 AS v
     FROM session_git_state
     WHERE ${PR_WINDOW_WHERE} AND pr_state = 'merged' AND pr_merged_at IS NOT NULL
     ORDER BY v ASC LIMIT 1 OFFSET ?`,
    [startIso, endIso],
  );

  return {
    opened: row?.opened ?? 0,
    merged: row?.merged ?? 0,
    closedUnmerged: row?.closed_unmerged ?? 0,
    stillOpen: row?.still_open ?? 0,
    medianHoursToMerge,
  };
}

// ─── Model usage (routing efficiency + LLM cost) ────────────────────────────

export interface ModelUsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getModelUsageRows(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ModelUsageRow[]> {
  const result = await db
    .prepare(`
      SELECT
        model,
        SUM(${SQL_BILLABLE_INPUT_EXPR}) AS input_tokens,
        SUM(${SQL_BILLABLE_OUTPUT_EXPR}) AS output_tokens
      FROM analytics_events
      WHERE model IS NOT NULL
        AND created_at >= ? AND created_at < ?
      GROUP BY model
      HAVING input_tokens + output_tokens > 0
    `)
    .bind(startIso, endIso)
    .all<{ model: string; input_tokens: number; output_tokens: number }>();

  return (result.results ?? []).map((r) => ({
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
  }));
}

export interface SessionModelPair {
  sessionId: string;
  model: string;
}

export async function getSessionModelPairs(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<SessionModelPair[]> {
  const result = await db
    .prepare(`
      SELECT DISTINCT session_id, model
      FROM analytics_events
      WHERE model IS NOT NULL
        AND created_at >= ? AND created_at < ?
        AND ${SQL_BILLABLE_INPUT_EXPR} + ${SQL_BILLABLE_OUTPUT_EXPR} > 0
    `)
    .bind(startIso, endIso)
    .all<{ session_id: string; model: string }>();

  return (result.results ?? []).map((r) => ({ sessionId: r.session_id, model: r.model }));
}

// ─── Sandbox seconds (for total cost) ───────────────────────────────────────

// Same attribution convention as getSandboxHeroStats: a session's cumulative
// active_seconds are attributed to its creation window.
export async function getSandboxSecondsInWindow(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<number> {
  const row = await db
    .prepare(`
      SELECT COALESCE(SUM(active_seconds), 0) AS s
      FROM sessions
      WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
    `)
    .bind(startIso, endIso)
    .first<{ s: number }>();

  return row?.s ?? 0;
}
