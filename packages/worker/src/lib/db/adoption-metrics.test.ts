import { describe, expect, it, beforeEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import type { D1Database } from '@cloudflare/workers-types';
import { createTestDb, createD1TestShim } from '../../test-utils/db.js';
import {
  getActiveUsersByDay,
  getActiveUsersByWeek,
  getReturningUserStats,
  getTotalUserCount,
  getEnabledTriggerCounts,
  getWorkflowRunsByDay,
  getChannelBreadth,
  getServiceBreadth,
  getChannelStickiness,
  type ChannelStickinessRow,
  getActionsPerPromptByChannel,
  type ActionsPerPromptRow,
  getWorkflowAutonomyStats,
  getWorkflowOutcomesByWorkflow,
  getWorkflowOutcomesByTriggerType,
  getWorkflowFailureReasons,
  getWorkflowDurationStats,
} from './adoption-metrics.js';
import { getFileChangeTotals } from './dashboard.js';

// Fixed [start, end) window. Workflow/invocation seeds mix ISO and SQLite
// datetime formats to lock in the datetime() normalisation, matching the
// value-metrics fixture conventions.
const START = '2026-07-01T00:00:00.000Z';
const END = '2026-07-15T00:00:00.000Z';

function exec(sqlite: BetterSqlite3.Database, sql: string, ...args: unknown[]) {
  sqlite.prepare(sql).run(...args);
}

function seedUser(sqlite: BetterSqlite3.Database, id: string) {
  exec(sqlite, `INSERT INTO users (id, email) VALUES (?, ?)`, id, `${id}@example.com`);
}

function seedSession(sqlite: BetterSqlite3.Database, id: string, userId = 'u1', opts: { createdAt?: string; purpose?: string } = {}) {
  exec(
    sqlite,
    `INSERT INTO sessions (id, user_id, workspace, status, purpose, created_at, last_active_at)
     VALUES (?, ?, 'w', 'active', ?, ?, ?)`,
    id,
    userId,
    opts.purpose ?? 'interactive',
    opts.createdAt ?? '2026-07-01T00:00:00.000Z',
    opts.createdAt ?? '2026-07-01T00:00:00.000Z',
  );
}

function seedEvent(
  sqlite: BetterSqlite3.Database,
  opts: { id: string; type?: string; sessionId?: string; userId?: string | null; channel?: string | null; createdAt: string },
) {
  exec(
    sqlite,
    `INSERT INTO analytics_events (id, event_type, session_id, user_id, channel, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    opts.id,
    opts.type ?? 'turn_complete',
    opts.sessionId ?? 's1',
    opts.userId === undefined ? 'u1' : opts.userId,
    opts.channel ?? null,
    opts.createdAt,
  );
}

function seedExecution(
  sqlite: BetterSqlite3.Database,
  opts: {
    id: string;
    status: string;
    mode?: string;
    triggerType?: string;
    workflowId?: string | null;
    startedAt: string;
    completedAt?: string | null;
    cancelledAt?: string | null;
    error?: string | null;
    userId?: string;
  },
) {
  exec(
    sqlite,
    `INSERT INTO workflow_executions (id, workflow_id, user_id, status, trigger_type, mode, started_at, completed_at, cancelled_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    opts.id,
    opts.workflowId ?? null,
    opts.userId ?? 'u1',
    opts.status,
    opts.triggerType ?? 'manual',
    opts.mode ?? 'production',
    opts.startedAt,
    opts.completedAt ?? null,
    opts.cancelledAt ?? null,
    opts.error ?? null,
  );
}

function seedInvocation(
  sqlite: BetterSqlite3.Database,
  opts: {
    id: string;
    executionId?: string | null;
    sessionId?: string | null;
    service?: string;
    status?: string;
    resolvedBy?: string | null;
    resolvedAt?: string | null;
    createdAt: string;
  },
) {
  exec(
    sqlite,
    `INSERT INTO action_invocations (id, session_id, workflow_execution_id, user_id, service, action_id, risk_level, resolved_mode, status, resolved_by, resolved_at, created_at)
     VALUES (?, ?, ?, 'u1', ?, 'act', 'high', 'require_approval', ?, ?, ?, ?)`,
    opts.id,
    opts.sessionId ?? null,
    opts.executionId ?? null,
    opts.service ?? 'github',
    opts.status ?? 'executed',
    opts.resolvedBy ?? null,
    opts.resolvedAt ?? null,
    opts.createdAt,
  );
}

describe('adoption-metrics db helpers', () => {
  let sqlite: BetterSqlite3.Database;
  let db: D1Database;

  beforeEach(() => {
    ({ sqlite } = createTestDb());
    db = createD1TestShim(sqlite);
    for (const u of ['u1', 'u2', 'u3']) seedUser(sqlite, u);
    seedSession(sqlite, 's1');
  });

  describe('active users', () => {
    beforeEach(() => {
      // u1: active in two distinct weeks. u2: one week, two days. u3: never.
      seedEvent(sqlite, { id: 'e1', userId: 'u1', createdAt: '2026-07-02T10:00:00.000Z' }); // week W26
      seedEvent(sqlite, { id: 'e2', userId: 'u1', createdAt: '2026-07-02T11:00:00.000Z' }); // same day, dedupes
      seedEvent(sqlite, { id: 'e3', userId: 'u1', createdAt: '2026-07-09T10:00:00.000Z' }); // week W27
      seedEvent(sqlite, { id: 'e4', userId: 'u2', createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'e5', userId: 'u2', createdAt: '2026-07-03T10:00:00.000Z' });
      // Unattributed and out-of-window events never count.
      seedEvent(sqlite, { id: 'e6', userId: null, createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'e7', userId: 'u3', createdAt: '2026-06-01T10:00:00.000Z' });
    });

    it('counts DISTINCT users per day, not events', async () => {
      const days = await getActiveUsersByDay(db, START, END);
      expect(days).toEqual([
        { bucket: '2026-07-02', users: 2 }, // u1 (two events, one user) + u2
        { bucket: '2026-07-03', users: 1 },
        { bucket: '2026-07-09', users: 1 },
      ]);
    });

    it('counts DISTINCT users per week', async () => {
      const weeks = await getActiveUsersByWeek(db, START, END);
      expect(weeks).toHaveLength(2);
      expect(weeks[0]!.users).toBe(2); // u1 + u2
      expect(weeks[1]!.users).toBe(1); // u1 only
    });

    it('returning = active in more than one distinct week', async () => {
      const stats = await getReturningUserStats(db, START, END);
      expect(stats.activeUsers).toBe(2); // u1 + u2 (null user and out-of-window u3 excluded)
      expect(stats.returningUsers).toBe(1); // only u1 spans two weeks
    });
  });

  describe('getTotalUserCount', () => {
    it('counts all registered users, not just active ones', async () => {
      // beforeEach already seeded u1, u2, u3 with no activity.
      expect(await getTotalUserCount(db)).toBe(3);
      seedUser(sqlite, 'u4');
      expect(await getTotalUserCount(db)).toBe(4);
    });
  });

  describe('getEnabledTriggerCounts', () => {
    it('counts only enabled triggers, grouped by type', async () => {
      const insert = `INSERT INTO triggers (id, user_id, name, enabled, type, config) VALUES (?, 'u1', ?, ?, ?, '{}')`;
      exec(sqlite, insert, 't1', 'daily sweep', 1, 'schedule');
      exec(sqlite, insert, 't2', 'weekly digest', 1, 'schedule');
      exec(sqlite, insert, 't3', 'on push', 1, 'webhook');
      exec(sqlite, insert, 't4', 'manual run', 1, 'manual');
      exec(sqlite, insert, 't5', 'disabled sweep', 0, 'schedule');

      const rows = await getEnabledTriggerCounts(db);
      const byType = new Map(rows.map((r) => [r.type, r.count]));
      expect(byType.get('schedule')).toBe(2);
      expect(byType.get('webhook')).toBe(1);
      expect(byType.get('manual')).toBe(1);
    });
  });

  describe('getWorkflowRunsByDay', () => {
    it('buckets production runs by start day and excludes mode=test', async () => {
      seedExecution(sqlite, { id: 'wx1', status: 'completed', startedAt: '2026-07-02 10:00:00', completedAt: '2026-07-02 10:10:00' });
      seedExecution(sqlite, { id: 'wx2', status: 'running', startedAt: '2026-07-02T18:00:00.000Z' });
      seedExecution(sqlite, { id: 'wx3', status: 'failed', startedAt: '2026-07-04T10:00:00.000Z', completedAt: '2026-07-04T10:05:00.000Z' });
      seedExecution(sqlite, { id: 'wx-test', status: 'completed', mode: 'test', startedAt: '2026-07-02T10:00:00.000Z', completedAt: '2026-07-02T10:10:00.000Z' });
      seedExecution(sqlite, { id: 'wx-old', status: 'completed', startedAt: '2026-06-01 10:00:00', completedAt: '2026-06-01 10:10:00' });

      const rows = await getWorkflowRunsByDay(db, START, END);
      expect(rows).toEqual([
        { day: '2026-07-02', runs: 2 },
        { day: '2026-07-04', runs: 1 },
      ]);
    });
  });

  describe('surface breadth', () => {
    it('counts channels from turn_complete rows only', async () => {
      seedEvent(sqlite, { id: 'c1', channel: 'slack', createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'c2', channel: 'slack', createdAt: '2026-07-03T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'c3', channel: 'web', createdAt: '2026-07-03T11:00:00.000Z' });
      seedEvent(sqlite, { id: 'c4', channel: null, createdAt: '2026-07-03T12:00:00.000Z' });
      seedEvent(sqlite, { id: 'c5', type: 'llm_call', channel: 'telegram', createdAt: '2026-07-03T13:00:00.000Z' });
      seedEvent(sqlite, { id: 'c6', channel: 'telegram', createdAt: '2026-06-01T10:00:00.000Z' });

      const rows = await getChannelBreadth(db, START, END);
      expect(rows).toEqual([
        { channel: 'slack', turns: 2 },
        { channel: 'web', turns: 1 },
      ]);
    });

    it('counts services from action_invocations, excluding test-mode workflow rows', async () => {
      seedExecution(sqlite, { id: 'wx-t', status: 'completed', mode: 'test', startedAt: '2026-07-02 00:00:00', completedAt: '2026-07-02 00:10:00' });
      seedInvocation(sqlite, { id: 'i1', sessionId: 's1', service: 'github', createdAt: '2026-07-02T10:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i2', sessionId: 's1', service: 'github', createdAt: '2026-07-03 10:00:00' });
      seedInvocation(sqlite, { id: 'i3', sessionId: 's1', service: 'slack', createdAt: '2026-07-03T11:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i4', executionId: 'wx-t', service: 'linear', createdAt: '2026-07-02T10:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i5', sessionId: 's1', service: 'notion', createdAt: '2026-06-01T10:00:00.000Z' });

      const rows = await getServiceBreadth(db, START, END);
      expect(rows).toEqual([
        { service: 'github', invocations: 2 },
        { service: 'slack', invocations: 1 },
      ]);
    });

    it('computes DAU (latest day in window) and MAU (whole window) per channel', async () => {
      // Latest day in this window is 07-03. slack: u1 active both days, u2 only day 1.
      // telegram: u3 only on day 1 — present in MAU, absent from the latest-day DAU.
      seedEvent(sqlite, { id: 'st1', userId: 'u1', channel: 'slack', createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'st2', userId: 'u1', channel: 'slack', createdAt: '2026-07-03T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'st3', userId: 'u2', channel: 'slack', createdAt: '2026-07-02T11:00:00.000Z' });
      seedEvent(sqlite, { id: 'st4', userId: 'u3', channel: 'telegram', createdAt: '2026-07-02T12:00:00.000Z' });
      // Excluded: non-turn_complete event, null channel, out-of-window event.
      seedEvent(sqlite, { id: 'st5', type: 'llm_call', userId: 'u1', channel: 'slack', createdAt: '2026-07-03T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'st6', userId: 'u2', channel: null, createdAt: '2026-07-03T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'st7', userId: 'u3', channel: 'telegram', createdAt: '2026-06-01T10:00:00.000Z' });

      const rows = await getChannelStickiness(db, START, END);
      expect(rows).toEqual([
        { channel: 'slack', dau: 1, mau: 2 },
        { channel: 'telegram', dau: 0, mau: 1 },
      ]);
    });

    it('returns an empty array when there is no channel activity', async () => {
      expect(await getChannelStickiness(db, START, END)).toEqual([]);
    });
  });

  describe('getActionsPerPromptByChannel', () => {
    it('buckets tool_exec and turn_complete counts per day and channel', async () => {
      seedEvent(sqlite, { id: 'ap1', type: 'tool_exec', channel: 'slack', createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'ap2', type: 'tool_exec', channel: 'slack', createdAt: '2026-07-02T10:01:00.000Z' });
      seedEvent(sqlite, { id: 'ap3', type: 'tool_exec', channel: 'slack', createdAt: '2026-07-02T10:02:00.000Z' });
      seedEvent(sqlite, { id: 'ap4', type: 'turn_complete', channel: 'slack', createdAt: '2026-07-02T10:03:00.000Z' });
      // A channel with turns but zero tool calls that day — division-by-zero
      // is a frontend concern (backend just reports the raw counts).
      seedEvent(sqlite, { id: 'ap5', type: 'turn_complete', channel: 'web', createdAt: '2026-07-02T11:00:00.000Z' });
      seedEvent(sqlite, { id: 'ap6', type: 'turn_complete', channel: 'web', createdAt: '2026-07-02T11:05:00.000Z' });
      // Excluded: null channel, unrelated event type, out-of-window.
      seedEvent(sqlite, { id: 'ap7', type: 'tool_exec', channel: null, createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'ap8', type: 'llm_call', channel: 'slack', createdAt: '2026-07-02T10:00:00.000Z' });
      seedEvent(sqlite, { id: 'ap9', type: 'tool_exec', channel: 'slack', createdAt: '2026-06-01T10:00:00.000Z' });

      const rows = await getActionsPerPromptByChannel(db, START, END);
      expect(rows).toEqual([
        { day: '2026-07-02', channel: 'slack', toolExecs: 3, turns: 1 },
        { day: '2026-07-02', channel: 'web', toolExecs: 0, turns: 2 },
      ]);
    });
  });

  describe('getWorkflowAutonomyStats', () => {
    beforeEach(() => {
      // Completed, zero invocations at all → unattended.
      seedExecution(sqlite, { id: 'wx-clean', status: 'completed', startedAt: '2026-07-02 10:00:00', completedAt: '2026-07-02 10:30:00' });
      // Completed with ONLY policy auto-allow rows (status=executed, no
      // resolver) → still unattended: resolved_by, not status, is the signal.
      seedExecution(sqlite, { id: 'wx-auto', status: 'completed', startedAt: '2026-07-03T10:00:00.000Z', completedAt: '2026-07-03T10:20:00.000Z' });
      seedInvocation(sqlite, { id: 'a-auto1', executionId: 'wx-auto', status: 'executed', createdAt: '2026-07-03T10:05:00.000Z' });
      seedInvocation(sqlite, { id: 'a-auto2', executionId: 'wx-auto', status: 'executed', createdAt: '2026-07-03T10:10:00.000Z' });
      // Completed but a human approved one gate → attended. Blocked 30m.
      seedExecution(sqlite, { id: 'wx-human', status: 'completed', startedAt: '2026-07-04T10:00:00.000Z', completedAt: '2026-07-04T11:00:00.000Z' });
      seedInvocation(sqlite, { id: 'a-h1', executionId: 'wx-human', status: 'executed', resolvedBy: 'u2', resolvedAt: '2026-07-04T10:40:00.000Z', createdAt: '2026-07-04T10:10:00.000Z' });
      // Failed after cancel-cleanup flipped a pending gate to failed with no
      // resolver → NOT attended (status='failed' is not a human decision).
      seedExecution(sqlite, { id: 'wx-cancelflip', status: 'failed', startedAt: '2026-07-05 10:00:00', completedAt: '2026-07-05 10:10:00', error: 'x' });
      seedInvocation(sqlite, { id: 'a-flip', executionId: 'wx-cancelflip', status: 'failed', createdAt: '2026-07-05 10:05:00' });
      // Cancelled run with a human denial → attended. Blocked 10m.
      seedExecution(sqlite, { id: 'wx-denied', status: 'cancelled', startedAt: '2026-07-06T10:00:00.000Z', cancelledAt: '2026-07-06T10:30:00.000Z' });
      seedInvocation(sqlite, { id: 'a-deny', executionId: 'wx-denied', status: 'denied', resolvedBy: 'u2', resolvedAt: '2026-07-06T10:20:00.000Z', createdAt: '2026-07-06T10:10:00.000Z' });
      // Excluded: test mode (even human-resolved), still running, out of window.
      seedExecution(sqlite, { id: 'wx-test', status: 'completed', mode: 'test', startedAt: '2026-07-02T10:00:00.000Z', completedAt: '2026-07-02T10:10:00.000Z' });
      seedInvocation(sqlite, { id: 'a-test', executionId: 'wx-test', status: 'executed', resolvedBy: 'u2', resolvedAt: '2026-07-02T10:05:00.000Z', createdAt: '2026-07-02T10:02:00.000Z' });
      seedExecution(sqlite, { id: 'wx-running', status: 'running', startedAt: '2026-07-02T10:00:00.000Z' });
      seedExecution(sqlite, { id: 'wx-old', status: 'completed', startedAt: '2026-06-01 10:00:00', completedAt: '2026-06-01 10:30:00' });
    });

    it('classifies attended vs unattended by resolved_by, never by status', async () => {
      const stats = await getWorkflowAutonomyStats(db, START, END);
      expect(stats.terminalRuns).toBe(5);
      expect(stats.completedRuns).toBe(3);
      expect(stats.failedRuns).toBe(1);
      expect(stats.cancelledRuns).toBe(1);
      // wx-clean + wx-auto: auto-allow executed rows are NOT human decisions.
      expect(stats.unattendedCompletedRuns).toBe(2);
      // wx-human + wx-denied only; wx-cancelflip's resolver-less failed row
      // must not count as an intervention.
      expect(stats.attendedRuns).toBe(2);
      // Blocked minutes [10, 30] → lower-middle median 10.
      expect(stats.medianBlockedMinutes).toBeCloseTo(10, 3);
    });

    it('excludes mode=test runs even when human-resolved', async () => {
      const stats = await getWorkflowAutonomyStats(db, START, END);
      // If wx-test leaked in, terminal would be 6 and attended 3.
      expect(stats.terminalRuns).toBe(5);
      expect(stats.attendedRuns).toBe(2);
    });
  });

  describe('workflow outcomes', () => {
    beforeEach(() => {
      exec(sqlite, `INSERT INTO workflows (id, user_id, name, data) VALUES ('wf1', 'u1', 'Daily digest', '{}')`);
      seedExecution(sqlite, { id: 'o1', workflowId: 'wf1', status: 'completed', triggerType: 'schedule', startedAt: '2026-07-02 10:00:00', completedAt: '2026-07-02 10:30:00' });
      seedExecution(sqlite, { id: 'o2', workflowId: 'wf1', status: 'failed', triggerType: 'schedule', startedAt: '2026-07-03T10:00:00.000Z', completedAt: '2026-07-03T10:05:00.000Z', error: 'LLM call timed out after 120s' });
      seedExecution(sqlite, { id: 'o3', workflowId: null, status: 'cancelled', triggerType: 'manual', startedAt: '2026-07-04T10:00:00.000Z', cancelledAt: '2026-07-04T10:10:00.000Z' });
      seedExecution(sqlite, { id: 'o4', workflowId: 'wf1', status: 'failed', triggerType: 'webhook', startedAt: '2026-07-05T10:00:00.000Z', completedAt: '2026-07-05T10:01:00.000Z', error: 'fetch failed: ECONNRESET' });
      seedExecution(sqlite, { id: 'o5', workflowId: 'wf1', status: 'failed', triggerType: 'webhook', startedAt: '2026-07-06T10:00:00.000Z', completedAt: '2026-07-06T10:01:00.000Z', error: null });
      seedExecution(sqlite, { id: 'o-test', workflowId: 'wf1', status: 'failed', mode: 'test', triggerType: 'schedule', startedAt: '2026-07-02T10:00:00.000Z', completedAt: '2026-07-02T10:01:00.000Z', error: 'timeout' });
    });

    it('groups terminal production runs per workflow, naming deleted workflows', async () => {
      const rows = await getWorkflowOutcomesByWorkflow(db, START, END);
      expect(rows).toEqual([
        { workflowId: 'wf1', name: 'Daily digest', completed: 1, failed: 3, cancelled: 0 },
        { workflowId: null, name: 'Deleted workflow', completed: 0, failed: 0, cancelled: 1 },
      ]);
    });

    it('groups per trigger type', async () => {
      const rows = await getWorkflowOutcomesByTriggerType(db, START, END);
      const byType = new Map(rows.map((r) => [r.triggerType, r]));
      expect(byType.get('schedule')).toMatchObject({ completed: 1, failed: 1 });
      expect(byType.get('webhook')).toMatchObject({ completed: 0, failed: 2 });
      expect(byType.get('manual')).toMatchObject({ cancelled: 1 });
    });

    it('buckets failure reasons coarsely and excludes test runs', async () => {
      const rows = await getWorkflowFailureReasons(db, START, END);
      const byReason = new Map(rows.map((r) => [r.reason, r.runs]));
      expect(byReason.get('timeout')).toBe(1);
      expect(byReason.get('network')).toBe(1);
      expect(byReason.get('unspecified')).toBe(1);
      expect(rows.reduce((s, r) => s + r.runs, 0)).toBe(3); // o-test excluded
    });
  });

  describe('getWorkflowDurationStats', () => {
    it('measures absolute duration over terminal production runs', async () => {
      // Durations: 10, 20, 30, 60 minutes.
      seedExecution(sqlite, { id: 'd1', status: 'completed', startedAt: '2026-07-02 10:00:00', completedAt: '2026-07-02 10:10:00' });
      seedExecution(sqlite, { id: 'd2', status: 'completed', startedAt: '2026-07-03T10:00:00.000Z', completedAt: '2026-07-03T10:20:00.000Z' });
      seedExecution(sqlite, { id: 'd3', status: 'failed', startedAt: '2026-07-04T10:00:00.000Z', completedAt: '2026-07-04T10:30:00.000Z' });
      seedExecution(sqlite, { id: 'd4', status: 'cancelled', startedAt: '2026-07-05T10:00:00.000Z', cancelledAt: '2026-07-05T11:00:00.000Z' });
      // No terminal timestamp at all → unmeasurable, excluded.
      seedExecution(sqlite, { id: 'd5', status: 'cancelled', startedAt: '2026-07-06T10:00:00.000Z' });
      // Test mode excluded.
      seedExecution(sqlite, { id: 'd-test', status: 'completed', mode: 'test', startedAt: '2026-07-02T10:00:00.000Z', completedAt: '2026-07-02T20:00:00.000Z' });

      const stats = await getWorkflowDurationStats(db, START, END);
      expect(stats.measuredRuns).toBe(4);
      // Nearest-rank: median of [10, 20, 30, 60] → lower-middle 20; p95 → 60.
      expect(stats.medianRunMinutes).toBeCloseTo(20, 3);
      expect(stats.p95RunMinutes).toBeCloseTo(60, 3);
    });

    it('returns nulls, not zeros, when nothing is measurable', async () => {
      const stats = await getWorkflowDurationStats(db, START, END);
      expect(stats.measuredRuns).toBe(0);
      expect(stats.medianRunMinutes).toBeNull();
      expect(stats.p95RunMinutes).toBeNull();
    });
  });

  describe('getFileChangeTotals (dashboard fix)', () => {
    it('sums real additions+deletions from session_files_changed — not toolCalls*15', async () => {
      exec(sqlite, `UPDATE sessions SET tool_call_count = 100 WHERE id = 's1'`); // would fabricate 1500 under the old formula
      seedSession(sqlite, 's2', 'u2');
      seedSession(sqlite, 's-wf', 'u1', { purpose: 'workflow' });
      seedSession(sqlite, 's-old', 'u1', { createdAt: '2026-06-01T00:00:00.000Z' });
      const insert = `INSERT INTO session_files_changed (id, session_id, file_path, status, additions, deletions) VALUES (?, ?, ?, 'modified', ?, ?)`;
      exec(sqlite, insert, 'f1', 's1', 'a.ts', 10, 5);
      exec(sqlite, insert, 'f2', 's1', 'b.ts', 3, 0);
      exec(sqlite, insert, 'f3', 's2', 'c.ts', 7, 2);
      exec(sqlite, insert, 'f4', 's-wf', 'd.ts', 100, 100); // workflow-purpose excluded
      exec(sqlite, insert, 'f5', 's-old', 'e.ts', 50, 50); // out of period

      const org = await getFileChangeTotals(db, START);
      expect(org.lines_changed).toBe(27); // 15 + 3 + 9 — the real diff, not 1500
      expect(org.files_changed).toBe(3);

      const u1 = await getFileChangeTotals(db, START, 'u1');
      expect(u1.lines_changed).toBe(18);
      expect(u1.files_changed).toBe(2);
    });

    it('returns honest zeros when no file changes were recorded', async () => {
      const totals = await getFileChangeTotals(db, START);
      expect(totals).toEqual({ files_changed: 0, lines_changed: 0 });
    });
  });
});
