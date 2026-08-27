/**
 * `/api/usage` — token/cost aggregates for the dashboard.
 *
 * Source of truth: the `cost_entries` view (see
 * `packages/api/migrations/pg/0000_app.sql`). The view resolves the owner of
 * every billable turn for BOTH session kinds — app sessions through
 * `agent_sessions`, workflow sessions through `workflow_runs` +
 * `workflow_definitions` — so this route and any Grafana panel read one
 * definition and cannot drift. This route reads the view directly with a raw
 * aggregate: the engine store's port has no analytics surface, and adding
 * one for a dashboard card would bloat a deliberately small port.
 *
 * Turns owned by a team or an org have no acting user (`user_id` is NULL in
 * the view), so this route omits them entirely — every window and the member
 * list are per-user. The view still carries those rows, so an org-wide total
 * can read them; this route does not compute one.
 *
 * `org.members` is included ONLY when the org's `features.organizations`
 * flag is on — single-user mode never sees comparative usage.
 */
import { Hono } from "hono";
import { eq, inArray, sql } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { orgs, users } from "../schema/index.js";
import type {
  UsageBreakdownResponse,
  UsageSessionRow,
  UsageSessionsResponse,
  UsageSummaryResponse,
  UsageUseCase,
  UsageWindow,
} from "../wire/types.js";

export const usageRouter = new Hono<AppEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;

interface AggRow {
  user_id: string;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  total_tokens: string | number | null;
  cost_usd: string | number | null;
  turns: string | number | null;
  unpriced_turns: string | number | null;
}

function toWindow(row: AggRow | undefined): UsageWindow {
  return {
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
    costUsd: Number(row?.cost_usd ?? 0),
    turns: Number(row?.turns ?? 0),
    unpricedTurns: Number(row?.unpriced_turns ?? 0),
  };
}

usageRouter.get("/summary", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const now = Date.now();

  // Per-user aggregate since a cutoff. `cost_total` is NULL on an unpriced
  // turn, so SUM skips it (never reads as 0) and `unpriced_turns` counts it.
  async function aggregate(sinceMs: number, onlyUserId?: string): Promise<AggRow[]> {
    // drizzle's execute() is typed `unknown` for raw SQL; narrow to the
    // node-postgres/PGlite result shape ({ rows }).
    const result = (await db.execute(sql`
      SELECT user_id,
             SUM(input_tokens)                    AS input_tokens,
             SUM(output_tokens)                   AS output_tokens,
             SUM(cache_read_tokens)               AS cache_read_tokens,
             SUM(cache_write_tokens)              AS cache_write_tokens,
             SUM(total_tokens)                    AS total_tokens,
             COALESCE(SUM(cost_total), 0)         AS cost_usd,
             COUNT(*)                             AS turns,
             COUNT(*) FILTER (WHERE NOT priced)   AS unpriced_turns
      FROM cost_entries
      WHERE created_at >= ${sinceMs}
        AND org_id = ${user.orgId}
        AND user_id IS NOT NULL
        ${onlyUserId ? sql`AND user_id = ${onlyUserId}` : sql``}
      GROUP BY user_id
    `)) as { rows: AggRow[] };
    return result.rows;
  }

  const [day, week, month] = await Promise.all([
    aggregate(now - DAY_MS, user.id),
    aggregate(now - 7 * DAY_MS, user.id),
    aggregate(now - 30 * DAY_MS, user.id),
  ]);

  const body: UsageSummaryResponse = {
    me: {
      day: toWindow(day[0]),
      week: toWindow(week[0]),
      month: toWindow(month[0]),
    },
  };

  // Org comparison — only when the organizations feature is enabled.
  const orgRows = await db.select().from(orgs).where(eq(orgs.id, user.orgId)).limit(1);
  const features = (orgRows[0]?.features ?? {}) as { organizations?: boolean };
  if (features.organizations === true) {
    const memberAgg = await aggregate(now - 30 * DAY_MS);
    // Look up exactly the ids the aggregate returned. An unscoped
    // `from(users)` would load every user in the deployment on each
    // dashboard load; scoping by org membership instead would drop the name
    // of someone who has since left the org but whose spend is still in the
    // window. Keying on the aggregate's own ids is bounded AND complete.
    const spenderIds = memberAgg.map((row) => row.user_id);
    const userRows =
      spenderIds.length === 0
        ? []
        : await db
            .select({ id: users.id, name: users.name, email: users.email })
            .from(users)
            .where(inArray(users.id, spenderIds));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    body.org = {
      windowDays: 30,
      members: memberAgg
        .map((row) => ({
          userId: row.user_id,
          name: nameById.get(row.user_id) ?? row.user_id,
          ...toWindow(row),
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    };
  }

  return c.json(body);
});

// ── Window parsing (shared by the breakdown + sessions endpoints) ──────────
const WINDOWS: Record<string, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};
function windowMsFrom(q: string | undefined): number {
  return WINDOWS[q ?? "30d"] ?? 30 * DAY_MS;
}
const USE_CASES: readonly UsageUseCase[] = ["orchestrator", "session", "workflow", "proxy"];
function toNum(v: unknown): number {
  return Number(v ?? 0);
}

/**
 * `GET /api/usage/breakdown?window=` — the caller's total spend for a window
 * across ALL use cases, from the single `cost_entries` definition. Powers the
 * unified `/usage` dashboard (not just proxy spend).
 */
usageRouter.get("/breakdown", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const windowMs = windowMsFrom(c.req.query("window"));
  const since = Date.now() - windowMs;
  const scope = sql`created_at >= ${since} AND org_id = ${user.orgId} AND user_id = ${user.id}`;

  interface UcRow { use_case: string; cost_usd: unknown; total_tokens: unknown; turns: unknown }
  interface MdRow { model: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
  interface DayRow { day_ms: unknown; cost_usd: unknown; total_tokens: unknown }
  interface TotRow { cost_usd: unknown; total_tokens: unknown; input_tokens: unknown; output_tokens: unknown }

  const [byUseCase, byModel, byDay, totals] = await Promise.all([
    db.execute(sql`SELECT use_case, COALESCE(SUM(cost_total),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens, COUNT(*) AS turns FROM cost_entries WHERE ${scope} GROUP BY use_case`) as Promise<{ rows: UcRow[] }>,
    db.execute(sql`SELECT model, COALESCE(SUM(cost_total),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens, COUNT(*) AS turns FROM cost_entries WHERE ${scope} GROUP BY model ORDER BY cost_usd DESC`) as Promise<{ rows: MdRow[] }>,
    db.execute(sql`SELECT (created_at / ${DAY_MS}) * ${DAY_MS} AS day_ms, COALESCE(SUM(cost_total),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens FROM cost_entries WHERE ${scope} GROUP BY day_ms ORDER BY day_ms ASC`) as Promise<{ rows: DayRow[] }>,
    db.execute(sql`SELECT COALESCE(SUM(cost_total),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens FROM cost_entries WHERE ${scope}`) as Promise<{ rows: TotRow[] }>,
  ]);

  const t = totals.rows[0];
  const isUseCase = (v: string): v is UsageUseCase => (USE_CASES as readonly string[]).includes(v);
  const body: UsageBreakdownResponse = {
    windowMs,
    totalCostUsd: toNum(t?.cost_usd),
    totalTokens: toNum(t?.total_tokens),
    totalInputTokens: toNum(t?.input_tokens),
    totalOutputTokens: toNum(t?.output_tokens),
    byUseCase: byUseCase.rows
      .filter((r) => isUseCase(r.use_case))
      .map((r) => ({ useCase: r.use_case as UsageUseCase, costUsd: toNum(r.cost_usd), totalTokens: toNum(r.total_tokens), turns: toNum(r.turns) }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byModel: byModel.rows.map((r) => ({ model: r.model, costUsd: toNum(r.cost_usd), totalTokens: toNum(r.total_tokens), turns: toNum(r.turns) })),
    byDay: byDay.rows.map((r) => ({ dayMs: toNum(r.day_ms), costUsd: toNum(r.cost_usd), totalTokens: toNum(r.total_tokens) })),
  };
  return c.json(body);
});

/**
 * `GET /api/usage/sessions?window=&useCase=` — per-session spend for drill-down
 * into the agent-session use cases (`orchestrator`/`session`). Joins
 * `agent_sessions` for the title and `child_watches` so an orchestrator's
 * spawned children carry `isChild`/`parentSessionId` and can be nested.
 */
usageRouter.get("/sessions", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const windowMs = windowMsFrom(c.req.query("window"));
  const since = Date.now() - windowMs;
  const useCaseQ = c.req.query("useCase");
  const useCaseFilter = useCaseQ && (USE_CASES as readonly string[]).includes(useCaseQ) ? sql`AND ce.use_case = ${useCaseQ}` : sql``;

  interface Row {
    session_id: string; title: string | null; use_case: string;
    parent_session_id: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown;
  }
  const result = (await db.execute(sql`
    SELECT ce.session_id,
           s.title,
           ce.use_case,
           cw.parent_session_id,
           COALESCE(SUM(ce.cost_total),0) AS cost_usd,
           COALESCE(SUM(ce.total_tokens),0) AS total_tokens,
           COUNT(*) AS turns
    FROM cost_entries ce
    LEFT JOIN agent_sessions s ON s.id = ce.session_id
    LEFT JOIN child_watches cw ON cw.child_session_id = ce.session_id
    WHERE ce.created_at >= ${since}
      AND ce.org_id = ${user.orgId}
      AND ce.user_id = ${user.id}
      AND ce.session_id IS NOT NULL
      AND ce.use_case IN ('orchestrator','session')
      ${useCaseFilter}
    GROUP BY ce.session_id, s.title, ce.use_case, cw.parent_session_id
    ORDER BY cost_usd DESC
    LIMIT 200
  `)) as { rows: Row[] };

  const sessions: UsageSessionRow[] = result.rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    useCase: r.use_case as UsageUseCase,
    isChild: r.parent_session_id !== null,
    parentSessionId: r.parent_session_id,
    costUsd: toNum(r.cost_usd),
    totalTokens: toNum(r.total_tokens),
    turns: toNum(r.turns),
  }));
  const body: UsageSessionsResponse = { sessions };
  return c.json(body);
});
