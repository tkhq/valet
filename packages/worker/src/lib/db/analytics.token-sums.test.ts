import { describe, expect, it, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb, createD1TestShim } from '../../test-utils/db.js';
import { getUsageByDay, getUsageByUserModel, getUsageByPurposeModel, billableInputTokens, billableOutputTokens } from './analytics.js';

/**
 * The usage queries return the RAW five-way token breakdown (uncached input,
 * visible output, cache reads, cache writes, reasoning) rather than pre-folded
 * billable totals, so routes can price each tier at its own rate. These tests
 * run the real SQL against SQLite to lock in that contract.
 */

function exec(sqlite: BetterSqlite3.Database, sql: string, ...args: unknown[]) {
  sqlite.prepare(sql).run(...args);
}

describe('usage token sums', () => {
  let sqlite: BetterSqlite3.Database;
  let db: D1Database;
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    db = createD1TestShim(sqlite);
    exec(sqlite, `INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com')`);
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose) VALUES ('s1', 'u1', 'ws', 'active', 'orchestrator')`);
    const insert = `INSERT INTO analytics_events (id, event_type, session_id, user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at) VALUES (?, 'llm_call', 's1', 'u1', ?, ?, ?, ?, ?, ?, ?)`;
    exec(sqlite, insert, 'e1', 'anthropic/claude-sonnet-4-5', 100, 50, 10_000, 500, 0, past);
    exec(sqlite, insert, 'e2', 'anthropic/claude-sonnet-4-5', 200, 150, 20_000, 1_500, 25, past);
    // NULL token columns must coalesce to 0, not poison the sums.
    exec(sqlite, `INSERT INTO analytics_events (id, event_type, session_id, user_id, model, created_at) VALUES ('e3', 'llm_call', 's1', 'u1', 'anthropic/claude-sonnet-4-5', ?)`, past);
  });

  const expected = {
    inputTokens: 300,
    outputTokens: 200,
    cacheReadTokens: 30_000,
    cacheWriteTokens: 2_000,
    reasoningTokens: 25,
  };

  it('getUsageByDay returns raw per-tier sums', async () => {
    const rows = await getUsageByDay(db, windowStart);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(expected);
  });

  it('getUsageByUserModel returns raw per-tier sums', async () => {
    const rows = await getUsageByUserModel(db, windowStart);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 'u1', callCount: 3, ...expected });
  });

  it('getUsageByPurposeModel returns raw per-tier sums', async () => {
    const rows = await getUsageByPurposeModel(db, windowStart);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'orchestrator', ...expected });
  });

  it('billable helpers compose display totals from the raw tiers', () => {
    expect(billableInputTokens(expected)).toBe(32_300);
    expect(billableOutputTokens(expected)).toBe(225);
  });
});
