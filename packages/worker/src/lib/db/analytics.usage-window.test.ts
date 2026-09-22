import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1TestShim, createTestDb, migrationSql } from '../../test-utils/db.js';
import { getUsageHeroStats, getUsageByDay, getUsageByPurposeModel, getUsageByWorkflowModel, getSandboxUsage, sandboxIntervalQuery } from './analytics.js';
import { addActiveSeconds } from './sessions.js';

describe('usage report window and scope', () => {
  let sqlite: BetterSqlite3.Database;
  let db: D1Database;
  const start = '2024-03-01T00:00:00.000Z';
  const end = '2024-04-01T00:00:00.000Z';

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    db = createD1TestShim(sqlite);
    sqlite.exec(`
      INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com'), ('u2', 'u2@example.com');
      INSERT INTO sessions (id, user_id, workspace, status, purpose, active_seconds, created_at) VALUES
        ('s1', 'u1', 'ws', 'active', 'interactive', 10, '2024-02-29 23:59:55'),
        ('s2', 'u2', 'ws', 'active', 'orchestrator', 20, '2024-03-31 23:59:59'),
        ('s3', 'u1', 'ws', 'active', 'interactive', 40, '2024-04-01 00:00:00');
      INSERT INTO session_active_intervals (id, session_id, started_at, ended_at, active_seconds, source) VALUES
        ('i1', 's1', '2024-02-29T23:59:55.000Z', '2024-03-01T00:00:05.000Z', 10, 'recorded'),
        ('i2', 's2', '2024-03-31T23:59:50.000Z', '2024-04-01T00:00:10.000Z', 20, 'recorded'),
        ('i3', 's3', '2024-04-01T00:00:00.000Z', '2024-04-01T00:00:40.000Z', 40, 'recorded');
      INSERT INTO analytics_events (id, event_type, session_id, user_id, model, input_tokens, output_tokens, created_at) VALUES
        ('at-start', 'llm_call', 's1', 'u1', 'model-a', 10, 1, '${start}'),
        ('before-end', 'llm_call', 's2', 'u2', 'model-a', 20, 2, '2024-03-31T23:59:59.999Z'),
        ('at-end', 'llm_call', 's3', 'u1', 'model-a', 40, 4, '${end}');
    `);
  });

  it('applies the reporting migration against the real schema', () => {
    const columns = sqlite.prepare("PRAGMA index_info('idx_analytics_events_usage_report')").all()
      .map((row) => (row as { name: string }).name);
    expect(columns).toEqual(['created_at', 'user_id', 'model', 'session_id', 'input_tokens', 'output_tokens']);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_active_intervals'").get())
      .toEqual({ name: 'session_active_intervals' });
  });

  it('does not duplicate legacy totals when migration 0032 is replayed', () => {
    sqlite.exec(migrationSql('0032_usage_reporting_indexes.sql'));
    const before = sqlite.prepare("SELECT COUNT(*) AS count FROM session_active_intervals WHERE source = 'legacy_session_total'").get();
    sqlite.exec(migrationSql('0032_usage_reporting_indexes.sql'));
    const after = sqlite.prepare("SELECT COUNT(*) AS count FROM session_active_intervals WHERE source = 'legacy_session_total'").get();
    expect(after).toEqual(before);
    expect(sqlite.prepare("SELECT started_at FROM session_active_intervals WHERE source = 'legacy_session_total' LIMIT 1").get())
      .toEqual(expect.objectContaining({ started_at: expect.stringMatching(/T.*Z$/) }));
  });

  it('uses the interval window index without wrapping timestamp columns', () => {
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sandboxIntervalQuery()}`)
      .all(end, start, start, end)
      .map((row) => (row as { detail: string }).detail);
    expect(plan.filter((detail) => detail.includes('idx_session_active_intervals_window'))).toHaveLength(2);
    expect(sandboxIntervalQuery()).not.toContain('datetime(');
  });

  it('includes start and excludes end consistently across aggregates and breakdowns', async () => {
    expect(await getUsageHeroStats(db, start, end)).toMatchObject({ totalInputTokens: 30, totalOutputTokens: 3, totalUsers: 2 });
    expect((await getUsageByDay(db, start, end)).reduce((sum, row) => sum + row.inputTokens, 0)).toBe(30);
    expect((await getUsageByPurposeModel(db, start, end)).map((row) => row.purpose).sort()).toEqual(['interactive', 'orchestrator']);
    const sandbox = await getSandboxUsage(db, start, end);
    expect(sandbox.hero).toEqual({ totalActiveSeconds: 15 });
    expect(sandbox.byDay).toEqual([
      expect.objectContaining({ date: '2024-03-01', activeSeconds: 5 }),
      expect.objectContaining({ date: '2024-03-31', activeSeconds: 10 }),
    ]);

    sqlite.exec(`INSERT INTO session_active_intervals
      (id, session_id, started_at, ended_at, active_seconds, source)
      VALUES ('subsecond', 's1', '2024-02-29T23:59:59.500Z', '2024-03-01T00:00:00.500Z', 1, 'recorded')`);
    expect((await getSandboxUsage(db, start, end)).hero.totalActiveSeconds).toBe(15.5);
  });

  it('records active-time flushes as reportable intervals and updates the lifetime counter', async () => {
    await addActiveSeconds(db, 's1', 8);
    expect(sqlite.prepare("SELECT active_seconds FROM sessions WHERE id = 's1'").get()).toEqual({ active_seconds: 18 });
    expect(sqlite.prepare("SELECT active_seconds, source FROM session_active_intervals WHERE session_id = 's1' ORDER BY ended_at DESC LIMIT 1").get()).toEqual({ active_seconds: 8, source: 'recorded' });
  });

  it('attributes legacy counters to session creation and labels that limitation', async () => {
    sqlite.exec(`
      INSERT INTO sessions (id, user_id, workspace, status, purpose, active_seconds, created_at)
      VALUES ('legacy', 'u1', 'ws', 'active', 'interactive', 12, '2024-03-10 12:00:00');
      INSERT INTO session_active_intervals (id, session_id, started_at, ended_at, active_seconds, source)
      VALUES ('legacy:legacy', 'legacy', '2024-03-10 12:00:00', '2024-03-10 12:00:00', 12, 'legacy_session_total');
    `);
    expect((await getSandboxUsage(db, start, end)).hero).toEqual({ totalActiveSeconds: 27 });
    expect((await getSandboxUsage(db, start, end, 'u1')).byUser).toEqual([
      expect.objectContaining({ userId: 'u1', activeSeconds: 17 }),
    ]);
  });

  it('uses the workflow execution session relationship and supports no workflow rows', async () => {
    expect(await getUsageByWorkflowModel(db, start, end)).toEqual([]);
    sqlite.exec(`
      INSERT INTO workflows (id, user_id, slug, name, data) VALUES ('w1', 'u1', 'wf', 'Workflow', '{}');
      INSERT INTO triggers (id, user_id, workflow_id, name, type, config) VALUES ('t1', 'u1', 'w1', 'Manual', 'manual', '{}');
      INSERT INTO workflow_executions (id, workflow_id, user_id, trigger_id, status, trigger_type, started_at, session_id)
      VALUES ('we1', 'w1', 'u1', 't1', 'completed', 'manual', '${start}', 's1');
    `);
    expect(await getUsageByWorkflowModel(db, start, end)).toEqual([
      expect.objectContaining({ workflowId: 'w1', workflowName: 'Workflow', triggerType: 'manual', model: 'model-a', inputTokens: 10 }),
    ]);
  });

  it('applies personal scope to totals and every breakdown', async () => {
    expect(await getUsageHeroStats(db, start, end, 'u1')).toMatchObject({ totalInputTokens: 10, totalUsers: 1 });
    expect(await getUsageByDay(db, start, end, 'u1')).toHaveLength(1);
    expect(await getUsageByPurposeModel(db, start, end, 'u1')).toEqual([expect.objectContaining({ purpose: 'interactive', inputTokens: 10 })]);
    expect((await getSandboxUsage(db, start, end, 'u1')).hero).toEqual({ totalActiveSeconds: 5 });
  });
});
