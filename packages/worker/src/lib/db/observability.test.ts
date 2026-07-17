import { describe, expect, it, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb } from '../../test-utils/db.js';
import { makeD1Adapter } from '../../test-utils/d1.js';
import {
  recordSweepSuccess,
  recordSweepError,
  getCronHeartbeats,
  recordWebhookDelivery,
  getWebhookDeliveryStats,
  deleteWebhookDeliveriesOlderThan,
} from './observability.js';

describe('observability db helpers', () => {
  let sqlite: BetterSqlite3.Database;
  let db: D1Database;

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    db = makeD1Adapter(sqlite);
  });

  describe('cron heartbeats', () => {
    it('records a success then upserts on the same job', async () => {
      await recordSweepSuccess(db, 'workflow_dispatch', { durationMs: 12, items: 3 });
      let rows = await getCronHeartbeats(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].jobName).toBe('workflow_dispatch');
      expect(rows[0].lastDurationMs).toBe(12);
      expect(rows[0].lastItems).toBe(3);
      expect(rows[0].lastSuccessAt).toBeTruthy();
      expect(rows[0].lastErrorAt).toBeNull();

      await recordSweepSuccess(db, 'workflow_dispatch', { durationMs: 34 });
      rows = await getCronHeartbeats(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].lastDurationMs).toBe(34);
      // items omitted on the second run → reset to null.
      expect(rows[0].lastItems).toBeNull();
    });

    it('records an error without clobbering last_success_at', async () => {
      await recordSweepSuccess(db, 'credential_refresh', { durationMs: 5, items: 1 });
      await recordSweepError(db, 'credential_refresh', { durationMs: 7, error: 'boom' });

      const rows = await getCronHeartbeats(db);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.lastSuccessAt).toBeTruthy();
      expect(row.lastErrorAt).toBeTruthy();
      expect(row.lastError).toBe('boom');
      expect(row.lastDurationMs).toBe(7);
    });

    it('an error on a never-succeeded job leaves last_success_at null', async () => {
      await recordSweepError(db, 'github_reconcile', { durationMs: 9, error: 'nope' });
      const rows = await getCronHeartbeats(db);
      expect(rows[0].lastSuccessAt).toBeNull();
      expect(rows[0].lastError).toBe('nope');
    });

    it('returns rows sorted by job name', async () => {
      await recordSweepSuccess(db, 'zzz_job', { durationMs: 1 });
      await recordSweepSuccess(db, 'aaa_job', { durationMs: 1 });
      const rows = await getCronHeartbeats(db);
      expect(rows.map((r) => r.jobName)).toEqual(['aaa_job', 'zzz_job']);
    });
  });

  describe('webhook deliveries', () => {
    it('records a delivery and rolls it up per provider + outcome', async () => {
      await recordWebhookDelivery(db, { provider: 'github', eventType: 'push', outcome: 'processed' });
      await recordWebhookDelivery(db, { provider: 'github', eventType: 'push', outcome: 'processed' });
      await recordWebhookDelivery(db, { provider: 'github', outcome: 'invalid_signature', error: 'bad sig' });
      await recordWebhookDelivery(db, { provider: 'slack', eventType: 'message', outcome: 'received' });

      const stats = await getWebhookDeliveryStats(db, '2000-01-01T00:00:00.000Z');
      const github = stats.filter((s) => s.provider === 'github');
      const slack = stats.filter((s) => s.provider === 'slack');

      expect(github).toEqual([
        expect.objectContaining({ provider: 'github', outcome: 'invalid_signature', count: 1 }),
        expect.objectContaining({ provider: 'github', outcome: 'processed', count: 2 }),
      ]);
      expect(slack).toEqual([
        expect.objectContaining({ provider: 'slack', outcome: 'received', count: 1 }),
      ]);
      for (const s of stats) expect(s.lastCreatedAt).toBeTruthy();
    });

    it('respects the since cutoff', async () => {
      // Seed an old row directly (bypassing the datetime('now') default).
      sqlite
        .prepare(`INSERT INTO webhook_deliveries (id, provider, outcome, created_at) VALUES (?, ?, ?, ?)`)
        .run('old-1', 'github', 'processed', '2020-01-01T00:00:00.000Z');
      await recordWebhookDelivery(db, { provider: 'github', outcome: 'processed' });

      const stats = await getWebhookDeliveryStats(db, '2025-01-01T00:00:00.000Z');
      expect(stats).toHaveLength(1);
      expect(stats[0].count).toBe(1);
    });

    it('batch-deletes rows older than the cutoff and keeps recent ones', async () => {
      const insert = sqlite.prepare(
        `INSERT INTO webhook_deliveries (id, provider, outcome, created_at) VALUES (?, ?, ?, ?)`,
      );
      for (let i = 0; i < 1500; i++) {
        insert.run(`old-${i}`, 'github', 'processed', '2020-01-01T00:00:00.000Z');
      }
      insert.run('recent-1', 'github', 'processed', '2099-01-01T00:00:00.000Z');

      const deleted = await deleteWebhookDeliveriesOlderThan(db, '2025-01-01T00:00:00.000Z');
      expect(deleted).toBe(1500);

      const remaining = sqlite.prepare('SELECT COUNT(*) as c FROM webhook_deliveries').get() as { c: number };
      expect(remaining.c).toBe(1);
    });
  });
});
