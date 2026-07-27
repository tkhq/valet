import type { D1Database } from '@cloudflare/workers-types';
import { WORKFLOW_TERMINAL_WHERE, quantileVia } from './analytics-predicates.js';

// Windowed queries for the admin "Adoption" tab: who is using Valet, how
// embedded recurring automation is, and how autonomously workflows run.
// Read-only aggregation over tables that are already written today — no new
// instrumentation feeds these.
//
// Timestamp handling follows value-metrics.ts: workflow_executions,
// action_invocations, and triggers mix SQLite `datetime('now')` strings with
// Drizzle-written ISO strings, so window comparisons normalise through
// `datetime()`. analytics_events is written exclusively as ISO by the DO
// flush, so its window compares the raw indexed column.

// ─── Active users ───────────────────────────────────────────────────────────

export interface ActiveUsersByBucket {
  bucket: string;
  users: number;
}

/** Distinct analytics_events.user_id per UTC day inside [start, end). */
export async function getActiveUsersByDay(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ActiveUsersByBucket[]> {
  const result = await db
    .prepare(`
      SELECT date(created_at) AS bucket, COUNT(DISTINCT user_id) AS users
      FROM analytics_events
      WHERE user_id IS NOT NULL
        AND created_at >= ? AND created_at < ?
      GROUP BY bucket
      ORDER BY bucket
    `)
    .bind(startIso, endIso)
    .all<{ bucket: string; users: number }>();

  return (result.results ?? []).map((r) => ({ bucket: r.bucket, users: r.users }));
}

/** Distinct analytics_events.user_id per ISO-ish week (%Y-W%W, Monday-first). */
export async function getActiveUsersByWeek(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ActiveUsersByBucket[]> {
  const result = await db
    .prepare(`
      SELECT strftime('%Y-W%W', created_at) AS bucket, COUNT(DISTINCT user_id) AS users
      FROM analytics_events
      WHERE user_id IS NOT NULL
        AND created_at >= ? AND created_at < ?
      GROUP BY bucket
      ORDER BY bucket
    `)
    .bind(startIso, endIso)
    .all<{ bucket: string; users: number }>();

  return (result.results ?? []).map((r) => ({ bucket: r.bucket, users: r.users }));
}

export interface ReturningUserStats {
  /** Distinct users with any attributed event in the window. */
  activeUsers: number;
  /** Users active in MORE than one distinct week of the window (retention proxy). */
  returningUsers: number;
}

export async function getReturningUserStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ReturningUserStats> {
  const row = await db
    .prepare(`
      SELECT
        COUNT(*) AS active_users,
        COALESCE(SUM(CASE WHEN weeks > 1 THEN 1 ELSE 0 END), 0) AS returning_users
      FROM (
        SELECT user_id, COUNT(DISTINCT strftime('%Y-W%W', created_at)) AS weeks
        FROM analytics_events
        WHERE user_id IS NOT NULL
          AND created_at >= ? AND created_at < ?
        GROUP BY user_id
      )
    `)
    .bind(startIso, endIso)
    .first<{ active_users: number; returning_users: number }>();

  return {
    activeUsers: row?.active_users ?? 0,
    returningUsers: row?.returning_users ?? 0,
  };
}

/** All registered users, regardless of activity — the "All members" baseline. */
export async function getTotalUserCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM users`)
    .bind()
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// ─── Recurring-automation embeddedness ──────────────────────────────────────

export interface EnabledTriggerRow {
  type: string;
  count: number;
}

/**
 * Currently-ENABLED triggers by type. Deliberately not windowed: a live
 * schedule/webhook is present-state embeddedness, not window activity.
 */
export async function getEnabledTriggerCounts(db: D1Database): Promise<EnabledTriggerRow[]> {
  const result = await db
    .prepare(`
      SELECT type, COUNT(*) AS count
      FROM triggers
      WHERE enabled = 1
      GROUP BY type
      ORDER BY count DESC
    `)
    .bind()
    .all<{ type: string; count: number }>();

  return (result.results ?? []).map((r) => ({ type: r.type, count: r.count }));
}

export interface WorkflowRunsByDay {
  day: string;
  runs: number;
}

/** Production workflow runs started per UTC day (cadence, all statuses). */
export async function getWorkflowRunsByDay(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<WorkflowRunsByDay[]> {
  const result = await db
    .prepare(`
      SELECT date(started_at) AS day, COUNT(*) AS runs
      FROM workflow_executions
      WHERE mode = 'production'
        AND datetime(started_at) >= datetime(?) AND datetime(started_at) < datetime(?)
      GROUP BY day
      ORDER BY day
    `)
    .bind(startIso, endIso)
    .all<{ day: string; runs: number }>();

  return (result.results ?? []).map((r) => ({ day: r.day, runs: r.runs }));
}

// ─── Surface breadth ────────────────────────────────────────────────────────

export interface ChannelBreadthRow {
  channel: string;
  turns: number;
}

/** Channels exercised in the window, from turn_complete events. */
export async function getChannelBreadth(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ChannelBreadthRow[]> {
  const result = await db
    .prepare(`
      SELECT channel, COUNT(*) AS turns
      FROM analytics_events
      WHERE event_type = 'turn_complete'
        AND channel IS NOT NULL
        AND created_at >= ? AND created_at < ?
      GROUP BY channel
      ORDER BY turns DESC
    `)
    .bind(startIso, endIso)
    .all<{ channel: string; turns: number }>();

  return (result.results ?? []).map((r) => ({ channel: r.channel, turns: r.turns }));
}

export interface ServiceBreadthRow {
  service: string;
  invocations: number;
}

/**
 * Integration services exercised in the window. action_invocations.service
 * is NOT NULL at the write site (every gated tool action inserts a row, and
 * policy auto-allows insert directly as executed), which makes it the
 * populated service column — tool_exec events carry only tool_name.
 * Invocations from mode='test' workflow runs are excluded like every other
 * workflow metric.
 */
export async function getServiceBreadth(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ServiceBreadthRow[]> {
  const result = await db
    .prepare(`
      SELECT ai.service AS service, COUNT(*) AS invocations
      FROM action_invocations ai
      LEFT JOIN workflow_executions we ON ai.workflow_execution_id = we.id
      WHERE (we.id IS NULL OR we.mode != 'test')
        AND datetime(ai.created_at) >= datetime(?) AND datetime(ai.created_at) < datetime(?)
      GROUP BY ai.service
      ORDER BY invocations DESC
    `)
    .bind(startIso, endIso)
    .all<{ service: string; invocations: number }>();

  return (result.results ?? []).map((r) => ({ service: r.service, invocations: r.invocations }));
}

export interface ChannelStickinessRow {
  channel: string;
  /** Distinct users active on this channel on the latest UTC day present in the window. */
  dau: number;
  /** Distinct users active on this channel anywhere in the window. */
  mau: number;
}

/**
 * DAU/MAU per channel — the "product stickiness" proxy. MAU is distinct
 * users per channel across the whole window; DAU is distinct users per
 * channel on the latest UTC day that actually has turn_complete activity in
 * the window (not necessarily "today" — the window may not reach the
 * present). A channel with MAU but zero activity on that specific day still
 * appears, with dau: 0.
 */
export async function getChannelStickiness(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ChannelStickinessRow[]> {
  const mauResult = await db
    .prepare(`
      SELECT channel, COUNT(DISTINCT user_id) AS mau
      FROM analytics_events
      WHERE event_type = 'turn_complete' AND channel IS NOT NULL AND user_id IS NOT NULL
        AND created_at >= ? AND created_at < ?
      GROUP BY channel
      ORDER BY mau DESC
    `)
    .bind(startIso, endIso)
    .all<{ channel: string; mau: number }>();

  const mauRows = mauResult.results ?? [];
  if (mauRows.length === 0) return [];

  const latestDayRow = await db
    .prepare(`
      SELECT MAX(date(created_at)) AS latest_day
      FROM analytics_events
      WHERE event_type = 'turn_complete' AND channel IS NOT NULL
        AND created_at >= ? AND created_at < ?
    `)
    .bind(startIso, endIso)
    .first<{ latest_day: string | null }>();
  const latestDay = latestDayRow?.latest_day ?? null;

  const dauMap = new Map<string, number>();
  if (latestDay !== null) {
    const dauResult = await db
      .prepare(`
        SELECT channel, COUNT(DISTINCT user_id) AS dau
        FROM analytics_events
        WHERE event_type = 'turn_complete' AND channel IS NOT NULL AND user_id IS NOT NULL
          AND date(created_at) = ?
        GROUP BY channel
      `)
      .bind(latestDay)
      .all<{ channel: string; dau: number }>();
    for (const row of dauResult.results ?? []) {
      dauMap.set(row.channel, row.dau);
    }
  }

  return mauRows.map((row) => ({
    channel: row.channel,
    dau: dauMap.get(row.channel) ?? 0,
    mau: row.mau,
  }));
}

// ─── Workflow autonomy ──────────────────────────────────────────────────────

// A human decision is resolved_by IS NOT NULL — never a status value.
// status='executed' includes policy auto-allows (inserted with no resolver)
// and cancel-cleanup flips pending gates to 'failed' without a resolver, so
// status cannot distinguish attended from unattended runs.
//
// Joined (not a correlated EXISTS) so the human-decision check is evaluated
// once per run rather than once per CASE branch that references it.
const HUMAN_DECISION_JOIN = `LEFT JOIN (
  SELECT workflow_execution_id, 1 AS human
  FROM action_invocations
  WHERE resolved_by IS NOT NULL
  GROUP BY workflow_execution_id
) hd ON hd.workflow_execution_id = we.id`;

export interface WorkflowAutonomyStats {
  /** Production runs that reached completed/failed/cancelled in the window. */
  terminalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  /** Completed with ZERO human decision on any of the run's invocations. */
  unattendedCompletedRuns: number;
  /** Runs where at least one invocation carries resolved_by (a human decided). */
  attendedRuns: number;
  /** Median minutes an attended run's invocations sat waiting on the human. */
  medianBlockedMinutes: number | null;
}

export async function getWorkflowAutonomyStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<WorkflowAutonomyStats> {
  const row = await db
    .prepare(`
      SELECT
        COUNT(*) AS terminal,
        COALESCE(SUM(CASE WHEN we.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN we.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN we.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled,
        COALESCE(SUM(CASE WHEN we.status = 'completed' AND hd.human IS NULL THEN 1 ELSE 0 END), 0) AS unattended_completed,
        COALESCE(SUM(CASE WHEN hd.human IS NOT NULL THEN 1 ELSE 0 END), 0) AS attended
      FROM workflow_executions we
      ${HUMAN_DECISION_JOIN}
      WHERE ${WORKFLOW_TERMINAL_WHERE}
    `)
    .bind(startIso, endIso)
    .first<{ terminal: number; completed: number; failed: number; cancelled: number; unattended_completed: number; attended: number }>();

  // Time blocked on the human: created_at → resolved_at of every
  // human-resolved invocation attached to a windowed terminal run.
  const medianBlockedMinutes = await quantileVia(
    db,
    `SELECT COUNT(*) AS cnt
     FROM action_invocations ai
     JOIN workflow_executions we ON ai.workflow_execution_id = we.id
     WHERE ${WORKFLOW_TERMINAL_WHERE}
       AND ai.resolved_by IS NOT NULL AND ai.resolved_at IS NOT NULL`,
    `SELECT (julianday(ai.resolved_at) - julianday(ai.created_at)) * 1440.0 AS v
     FROM action_invocations ai
     JOIN workflow_executions we ON ai.workflow_execution_id = we.id
     WHERE ${WORKFLOW_TERMINAL_WHERE}
       AND ai.resolved_by IS NOT NULL AND ai.resolved_at IS NOT NULL
     ORDER BY v ASC LIMIT 1 OFFSET ?`,
    [startIso, endIso],
    0.5,
  );

  return {
    terminalRuns: row?.terminal ?? 0,
    completedRuns: row?.completed ?? 0,
    failedRuns: row?.failed ?? 0,
    cancelledRuns: row?.cancelled ?? 0,
    unattendedCompletedRuns: row?.unattended_completed ?? 0,
    attendedRuns: row?.attended ?? 0,
    medianBlockedMinutes,
  };
}

// ─── Workflow outcomes ──────────────────────────────────────────────────────

export interface WorkflowOutcomeRow {
  workflowId: string | null;
  name: string;
  completed: number;
  failed: number;
  cancelled: number;
}

export async function getWorkflowOutcomesByWorkflow(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<WorkflowOutcomeRow[]> {
  const result = await db
    .prepare(`
      SELECT
        we.workflow_id AS workflow_id,
        COALESCE(w.name, 'Deleted workflow') AS name,
        COALESCE(SUM(CASE WHEN we.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN we.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN we.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM workflow_executions we
      LEFT JOIN workflows w ON w.id = we.workflow_id
      WHERE ${WORKFLOW_TERMINAL_WHERE}
      GROUP BY we.workflow_id, COALESCE(w.name, 'Deleted workflow')
      ORDER BY (completed + failed + cancelled) DESC
    `)
    .bind(startIso, endIso)
    .all<{ workflow_id: string | null; name: string; completed: number; failed: number; cancelled: number }>();

  return (result.results ?? []).map((r) => ({
    workflowId: r.workflow_id,
    name: r.name,
    completed: r.completed,
    failed: r.failed,
    cancelled: r.cancelled,
  }));
}

export interface TriggerTypeOutcomeRow {
  triggerType: string;
  completed: number;
  failed: number;
  cancelled: number;
}

export async function getWorkflowOutcomesByTriggerType(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<TriggerTypeOutcomeRow[]> {
  const result = await db
    .prepare(`
      SELECT
        we.trigger_type AS trigger_type,
        COALESCE(SUM(CASE WHEN we.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
        COALESCE(SUM(CASE WHEN we.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN we.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM workflow_executions we
      WHERE ${WORKFLOW_TERMINAL_WHERE}
      GROUP BY we.trigger_type
      ORDER BY (completed + failed + cancelled) DESC
    `)
    .bind(startIso, endIso)
    .all<{ trigger_type: string; completed: number; failed: number; cancelled: number }>();

  return (result.results ?? []).map((r) => ({
    triggerType: r.trigger_type,
    completed: r.completed,
    failed: r.failed,
    cancelled: r.cancelled,
  }));
}

export interface FailureReasonRow {
  reason: string;
  runs: number;
}

/** Coarse keyword buckets over workflow_executions.error for failed runs. */
export async function getWorkflowFailureReasons(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<FailureReasonRow[]> {
  const result = await db
    .prepare(`
      SELECT
        CASE
          WHEN we.error IS NULL OR we.error = '' THEN 'unspecified'
          WHEN lower(we.error) LIKE '%timeout%' OR lower(we.error) LIKE '%timed out%' THEN 'timeout'
          WHEN lower(we.error) LIKE '%approval%' OR lower(we.error) LIKE '%denied%' THEN 'approval'
          WHEN lower(we.error) LIKE '%rate limit%' OR lower(we.error) LIKE '%429%' THEN 'rate-limit'
          WHEN lower(we.error) LIKE '%network%' OR lower(we.error) LIKE '%fetch failed%' OR lower(we.error) LIKE '%econn%' THEN 'network'
          WHEN lower(we.error) LIKE '%cancel%' THEN 'cancelled'
          ELSE 'other'
        END AS reason,
        COUNT(*) AS runs
      FROM workflow_executions we
      WHERE ${WORKFLOW_TERMINAL_WHERE}
        AND we.status = 'failed'
      GROUP BY reason
      ORDER BY runs DESC
    `)
    .bind(startIso, endIso)
    .all<{ reason: string; runs: number }>();

  return (result.results ?? []).map((r) => ({ reason: r.reason, runs: r.runs }));
}

// ─── Absolute cycle time ────────────────────────────────────────────────────

export interface WorkflowDurationStats {
  /** ABSOLUTE run duration — no baseline exists, so never a "reduction". */
  medianRunMinutes: number | null;
  p95RunMinutes: number | null;
  measuredRuns: number;
}

export async function getWorkflowDurationStats(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<WorkflowDurationStats> {
  const countSql = `
    SELECT COUNT(*) AS cnt FROM workflow_executions we
    WHERE ${WORKFLOW_TERMINAL_WHERE}
      AND COALESCE(we.completed_at, we.cancelled_at) IS NOT NULL`;
  const valueSql = `
    SELECT (julianday(COALESCE(we.completed_at, we.cancelled_at)) - julianday(we.started_at)) * 1440.0 AS v
    FROM workflow_executions we
    WHERE ${WORKFLOW_TERMINAL_WHERE}
      AND COALESCE(we.completed_at, we.cancelled_at) IS NOT NULL
    ORDER BY v ASC LIMIT 1 OFFSET ?`;

  const countRow = await db.prepare(countSql).bind(startIso, endIso).first<{ cnt: number }>();
  const measuredRuns = countRow?.cnt ?? 0;
  const [medianRunMinutes, p95RunMinutes] = await Promise.all([
    quantileVia(db, countSql, valueSql, [startIso, endIso], 0.5),
    quantileVia(db, countSql, valueSql, [startIso, endIso], 0.95),
  ]);

  return { medianRunMinutes, p95RunMinutes, measuredRuns };
}
