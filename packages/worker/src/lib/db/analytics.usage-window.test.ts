import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1TestShim, createTestDb } from '../../test-utils/db.js';
import { getUsageHeroStats, getUsageByDay, getUsageByPurposeModel, getSandboxHeroStats } from './analytics.js';

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
        ('s1', 'u1', 'ws', 'active', 'interactive', 10, '${start}'),
        ('s2', 'u2', 'ws', 'active', 'orchestrator', 20, '2024-03-31T23:59:59.999Z'),
        ('s3', 'u1', 'ws', 'active', 'interactive', 40, '${end}');
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

  it('applies personal scope to totals and every breakdown', async () => {
    expect(await getUsageHeroStats(db, start, end, 'u1')).toMatchObject({ totalInputTokens: 10, totalUsers: 1 });
    expect(await getUsageByDay(db, start, end, 'u1')).toHaveLength(1);
    expect(await getUsageByPurposeModel(db, start, end, 'u1')).toEqual([expect.objectContaining({ purpose: 'interactive', inputTokens: 10 })]);
    expect(await getSandboxHeroStats(db, start, end, 'u1')).toEqual({ totalActiveSeconds: 10 });
  });
});
