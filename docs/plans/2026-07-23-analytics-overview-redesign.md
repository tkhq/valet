# Analytics Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin "Adoption" tab with an "Overview" tab that mirrors the Claude enterprise dashboard's structure (who's using it → how they're using it → how agentic the work is → what it produces → what it costs), built entirely from data Valet already writes.

**Architecture:** Four new read-only D1 query functions in `packages/worker/src/lib/db/adoption-metrics.ts` (one replaces an existing function), wired into the existing `GET /api/analytics/adoption` handler. The frontend replaces `adoption-tab.tsx` with `overview-tab.tsx`, which composes three existing API hooks (`useAnalyticsAdoption`, `useAnalyticsValue`, `useUsageStats`) instead of duplicating cost/spend/PR query logic that the Value and Billing tabs already fetch.

**Tech Stack:** Cloudflare Worker (Hono, D1/SQLite via raw `db.prepare`), Drizzle ORM (schema only, not used for these aggregate queries), React 19 + TanStack Query, Recharts.

## Global Constraints

- No migration, no schema change, no new instrumentation. Every new query reads tables that already exist.
- No time-saved, hours-saved, or efficiency-gained figure anywhere in the new code (see [`docs/specs/2026-07-23-analytics-overview-redesign-design.md`](../specs/2026-07-23-analytics-overview-redesign-design.md) Motivation section).
- Workflow-metric queries exclude `mode='test'` runs and window by when the run reached a terminal state, matching `WORKFLOW_TERMINAL_WHERE` in `packages/worker/src/lib/db/analytics-predicates.ts`.
- `pnpm typecheck` (root) and `cd packages/client && pnpm build` must both pass before the final commit — the client production build uses stricter `tsc` settings than typecheck.
- No `any`, no `as unknown as T` double-casts, no unnecessary `as` assertions (see CLAUDE.md Type Safety rules).
- Never add "Co-Authored-by" trailers mentioning AI models in commits.

---

### Task 1: `getTotalUserCount`

**Files:**
- Modify: `packages/worker/src/lib/db/adoption-metrics.ts` (add function after the "Active users" section, before "Recurring-automation embeddedness")
- Test: `packages/worker/src/lib/db/adoption-metrics.test.ts` (add a new top-level `describe('getTotalUserCount', ...)` block)

**Interfaces:**
- Produces: `export async function getTotalUserCount(db: D1Database): Promise<number>`

- [ ] **Step 1: Write the failing test**

Add this `describe` block right after the existing `describe('active users', ...)` block (before `describe('getEnabledTriggerCounts', ...)`):

```typescript
  describe('getTotalUserCount', () => {
    it('counts all registered users, not just active ones', async () => {
      // beforeEach already seeded u1, u2, u3 with no activity.
      expect(await getTotalUserCount(db)).toBe(3);
      seedUser(sqlite, 'u4');
      expect(await getTotalUserCount(db)).toBe(4);
    });
  });
```

Add `getTotalUserCount` to the import list at the top of the file:

```typescript
import {
  getActiveUsersByDay,
  getActiveUsersByWeek,
  getReturningUserStats,
  getTotalUserCount,
  getEnabledTriggerCounts,
  getWorkflowRunsByDay,
  getChannelBreadth,
  getServiceBreadth,
  getWorkflowAutonomyStats,
  getWorkflowOutcomesByWorkflow,
  getWorkflowOutcomesByTriggerType,
  getWorkflowFailureReasons,
  getWorkflowDurationStats,
} from './adoption-metrics.js';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "getTotalUserCount"`
Expected: FAIL — `getTotalUserCount is not a function` (or a TS error that the import doesn't exist).

- [ ] **Step 3: Write minimal implementation**

Add to `packages/worker/src/lib/db/adoption-metrics.ts`, immediately after `getReturningUserStats` and before the `// ─── Recurring-automation embeddedness ───` section divider:

```typescript
/** All registered users, regardless of activity — the "All members" baseline. */
export async function getTotalUserCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM users`).first<{ count: number }>();
  return row?.count ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "getTotalUserCount"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/adoption-metrics.ts packages/worker/src/lib/db/adoption-metrics.test.ts
git commit -m "Add getTotalUserCount for the adoption-level baseline"
```

---

### Task 2: `getChannelStickiness`

**Files:**
- Modify: `packages/worker/src/lib/db/adoption-metrics.ts` (add after `getServiceBreadth`, still inside the "Surface breadth" section)
- Test: `packages/worker/src/lib/db/adoption-metrics.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ChannelStickinessRow {
    channel: string;
    /** Distinct users active on this channel on the latest UTC day present in the window. */
    dau: number;
    /** Distinct users active on this channel anywhere in the window. */
    mau: number;
  }
  export async function getChannelStickiness(
    db: D1Database,
    startIso: string,
    endIso: string,
  ): Promise<ChannelStickinessRow[]>
  ```

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('surface breadth', ...)` block, after the `getServiceBreadth` test:

```typescript
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
```

Add `getChannelStickiness` and `ChannelStickinessRow` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "DAU"`
Expected: FAIL — function not defined.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/worker/src/lib/db/adoption-metrics.ts`, immediately after `getServiceBreadth`'s closing brace:

```typescript
export interface ChannelStickinessRow {
  channel: string;
  /** Distinct users active on this channel on the latest UTC day present in the window. */
  dau: number;
  /** Distinct users active on this channel anywhere in the window. */
  mau: number;
}

/**
 * DAU/MAU per channel — the "product stickiness" proxy. MAU is distinct
 * users per channel across the whole window; DAU is distinct users per
 * channel on the latest UTC day that actually has turn_complete activity in
 * the window (not necessarily "today" — the window may not reach the
 * present). A channel with MAU but zero activity on that specific day still
 * appears, with dau: 0.
 */
export async function getChannelStickiness(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ChannelStickinessRow[]> {
  const mauResult = await db
    .prepare(`
      SELECT channel, COUNT(DISTINCT user_id) AS mau
      FROM analytics_events
      WHERE event_type = 'turn_complete' AND channel IS NOT NULL AND user_id IS NOT NULL
        AND created_at >= ? AND created_at < ?
      GROUP BY channel
      ORDER BY mau DESC
    `)
    .bind(startIso, endIso)
    .all<{ channel: string; mau: number }>();

  const mauRows = mauResult.results ?? [];
  if (mauRows.length === 0) return [];

  const latestDayRow = await db
    .prepare(`
      SELECT MAX(date(created_at)) AS latest_day
      FROM analytics_events
      WHERE event_type = 'turn_complete' AND channel IS NOT NULL
        AND created_at >= ? AND created_at < ?
    `)
    .bind(startIso, endIso)
    .first<{ latest_day: string | null }>();
  const latestDay = latestDayRow?.latest_day ?? null;

  const dauMap = new Map<string, number>();
  if (latestDay !== null) {
    const dauResult = await db
      .prepare(`
        SELECT channel, COUNT(DISTINCT user_id) AS dau
        FROM analytics_events
        WHERE event_type = 'turn_complete' AND channel IS NOT NULL AND user_id IS NOT NULL
          AND date(created_at) = ?
        GROUP BY channel
      `)
      .bind(latestDay)
      .all<{ channel: string; dau: number }>();
    for (const row of dauResult.results ?? []) {
      dauMap.set(row.channel, row.dau);
    }
  }

  return mauRows.map((row) => ({
    channel: row.channel,
    dau: dauMap.get(row.channel) ?? 0,
    mau: row.mau,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "DAU"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/adoption-metrics.ts packages/worker/src/lib/db/adoption-metrics.test.ts
git commit -m "Add getChannelStickiness (DAU/MAU per channel)"
```

---

### Task 3: `getActionsPerPromptByChannel`

**Files:**
- Modify: `packages/worker/src/lib/db/adoption-metrics.ts` (new section after "Surface breadth", before "Workflow autonomy")
- Test: `packages/worker/src/lib/db/adoption-metrics.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ActionsPerPromptRow {
    day: string;
    channel: string;
    toolExecs: number;
    turns: number;
  }
  export async function getActionsPerPromptByChannel(
    db: D1Database,
    startIso: string,
    endIso: string,
  ): Promise<ActionsPerPromptRow[]>
  ```
- Consumes: nothing new (reads `analytics_events` directly, same table as `getChannelBreadth`).

- [ ] **Step 1: Write the failing test**

Add a new top-level `describe` block, after `describe('surface breadth', ...)` and before `describe('getWorkflowAutonomyStats', ...)`:

```typescript
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
```

Add `getActionsPerPromptByChannel` and `ActionsPerPromptRow` to the import list.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "buckets tool_exec"`
Expected: FAIL — function not defined.

- [ ] **Step 3: Write minimal implementation**

Add after `getChannelStickiness`'s closing brace:

```typescript
export interface ActionsPerPromptRow {
  day: string;
  channel: string;
  toolExecs: number;
  turns: number;
}

/**
 * Raw daily tool_exec / turn_complete counts per channel — the "how agentic
 * is their work" trend. Division into a ratio (and null-on-zero-turns
 * handling) is a presentation concern left to callers, since a 0-turn day
 * is meaningfully different from a 0-tool-call day.
 */
export async function getActionsPerPromptByChannel(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ActionsPerPromptRow[]> {
  const result = await db
    .prepare(`
      SELECT
        date(created_at) AS day,
        channel,
        COALESCE(SUM(CASE WHEN event_type = 'tool_exec' THEN 1 ELSE 0 END), 0) AS tool_execs,
        COALESCE(SUM(CASE WHEN event_type = 'turn_complete' THEN 1 ELSE 0 END), 0) AS turns
      FROM analytics_events
      WHERE channel IS NOT NULL
        AND event_type IN ('tool_exec', 'turn_complete')
        AND created_at >= ? AND created_at < ?
      GROUP BY day, channel
      ORDER BY day, channel
    `)
    .bind(startIso, endIso)
    .all<{ day: string; channel: string; tool_execs: number; turns: number }>();

  return (result.results ?? []).map((r) => ({
    day: r.day,
    channel: r.channel,
    toolExecs: r.tool_execs,
    turns: r.turns,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "buckets tool_exec"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/adoption-metrics.ts packages/worker/src/lib/db/adoption-metrics.test.ts
git commit -m "Add getActionsPerPromptByChannel"
```

---

### Task 4: `getConnectorBreadth` (replaces `getServiceBreadth`)

**Files:**
- Modify: `packages/worker/src/lib/db/adoption-metrics.ts` (replace `getServiceBreadth` and its `ServiceBreadthRow` interface in place)
- Test: `packages/worker/src/lib/db/adoption-metrics.test.ts` (replace the `getServiceBreadth` test, extend `seedInvocation`)

**Interfaces:**
- Produces:
  ```typescript
  export interface ConnectorBreadthRow {
    service: string;
    users: number;
    reads: number;
    writes: number;
  }
  export async function getConnectorBreadth(
    db: D1Database,
    startIso: string,
    endIso: string,
  ): Promise<ConnectorBreadthRow[]>
  ```
- Consumes: none new.

This task drops `getServiceBreadth`/`ServiceBreadthRow` entirely — its only call site is the `/adoption` route, updated in Task 6.

- [ ] **Step 1: Write the failing test**

First, extend the `seedInvocation` helper (near the top of the test file) so tests can vary `actionId` and `userId` — both currently hardcoded:

```typescript
function seedInvocation(
  sqlite: BetterSqlite3.Database,
  opts: {
    id: string;
    executionId?: string | null;
    sessionId?: string | null;
    service?: string;
    actionId?: string;
    userId?: string;
    status?: string;
    resolvedBy?: string | null;
    resolvedAt?: string | null;
    createdAt: string;
  },
) {
  exec(
    sqlite,
    `INSERT INTO action_invocations (id, session_id, workflow_execution_id, user_id, service, action_id, risk_level, resolved_mode, status, resolved_by, resolved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'high', 'require_approval', ?, ?, ?, ?)`,
    opts.id,
    opts.sessionId ?? null,
    opts.executionId ?? null,
    opts.userId ?? 'u1',
    opts.service ?? 'github',
    opts.actionId ?? 'act',
    opts.status ?? 'executed',
    opts.resolvedBy ?? null,
    opts.resolvedAt ?? null,
    opts.createdAt,
  );
}
```

(Every existing call site keeps working unchanged — `actionId` defaults to `'act'` and `userId` to `'u1'`, matching the previous hardcoded values.)

Replace the existing `it('counts services from action_invocations, excluding test-mode workflow rows', ...)` test with:

```typescript
    it('classifies reads vs writes by action_id keyword and counts distinct users', async () => {
      seedInvocation(sqlite, { id: 'i1', sessionId: 's1', service: 'github', actionId: 'github.get_pull_request', userId: 'u1', createdAt: '2026-07-02T10:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i2', sessionId: 's1', service: 'github', actionId: 'github.get_pull_request', userId: 'u1', createdAt: '2026-07-03T10:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i3', sessionId: 's1', service: 'github', actionId: 'github.create_pr', userId: 'u2', createdAt: '2026-07-03T11:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i4', sessionId: 's1', service: 'slack', actionId: 'slack.send_message', userId: 'u3', createdAt: '2026-07-03T12:00:00.000Z' });

      const rows = await getConnectorBreadth(db, START, END);
      expect(rows).toEqual([
        { service: 'github', users: 2, reads: 2, writes: 1 },
        { service: 'slack', users: 1, reads: 0, writes: 1 },
      ]);
    });

    it('excludes invocations from mode=test workflow runs', async () => {
      seedExecution(sqlite, { id: 'wx-t', status: 'completed', mode: 'test', startedAt: '2026-07-02 00:00:00', completedAt: '2026-07-02 00:10:00' });
      seedInvocation(sqlite, { id: 'i5', sessionId: 's1', service: 'github', actionId: 'github.get_pull_request', createdAt: '2026-07-02T10:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i6', executionId: 'wx-t', service: 'linear', actionId: 'linear.get_issue', createdAt: '2026-07-02T10:00:00.000Z' });
      seedInvocation(sqlite, { id: 'i7', sessionId: 's1', service: 'notion', actionId: 'notion.get_page', createdAt: '2026-06-01T10:00:00.000Z' });

      const rows = await getConnectorBreadth(db, START, END);
      expect(rows).toEqual([{ service: 'github', users: 1, reads: 1, writes: 0 }]);
    });
```

Update the import list: remove `getServiceBreadth`, add `getConnectorBreadth`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts -t "reads vs writes"`
Expected: FAIL — `getConnectorBreadth` not defined (and the old `getServiceBreadth` import will now be a TS error too, confirming the replacement is wired correctly).

- [ ] **Step 3: Write minimal implementation**

Replace `ServiceBreadthRow` and `getServiceBreadth` entirely with:

```typescript
export interface ConnectorBreadthRow {
  service: string;
  users: number;
  reads: number;
  writes: number;
}

// Coarse keyword classifier over action_id, same spirit as
// getWorkflowFailureReasons' keyword buckets: approximate, not exhaustive.
// Verbs were chosen from the actual action_id catalog across all plugins
// (github, slack, linear, google_workspace, salesforce, etc.) — ambiguous
// verbs ('run', 'search', 'query') are deliberately NOT matched here, since
// they cover both reads (query_prometheus, runSoqlQuery) and writes
// (workflows.run) and a false-positive miscounts a read as a write more
// often than the reverse. Unmatched action_ids default to reads.
const WRITE_ACTION_ID_LIKE = `(
  ai.action_id LIKE '%create%' OR ai.action_id LIKE '%update%' OR ai.action_id LIKE '%delete%' OR
  ai.action_id LIKE '%insert%' OR ai.action_id LIKE '%append%' OR ai.action_id LIKE '%send%' OR
  ai.action_id LIKE '%post%' OR ai.action_id LIKE '%write%' OR ai.action_id LIKE '%replace%' OR
  ai.action_id LIKE '%remove%' OR ai.action_id LIKE '%modify%' OR ai.action_id LIKE '%merge%' OR
  ai.action_id LIKE '%move_%' OR ai.action_id LIKE '%rename%' OR ai.action_id LIKE '%format%' OR
  ai.action_id LIKE '%protect%' OR ai.action_id LIKE '%resize%' OR ai.action_id LIKE '%freeze%' OR
  ai.action_id LIKE '%duplicate%' OR ai.action_id LIKE '%upload%' OR ai.action_id LIKE '%save%' OR
  ai.action_id LIKE '%reply%' OR ai.action_id LIKE '%resolve_comment%' OR ai.action_id LIKE '%apply_%' OR
  ai.action_id LIKE '%dm_%' OR ai.action_id LIKE '%disable%' OR ai.action_id LIKE '%enable%' OR
  ai.action_id LIKE '%set_%' OR ai.action_id LIKE '%add_%' OR ai.action_id LIKE '%add-%' OR
  ai.action_id LIKE '%clear_%' OR ai.action_id LIKE '%batch_%' OR ai.action_id LIKE '%push_files%' OR
  ai.action_id IN ('workflows.run', 'triggers.run', 'triggers.disable')
)`;

/**
 * Integration services exercised in the window, with a distinct-user count
 * and a coarse read/write split (see WRITE_ACTION_ID_LIKE). Invocations from
 * mode='test' workflow runs are excluded like every other workflow metric.
 */
export async function getConnectorBreadth(
  db: D1Database,
  startIso: string,
  endIso: string,
): Promise<ConnectorBreadthRow[]> {
  const result = await db
    .prepare(`
      SELECT
        ai.service AS service,
        COUNT(DISTINCT ai.user_id) AS users,
        COALESCE(SUM(CASE WHEN NOT ${WRITE_ACTION_ID_LIKE} THEN 1 ELSE 0 END), 0) AS reads,
        COALESCE(SUM(CASE WHEN ${WRITE_ACTION_ID_LIKE} THEN 1 ELSE 0 END), 0) AS writes
      FROM action_invocations ai
      LEFT JOIN workflow_executions we ON ai.workflow_execution_id = we.id
      WHERE (we.id IS NULL OR we.mode != 'test')
        AND datetime(ai.created_at) >= datetime(?) AND datetime(ai.created_at) < datetime(?)
      GROUP BY ai.service
      ORDER BY (reads + writes) DESC
    `)
    .bind(startIso, endIso)
    .all<{ service: string; users: number; reads: number; writes: number }>();

  return (result.results ?? []).map((r) => ({
    service: r.service,
    users: r.users,
    reads: r.reads,
    writes: r.writes,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && npx vitest run src/lib/db/adoption-metrics.test.ts`
Expected: PASS (whole file — confirms the rename didn't break any other test in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/adoption-metrics.ts packages/worker/src/lib/db/adoption-metrics.test.ts
git commit -m "Replace getServiceBreadth with getConnectorBreadth (users, reads, writes)"
```

---

### Task 5: Extend `AnalyticsAdoptionResponse`

**Files:**
- Modify: `packages/shared/src/types/index.ts` (the `AnalyticsAdoptionResponse` interface, ~line 1451)

**Interfaces:**
- Consumes: `ChannelStickinessRow`, `ActionsPerPromptRow`, `ConnectorBreadthRow` shapes from Tasks 2-4 (mirrored as inline types here — `packages/shared` cannot import from `packages/worker`).
- Produces: the extended `AnalyticsAdoptionResponse` type, consumed by Task 6 (route) and Task 8 (frontend).

- [ ] **Step 1: Write the failing test**

This is a pure type change — there's no dedicated type-level test file for `AnalyticsAdoptionResponse`. Skip the test-first cycle for this task; type-correctness is verified by `pnpm typecheck` after Task 6 wires the route to the new shape (a route that doesn't populate a required field fails to typecheck).

- [ ] **Step 2: N/A**

- [ ] **Step 3: Make the type change**

In `packages/shared/src/types/index.ts`, replace the `adoption` block's `services` field and add three new fields. The full updated interface (replace the entire `AnalyticsAdoptionResponse` interface with this):

```typescript
export interface AnalyticsAdoptionResponse {
  adoption: {
    /** Distinct analytics_events users per UTC day. */
    activeUsersByDay: Array<{ bucket: string; users: number }>;
    /** Distinct analytics_events users per week (%Y-W%W, Monday-first). */
    activeUsersByWeek: Array<{ bucket: string; users: number }>;
    /** Distinct users with any attributed event in the window. */
    activeUsers: number;
    /** Users active in more than one distinct week (retention proxy). */
    returningUsers: number;
    returningUserRate: number | null;
    /** All registered users, regardless of activity — the adoption-level baseline. */
    totalUsers: number;
    /** Currently-enabled triggers by type — present state, not windowed. */
    enabledTriggers: Array<{ type: string; count: number }>;
    /** Production workflow runs started per UTC day. */
    workflowRunsByDay: Array<{ day: string; runs: number }>;
    /** Channels exercised (turn_complete events with a channel). */
    channels: Array<{ channel: string; turns: number }>;
    /** DAU (latest window day) / MAU (whole window) per channel. */
    channelStickiness: Array<{ channel: string; dau: number; mau: number }>;
    /** Integration connectors exercised, with distinct users and a read/write split. */
    connectors: Array<{ service: string; users: number; reads: number; writes: number }>;
    /** Raw daily tool_exec/turn_complete counts per channel ("actions per prompt" trend). */
    actionsPerPromptByChannel: Array<{ day: string; channel: string; toolExecs: number; turns: number }>;
    /** Real SUM(additions + deletions) from session_files_changed, org-wide for the window. */
    linesChanged: number;
    /** Distinct (session, file) changes recorded across the window. */
    filesChanged: number;
  };
  autonomy: {
    terminalRuns: number;
    completedRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    successRate: number | null;
    /** Completed with zero human decision (no resolved_by on any invocation). */
    unattendedCompletedRuns: number;
    unattendedCompletionRate: number | null;
    /** Runs where a human resolved at least one invocation. */
    attendedRuns: number;
    interventionRate: number | null;
    /** Median minutes attended runs' invocations sat waiting on the human. */
    medianBlockedMinutes: number | null;
    outcomesByWorkflow: Array<{ workflowId: string | null; name: string; completed: number; failed: number; cancelled: number }>;
    outcomesByTriggerType: Array<{ triggerType: string; completed: number; failed: number; cancelled: number }>;
    /** Coarse keyword buckets over workflow_executions.error (failed runs). */
    failureReasons: Array<{ reason: string; runs: number }>;
    /** ABSOLUTE run duration; not a reduction claim. */
    medianRunMinutes: number | null;
    p95RunMinutes: number | null;
    measuredRuns: number;
  };
  period: number;
}
```

(`unattendedCompletedRuns`/`attendedRuns`/`medianBlockedMinutes`/`interventionRate` are unchanged and stay in the response — Conner's ask was to stop giving Human Intervention Rate a *hero card*, not to stop computing it. The Outcomes tables the frontend already renders lower on the page keep using it.)

- [ ] **Step 4: Verify the package builds**

Run: `cd packages/shared && pnpm build`
Expected: succeeds (this is a type-only change — if it fails, a syntax error was introduced).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "Extend AnalyticsAdoptionResponse for the Overview redesign"
```

---

### Task 6: Wire new queries into the `/adoption` route

**Files:**
- Modify: `packages/worker/src/routes/analytics.ts`

**Interfaces:**
- Consumes: `getTotalUserCount`, `getChannelStickiness`, `getActionsPerPromptByChannel`, `getConnectorBreadth` (Tasks 1-4); `getFileChangeTotals` from `../lib/db/dashboard.js` (already exported, from PR #152); extended `AnalyticsAdoptionResponse` (Task 5).
- Produces: the populated `/api/analytics/adoption` response used by Task 8.

- [ ] **Step 1: Write the failing test**

There's no dedicated route-level test file for `analyticsRouter` today (`analytics-health.test.ts` covers `/health` only; the rest of `/adoption` is covered at the query-function level in `adoption-metrics.test.ts`, already green from Tasks 1-4). This task is route wiring — verified by running the worker and checking the response shape, plus the full existing suite must stay green. Skip a new test file; rely on Step 2's typecheck as the correctness gate (a route that returns the wrong shape fails to compile against the Task 5 type).

- [ ] **Step 2: Run typecheck to confirm the current route is now out of sync with the type**

Run: `cd packages/worker && pnpm typecheck`
Expected: FAIL — `src/routes/analytics.ts` errors that `services`, `channelStickiness`, `connectors`, etc. don't match `AnalyticsAdoptionResponse` (missing fields, and `getServiceBreadth` no longer exists).

- [ ] **Step 3: Write the implementation**

In `packages/worker/src/routes/analytics.ts`, update the import block:

```typescript
import {
  getActiveUsersByDay,
  getActiveUsersByWeek,
  getReturningUserStats,
  getTotalUserCount,
  getEnabledTriggerCounts,
  getWorkflowRunsByDay,
  getChannelBreadth,
  getChannelStickiness,
  getConnectorBreadth,
  getActionsPerPromptByChannel,
  getWorkflowAutonomyStats,
  getWorkflowOutcomesByWorkflow,
  getWorkflowOutcomesByTriggerType,
  getWorkflowFailureReasons,
  getWorkflowDurationStats,
} from '../lib/db/adoption-metrics.js';
import { getFileChangeTotals } from '../lib/db/dashboard.js';
```

(This replaces the previous `getChannelBreadth, getServiceBreadth,` line — `getServiceBreadth` no longer exists after Task 4.)

Replace the `/adoption` handler body (from `const [` through the `return c.json(response);`) with:

```typescript
  const [
    activeUsersByDay,
    activeUsersByWeek,
    returning,
    totalUsers,
    enabledTriggers,
    workflowRunsByDay,
    channels,
    channelStickiness,
    connectors,
    actionsPerPromptByChannel,
    fileChangeTotals,
    autonomy,
    outcomesByWorkflow,
    outcomesByTriggerType,
    failureReasons,
    durations,
  ] = await Promise.all([
    getActiveUsersByDay(db, startIso, endIso),
    getActiveUsersByWeek(db, startIso, endIso),
    getReturningUserStats(db, startIso, endIso),
    getTotalUserCount(db),
    getEnabledTriggerCounts(db),
    getWorkflowRunsByDay(db, startIso, endIso),
    getChannelBreadth(db, startIso, endIso),
    getChannelStickiness(db, startIso, endIso),
    getConnectorBreadth(db, startIso, endIso),
    getActionsPerPromptByChannel(db, startIso, endIso),
    getFileChangeTotals(db, startIso),
    getWorkflowAutonomyStats(db, startIso, endIso),
    getWorkflowOutcomesByWorkflow(db, startIso, endIso),
    getWorkflowOutcomesByTriggerType(db, startIso, endIso),
    getWorkflowFailureReasons(db, startIso, endIso),
    getWorkflowDurationStats(db, startIso, endIso),
  ]);

  const response: AnalyticsAdoptionResponse = {
    adoption: {
      activeUsersByDay,
      activeUsersByWeek,
      activeUsers: returning.activeUsers,
      returningUsers: returning.returningUsers,
      returningUserRate: safeRate(returning.returningUsers, returning.activeUsers),
      totalUsers,
      enabledTriggers,
      workflowRunsByDay,
      channels,
      channelStickiness,
      connectors,
      actionsPerPromptByChannel,
      linesChanged: fileChangeTotals.lines_changed,
      filesChanged: fileChangeTotals.files_changed,
    },
    autonomy: {
      terminalRuns: autonomy.terminalRuns,
      completedRuns: autonomy.completedRuns,
      failedRuns: autonomy.failedRuns,
      cancelledRuns: autonomy.cancelledRuns,
      successRate: safeRate(autonomy.completedRuns, autonomy.terminalRuns),
      unattendedCompletedRuns: autonomy.unattendedCompletedRuns,
      unattendedCompletionRate: safeRate(autonomy.unattendedCompletedRuns, autonomy.terminalRuns),
      attendedRuns: autonomy.attendedRuns,
      interventionRate: safeRate(autonomy.attendedRuns, autonomy.terminalRuns),
      medianBlockedMinutes: autonomy.medianBlockedMinutes,
      outcomesByWorkflow,
      outcomesByTriggerType,
      failureReasons,
      medianRunMinutes: durations.medianRunMinutes,
      p95RunMinutes: durations.p95RunMinutes,
      measuredRuns: durations.measuredRuns,
    },
    period: periodHours,
  };

  return c.json(response);
});
```

Note `getFileChangeTotals` takes only `periodStart` (a "since" window, not `[start, end)`) — that's the existing convention in `dashboard.ts` (PR #152) and is intentionally not changed here; the design doc's "What are the results" section inherits that convention rather than forcing a bounded window onto a function whose only other caller uses the open-ended one.

- [ ] **Step 4: Run typecheck and the full worker suite**

Run: `cd packages/worker && pnpm typecheck && npx vitest run`
Expected: typecheck passes; vitest shows the same pass count as the pre-existing baseline (1602 tests, 3 pre-existing unrelated failures in `integrations.test.ts`/`session-tools.test.ts` — see the note in [PR #152](https://github.com/tkhq/valet/pull/152)'s verification).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/analytics.ts
git commit -m "Wire adoption-level, stickiness, connector, and actions-per-prompt data into /adoption"
```

---

### Task 7: `ChannelTrendChart` component

**Files:**
- Create: `packages/client/src/components/analytics/channel-trend-chart.tsx`

**Interfaces:**
- Consumes: nothing project-specific — a generic dynamic-series wrapper around Recharts, following the exact visual conventions of `latency-trend-chart.tsx` and `activity-chart.tsx` (same card chrome, axis styling, tooltip pattern).
- Produces:
  ```typescript
  interface ChannelTrendChartProps {
    title: string;
    data: Array<{ date: string; [seriesKey: string]: string | number | null }>;
    seriesKeys: string[];
    emptyLabel: string;
    valueFormatter?: (v: number) => string;
  }
  export function ChannelTrendChart(props: ChannelTrendChartProps): JSX.Element
  ```
  Consumed by Task 8 for both the active-users trend (reusing `getActiveUsersByDay`, single series) and the actions-per-prompt trend (multiple channel series).

- [ ] **Step 1: Write the failing test**

No component-test convention exists in this codebase (confirmed: `.test.tsx` files don't exist anywhere under `packages/client/src`; existing `*.test.ts` files test extracted pure logic, not rendering). Skip the test-first cycle for this presentational component — verification is `pnpm build` (Step 2 below) plus the live-browser check in Task 9's final step.

- [ ] **Step 2: N/A (no test to run first)**

- [ ] **Step 3: Write the implementation**

```typescript
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// Cycled per series in the order seriesKeys is given. Matches the
// blue/emerald palette already used in activity-chart.tsx / latency-trend-chart.tsx.
const SERIES_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

interface ChannelTrendChartProps {
  title: string;
  /** Each row must have a `date` key plus one numeric (or null) key per entry in seriesKeys. */
  data: Array<{ date: string; [seriesKey: string]: string | number | null }>;
  seriesKeys: string[];
  emptyLabel: string;
  valueFormatter?: (v: number) => string;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function CustomTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number | null; color: string }>;
  label?: string;
  valueFormatter: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-neutral-200/80 bg-white px-3 py-2.5 shadow-[0_4px_12px_-4px_rgb(0_0_0/0.1)] dark:border-neutral-700 dark:bg-surface-2">
      <p className="mb-1.5 font-mono text-2xs text-neutral-400">{formatDateLabel(String(label))}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: entry.color }} />
          <span className="text-xs text-neutral-500 dark:text-neutral-400">{entry.name}</span>
          <span className="ml-auto font-mono text-xs font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
            {entry.value === null ? 'N/A' : valueFormatter(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ChannelTrendChart({ title, data, seriesKeys, emptyLabel, valueFormatter = (v) => String(v) }: ChannelTrendChartProps) {
  if (data.length === 0 || seriesKeys.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
        <h3 className="label-mono text-neutral-400 mb-4">{title}</h3>
        <div className="flex h-[240px] items-center justify-center text-[13px] text-neutral-300">{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
      <h3 className="label-mono text-neutral-400 mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={260}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            {seriesKeys.map((key, i) => (
              <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0.12} />
                <stop offset="100%" stopColor={SERIES_COLORS[i % SERIES_COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(245 245 245)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDateLabel}
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#a3a3a3', fontFamily: '"JetBrains Mono", monospace' }}
            axisLine={false}
            tickLine={false}
            width={45}
          />
          <Tooltip content={<CustomTooltip valueFormatter={valueFormatter} />} />
          <Legend />
          {seriesKeys.map((key, i) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              name={key}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              strokeWidth={1.5}
              fill={`url(#grad-${key})`}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 2, fill: 'white', stroke: SERIES_COLORS[i % SERIES_COLORS.length] }}
              connectNulls
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `cd packages/client && pnpm build`
Expected: succeeds (this component isn't imported anywhere yet, so the build only confirms it compiles standalone — full integration is verified in Task 9).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/analytics/channel-trend-chart.tsx
git commit -m "Add ChannelTrendChart (dynamic multi-series area chart)"
```

---

### Task 8: `overview-tab.tsx`

**Files:**
- Create: `packages/client/src/components/analytics/overview-tab.tsx`
- Delete: `packages/client/src/components/analytics/adoption-tab.tsx` (its contents — `Card`, `SimpleTable`, `Icon`, `MetricHelp`, `formatPercent`, `formatMinutes`, `TRIGGER_LABELS`, and all 7 hero icon components — move into the new file; nothing from the old file survives unchanged since every hero card and section is being rebuilt)

**Interfaces:**
- Consumes:
  - `useAnalyticsAdoption(period)` → `AnalyticsAdoptionResponse` (Task 6)
  - `useAnalyticsValue(period)` → `AnalyticsValueResponse` (existing, `packages/client/src/api/analytics.ts`)
  - `useUsageStats(period)` → `UsageStatsResponse` (existing, `packages/client/src/api/usage.ts`)
  - `HeroMetricCard` (`@/components/dashboard/hero-metric-card`)
  - `ChannelTrendChart` (Task 7)
  - `UserBreakdownTable` (`@/components/usage/user-breakdown-table`)
  - `ModelBreakdownTable` (`@/components/usage/model-breakdown-table`)
- Produces: `export function OverviewTab({ period }: { period: number }): JSX.Element`, consumed by Task 9.

- [ ] **Step 1: Write the failing test**

No component-test convention exists for tab-level components (confirmed in Task 7). Skip test-first; verification is `pnpm build` + the live-browser check that closes out Task 9.

- [ ] **Step 2: N/A (no test to run first)**

- [ ] **Step 3: Write the implementation**

```typescript
import { HeroMetricCard } from '@/components/dashboard/hero-metric-card';
import { useAnalyticsAdoption, useAnalyticsValue } from '@/api/analytics';
import { useUsageStats } from '@/api/usage';
import { ChannelTrendChart } from './channel-trend-chart';
import { UserBreakdownTable } from '@/components/usage/user-breakdown-table';
import { ModelBreakdownTable } from '@/components/usage/model-breakdown-table';
import type { AnalyticsAdoptionResponse } from '@valet/shared';

function formatPercent(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${Math.round(rate * 1000) / 10}%`;
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return 'N/A';
  if (minutes < 1) return '<1m';
  if (minutes < 90) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / (24 * 60)).toFixed(1)}d`;
}

function formatCost(cost: number | null): string {
  if (cost === null) return 'N/A';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// Shared wrapper for the 14x14 stroke-icon boilerplate every hero metric uses.
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function UsersIcon() {
  return (
    <Icon>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Icon>
  );
}

function BoxIcon() {
  return (
    <Icon>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </Icon>
  );
}

function GitPullRequestIcon() {
  return (
    <Icon>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </Icon>
  );
}

function DollarIcon() {
  return (
    <Icon>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </Icon>
  );
}

function BoltIcon() {
  return (
    <Icon>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </Icon>
  );
}

// Tooltip body: derivation, this window's numbers, and the honest caveat.
function MetricHelp({ formula, numbers, caveat }: { formula: string; numbers: string; caveat: string }) {
  return (
    <div className="space-y-1.5 py-1">
      <p className="font-mono text-[11px] leading-snug">{formula}</p>
      <p>{numbers}</p>
      <p className="opacity-60">{caveat}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="animate-stagger-in rounded-lg border border-neutral-200/80 bg-white p-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none">
      <h3 className="label-mono text-neutral-400 mb-4">{title}</h3>
      {children}
    </div>
  );
}

function SimpleTable({
  columns,
  rows,
  empty,
}: {
  columns: [string, string, ...string[]];
  rows: Array<Array<string | number>>;
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-300">{empty}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-neutral-100 dark:border-neutral-800">
            {columns.map((c, i) => (
              <th
                key={c}
                className={`pb-2 font-mono text-2xs font-medium text-neutral-400 ${i === 0 ? 'pr-4 text-left' : 'px-4 text-right last:pl-4 last:pr-0'}`}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-neutral-50 last:border-0 dark:border-neutral-800/50">
              {r.map((cell, ci) => (
                <td
                  key={ci}
                  className={
                    ci === 0
                      ? 'py-2.5 pr-4 font-medium text-neutral-900 dark:text-neutral-100'
                      : 'py-2.5 px-4 text-right font-mono text-xs tabular-nums text-neutral-600 last:pl-4 last:pr-0 dark:text-neutral-300'
                  }
                >
                  {typeof cell === 'number' ? cell.toLocaleString() : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewTab({ period }: { period: number }) {
  const { data: adoptionData, isLoading: adoptionLoading } = useAnalyticsAdoption(period);
  const { data: valueData, isLoading: valueLoading } = useAnalyticsValue(period);
  const { data: usageData, isLoading: usageLoading } = useUsageStats(period);

  if (adoptionLoading || valueLoading || usageLoading) {
    return <OverviewSkeleton />;
  }

  if (!adoptionData || !valueData || !usageData) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-neutral-400">
        No analytics data available
      </div>
    );
  }

  const { adoption, autonomy } = adoptionData;
  const conversations = adoption.channels.reduce((sum, c) => sum + c.turns, 0);

  const activeUsersTrendData = adoption.activeUsersByDay.map((d) => ({ date: d.bucket, 'Active Users': d.users }));

  const apDayMap = new Map<string, Record<string, number | null>>();
  for (const row of adoption.actionsPerPromptByChannel) {
    const bucket: Record<string, number | null> = apDayMap.get(row.day) ?? {};
    bucket[row.channel] = row.turns > 0 ? Math.round((row.toolExecs / row.turns) * 10) / 10 : null;
    apDayMap.set(row.day, bucket);
  }
  const apChannels = Array.from(new Set(adoption.actionsPerPromptByChannel.map((r) => r.channel)));
  const actionsPerPromptTrendData = Array.from(apDayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, series]) => ({ date, ...series }));

  const totalToolExecs = adoption.actionsPerPromptByChannel.reduce((sum, r) => sum + r.toolExecs, 0);
  const totalTurns = adoption.actionsPerPromptByChannel.reduce((sum, r) => sum + r.turns, 0);
  const orgActionsPerPrompt = totalTurns > 0 ? totalToolExecs / totalTurns : null;

  const dailyActiveUsers = adoption.activeUsersByDay.at(-1)?.users ?? 0;
  const weeklyActiveUsers = adoption.activeUsersByWeek.at(-1)?.users ?? 0;

  return (
    <div className="space-y-6">
      {/* Summary hero row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HeroMetricCard icon={<UsersIcon />} label="Weekly Active Users" value={weeklyActiveUsers.toLocaleString()} index={0} />
        <HeroMetricCard icon={<BoxIcon />} label="Sessions Started" value={valueData.current.resolvedSessions.toLocaleString()} index={1} />
        <HeroMetricCard icon={<GitPullRequestIcon />} label="PRs Merged" value={valueData.current.prsMerged.toLocaleString()} index={2} />
        <HeroMetricCard icon={<DollarIcon />} label="Total Spend" value={formatCost(usageData.hero.totalCost)} index={3} />
      </div>

      {/* Who's using Valet */}
      <ChannelTrendChart
        title="Active Users"
        data={activeUsersTrendData}
        seriesKeys={['Active Users']}
        emptyLabel="No attributed activity in this window"
      />
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-1">
        <UserBreakdownTable data={usageData.byUser} byUserModel={usageData.byUserModel} />
      </div>

      {/* How are they using it */}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card title="Adoption Level">
          <SimpleTable
            columns={['Cadence', 'Users']}
            rows={[
              ['All members', adoption.totalUsers],
              ['Monthly active', adoption.activeUsers],
              ['Weekly active', weeklyActiveUsers],
              ['Daily active', dailyActiveUsers],
            ]}
            empty="No user data"
          />
        </Card>
        <Card title="Stickiness by Channel (DAU/MAU)">
          <SimpleTable
            columns={['Channel', 'DAU', 'MAU', 'Stickiness']}
            rows={adoption.channelStickiness.map((c) => [c.channel, c.dau, c.mau, formatPercent(c.mau > 0 ? c.dau / c.mau : null)])}
            empty="No channel activity in this window"
          />
        </Card>
        <Card title="Connectors">
          <SimpleTable
            columns={['Service', 'Users', 'Reads', 'Writes']}
            rows={adoption.connectors.map((c) => [c.service, c.users, c.reads, c.writes])}
            empty="No action invocations in this window"
          />
        </Card>
        <Card title="Enabled Automations">
          <SimpleTable
            columns={['Trigger type', 'Enabled']}
            rows={adoption.enabledTriggers.map((t) => [t.type, t.count])}
            empty="No enabled triggers"
          />
        </Card>
      </div>

      {/* How agentic is their work */}
      <HeroMetricCard
        icon={<BoltIcon />}
        label="Actions Per Prompt"
        value={orgActionsPerPrompt === null ? 'N/A' : orgActionsPerPrompt.toFixed(1)}
        tooltip={
          <MetricHelp
            formula="tool_exec count ÷ turn_complete count, org-wide"
            numbers={`${totalToolExecs} tool calls across ${totalTurns} turns`}
            caveat="Higher means more tool use is happening per user turn — not a claim about time saved."
          />
        }
        index={0}
      />
      <ChannelTrendChart
        title="Actions Per Prompt by Channel"
        data={actionsPerPromptTrendData}
        seriesKeys={apChannels}
        emptyLabel="No tool activity in this window"
        valueFormatter={(v) => v.toFixed(1)}
      />

      {/* What are the results */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <HeroMetricCard icon={<GitPullRequestIcon />} label="PRs Merged" value={valueData.current.prsMerged.toLocaleString()} index={0} />
        <HeroMetricCard icon={<BoxIcon />} label="Sessions" value={valueData.current.resolvedSessions.toLocaleString()} index={1} />
        <HeroMetricCard icon={<BoxIcon />} label="File Operations" value={adoption.filesChanged.toLocaleString()} index={2} />
        <HeroMetricCard icon={<UsersIcon />} label="Conversations" value={conversations.toLocaleString()} index={3} />
      </div>

      {/* What it costs */}
      <Card title="Spend by Model">
        <ModelBreakdownTable data={usageData.byModel} />
      </Card>

      {/* Outcomes tables — kept from the old Adoption tab, human-intervention data
          lives here now instead of as a hero card. */}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card title="Outcomes by Workflow">
          <SimpleTable
            columns={['Workflow', 'Completed', 'Failed', 'Cancelled']}
            rows={autonomy.outcomesByWorkflow.map((w) => [w.name, w.completed, w.failed, w.cancelled])}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Outcomes by Trigger Type">
          <SimpleTable
            columns={['Trigger type', 'Completed', 'Failed', 'Cancelled']}
            rows={autonomy.outcomesByTriggerType.map((t) => [t.triggerType, t.completed, t.failed, t.cancelled])}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Human Intervention">
          <SimpleTable
            columns={['Metric', 'Value']}
            rows={[
              ['Attended runs', autonomy.attendedRuns],
              ['Intervention rate', formatPercent(autonomy.interventionRate)],
              ['Median minutes blocked', formatMinutes(autonomy.medianBlockedMinutes)],
            ]}
            empty="No terminal production runs in this window"
          />
        </Card>
        <Card title="Failure Reasons">
          <SimpleTable
            columns={['Reason', 'Failed runs']}
            rows={autonomy.failureReasons.map((f) => [f.reason, f.runs])}
            empty="No failed production runs in this window"
          />
        </Card>
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
      <div className="h-[280px] rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-64 rounded-lg border border-neutral-200/80 bg-white dark:border-neutral-800 dark:bg-surface-1" />
        ))}
      </div>
    </div>
  );
}
```

Delete the old file:

```bash
rm packages/client/src/components/analytics/adoption-tab.tsx
```

- [ ] **Step 4: Build**

Run: `cd packages/client && pnpm build`
Expected: fails at this point with "Cannot find module './adoption-tab'" from `usage.tsx` — that import is fixed in Task 9. This is expected; do not treat it as a Task 8 failure, but also don't commit yet (Task 8 and 9 land as one commit specifically because deleting `adoption-tab.tsx` without updating its only import site leaves the build broken — see Task 9's note).

- [ ] **Step 5: No commit yet — proceed directly to Task 9, which commits both together**

---

### Task 9: Wire `OverviewTab` into the Analytics page, delete the old tab, verify everything

**Files:**
- Modify: `packages/client/src/routes/settings/usage.tsx`

**Interfaces:**
- Consumes: `OverviewTab` (Task 8).

- [ ] **Step 1: Update the import and tab wiring**

In `packages/client/src/routes/settings/usage.tsx`:

Replace:
```typescript
import { AdoptionTab } from '@/components/analytics/adoption-tab';
```
with:
```typescript
import { OverviewTab } from '@/components/analytics/overview-tab';
```

Replace:
```typescript
  const [tab, setTab] = React.useState<'billing' | 'value' | 'adoption' | 'performance' | 'events'>('billing');
```
with:
```typescript
  const [tab, setTab] = React.useState<'billing' | 'value' | 'overview' | 'performance' | 'events'>('billing');
```

Replace:
```typescript
          {(['billing', 'value', 'adoption', 'performance', 'events'] as const).map((t) => (
```
with:
```typescript
          {(['billing', 'value', 'overview', 'performance', 'events'] as const).map((t) => (
```

Replace:
```typescript
        {tab === 'adoption' && <AdoptionTab period={period} />}
```
with:
```typescript
        {tab === 'overview' && <OverviewTab period={period} />}
```

- [ ] **Step 2: Build and typecheck everything**

Run, from the repo root:
```bash
pnpm typecheck
cd packages/client && pnpm build
cd ../worker && npx vitest run
```
Expected: `pnpm typecheck` passes across all packages; `pnpm build` succeeds with no TypeScript errors (only the pre-existing chunk-size warning); the worker test suite shows the same 1599/1602 passing baseline as before this plan (3 pre-existing, unrelated failures in `integrations.test.ts`/`session-tools.test.ts`).

- [ ] **Step 3: Live-browser verification**

Start the worker and client dev servers (`make dev-worker` and `cd packages/client && pnpm dev`, or via the preview tooling), sign in as an admin, navigate to Settings → Analytics → Overview tab, and confirm:
- The four summary hero cards render non-crashing values (not "undefined" or "NaN").
- The Active Users trend chart renders (or shows the empty state if the window has no data).
- Adoption Level, Stickiness, Connectors, and Enabled Automations tables render.
- The Actions Per Prompt hero card and per-channel trend chart render.
- The Top users by spend table (reused `UserBreakdownTable`) and Spend by Model table render.
- The Outcomes/Human Intervention/Failure Reasons tables at the bottom still render (this is where the old Human Intervention Rate hero card's data moved to).
- No console errors in the browser devtools.
- Toggle the period selector (e.g. 7d → 90d) and confirm the page re-fetches without crashing.

- [ ] **Step 4: Commit (Tasks 8 and 9 together)**

```bash
git add packages/client/src/components/analytics/overview-tab.tsx \
        packages/client/src/components/analytics/channel-trend-chart.tsx \
        packages/client/src/routes/settings/usage.tsx
git rm packages/client/src/components/analytics/adoption-tab.tsx
git commit -m "Replace Adoption tab with Overview tab"
```

(`channel-trend-chart.tsx` was already committed in Task 7 — `git add` on an already-committed, unchanged file is a no-op; it's listed here only if Task 7's commit hasn't happened yet in your working session. If it has, omit it from this `git add` line.)

---

## Post-plan cross-check

After all 9 tasks:
- [ ] Every row of the design spec's "Data mapping" table has a corresponding task: Summary hero row (Task 8), Who's using Valet (Tasks 2, 8), How are they using it (Tasks 1, 2, 4, 8), How agentic (Tasks 3, 8), What are the results (Tasks 6, 8), What it costs (Task 8, reusing existing Value/Billing data). Skills, Groups, Estimated time saved, and Usage limits are confirmed absent from the diff.
- [ ] `git log --oneline` on the branch shows one commit per task (9 commits, or 8 if Task 7/9 are combined per the note above).
- [ ] No migration files were added (`packages/worker/migrations/` unchanged).
