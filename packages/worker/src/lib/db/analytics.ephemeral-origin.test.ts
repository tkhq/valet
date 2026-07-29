import { describe, expect, it, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb, createD1TestShim } from '../../test-utils/db.js';
import { getUsageByPurposeModel, getUsageByModel, getUsageHeroStats } from './analytics.js';

/**
 * Usage burned by ephemeral OpenCode sessions (memory-flush forks, review
 * sessions) is billed to the key like any other call, so it must appear in the
 * totals — but it is not conversation work, so the origin split breaks it out
 * rather than folding it into the parent session's purpose.
 */

function exec(sqlite: BetterSqlite3.Database, sql: string, ...args: unknown[]) {
  sqlite.prepare(sql).run(...args);
}

describe('ephemeral-session usage origin', () => {
  let sqlite: BetterSqlite3.Database;
  let db: D1Database;
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const MODEL = 'anthropic/claude-sonnet-4-5';

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    db = createD1TestShim(sqlite);
    exec(sqlite, `INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com')`);
    exec(sqlite, `INSERT INTO sessions (id, user_id, workspace, status, purpose) VALUES ('s1', 'u1', 'ws', 'active', 'orchestrator')`);

    const insert = `INSERT INTO analytics_events
      (id, event_type, session_id, user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, properties, created_at)
      VALUES (?, 'llm_call', 's1', 'u1', ?, ?, ?, ?, ?, 0, ?, ?)`;
    // The session's own conversation.
    exec(sqlite, insert, 'e1', MODEL, 100, 50, 10_000, 500, JSON.stringify({ oc_message_id: 'm1' }), past);
    // A memory-flush fork billed against the same session.
    exec(sqlite, insert, 'e2', MODEL, 10, 5, 90_000, 0,
      JSON.stringify({ oc_message_id: 'm2', usage_kind: 'memory_flush', ephemeral_session_id: 'ses_fork' }), past);
    // An automatic review session.
    exec(sqlite, insert, 'e3', MODEL, 1, 2, 3_000, 0,
      JSON.stringify({ oc_message_id: 'm3', usage_kind: 'review', ephemeral_session_id: 'ses_review' }), past);
  });

  it('splits ephemeral usage into its own origin instead of the session purpose', async () => {
    const rows = await getUsageByPurposeModel(db, windowStart);
    const byPurpose = Object.fromEntries(rows.map((r) => [r.purpose, r]));

    expect(Object.keys(byPurpose).sort()).toEqual(['memory_flush', 'orchestrator', 'review']);
    // The orchestrator row keeps ONLY its own conversation.
    expect(byPurpose.orchestrator).toMatchObject({
      callCount: 1, inputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 500,
    });
    expect(byPurpose.memory_flush).toMatchObject({ callCount: 1, cacheReadTokens: 90_000 });
    expect(byPurpose.review).toMatchObject({ callCount: 1, cacheReadTokens: 3_000 });
  });

  it('still counts ephemeral usage in the overall totals', async () => {
    // Surfacing this spend is the point — it must not vanish from the top line.
    const byModel = await getUsageByModel(db, windowStart);
    expect(byModel).toHaveLength(1);
    expect(byModel[0]).toMatchObject({
      model: MODEL, callCount: 3, inputTokens: 111, cacheReadTokens: 103_000,
    });

    const hero = await getUsageHeroStats(db, windowStart);
    // billable input = uncached + cache read + cache write across all three rows
    expect(hero.totalInputTokens).toBe(111 + 103_000 + 500);
  });

  it('keeps rows with no usage_kind on their session purpose', async () => {
    exec(sqlite, `DELETE FROM analytics_events WHERE id IN ('e2','e3')`);
    const rows = await getUsageByPurposeModel(db, windowStart);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe('orchestrator');
  });
});
