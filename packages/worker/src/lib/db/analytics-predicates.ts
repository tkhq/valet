import type { D1Database } from '@cloudflare/workers-types';

// Shared SQL predicates for windowed workflow-run analytics (value-metrics.ts,
// adoption-metrics.ts). A run belongs to the window in which it REACHED a
// terminal state, not when it started — otherwise the current window is
// systematically incomplete (recent runs still executing) and the prior
// window's numbers drift as its stragglers finish. Test-mode runs never
// count. Aliased to `we` so callers can join against workflow_executions.
//
// The terminal-status set is the invariant both windows depend on — if it
// changes (e.g. a new 'timed_out' status), it must change here once so both
// modules agree on what a terminal run is.
export const WORKFLOW_TERMINAL_WHERE = `
  we.mode = 'production'
  AND we.status IN ('completed', 'failed', 'cancelled')
  AND datetime(COALESCE(we.completed_at, we.cancelled_at, we.started_at)) >= datetime(?)
  AND datetime(COALESCE(we.completed_at, we.cancelled_at, we.started_at)) < datetime(?)`;

// valueSql must select the same rows as countSql, ordered ascending, and end
// with `LIMIT 1 OFFSET ?` — the computed offset is bound after `binds`. A
// population mismatch fails silently with a wrong quantile. Nearest-rank, no
// interpolation: q=0.5 takes the lower-middle value on even-sized sets, q=0.95
// the smallest value with at least 95% of rows at or below it.
export async function quantileVia(
  db: D1Database,
  countSql: string,
  valueSql: string,
  binds: (string | number)[],
  q: number,
): Promise<number | null> {
  const countRow = await db.prepare(countSql).bind(...binds).first<{ cnt: number }>();
  const count = countRow?.cnt ?? 0;
  if (count === 0) return null;
  const offset = Math.max(0, Math.ceil(q * count) - 1);
  const row = await db.prepare(valueSql).bind(...binds, offset).first<{ v: number }>();
  return row?.v ?? null;
}
