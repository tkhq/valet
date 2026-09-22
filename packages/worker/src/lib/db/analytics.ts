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
  input_tokens: number | null;
  output_tokens: number | null;
  tool_name: string | null;
  error_code: string | null;
  summary: string | null;
  actor_id: string | null;
  properties: string | null;
};

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
        (id, event_type, session_id, user_id, turn_id, duration_ms, created_at, channel, model, queue_mode, input_tokens, output_tokens, tool_name, error_code, summary, actor_id, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      entry.toolName ?? null,
      entry.errorCode ?? null,
      entry.summary ?? null,
      entry.actorId ?? null,
      entry.properties ?? null,
    )
  );

  await db.batch(stmts);
}

// Usage reports use exact [start, end) windows. The optional user filter powers
// personal scope without changing the aggregation or exposing another user.
function usageWindowSql(alias: string, periodEnd?: string, userId?: string): string {
  return `${periodEnd ? `AND ${alias}.created_at < ?` : ''} ${userId ? `AND ${alias}.user_id = ?` : ''}`;
}

function usageWindowBindings(periodStart: string, periodEnd?: string, userId?: string): string[] {
  return [periodStart, ...(periodEnd ? [periodEnd] : []), ...(userId ? [userId] : [])];
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
  periodEnd?: string,
  userId?: string,
): Promise<UsageHeroStats> {
  const row = await db
    .prepare(`
      SELECT
        COALESCE(SUM(ae.input_tokens), 0) as total_input_tokens,
        COALESCE(SUM(ae.output_tokens), 0) as total_output_tokens,
        COUNT(DISTINCT ae.session_id) as total_sessions,
        COUNT(DISTINCT ae.user_id) as total_users
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        ${usageWindowSql('ae', periodEnd, userId)}
    `)
    .bind(...usageWindowBindings(periodStart, periodEnd, userId))
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

export interface UsageByDayRow {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export async function getUsageByDay(
  db: D1Database,
  periodStart: string,
  periodEnd?: string,
  userId?: string,
): Promise<UsageByDayRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(ae.created_at) as date,
        ae.model,
        SUM(ae.input_tokens) as input_tokens,
        SUM(ae.output_tokens) as output_tokens,
        COUNT(*) as call_count
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        ${usageWindowSql('ae', periodEnd, userId)}
      GROUP BY date(ae.created_at), ae.model
      ORDER BY date ASC
    `)
    .bind(...usageWindowBindings(periodStart, periodEnd, userId))
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
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
  periodEnd?: string,
  userId?: string,
): Promise<UsageByUserRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ae.user_id,
        u.email,
        u.name,
        SUM(ae.input_tokens) as input_tokens,
        SUM(ae.output_tokens) as output_tokens,
        COUNT(DISTINCT ae.session_id) as session_count
      FROM analytics_events ae
      LEFT JOIN users u ON u.id = ae.user_id
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        ${usageWindowSql('ae', periodEnd, userId)}
        AND ae.user_id IS NOT NULL
      GROUP BY ae.user_id
      ORDER BY (SUM(ae.input_tokens) + SUM(ae.output_tokens)) DESC
    `)
    .bind(...usageWindowBindings(periodStart, periodEnd, userId))
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

export interface UsageByUserModelRow {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

export async function getUsageByUserModel(
  db: D1Database,
  periodStart: string,
  periodEnd?: string,
  userId?: string,
): Promise<UsageByUserModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ae.user_id,
        ae.model,
        SUM(ae.input_tokens) as input_tokens,
        SUM(ae.output_tokens) as output_tokens,
        COUNT(*) as call_count
      FROM analytics_events ae
      WHERE ae.event_type = 'llm_call'
        AND ae.created_at >= ?
        ${usageWindowSql('ae', periodEnd, userId)}
        AND ae.user_id IS NOT NULL
      GROUP BY ae.user_id, ae.model
    `)
    .bind(...usageWindowBindings(periodStart, periodEnd, userId))
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    userId: String(r.user_id),
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    callCount: Number(r.call_count),
  }));
}

export interface UsageByPurposeModelRow {
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

const AE_ORIGIN_EXPR = `COALESCE(s.purpose, 'interactive')`;

export async function getUsageByPurposeModel(db: D1Database, periodStart: string, periodEnd?: string, userId?: string): Promise<UsageByPurposeModelRow[]> {
  const result = await db.prepare(`
    SELECT ${AE_ORIGIN_EXPR} as purpose, ae.model, SUM(ae.input_tokens) as input_tokens, SUM(ae.output_tokens) as output_tokens, COUNT(*) as call_count
    FROM analytics_events ae LEFT JOIN sessions s ON s.id = ae.session_id
    WHERE ae.event_type = 'llm_call' AND ae.created_at >= ? ${usageWindowSql('ae', periodEnd, userId)}
    GROUP BY ${AE_ORIGIN_EXPR}, ae.model
  `).bind(...usageWindowBindings(periodStart, periodEnd, userId)).all();
  return (result.results ?? []).map((r: Record<string, unknown>) => ({ purpose: String(r.purpose), model: String(r.model), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), callCount: Number(r.call_count) }));
}

export interface UsageByWorkflowModelRow {
  workflowId: string | null; workflowName: string; triggerType: string; model: string; inputTokens: number; outputTokens: number; callCount: number;
}

export async function getUsageByWorkflowModel(db: D1Database, periodStart: string, periodEnd?: string, userId?: string): Promise<UsageByWorkflowModelRow[]> {
  const result = await db.prepare(`
    SELECT we.workflow_id, COALESCE(w.name, w.slug, 'Unknown workflow') as workflow_name, COALESCE(t.type, 'manual') as trigger_type, ae.model, SUM(ae.input_tokens) as input_tokens, SUM(ae.output_tokens) as output_tokens, COUNT(*) as call_count
    FROM analytics_events ae JOIN sessions s ON s.id = ae.session_id JOIN workflow_executions we ON we.session_id = s.id LEFT JOIN workflows w ON w.id = we.workflow_id LEFT JOIN triggers t ON t.id = we.trigger_id
    WHERE ae.event_type = 'llm_call' AND ae.created_at >= ? ${usageWindowSql('ae', periodEnd, userId)}
    GROUP BY we.workflow_id, w.name, w.slug, t.type, ae.model
  `).bind(...usageWindowBindings(periodStart, periodEnd, userId)).all();
  return (result.results ?? []).map((r: Record<string, unknown>) => ({ workflowId: r.workflow_id ? String(r.workflow_id) : null, workflowName: String(r.workflow_name), triggerType: String(r.trigger_type), model: String(r.model), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), callCount: Number(r.call_count) }));
}

export interface UsageByModelRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
}

export async function getUsageByModel(
  db: D1Database,
  periodStart: string,
  periodEnd?: string,
  userId?: string,
): Promise<UsageByModelRow[]> {
  const result = await db
    .prepare(`
      SELECT
        model,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        COUNT(*) as call_count
      FROM analytics_events
      WHERE event_type = 'llm_call'
        AND created_at >= ?
        ${periodEnd ? 'AND created_at < ?' : ''}
        ${userId ? 'AND user_id = ?' : ''}
      GROUP BY model
      ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC
    `)
    .bind(...usageWindowBindings(periodStart, periodEnd, userId))
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    model: String(r.model),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    callCount: Number(r.call_count),
  }));
}

// ─── Sandbox Usage Queries ──────────────────────────────────────────────────

interface SandboxIntervalRow {
  userId: string;
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
  source: 'recorded' | 'legacy_session_total';
  sandboxCpuCores: number | null;
  sandboxMemoryMib: number | null;
}

async function getSandboxIntervals(
  db: D1Database,
  periodStart: string,
  periodEnd?: string,
  userId?: string,
): Promise<SandboxIntervalRow[]> {
  const end = periodEnd ?? '9999-12-31T23:59:59.999Z';
  const result = await db.prepare(`
    SELECT s.user_id, sai.started_at, sai.ended_at, sai.active_seconds, sai.source,
      u.sandbox_cpu_cores, u.sandbox_memory_mib
    FROM session_active_intervals sai
    JOIN sessions s ON s.id = sai.session_id
    LEFT JOIN users u ON u.id = s.user_id
    WHERE (
      (sai.source = 'recorded' AND datetime(sai.ended_at) > datetime(?) AND datetime(sai.started_at) < datetime(?))
      OR
      (sai.source = 'legacy_session_total' AND datetime(sai.started_at) >= datetime(?) AND datetime(sai.started_at) < datetime(?))
    )
    ${userId ? 'AND s.user_id = ?' : ''}
  `).bind(periodStart, end, periodStart, end, ...(userId ? [userId] : [])).all();

  return (result.results ?? []).map((row: Record<string, unknown>) => ({
    userId: String(row.user_id),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    activeSeconds: Number(row.active_seconds),
    source: String(row.source) as SandboxIntervalRow['source'],
    sandboxCpuCores: row.sandbox_cpu_cores != null ? Number(row.sandbox_cpu_cores) : null,
    sandboxMemoryMib: row.sandbox_memory_mib != null ? Number(row.sandbox_memory_mib) : null,
  }));
}

function clippedActiveSeconds(row: SandboxIntervalRow, startMs: number, endMs: number): number {
  if (row.source === 'legacy_session_total') return row.activeSeconds;
  const overlapMs = Math.max(0, Math.min(Date.parse(row.endedAt), endMs) - Math.max(Date.parse(row.startedAt), startMs));
  return Math.min(row.activeSeconds, Math.round(overlapMs / 1_000));
}

export interface SandboxHeroStats {
  totalActiveSeconds: number;
}

export async function getSandboxHeroStats(
  db: D1Database,
  periodStart: string,
  periodEnd?: string,
  userId?: string,
): Promise<SandboxHeroStats> {
  const rows = await getSandboxIntervals(db, periodStart, periodEnd, userId);
  const startMs = Date.parse(periodStart);
  const endMs = periodEnd ? Date.parse(periodEnd) : Number.POSITIVE_INFINITY;
  return {
    totalActiveSeconds: rows.reduce((total, row) => total + clippedActiveSeconds(row, startMs, endMs), 0),
  };
}

export interface SandboxByDayRow {
  date: string;
  activeSeconds: number;
}

export async function getSandboxByDay(
  db: D1Database,
  periodStart: string,
  periodEnd?: string,
  userId?: string,
): Promise<SandboxByDayRow[]> {
  const rows = await getSandboxIntervals(db, periodStart, periodEnd, userId);
  const reportStartMs = Date.parse(periodStart);
  const reportEndMs = periodEnd ? Date.parse(periodEnd) : Number.POSITIVE_INFINITY;
  const totals = new Map<string, number>();

  for (const row of rows) {
    if (row.source === 'legacy_session_total') {
      const date = row.startedAt.slice(0, 10);
      totals.set(date, (totals.get(date) ?? 0) + row.activeSeconds);
      continue;
    }

    let cursor = Math.max(Date.parse(row.startedAt), reportStartMs);
    const intervalEnd = Math.min(Date.parse(row.endedAt), reportEndMs);
    while (cursor < intervalEnd) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      const nextDay = Date.parse(`${date}T00:00:00.000Z`) + 86_400_000;
      const seconds = Math.round((Math.min(intervalEnd, nextDay) - cursor) / 1_000);
      totals.set(date, (totals.get(date) ?? 0) + seconds);
      cursor = nextDay;
    }
  }

  return Array.from(totals, ([date, activeSeconds]) => ({ date, activeSeconds }))
    .sort((a, b) => a.date.localeCompare(b.date));
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
  periodEnd?: string,
  userId?: string,
): Promise<SandboxByUserRow[]> {
  const rows = await getSandboxIntervals(db, periodStart, periodEnd, userId);
  const startMs = Date.parse(periodStart);
  const endMs = periodEnd ? Date.parse(periodEnd) : Number.POSITIVE_INFINITY;
  const totals = new Map<string, SandboxByUserRow>();

  for (const row of rows) {
    const item = totals.get(row.userId) ?? {
      userId: row.userId,
      activeSeconds: 0,
      sandboxCpuCores: row.sandboxCpuCores,
      sandboxMemoryMib: row.sandboxMemoryMib,
    };
    item.activeSeconds += clippedActiveSeconds(row, startMs, endMs);
    totals.set(row.userId, item);
  }
  return Array.from(totals.values());
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
