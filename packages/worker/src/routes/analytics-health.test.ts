import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createTestDb } from '../test-utils/db.js';
import { makeD1Adapter } from '../test-utils/d1.js';
import { analyticsRouter, isJobStale } from './analytics.js';
import { recordSweepSuccess, recordSweepError, recordWebhookDelivery } from '../lib/db/observability.js';
import type { AnalyticsHealthResponse } from '@valet/shared';

describe('isJobStale', () => {
  const now = Date.parse('2026-07-08T12:00:00.000Z');

  it('is not stale when the last success is within 3x the interval', () => {
    // workflow_dispatch = 60s → threshold 180s. 2 minutes ago is fresh.
    expect(isJobStale('workflow_dispatch', '2026-07-08T11:58:00.000Z', now)).toBe(false);
  });

  it('is stale when the last success is older than 3x the interval', () => {
    // 5 minutes ago > 180s threshold.
    expect(isJobStale('workflow_dispatch', '2026-07-08T11:55:00.000Z', now)).toBe(true);
  });

  it('treats SQLite space-separated datetimes as UTC', () => {
    // "11:58:00" one hour... use exactly 2 min ago in the space form → fresh.
    expect(isJobStale('workflow_dispatch', '2026-07-08 11:58:00', now)).toBe(false);
    expect(isJobStale('workflow_dispatch', '2026-07-08 11:55:00', now)).toBe(true);
  });

  it('never flags a job with no known interval', () => {
    expect(isJobStale('some_renamed_job', '2020-01-01T00:00:00.000Z', now)).toBe(false);
  });

  it('never flags a job that has never succeeded', () => {
    expect(isJobStale('workflow_dispatch', null, now)).toBe(false);
  });

  it('honours the longer nightly interval', () => {
    // nightly = 86_400_000ms → 3x = 3 days. 2 days ago is fresh; 4 days is stale.
    expect(isJobStale('nightly_analytics_retention', '2026-07-06T12:00:00.000Z', now)).toBe(false);
    expect(isJobStale('nightly_analytics_retention', '2026-07-04T11:00:00.000Z', now)).toBe(true);
  });
});

function buildApp(d1: Env['DB'], role: 'admin' | 'member' = 'admin') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    (c as any).set('user', { id: 'admin-user', email: 'admin@example.com', role } as any);
    (c as any).env = { DB: d1 } as Env;
    await next();
  });
  app.route('/', analyticsRouter);
  return app;
}

describe('GET /api/analytics/health', () => {
  let sqlite: ReturnType<typeof createTestDb>['sqlite'];
  let d1: Env['DB'];

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    d1 = makeD1Adapter(sqlite);
  });

  it('rejects non-admins', async () => {
    const app = buildApp(d1, 'member');
    const res = await app.request('/health');
    expect(res.status).toBe(403);
  });

  it('returns jobs with staleness and a per-provider webhook rollup', async () => {
    await recordSweepSuccess(d1, 'workflow_dispatch', { durationMs: 10, items: 2 });
    await recordSweepError(d1, 'github_reconcile', { durationMs: 20, error: 'boom' });
    // A stale minutely job: force an old last_success_at directly.
    sqlite
      .prepare(`INSERT INTO cron_heartbeats (job_name, last_success_at, last_duration_ms, updated_at) VALUES (?, ?, ?, datetime('now'))`)
      .run('cancel_cleanup', '2020-01-01T00:00:00.000Z', 5);

    await recordWebhookDelivery(d1, { provider: 'github', outcome: 'processed' });
    await recordWebhookDelivery(d1, { provider: 'github', outcome: 'processed' });
    await recordWebhookDelivery(d1, { provider: 'github', outcome: 'invalid_signature', error: 'sig' });
    await recordWebhookDelivery(d1, { provider: 'slack', outcome: 'received' });

    const app = buildApp(d1);
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnalyticsHealthResponse;

    const byName = Object.fromEntries(body.jobs.map((j) => [j.jobName, j]));
    expect(byName.workflow_dispatch.stale).toBe(false);
    expect(byName.workflow_dispatch.lastItems).toBe(2);
    // github_reconcile only errored → never succeeded → not stale, error surfaced.
    expect(byName.github_reconcile.stale).toBe(false);
    expect(byName.github_reconcile.lastError).toBe('boom');
    expect(byName.cancel_cleanup.stale).toBe(true);

    const github = body.webhooks.find((w) => w.provider === 'github');
    expect(github).toMatchObject({ processed: 2, invalidSignature: 1, total: 3 });
    expect(github?.lastCreatedAt).toBeTruthy();
    const slack = body.webhooks.find((w) => w.provider === 'slack');
    expect(slack).toMatchObject({ received: 1, total: 1 });
  });
});
