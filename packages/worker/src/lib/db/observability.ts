import type { D1Database } from '@cloudflare/workers-types';

// ─── Cron Heartbeats ─────────────────────────────────────────────────────────
//
// One row per scheduled-handler job, upserted on every run by the runSweep
// wrapper in index.ts. /api/analytics/health reads these rows and flags a job
// stale when now - last_success_at exceeds 3x its expected interval.

export interface CronHeartbeatRow {
  jobName: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastItems: number | null;
  updatedAt: string;
}

/**
 * Record a successful sweep run. UPSERT keyed on job_name: refreshes
 * last_success_at + last_duration_ms (+ last_items when the job reports a
 * count) and clears nothing about the last error — a job that succeeds after
 * failing keeps its last_error_at/last_error for post-mortem context until it
 * next fails.
 */
export async function recordSweepSuccess(
  db: D1Database,
  jobName: string,
  opts: { durationMs: number; items?: number | null },
): Promise<void> {
  const items = opts.items ?? null;
  await db
    .prepare(`
      INSERT INTO cron_heartbeats (job_name, last_success_at, last_duration_ms, last_items, updated_at)
      VALUES (?, datetime('now'), ?, ?, datetime('now'))
      ON CONFLICT(job_name) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        last_duration_ms = excluded.last_duration_ms,
        last_items = excluded.last_items,
        updated_at = excluded.updated_at
    `)
    .bind(jobName, opts.durationMs, items)
    .run();
}

/**
 * Record a failed sweep run. UPSERT keyed on job_name: stamps
 * last_error_at + last_error + last_duration_ms and leaves last_success_at
 * untouched so /api/analytics/health can still show how long ago the job last
 * worked while surfacing the current failure.
 */
export async function recordSweepError(
  db: D1Database,
  jobName: string,
  opts: { durationMs: number; error: string },
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO cron_heartbeats (job_name, last_error_at, last_error, last_duration_ms, updated_at)
      VALUES (?, datetime('now'), ?, ?, datetime('now'))
      ON CONFLICT(job_name) DO UPDATE SET
        last_error_at = excluded.last_error_at,
        last_error = excluded.last_error,
        last_duration_ms = excluded.last_duration_ms,
        updated_at = excluded.updated_at
    `)
    .bind(jobName, opts.error, opts.durationMs)
    .run();
}

export async function getCronHeartbeats(db: D1Database): Promise<CronHeartbeatRow[]> {
  const result = await db
    .prepare(`
      SELECT job_name, last_success_at, last_error_at, last_error, last_duration_ms, last_items, updated_at
      FROM cron_heartbeats
      ORDER BY job_name ASC
    `)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    jobName: String(r.job_name),
    lastSuccessAt: r.last_success_at != null ? String(r.last_success_at) : null,
    lastErrorAt: r.last_error_at != null ? String(r.last_error_at) : null,
    lastError: r.last_error != null ? String(r.last_error) : null,
    lastDurationMs: r.last_duration_ms != null ? Number(r.last_duration_ms) : null,
    lastItems: r.last_items != null ? Number(r.last_items) : null,
    updatedAt: String(r.updated_at),
  }));
}

// ─── Webhook Deliveries ──────────────────────────────────────────────────────
//
// One row per inbound delivery on the unauthenticated webhook surfaces
// (github, slack, telegram, generic/channel). Written fire-and-forget from the
// route layer; pruned after 30 days by the nightly retention sweep.

export type WebhookOutcome = 'received' | 'invalid_signature' | 'processed' | 'failed';

export interface RecordWebhookDeliveryInput {
  provider: string;
  eventType?: string | null;
  outcome: WebhookOutcome;
  error?: string | null;
}

export async function recordWebhookDelivery(
  db: D1Database,
  input: RecordWebhookDeliveryInput,
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO webhook_deliveries (id, provider, event_type, outcome, error, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `)
    .bind(
      crypto.randomUUID(),
      input.provider,
      input.eventType ?? null,
      input.outcome,
      input.error ?? null,
    )
    .run();
}

export interface WebhookDeliveryStatRow {
  provider: string;
  outcome: string;
  count: number;
  lastCreatedAt: string;
}

/**
 * Per-provider delivery counts grouped by outcome since `sinceIso`, plus the
 * most recent created_at within each (provider, outcome) bucket. The route
 * rolls these rows up into per-provider outcome maps.
 */
export async function getWebhookDeliveryStats(
  db: D1Database,
  sinceIso: string,
): Promise<WebhookDeliveryStatRow[]> {
  const result = await db
    .prepare(`
      SELECT provider, outcome, COUNT(*) as count, MAX(created_at) as last_created_at
      FROM webhook_deliveries
      WHERE created_at >= ?
      GROUP BY provider, outcome
      ORDER BY provider ASC, outcome ASC
    `)
    .bind(sinceIso)
    .all();

  return (result.results ?? []).map((r: Record<string, unknown>) => ({
    provider: String(r.provider),
    outcome: String(r.outcome),
    count: Number(r.count),
    lastCreatedAt: String(r.last_created_at),
  }));
}

/**
 * Batched retention delete for the nightly sweep. Mirrors the analytics-events
 * retention batching in index.ts (delete in ≤1000-row chunks so a large backlog
 * can't trip the D1 statement timeout). Returns the total rows deleted.
 */
export async function deleteWebhookDeliveriesOlderThan(
  db: D1Database,
  cutoffIso: string,
): Promise<number> {
  let totalDeleted = 0;
  let deleted: number;
  do {
    const result = await db
      .prepare(
        'DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < ? LIMIT 1000)',
      )
      .bind(cutoffIso)
      .run();
    deleted = result.meta.changes ?? 0;
    totalDeleted += deleted;
  } while (deleted >= 1000);
  return totalDeleted;
}
