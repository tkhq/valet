import type { D1Database } from '@cloudflare/workers-types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AnalyticsEventRow = {
  id: string;
  event_type: string;
  session_id: string;
  user_id: string | null;
  turn_id: string | null;
  duration_ms: number | null;
  created_at: string;
  channel: string | null;
  model: string | null;
  queue_mode: string | null;
  // Raw five-way token breakdown from OpenCode. See SQL_BILLABLE_INPUT_EXPR /
  // SQL_BILLABLE_OUTPUT_EXPR below for the canonical billable totals.
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  tool_name: string | null;
  error_code: string | null;
  summary: string | null;
  actor_id: string | null;
  properties: string | null;
};

// Canonical SQL expressions for "billable input" and "billable output"
// TOKEN VOLUME composed from the raw OpenCode token breakdown (cache reads +
// writes count as input, reasoning as output). These are for token-count
// display and ordering ONLY — never feed them into cost math: each tier is
// billed at a different rate (cache reads ~0.1x input), so cost consumers
// must aggregate the raw five-way breakdown and use computeCost.
export const SQL_BILLABLE_INPUT_EXPR =
  '(COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0))';
export const SQL_BILLABLE_OUTPUT_EXPR =
  '(COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0))';
// Same expressions but qualified with the `ae` alias for the existing
// JOIN-against-sessions queries below.
const AE_BILLABLE_INPUT_EXPR =
  '(COALESCE(ae.input_tokens, 0) + COALESCE(ae.cache_read_tokens, 0) + COALESCE(ae.cache_write_tokens, 0))';
const AE_BILLABLE_OUTPUT_EXPR =
  '(COALESCE(ae.output_tokens, 0) + COALESCE(ae.reasoning_tokens, 0))';

// Raw five-way token SELECT columns, `ae`-qualified and bare. Cost-bearing
// queries select these so routes can price each tier at its own rate.
const AE_TOKEN_SUM_COLS = `
        SUM(COALESCE(ae.input_tokens, 0)) as input_tokens,
        SUM(COALESCE(ae.output_tokens, 0)) as output_tokens,
        SUM(COALESCE(ae.cache_read_tokens, 0)) as cache_read_tokens,
        SUM(COALESCE(ae.cache_write_tokens, 0)) as cache_write_tokens,
        SUM(COALESCE(ae.reasoning_tokens, 0)) as reasoning_tokens`;
const SQL_TOKEN_SUM_COLS = `
        SUM(COALESCE(input_tokens, 0)) as input_tokens,
        SUM(COALESCE(output_tokens, 0)) as output_tokens,
        SUM(COALESCE(cache_read_tokens, 0)) as cache_read_tokens,
        SUM(COALESCE(cache_write_tokens, 0)) as cache_write_tokens,
        SUM(COALESCE(reasoning_tokens, 0)) as reasoning_tokens`;

/**
 * Raw per-tier token sums for a group of llm_call rows. `inputTokens` is
 * UNCACHED input and `outputTokens` is visible output. Billable display
 * totals are composed via billableInputTokens / billableOutputTokens.
 */
export interface LlmTokenSums {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/** Input-side token volume as billed (uncached input + cache reads + cache writes). */
export function billableInputTokens(t: LlmTokenSums): number {
  return t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/** Output-side token volume as billed (visible output + reasoning). */
export function billableOutputTokens(t: LlmTokenSums): number {
  return t.outputTokens + t.reasoningTokens;
}

function mapTokenSums(r: Record<string, unknown>): LlmTokenSums {
  return {
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
  };
}

// ─── Batch Insert (DO flush → D1) ──────────────────────────────────────────

export async function batchInsertAnalyticsEvents(
  db: D1Database,
  sessionId: string,
  userId: string | null,
  entries: Array<{
    id: string;
    eventType: string;
    turnId?: string | null;
    durationMs?: number | null;
    createdAt: string;
    channel?: string | null;
    model?: string | null;
    queueMode?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    reasoningTokens?: number | null;
    toolName?: string | null;
    errorCode?: string | null;
    summary?: string | null;
    actorId?: string | null;
    properties?: string | null;
  }>,
): Promise<void> {
  if (entries.length === 0) return;

  const stmts = entries.map((entry) =>
    db.prepare(
      `INSERT OR IGNORE INTO analytics_events
        (id, event_type, session_id, user_id, turn_id, duration_ms, created_at, channel, model, queue_mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, tool_name, error_code, summary, actor_id, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      entry.id,
      entry.eventType,
      sessionId,
      userId,
      entry.turnId ?? null,
      entry.durationMs ?? null,
      entry.createdAt,
      entry.channel ?? null,
      entry.model ?? null,
      entry.queueMode ?? null,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
      entry.cacheReadTokens ?? null,
      entry.cacheWriteTokens ?? null,
      entry.reasoningTokens ?? null,
      entry.toolName ?? null,
      entry.errorCode ?? null,
      entry.summary ?? null,
      entry.actorId ?? null,
      entry.properties ?? null,
    )
  );

  await db.batch(stmts);
}

// ─── Billing / Usage Aggregate Queries ──────────────────────────────────────

export interface UsageHeroStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  totalUsers: number;
}

export async function getUsageHeroStats(
  db: D1Database,
  periodStart: string,
): Promise<UsageHeroStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(${AE_BILLABLE_INPUT_EXPR}), 0) as total_input_tokens,
        COALESCE(SUM(${AE_BILLABLE_OUTPUT_EXPR}), 0) as total_output_tokens,
        COUNT(DISTINCT ae.session_id) as total_sessions,
        COUNT(DISTINCT ae.user_id) as total_users
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
    `)
    .bind(periodStart)
    .first<{
      total_input_tokens: number;
      total_output_tokens: number;
      total_sessions: number;
      total_users: number;
    }>();

  return {
    totalInputTokens: row?.total_input_tokens ?? 0,
    totalOutputTokens: row?.total_output_tokens ?? 0,
    totalSessions: row?.total_sessions ?? 0,
    totalUsers: row?.total_users ?? 0,
  };
}

export interface UsageByDayRow extends LlmTokenSums {
  date: string;
  model: string;
}

export async function getUsageByDay(
  db: D1Database,
  periodStart: string,
): Promise<UsageByDayRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(ae.created_at) as date,
        ae.model,${AE_TOKEN_SUM_COLS}
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
      GROUP BY date(ae.created_at), ae.model
      ORDER BY date ASC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    model: String(r.model),
    ...mapTokenSums(r),
  }));
}

export interface UsageByUserRow {
  userId: string;
  email: string;
  name: string | null;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
}

export async function getUsageByUser(
  db: D1Database,
  periodStart: string,
): Promise<UsageByUserRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ae.user_id,
        u.email,
        u.name,
        SUM(${AE_BILLABLE_INPUT_EXPR}) as input_tokens,
        SUM(${AE_BILLABLE_OUTPUT_EXPR}) as output_tokens,
        COUNT(DISTINCT ae.session_id) as session_count
      FROM analytics_events ae
      LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        AND ae.user_id IS NOT NULL
      GROUP BY ae.user_id
      ORDER BY (SUM(${AE_BILLABLE_INPUT_EXPR}) + SUM(${AE_BILLABLE_OUTPUT_EXPR})) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    email: r.email ? String(r.email) : 'Unknown',
    name: r.name ? String(r.name) : null,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    sessionCount: Number(r.session_count),
  }));
}

export interface UsageByUserModelRow extends LlmTokenSums {
  userId: string;
  model: string;
  callCount: number;
}

export async function getUsageByUserModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByUserModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ae.user_id,
        ae.model,${AE_TOKEN_SUM_COLS},
        COUNT(*) as call_count
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        AND ae.user_id IS NOT NULL
      GROUP BY ae.user_id, ae.model
      ORDER BY (SUM(${AE_BILLABLE_INPUT_EXPR}) + SUM(${AE_BILLABLE_OUTPUT_EXPR})) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    model: String(r.model),
    callCount: Number(r.call_count),
    ...mapTokenSums(r),
  }));
}

export interface UsageByPurposeModelRow extends LlmTokenSums {
  purpose: string;
  model: string;
  callCount: number;
}

/**
 * Origin of a usage row: the session's purpose, unless the row is marked as
 * ephemeral-session usage, which gets its own synthetic origin.
 *
 * Must be repeated verbatim in GROUP BY rather than referenced by its alias —
 * `sessions` has a real `purpose` column, so a bare `GROUP BY purpose` binds to
 * that column instead of this expression and collapses the origins back together.
 */
const AE_ORIGIN_EXPR = `
  CASE json_extract(ae.properties, '$.usage_kind')
    WHEN 'memory_flush' THEN 'memory_flush'
    WHEN 'review' THEN 'review'
    ELSE COALESCE(s.purpose, 'interactive')
  END`;

/**
 * Usage grouped by session ORIGIN (sessions.purpose: 'interactive' | 'workflow' | 'orchestrator')
 * × model. Model is retained so the route can compute cost per-model first (pricing is per-model)
 * and then roll up to a per-origin total. LEFT JOIN + COALESCE keeps any row whose session row is
 * missing (defaults to 'interactive'). No user_id filter — this is the origin split of ALL usage,
 * matching the by-model/hero scope.
 *
 * Usage from ephemeral OpenCode sessions (memory-flush forks, review sessions) is billed to the
 * key but is not conversation work, so it gets its own synthetic origin from the row's usage_kind
 * marker rather than being folded into the parent session's purpose.
 */
export async function getUsageByPurposeModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByPurposeModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ${AE_ORIGIN_EXPR} as purpose,
        ae.model,${AE_TOKEN_SUM_COLS},
        COUNT(*) as call_count
      FROM analytics_events ae
      LEFT JOIN sessions s ON s.id = ae.session_id
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
      GROUP BY ${AE_ORIGIN_EXPR}, ae.model
      ORDER BY (SUM(${AE_BILLABLE_INPUT_EXPR}) + SUM(${AE_BILLABLE_OUTPUT_EXPR})) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    purpose: String(r.purpose),
    model: String(r.model),
    callCount: Number(r.call_count),
    ...mapTokenSums(r),
  }));
}

export interface UsageByWorkflowModelRow extends LlmTokenSums {
  workflowId: string | null;
  workflowName: string;
  triggerType: string;
  model: string;
  callCount: number;
}

/**
 * Usage for AUTOMATED (workflow) sessions attributed to the SPECIFIC workflow that produced it,
 * and how it fired. Joins analytics_events → sessions (by session_id) → workflow_executions
 * (by sessions.workflow_execution_id) → workflows (name) → triggers (type:
 * schedule/webhook/manual; NULL trigger = manual/on-demand). Model is kept for per-model cost,
 * rolled up per workflow in the route. INNER JOINs on sessions + workflow_executions scope this
 * to the automated subset — interactive/orchestrator rows simply don't appear. LEFT JOINs to
 * workflows/triggers keep usage for a deleted workflow/trigger visible as 'Unknown workflow'.
 *
 * sessions.workflow_execution_id is the durable attribution column; unlike
 * workflow_spawned_sessions (which is pruned on successful terminal cleanup) it persists for
 * the life of the session row.
 */
export async function getUsageByWorkflowModel(
  db: D1Database,
  periodStart: string,
): Promise<UsageByWorkflowModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        we.workflow_id,
        COALESCE(w.name, w.slug, 'Unknown workflow') as workflow_name,
        COALESCE(t.type, 'manual') as trigger_type,
        ae.model,${AE_TOKEN_SUM_COLS},
        COUNT(*) as call_count
      FROM analytics_events ae
      JOIN sessions s ON s.id = ae.session_id
      JOIN workflow_executions we ON we.id = s.workflow_execution_id
      LEFT JOIN workflows w ON w.id = we.workflow_id
      LEFT JOIN triggers t ON t.id = we.trigger_id
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        -- Ephemeral-session usage reports under its own origin, so exclude it
        -- here to keep this drill-down consistent with the by-origin table.
        AND json_extract(ae.properties, '$.usage_kind') IS NULL
      GROUP BY we.workflow_id, w.name, w.slug, t.type, ae.model
      ORDER BY (SUM(${AE_BILLABLE_INPUT_EXPR}) + SUM(${AE_BILLABLE_OUTPUT_EXPR})) DESC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    workflowId: r.workflow_id ? String(r.workflow_id) : null,
    workflowName: String(r.workflow_name),
    triggerType: String(r.trigger_type),
    model: String(r.model),
    callCount: Number(r.call_count),
    ...mapTokenSums(r),
  }));
}

export interface UsageByModelRow extends LlmTokenSums {
  model: string;
  callCount: number;
}

export async function getUsageByModel(
  db: D1Database,
  periodStart: string,
  // Optional exclusive upper bound so windowed consumers (Value tab deltas)
  // can query [start, end); omitted = "since periodStart" (usage stats).
  periodEnd?: string,
): Promise<UsageByModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        model,${SQL_TOKEN_SUM_COLS},
        COUNT(*) as call_count
      FROM analytics_events
      WHERE event_type = 'llm_call'
        AND created_at >= ?
        ${periodEnd ? 'AND created_at < ?' : ''}
      GROUP BY model
      ORDER BY (SUM(${SQL_BILLABLE_INPUT_EXPR}) + SUM(${SQL_BILLABLE_OUTPUT_EXPR})) DESC
    `)
    .bind(...(periodEnd ? [periodStart, periodEnd] : [periodStart]))
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    model: String(r.model),
    callCount: Number(r.call_count),
    ...mapTokenSums(r),
  }));
}

// ─── Sandbox Usage Queries ──────────────────────────────────────────────────

export interface SandboxHeroStats {
  totalActiveSeconds: number;
}

export async function getSandboxHeroStats(
  db: D1Database,
  periodStart: string,
): Promise<SandboxHeroStats> {
  const row = await db
    .prepare(`
      SELECT COALESCE(SUM(active_seconds), 0) as total_active_seconds
      FROM sessions
      WHERE created_at >= ?
    `)
    .bind(periodStart)
    .first<{ total_active_seconds: number }>();

  return {
    totalActiveSeconds: row?.total_active_seconds ?? 0,
  };
}

export interface SandboxByDayRow {
  date: string;
  activeSeconds: number;
}

export async function getSandboxByDay(
  db: D1Database,
  periodStart: string,
): Promise<SandboxByDayRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(created_at) as date,
        SUM(active_seconds) as active_seconds
      FROM sessions
      WHERE created_at >= ?
      GROUP BY date(created_at)
      ORDER BY date ASC
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    activeSeconds: Number(r.active_seconds),
  }));
}

export interface SandboxByUserRow {
  userId: string;
  activeSeconds: number;
  sandboxCpuCores: number | null;
  sandboxMemoryMib: number | null;
}

export async function getSandboxByUser(
  db: D1Database,
  periodStart: string,
): Promise<SandboxByUserRow[]> {
  const result = await db
    .prepare(`
      SELECT
        s.user_id,
        SUM(s.active_seconds) as active_seconds,
        u.sandbox_cpu_cores,
        u.sandbox_memory_mib
      FROM sessions s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.created_at >= ?
        AND s.user_id IS NOT NULL
      GROUP BY s.user_id
    `)
    .bind(periodStart)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    activeSeconds: Number(r.active_seconds),
    sandboxCpuCores: r.sandbox_cpu_cores != null ? Number(r.sandbox_cpu_cores) : null,
    sandboxMemoryMib: r.sandbox_memory_mib != null ? Number(r.sandbox_memory_mib) : null,
  }));
}

// ─── Performance Queries ────────────────────────────────────────────────────

export interface PercentileStats {
  p50: number | null;
  p95: number | null;
  count: number;
}

export async function getPercentiles(
  db: D1Database,
  eventType: string,
  periodStart: string,
): Promise<PercentileStats> {
  const countRow = await db
    .prepare(`
      SELECT COUNT(*) as cnt
      FROM analytics_events
      WHERE event_type = ?
        AND created_at >= ?
        AND duration_ms IS NOT NULL
    `)
    .bind(eventType, periodStart)
    .first<{ cnt: number }>();

  const count = countRow?.cnt ?? 0;
  if (count === 0) return { p50: null, p95: null, count: 0 };

  const p50Offset = Math.floor((count - 1) * 0.5);
  const p95Offset = Math.floor((count - 1) * 0.95);

  const [p50Row, p95Row] = await Promise.all([
    db.prepare(`
      SELECT duration_ms FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
      ORDER BY duration_ms ASC
      LIMIT 1 OFFSET ?
    `).bind(eventType, periodStart, p50Offset).first<{ duration_ms: number }>(),
    db.prepare(`
      SELECT duration_ms FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
      ORDER BY duration_ms ASC
      LIMIT 1 OFFSET ?
    `).bind(eventType, periodStart, Math.min(p95Offset, count - 1)).first<{ duration_ms: number }>(),
  ]);

  return {
    p50: p50Row?.duration_ms ?? null,
    p95: p95Row?.duration_ms ?? null,
    count,
  };
}

export interface PerfTrendRow {
  date: string;
  p50: number | null;
  p95: number | null;
  count: number;
}

export async function getPerfTrend(
  db: D1Database,
  eventType: string,
  periodStart: string,
): Promise<PerfTrendRow[]> {
  const result = await db
    .prepare(`
      SELECT date(created_at) as date, duration_ms
      FROM analytics_events
      WHERE event_type = ? AND created_at >= ? AND duration_ms IS NOT NULL
      ORDER BY date(created_at), duration_ms
    `)
    .bind(eventType, periodStart)
    .all();

  const rows = result.results ?? [];
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const date = String(r.date);
    const arr = byDay.get(date) ?? [];
    arr.push(Number(r.duration_ms));
    byDay.set(date, arr);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, durations]) => ({
      date,
      p50: durations[Math.floor((durations.length - 1) * 0.5)] ?? null,
      p95: durations[Math.floor((durations.length - 1) * 0.95)] ?? null,
      count: durations.length,
    }));
}

export interface StageBreakdownRow {
  eventType: string;
  p50: number | null;
  p95: number | null;
  count: number;
}

const STAGE_EVENT_TYPES = ['queue_wait', 'sandbox_wake', 'sandbox_restore', 'llm_response', 'tool_exec', 'runner_connect', 'runner_idle'];

export async function getStageBreakdown(
  db: D1Database,
  periodStart: string,
): Promise<StageBreakdownRow[]> {
  const placeholders = STAGE_EVENT_TYPES.map(() => '?').join(', ');
  const result = await db
    .prepare(`
      SELECT event_type, duration_ms
      FROM analytics_events
      WHERE created_at >= ?
        AND duration_ms IS NOT NULL
        AND event_type IN (${placeholders})
      ORDER BY event_type, duration_ms
    `)
    .bind(periodStart, ...STAGE_EVENT_TYPES)
    .all();

  const rows = result.results ?? [];
  const byType = new Map<string, number[]>();
  for (const r of rows) {
    const eventType = String(r.event_type);
    const arr = byType.get(eventType) ?? [];
    arr.push(Number(r.duration_ms));
    byType.set(eventType, arr);
  }

  return Array.from(byType.entries())
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([eventType, durations]) => ({
      eventType,
      p50: durations[Math.floor((durations.length - 1) * 0.5)] ?? null,
      p95: durations[Math.floor((durations.length - 1) * 0.95)] ?? null,
      count: durations.length,
    }));
}

export interface ErrorRateStats {
  totalErrors: number;
  totalCompleted: number;
  errorRate: number;
}

export async function getErrorRate(
  db: D1Database,
  periodStart: string,
): Promise<ErrorRateStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN event_type = 'turn_error' THEN 1 ELSE 0 END), 0) as total_errors,
        COALESCE(SUM(CASE WHEN event_type = 'turn_complete' THEN 1 ELSE 0 END), 0) as total_completed
      FROM analytics_events
      WHERE event_type IN ('turn_error', 'turn_complete')
        AND created_at >= ?
    `)
    .bind(periodStart)
    .first<{ total_errors: number; total_completed: number }>();

  const totalErrors = row?.total_errors ?? 0;
  const totalCompleted = row?.total_completed ?? 0;
  const total = totalErrors + totalCompleted;

  return {
    totalErrors,
    totalCompleted,
    errorRate: total > 0 ? totalErrors / total : 0,
  };
}

// ─── Throughput ─────────────────────────────────────────────────────────────

export interface ThroughputStats {
  medianTokensPerSec: number | null;
  count: number;
}

export async function getThroughputStats(
  db: D1Database,
  periodStart: string,
): Promise<ThroughputStats> {
  const countRow = await db
    .prepare(`
      SELECT COUNT(*) as cnt
      FROM analytics_events
      WHERE event_type = 'llm_response'
        AND created_at >= ?
        AND properties IS NOT NULL
        AND json_extract(properties, '$.tokens_per_sec') > 0
    `)
    .bind(periodStart)
    .first<{ cnt: number }>();

  const count = countRow?.cnt ?? 0;
  if (count === 0) return { medianTokensPerSec: null, count: 0 };

  const medianOffset = Math.floor((count - 1) * 0.5);
  const row = await db
    .prepare(`
      SELECT json_extract(properties, '$.tokens_per_sec') as tps
      FROM analytics_events
      WHERE event_type = 'llm_response'
        AND created_at >= ?
        AND properties IS NOT NULL
        AND json_extract(properties, '$.tokens_per_sec') > 0
      ORDER BY json_extract(properties, '$.tokens_per_sec') ASC
      LIMIT 1 OFFSET ?
    `)
    .bind(periodStart, medianOffset)
    .first<{ tps: number }>();

  return {
    medianTokensPerSec: row?.tps ?? null,
    count,
  };
}

// ─── Event Feed ─────────────────────────────────────────────────────────────

export interface EventFeedRow {
  id: string;
  eventType: string;
  sessionId: string;
  sessionTitle: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  turnId: string | null;
  durationMs: number | null;
  createdAt: string;
  channel: string | null;
  model: string | null;
  toolName: string | null;
  errorCode: string | null;
  summary: string | null;
  properties: string | null;
}

export interface EventFeedOptions {
  limit?: number;
  offset?: number;
  typePrefix?: string;
}

export async function getEventFeed(
  db: D1Database,
  periodStart: string,
  options: EventFeedOptions = {},
): Promise<{ events: EventFeedRow[]; total: number }> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  let whereClause = 'WHERE ae.created_at >= ?';
  const binds: unknown[] = [periodStart];

  if (options.typePrefix) {
    const escaped = options.typePrefix.replace(/%/g, '\\%').replace(/_/g, '\\_');
    whereClause += " AND ae.event_type LIKE ? ESCAPE '\\'";
    binds.push(`${escaped}%`);
  }

  // Count query uses plain table (no alias)
  const countWhere = whereClause.replace(/ae\./g, '');
  const countRow = await db
    .prepare(`SELECT COUNT(*) as cnt FROM analytics_events ${countWhere}`)
    .bind(...binds)
    .first<{ cnt: number }>();

  const result = await db
    .prepare(`
      SELECT ae.id, ae.event_type, ae.session_id, ae.user_id, ae.turn_id,
             ae.duration_ms, ae.created_at, ae.channel, ae.model,
             ae.tool_name, ae.error_code, ae.summary, ae.properties,
             s.title as session_title,
             u.email as user_email, u.name as user_name
      FROM analytics_events ae
      LEFT JOIN sessions s ON s.id = ae.session_id
      LEFT JOIN users u ON u.id = ae.user_id
      ${whereClause}
      ORDER BY ae.created_at DESC
      LIMIT ? OFFSET ?
    `)
    .bind(...binds, limit, offset)
    .all();

  const events = (result.results ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    eventType: String(r.event_type),
    sessionId: String(r.session_id),
    sessionTitle: r.session_title != null ? String(r.session_title) : null,
    userId: r.user_id != null ? String(r.user_id) : null,
    userEmail: r.user_email != null ? String(r.user_email) : null,
    userName: r.user_name != null ? String(r.user_name) : null,
    turnId: r.turn_id != null ? String(r.turn_id) : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    createdAt: String(r.created_at),
    channel: r.channel != null ? String(r.channel) : null,
    model: r.model != null ? String(r.model) : null,
    toolName: r.tool_name != null ? String(r.tool_name) : null,
    errorCode: r.error_code != null ? String(r.error_code) : null,
    summary: r.summary != null ? String(r.summary) : null,
    properties: r.properties != null ? String(r.properties) : null,
  }));

  return { events, total: countRow?.cnt ?? 0 };
}

// ─── Slow Paths ─────────────────────────────────────────────────────────────

export interface SlowPathRow {
  dimension: string;
  p50: number | null;
  p95: number | null;
  count: number;
}

export async function getSlowPaths(
  db: D1Database,
  periodStart: string,
  dimension: 'model' | 'channel' | 'tool_name',
): Promise<SlowPathRow[]> {
  const result = await db
    .prepare(`
      SELECT ${dimension} as dim, duration_ms
      FROM analytics_events
      WHERE event_type = 'turn_complete'
        AND created_at >= ?
        AND duration_ms IS NOT NULL
        AND ${dimension} IS NOT NULL
      ORDER BY ${dimension}, duration_ms
    `)
    .bind(periodStart)
    .all();

  const rows = result.results ?? [];
  const byDim = new Map<string, number[]>();
  for (const r of rows) {
    const dim = String(r.dim);
    const arr = byDim.get(dim) ?? [];
    arr.push(Number(r.duration_ms));
    byDim.set(dim, arr);
  }

  return Array.from(byDim.entries())
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 20)
    .map(([dim, durations]) => ({
      dimension: dim,
      p50: durations[Math.floor((durations.length - 1) * 0.5)] ?? null,
      p95: durations[Math.floor((durations.length - 1) * 0.95)] ?? null,
      count: durations.length,
    }));
}
