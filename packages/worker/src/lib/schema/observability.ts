import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

/**
 * Cron sweep heartbeats — one row per scheduled-handler job, upserted on every
 * run by the runSweep wrapper. /api/analytics/health flags a job stale when
 * now - last_success_at exceeds 3x its expected interval.
 */
export const cronHeartbeats = sqliteTable('cron_heartbeats', {
  jobName: text('job_name').primaryKey(),
  lastSuccessAt: text('last_success_at'),
  lastErrorAt: text('last_error_at'),
  lastError: text('last_error'),
  lastDurationMs: integer('last_duration_ms'),
  lastItems: integer('last_items'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

/**
 * Webhook delivery telemetry — one row per inbound delivery on the
 * unauthenticated webhook surfaces. Written fire-and-forget from the route
 * layer; pruned after 30 days by the nightly retention sweep.
 */
export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text().primaryKey(),
  provider: text().notNull(),
  eventType: text('event_type'),
  outcome: text().notNull(),
  error: text(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_webhook_deliveries_provider_created').on(table.provider, table.createdAt),
  index('idx_webhook_deliveries_created').on(table.createdAt),
]);
