import { describe, expect, it, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb, createD1TestShim } from '../../test-utils/db.js';
import { getUsageByModel } from './analytics.js';
import {
  getWorkflowResolutionStats,
  getSessionResolutionStats,
  getApprovalDecisionStats,
  getAgentPrStats,
  getSessionModelPairs,
  getSandboxSecondsInWindow,
  getSessionSourceStats,
} from './value-metrics.js';

// Fixed [start, end) window for every test. Seeds deliberately mix the two
// timestamp formats found in production (Drizzle ISO strings and SQLite
// datetime('now') strings) to lock in the datetime() normalisation.
const START = '2026-07-01T00:00:00.000Z';
const END = '2026-07-08T00:00:00.000Z';

function exec(sqlite: BetterSqlite3.Database, sql: string, ...args: unknown[]) {
  sqlite.prepare(sql).run(...args);
}

function seedSession(
  sqlite: BetterSqlite3.Database,
  opts: {
    id: string;
    status: string;
    createdAt: string;
    lastActiveAt: string;
    purpose?: string;
    isOrchestrator?: number;
    errorMessage?: string | null;
    activeSeconds?: number;
  },
) {
  exec(
    sqlite,
    `INSERT INTO sessions (id, user_id, workspace, status, purpose, is_orchestrator, error_message, active_seconds, created_at, last_active_at)
     VALUES (?, 'u1', 'w', ?, ?, ?, ?, ?, ?, ?)`,
    opts.id,
    opts.status,
    opts.purpose ?? 'interactive',
    opts.isOrchestrator ?? 0,
    opts.errorMessage ?? null,
    opts.activeSeconds ?? 0,
    opts.createdAt,
    opts.lastActiveAt,
  );
}

describe('value-metrics db helpers', () => {
  let sqlite: BetterSqlite3.Database;
  let db: D1Database;

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    db = createD1TestShim(sqlite);
    exec(sqlite, `INSERT INTO users (id, email) VALUES ('u1', 'u1@example.com')`);
  });

  describe('getSessionResolutionStats', () => {
    beforeEach(() => {
      // Resolved, ISO timestamps: 120 minutes of wall clock.
      seedSession(sqlite, { id: 's-resolved-1', status: 'archived', createdAt: '2026-07-02T10:00:00.000Z', lastActiveAt: '2026-07-02T12:00:00.000Z', activeSeconds: 100 });
      // Resolved, SQLite-format timestamps: 30 minutes.
      seedSession(sqlite, { id: 's-resolved-2', status: 'terminated', createdAt: '2026-07-03 08:00:00', lastActiveAt: '2026-07-03 08:30:00', activeSeconds: 200 });
      // Errored.
      seedSession(sqlite, { id: 's-error', status: 'error', createdAt: '2026-07-04T09:00:00.000Z', lastActiveAt: '2026-07-04T09:10:00.000Z', errorMessage: 'boom' });
      // Cleanly closed: 60 minutes.
      seedSession(sqlite, { id: 's-closed', status: 'archived', createdAt: '2026-07-04T09:00:00.000Z', lastActiveAt: '2026-07-04T10:00:00.000Z' });
      // Hibernated is the organic end state — counts as ended+resolved: 45 minutes.
      seedSession(sqlite, { id: 's-hib', status: 'hibernated', createdAt: '2026-07-05T09:00:00.000Z', lastActiveAt: '2026-07-05T09:45:00.000Z' });
      // Excluded: orchestrator, workflow-purpose, out-of-window, still active.
      seedSession(sqlite, { id: 's-orch', status: 'archived', createdAt: '2026-07-02T00:00:00.000Z', lastActiveAt: '2026-07-02T01:00:00.000Z', isOrchestrator: 1, purpose: 'orchestrator' });
      seedSession(sqlite, { id: 's-workflow', status: 'archived', createdAt: '2026-07-02T00:00:00.000Z', lastActiveAt: '2026-07-02T01:00:00.000Z', purpose: 'workflow' });
      seedSession(sqlite, { id: 's-old', status: 'archived', createdAt: '2026-06-20 00:00:00', lastActiveAt: '2026-06-20 01:00:00', activeSeconds: 999 });
      seedSession(sqlite, { id: 's-active', status: 'active', createdAt: '2026-07-05T00:00:00.000Z', lastActiveAt: '2026-07-05T01:00:00.000Z' });
    });

    it('counts resolved/errored/ended', async () => {
      const stats = await getSessionResolutionStats(db, START, END);
      expect(stats.ended).toBe(5);
      expect(stats.resolved).toBe(4);
      expect(stats.errored).toBe(1);
      // Durations [30, 45, 60, 120] → median (lower middle) 45.
      expect(stats.medianResolvedMinutes).toBeCloseTo(45, 3);
    });

    it('respects the window end bound', async () => {
      const stats = await getSessionResolutionStats(db, START, '2026-07-03T00:00:00.000Z');
      expect(stats.ended).toBe(1);
      expect(stats.resolved).toBe(1);
    });

    it('recomputes hibernated sessions live: waking removes a session from the ended pool', async () => {
      // s-hib wakes: the DO flips status away from 'hibernated' immediately
      // (performWake → 'restoring' → 'running'), so the same historical
      // window must stop counting it as ended/resolved.
      exec(sqlite, `UPDATE sessions SET status = 'running' WHERE id = 's-hib'`);
      const stats = await getSessionResolutionStats(db, START, END);
      expect(stats.ended).toBe(4);
      expect(stats.resolved).toBe(3);
      // Durations [30, 60, 120] → median 60 (s-hib's 45 no longer counted).
      expect(stats.medianResolvedMinutes).toBeCloseTo(60, 3);
    });

    it('recomputes hibernated sessions live: re-hibernating re-enters at the new last_active_at', async () => {
      // The woken session settles again later, still inside the window —
      // it re-enters the ended pool once, at its new end time.
      exec(sqlite, `UPDATE sessions SET status = 'running' WHERE id = 's-hib'`);
      exec(sqlite, `UPDATE sessions SET status = 'hibernated', last_active_at = '2026-07-06T10:00:00.000Z' WHERE id = 's-hib'`);
      const stats = await getSessionResolutionStats(db, START, END);
      expect(stats.ended).toBe(5);
      expect(stats.resolved).toBe(4);
      // A re-hibernate AFTER the window end must drop it from this window.
      exec(sqlite, `UPDATE sessions SET last_active_at = '2026-07-09T10:00:00.000Z' WHERE id = 's-hib'`);
      const after = await getSessionResolutionStats(db, START, END);
      expect(after.ended).toBe(4);
    });
  });

  describe('getWorkflowResolutionStats', () => {
    beforeEach(() => {
      const insert = `INSERT INTO workflow_executions (id, user_id, status, trigger_type, mode, started_at, completed_at) VALUES (?, 'u1', ?, 'manual', ?, ?, ?)`;
      exec(sqlite, insert, 'wx-done-1', 'completed', 'production', '2026-07-02 10:00:00', '2026-07-02 10:30:00');
      exec(sqlite, insert, 'wx-done-2', 'completed', 'production', '2026-07-03T10:00:00.000Z', '2026-07-03T11:00:00.000Z');
      // Started before the window but FINISHED inside it — runs are windowed
      // by terminal time, so this counts.
      exec(sqlite, insert, 'wx-boundary', 'completed', 'production', '2026-06-30 23:50:00', '2026-07-01 00:10:00');
      exec(sqlite, insert, 'wx-failed', 'failed', 'production', '2026-07-04 12:00:00', '2026-07-04 12:05:00');
      exec(sqlite, insert, 'wx-cancelled', 'cancelled', 'production', '2026-07-05 12:00:00', null);
      // Excluded: test mode, non-terminal, out of window.
      exec(sqlite, insert, 'wx-test', 'completed', 'test', '2026-07-02 10:00:00', '2026-07-02 10:10:00');
      exec(sqlite, insert, 'wx-running', 'running', 'production', '2026-07-02 10:00:00', null);
      exec(sqlite, insert, 'wx-old', 'completed', 'production', '2026-06-01 10:00:00', '2026-06-01 10:30:00');
    });

    it('counts terminal production runs (by terminal time) and the completed median', async () => {
      const stats = await getWorkflowResolutionStats(db, START, END);
      expect(stats.completed).toBe(3);
      expect(stats.failed).toBe(1);
      expect(stats.terminal).toBe(5);
      // Durations [20, 30, 60] → median 30.
      expect(stats.medianCompletedMinutes).toBeCloseTo(30, 3);
    });
  });

  describe('getApprovalDecisionStats', () => {
    it('counts only human-resolved decisions; auto-policy and cancellation rows are excluded', async () => {
      seedSession(sqlite, { id: 's1', status: 'active', createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z' });
      const human = `INSERT INTO action_invocations (id, session_id, user_id, service, action_id, risk_level, resolved_mode, status, resolved_by, created_at) VALUES (?, 's1', 'u1', ?, ?, 'high', 'require_approval', ?, 'u1', ?)`;
      exec(sqlite, human, 'a1', 'github', 'a', 'approved', '2026-07-02T00:00:00.000Z');
      exec(sqlite, human, 'a2', 'github', 'a', 'executed', '2026-07-02 01:00:00');
      exec(sqlite, human, 'a3', 'github', 'a', 'failed', '2026-07-02T02:00:00.000Z'); // approved, then execution failed
      exec(sqlite, human, 'a4', 'github', 'a', 'denied', '2026-07-02T03:00:00.000Z');
      exec(sqlite, human, 'a7', 'github', 'a', 'approved', '2026-06-01 00:00:00'); // out of window
      // Workflow gate a human approved (shaped like the 0022-migrated rows).
      exec(sqlite, human, 'g1', 'workflow', 'request_approval', 'approved', '2026-07-03T00:00:00.000Z');
      exec(sqlite, human, 'g2', 'workflow', 'request_approval', 'denied', '2026-07-03 01:00:00');

      const auto = `INSERT INTO action_invocations (id, session_id, user_id, service, action_id, risk_level, resolved_mode, status, error, created_at) VALUES (?, 's1', 'u1', 'github', 'a', 'low', ?, ?, ?, ?)`;
      // Policy auto-allow/auto-deny: no human decision, must not count.
      exec(sqlite, auto, 'auto1', 'allow', 'executed', null, '2026-07-02T06:00:00.000Z');
      exec(sqlite, auto, 'auto2', 'allow', 'executed', null, '2026-07-02T07:00:00.000Z');
      exec(sqlite, auto, 'auto3', 'deny', 'denied', null, '2026-07-02T08:00:00.000Z');
      // Workflow cancel-cleanup flips pending gates to failed with no resolver.
      exec(sqlite, auto, 'auto4', 'require_approval', 'failed', 'workflow execution cancelled', '2026-07-02T09:00:00.000Z');
      // Expired and pending rows never carry a resolver.
      exec(sqlite, auto, 'a5', 'require_approval', 'expired', null, '2026-07-02T04:00:00.000Z');
      exec(sqlite, auto, 'a6', 'require_approval', 'pending', null, '2026-07-02T05:00:00.000Z');

      // Gate from a test-mode workflow run: excluded even though human-resolved.
      exec(sqlite, `INSERT INTO workflow_executions (id, user_id, status, trigger_type, mode, started_at) VALUES ('wx-t', 'u1', 'completed', 'manual', 'test', '2026-07-02 00:00:00')`);
      exec(
        sqlite,
        `INSERT INTO action_invocations (id, session_id, user_id, workflow_execution_id, service, action_id, risk_level, resolved_mode, status, resolved_by, created_at) VALUES ('gt', 's1', 'u1', 'wx-t', 'workflow', 'request_approval', 'high', 'require_approval', 'approved', 'u1', '2026-07-03T02:00:00.000Z')`,
      );

      const stats = await getApprovalDecisionStats(db, START, END);
      expect(stats.accepted).toBe(4); // a1 + a2 + a3 + g1
      expect(stats.denied).toBe(2); // a4 + g2
      expect(stats.expired).toBe(1); // a5
    });
  });

  describe('getAgentPrStats', () => {
    beforeEach(() => {
      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) {
        seedSession(sqlite, { id: `s-${id}`, status: 'active', createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z' });
      }
      const insert = `INSERT INTO session_git_state (id, session_id, agent_authored, pr_number, pr_state, pr_created_at, pr_merged_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      exec(sqlite, insert, 'p1', 's-p1', 1, 101, 'merged', '2026-07-02T00:00:00.000Z', '2026-07-02T12:00:00.000Z'); // 12h
      exec(sqlite, insert, 'p2', 's-p2', 1, 102, 'merged', '2026-07-03 00:00:00', '2026-07-04 00:00:00'); // 24h
      exec(sqlite, insert, 'p3', 's-p3', 1, 103, 'closed', '2026-07-03T00:00:00.000Z', null);
      exec(sqlite, insert, 'p4', 's-p4', 1, 104, 'open', '2026-07-04T00:00:00.000Z', null);
      exec(sqlite, insert, 'p5', 's-p5', 1, 105, 'draft', '2026-07-05T00:00:00.000Z', null);
      exec(sqlite, insert, 'p6', 's-p6', 1, 106, 'merged', '2026-06-01 00:00:00', '2026-06-02 00:00:00'); // out of window
      exec(sqlite, insert, 'p7', 's-p7', 0, 107, 'merged', '2026-07-02T00:00:00.000Z', '2026-07-02T06:00:00.000Z'); // human-authored
    });

    it('counts agent-authored PR outcomes and median hours to merge', async () => {
      const stats = await getAgentPrStats(db, START, END);
      expect(stats.opened).toBe(5);
      expect(stats.merged).toBe(2);
      expect(stats.closedUnmerged).toBe(1);
      expect(stats.stillOpen).toBe(2);
      // Hours [12, 24] → median (lower middle) 12.
      expect(stats.medianHoursToMerge).toBeCloseTo(12, 3);
    });
  });

  describe('model usage', () => {
    beforeEach(() => {
      seedSession(sqlite, { id: 's1', status: 'active', createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z' });
      seedSession(sqlite, { id: 's2', status: 'active', createdAt: '2026-07-01T00:00:00.000Z', lastActiveAt: '2026-07-01T00:00:00.000Z' });
      const insert = `INSERT INTO analytics_events (id, event_type, session_id, model, input_tokens, output_tokens, cache_read_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
      exec(sqlite, insert, 'e1', 'llm_call', 's1', 'anthropic/claude-opus-4', 1000, 500, null, '2026-07-02T00:00:00.000Z');
      exec(sqlite, insert, 'e2', 'llm_call', 's1', 'anthropic/claude-haiku-4-5', 2000, 1000, 1000, '2026-07-02T01:00:00.000Z');
      exec(sqlite, insert, 'e3', 'llm_call', 's2', 'anthropic/claude-haiku-4-5', 500, 500, null, '2026-07-02T02:00:00.000Z');
      exec(sqlite, insert, 'e4', 'llm_call', 's1', 'anthropic/claude-opus-4', 9999, 9999, null, '2026-06-01T00:00:00.000Z'); // out of window
      exec(sqlite, insert, 'e5', 'turn_complete', 's1', null, 100, 100, null, '2026-07-02T03:00:00.000Z'); // not an llm_call, no model
      exec(sqlite, insert, 'e6', 'llm_call', 's2', 'anthropic/claude-opus-4', null, null, null, '2026-07-02T04:00:00.000Z'); // zero tokens
    });

    it('aggregates raw per-tier tokens per model within the window', async () => {
      const rows = await getUsageByModel(db, START, END);
      const byModel = new Map(rows.map((r) => [r.model, r]));
      // Raw tiers stay separate so cost math can price cache reads at their
      // own (cheaper) rate: uncached input 2000 + 500, cache reads 1000.
      expect(byModel.get('anthropic/claude-haiku-4-5')).toMatchObject({ inputTokens: 2500, outputTokens: 1500, cacheReadTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 0 });
      expect(byModel.get('anthropic/claude-opus-4')).toMatchObject({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0 });
      expect(rows).toHaveLength(2);
    });

    it('returns distinct session/model pairs with billable usage', async () => {
      const pairs = await getSessionModelPairs(db, START, END);
      const keys = pairs.map((p) => `${p.sessionId}:${p.model}`).sort();
      expect(keys).toEqual([
        's1:anthropic/claude-haiku-4-5',
        's1:anthropic/claude-opus-4',
        's2:anthropic/claude-haiku-4-5',
      ]);
    });
  });

  describe('getSessionSourceStats', () => {
    it('segments ended interactive sessions by git source type', async () => {
      seedSession(sqlite, { id: 'src-pr', status: 'hibernated', createdAt: '2026-07-02T00:00:00.000Z', lastActiveAt: '2026-07-02T01:00:00.000Z' });
      seedSession(sqlite, { id: 'src-issue', status: 'archived', createdAt: '2026-07-03T00:00:00.000Z', lastActiveAt: '2026-07-03T01:00:00.000Z' });
      seedSession(sqlite, { id: 'src-none', status: 'terminated', createdAt: '2026-07-04T00:00:00.000Z', lastActiveAt: '2026-07-04T01:00:00.000Z' });
      // Excluded: still active, orchestrator, out of window.
      seedSession(sqlite, { id: 'src-active', status: 'active', createdAt: '2026-07-05T00:00:00.000Z', lastActiveAt: '2026-07-05T01:00:00.000Z' });
      seedSession(sqlite, { id: 'src-orch', status: 'hibernated', createdAt: '2026-07-05T00:00:00.000Z', lastActiveAt: '2026-07-05T01:00:00.000Z', isOrchestrator: 1, purpose: 'orchestrator' });
      seedSession(sqlite, { id: 'src-old', status: 'archived', createdAt: '2026-06-01 00:00:00', lastActiveAt: '2026-06-01 01:00:00' });
      const git = `INSERT INTO session_git_state (id, session_id, source_type) VALUES (?, ?, ?)`;
      exec(sqlite, git, 'g-pr', 'src-pr', 'pr');
      exec(sqlite, git, 'g-issue', 'src-issue', 'issue');

      const rows = await getSessionSourceStats(db, START, END);
      const bySource = new Map(rows.map((r) => [r.sourceType, r.sessions]));
      expect(bySource.get('pr')).toBe(1);
      expect(bySource.get('issue')).toBe(1);
      expect(bySource.get('none')).toBe(1);
      expect(rows).toHaveLength(3);
    });
  });

  describe('getSandboxSecondsInWindow', () => {
    it('prorates active_seconds by how much of a session lifespan overlaps the window', async () => {
      // Instant sessions fully inside the window attribute fully.
      seedSession(sqlite, { id: 's-in-1', status: 'active', createdAt: '2026-07-02T00:00:00.000Z', lastActiveAt: '2026-07-02T00:00:00.000Z', activeSeconds: 100 });
      seedSession(sqlite, { id: 's-in-2', status: 'active', createdAt: '2026-07-03 00:00:00', lastActiveAt: '2026-07-03 00:00:00', activeSeconds: 200 });
      // Entirely before the window: excluded.
      seedSession(sqlite, { id: 's-out', status: 'active', createdAt: '2026-06-20 00:00:00', lastActiveAt: '2026-06-20 00:00:00', activeSeconds: 999 });
      // Spans the window boundary: 11-day life, 4 days inside → 4/11 of 1100.
      seedSession(sqlite, { id: 's-span', status: 'active', createdAt: '2026-06-24T00:00:00.000Z', lastActiveAt: '2026-07-05T00:00:00.000Z', activeSeconds: 1100 });
      expect(await getSandboxSecondsInWindow(db, START, END)).toBeCloseTo(300 + 400, 1);
    });
  });
});
