import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1TestShim, createTestDb } from '../../test-utils/db.js';
import { getUsageHeroStats, getUsageByDay, getUsageByPurposeModel, getSandboxHeroStats, getSandboxByDay, getSandboxByUser } from './analytics.js';

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
        ('s1', 'u1', 'ws', 'active', 'interactive', 10, '2024-03-01 00:00:00'),
        ('s2', 'u2', 'ws', 'active', 'orchestrator', 20, '2024-03-31 23:59:59'),
        ('s3', 'u1', 'ws', 'active', 'interactive', 40, '2024-04-01 00:00:00');
      INSERT INTO analytics_events (id, event_type, session_id, user_id, model, input_tokens, output_tokens, created_at) VALUES
        ('at-start', 'llm_call', 's1', 'u1', 'model-a', 10, 1, '${start}'),
        ('before-end', 'llm_call', 's2', 'u2', 'model-a', 20, 2, '2024-03-31T23:59:59.999Z'),
        ('at-end', 'llm_call', 's3', 'u1', 'model-a', 40, 4, '${end}');
    `);
  });

  it('includes start and excludes end consistently across aggregates and breakdowns', async () => {
    expect(await getUsageHeroStats(db, start, end)).toMatchObject({ totalInputTokens: 30, totalOutputTokens: 3, totalUsers: 2 });
    expect((await getUsageByDay(db, start, end)).reduce((sum, row) => sum + row.inputTokens, 0)).toBe(30);
    expect((await getUsageByPurposeModel(db, start, end)).map((row) => row.purpose).sort()).toEqual(['interactive', 'orchestrator']);
    expect(await getSandboxHeroStats(db, start, end)).toEqual({ totalActiveSeconds: 30 });
  });

  it('uses production SQLite timestamps for all sandbox aggregates at month boundaries', async () => {
    sqlite.exec(`
      INSERT INTO sessions (id, user_id, workspace, status, purpose, active_seconds, created_at) VALUES
        ('feb-start', 'u1', 'ws', 'active', 'interactive', 5, '2024-02-01 00:00:00'),
        ('feb-end', 'u2', 'ws', 'active', 'interactive', 7, '2024-02-29 23:59:59'),
        ('mar-start', 'u1', 'ws', 'active', 'interactive', 11, '2024-03-01 00:00:00');
    `);
    const febStart = '2024-02-01T00:00:00.000Z';
    const marStart = '2024-03-01T00:00:00.000Z';
    expect(await getSandboxHeroStats(db, febStart, marStart)).toEqual({ totalActiveSeconds: 12 });
    expect(await getSandboxByDay(db, febStart, marStart)).toEqual([
      { date: '2024-02-01', activeSeconds: 5 },
      { date: '2024-02-29', activeSeconds: 7 },
    ]);
    expect(await getSandboxByUser(db, febStart, marStart)).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'u1', activeSeconds: 5 }),
      expect.objectContaining({ userId: 'u2', activeSeconds: 7 }),
    ]));
  });

  it('applies personal scope to totals and every breakdown', async () => {
    expect(await getUsageHeroStats(db, start, end, 'u1')).toMatchObject({ totalInputTokens: 10, totalUsers: 1 });
    expect(await getUsageByDay(db, start, end, 'u1')).toHaveLength(1);
    expect(await getUsageByPurposeModel(db, start, end, 'u1')).toEqual([expect.objectContaining({ purpose: 'interactive', inputTokens: 10 })]);
    expect(await getSandboxHeroStats(db, start, end, 'u1')).toEqual({ totalActiveSeconds: 10 });
  });
});
