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
import { Hono, type Context } from "hono";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { orgs, users } from "../schema/index.js";
import { isOrgAdmin } from "../services/org.js";
import type {
  UsageBucket,
  UsageBreakdownResponse,
  UsageDrillItem,
  UsageDrillResponse,
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
function isUseCase(v: string): v is UsageUseCase {
  return (USE_CASES as readonly string[]).includes(v);
}

/** The full token-type + turn columns for one spend bucket — shared by every
 * usage aggregate so input/output/cache split and unpriced turns are always
 * available (cache is the biggest cost lever; unpriced turns burn tokens at
 * $0). */
const BUCKET_COLS = sql`
  COALESCE(SUM(cost_total),0)            AS cost_usd,
  COALESCE(SUM(total_tokens),0)         AS total_tokens,
  COALESCE(SUM(input_tokens),0)         AS input_tokens,
  COALESCE(SUM(output_tokens),0)        AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0)    AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens),0)   AS cache_write_tokens,
  COUNT(*)                              AS turns,
  COUNT(*) FILTER (WHERE NOT priced)    AS unpriced_turns`;

interface BucketRow {
  cost_usd: unknown; total_tokens: unknown; input_tokens: unknown; output_tokens: unknown;
  cache_read_tokens: unknown; cache_write_tokens: unknown; turns: unknown; unpriced_turns: unknown;
}
function toBucket(r: BucketRow | undefined): UsageBucket {
  return {
    costUsd: toNum(r?.cost_usd),
    totalTokens: toNum(r?.total_tokens),
    inputTokens: toNum(r?.input_tokens),
    outputTokens: toNum(r?.output_tokens),
    cacheReadTokens: toNum(r?.cache_read_tokens),
    cacheWriteTokens: toNum(r?.cache_write_tokens),
    turns: toNum(r?.turns),
    unpricedTurns: toNum(r?.unpriced_turns),
  };
}

interface UsageScope { scope: "me" | "org"; isOrg: boolean; orgId: string; userId: string | null }

/**
 * Resolves the scope for a usage query. `scope=org` covers every member of the
 * caller's org and is org-admin-only (org feature must be on) — a non-admin
 * asking for it 403s. Anything else is the caller's own spend.
 */
async function resolveUsageScope(c: Context<AppEnv>): Promise<UsageScope | Response> {
  const { db } = c.var.providers;
  const user = c.var.user;
  if (c.req.query("scope") === "org") {
    const orgRows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, user.orgId)).limit(1);
    const features = (orgRows[0]?.features ?? {}) as { organizations?: boolean };
    const admin = await isOrgAdmin(db, user.orgId, user.id);
    if (!features.organizations || !admin) {
      return c.json({ error: "Organization usage is available to org admins only." }, 403);
    }
    return { scope: "org", isOrg: true, orgId: user.orgId, userId: null };
  }
  return { scope: "me", isOrg: false, orgId: user.orgId, userId: user.id };
}

/**
 * The window + scope WHERE clause, with columns optionally qualified by a table
 * alias (`prefix`, e.g. `"ce."`) so joined queries (where `workflow_definitions`
 * / `agent_sessions` share `org_id`/`created_at`) are unambiguous. `prefix` is a
 * hardcoded literal, never user input.
 */
function scopeWhere(prefix: "" | "ce.", since: number, s: UsageScope): SQL {
  const col = (name: string): SQL => sql.raw(`${prefix}${name}`);
  const userClause = s.userId !== null ? sql` AND ${col("user_id")} = ${s.userId}` : sql``;
  return sql`${col("created_at")} >= ${since} AND ${col("org_id")} = ${s.orgId}${userClause}`;
}

/**
 * `GET /api/usage/breakdown?window=&scope=me|org` — spend for a window across
 * ALL use cases, from the single `cost_entries` definition. Powers the unified
 * `/usage` dashboard. `scope=org` (admin) covers the whole org and adds
 * `byUser`.
 */
usageRouter.get("/breakdown", async (c) => {
  const { db } = c.var.providers;
  const windowMs = windowMsFrom(c.req.query("window"));
  const scoped = await resolveUsageScope(c);
  if (scoped instanceof Response) return scoped;
  const since = Date.now() - windowMs;
  const where = scopeWhere("", since, scoped);

  const [byUseCase, byModel, byDay, totals, byUser] = await Promise.all([
    db.execute(sql`SELECT use_case, ${BUCKET_COLS} FROM cost_entries WHERE ${where} GROUP BY use_case`) as Promise<{ rows: (BucketRow & { use_case: string })[] }>,
    db.execute(sql`SELECT model, ${BUCKET_COLS} FROM cost_entries WHERE ${where} GROUP BY model ORDER BY cost_usd DESC`) as Promise<{ rows: (BucketRow & { model: string | null })[] }>,
    db.execute(sql`SELECT (created_at / ${DAY_MS}) * ${DAY_MS} AS day_ms, COALESCE(SUM(cost_total),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens FROM cost_entries WHERE ${where} GROUP BY day_ms ORDER BY day_ms ASC`) as Promise<{ rows: { day_ms: unknown; cost_usd: unknown; total_tokens: unknown }[] }>,
    db.execute(sql`SELECT ${BUCKET_COLS} FROM cost_entries WHERE ${where}`) as Promise<{ rows: BucketRow[] }>,
    scoped.isOrg
      ? (db.execute(sql`SELECT user_id, ${BUCKET_COLS} FROM cost_entries WHERE ${where} AND user_id IS NOT NULL GROUP BY user_id ORDER BY cost_usd DESC`) as Promise<{ rows: (BucketRow & { user_id: string })[] }>)
      : Promise.resolve({ rows: [] as (BucketRow & { user_id: string })[] }),
  ]);

  const total = toBucket(totals.rows[0]);
  let byUserOut: (UsageBucket & { userId: string; name: string })[] | undefined;
  if (scoped.isOrg) {
    const ids = byUser.rows.map((r) => r.user_id);
    const userRows = ids.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    byUserOut = byUser.rows.map((r) => ({ userId: r.user_id, name: nameById.get(r.user_id) ?? r.user_id, ...toBucket(r) }));
  }

  const body: UsageBreakdownResponse = {
    windowMs,
    scope: scoped.scope,
    totalCostUsd: total.costUsd,
    totalTokens: total.totalTokens,
    totalInputTokens: total.inputTokens,
    totalOutputTokens: total.outputTokens,
    totalCacheReadTokens: total.cacheReadTokens,
    totalCacheWriteTokens: total.cacheWriteTokens,
    totalTurns: total.turns,
    unpricedTurns: total.unpricedTurns,
    byUseCase: byUseCase.rows.filter((r) => isUseCase(r.use_case)).map((r) => ({ useCase: r.use_case as UsageUseCase, ...toBucket(r) })).sort((a, b) => b.costUsd - a.costUsd),
    byModel: byModel.rows.map((r) => ({ model: r.model, ...toBucket(r) })),
    byUser: byUserOut,
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

/**
 * `GET /api/usage/items?window=&scope=&useCase=` — drill-down for ONE use case:
 * `session`/`orchestrator` → per agent session (title + child nesting),
 * `workflow` → per workflow run (workflow name), `proxy` → per harness. Powers
 * the symmetric expand on every use-case row.
 */
usageRouter.get("/items", async (c) => {
  const { db } = c.var.providers;
  const windowMs = windowMsFrom(c.req.query("window"));
  const scoped = await resolveUsageScope(c);
  if (scoped instanceof Response) return scoped;
  const since = Date.now() - windowMs;
  const useCaseQ = c.req.query("useCase");
  if (!useCaseQ || !isUseCase(useCaseQ)) return c.json({ error: "useCase must be one of orchestrator, session, workflow, proxy." }, 400);
  const useCase: UsageUseCase = useCaseQ;
  const whereCe = scopeWhere("ce.", since, scoped);

  let items: UsageDrillItem[];
  if (useCase === "session" || useCase === "orchestrator") {
    interface Row { session_id: string; title: string | null; parent_session_id: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
    const r = (await db.execute(sql`
      SELECT ce.session_id, s.title, cw.parent_session_id,
             COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COUNT(*) AS turns
      FROM cost_entries ce
      LEFT JOIN agent_sessions s ON s.id = ce.session_id
      LEFT JOIN child_watches cw ON cw.child_session_id = ce.session_id
      WHERE ${whereCe} AND ce.session_id IS NOT NULL AND ce.use_case = ${useCase}
      GROUP BY ce.session_id, s.title, cw.parent_session_id
      ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
    items = r.rows.map((x) => ({
      id: x.session_id, label: x.title ?? x.session_id, useCase, isChild: x.parent_session_id !== null,
      parentId: x.parent_session_id, sessionId: x.session_id, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
    }));
  } else if (useCase === "workflow") {
    interface Row { workflow_run_id: string | null; name: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
    const r = (await db.execute(sql`
      SELECT ce.workflow_run_id, wd.name,
             COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COUNT(*) AS turns
      FROM cost_entries ce
      LEFT JOIN workflow_definitions wd ON wd.id = ce.workflow_id
      WHERE ${whereCe} AND ce.use_case = 'workflow' AND ce.workflow_run_id IS NOT NULL
      GROUP BY ce.workflow_run_id, wd.name
      ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
    items = r.rows.map((x) => ({
      id: x.workflow_run_id ?? "", label: x.name ? `${x.name}` : `run ${x.workflow_run_id}`, useCase, isChild: false,
      parentId: null, sessionId: null, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
    }));
  } else {
    // proxy — group the raw proxy rows by harness (cost_entries has no harness).
    // Single table, so the unqualified scope clause is fine.
    const whereProxy = scopeWhere("", since, scoped);
    interface Row { harness: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
    const r = (await db.execute(sql`
      SELECT harness, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens, COUNT(*) AS turns
      FROM llm_proxy_requests
      WHERE ${whereProxy} AND total_tokens > 0
      GROUP BY harness ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
    items = r.rows.map((x) => ({
      id: x.harness ?? "unknown", label: x.harness ?? "unknown", useCase, isChild: false,
      parentId: null, sessionId: null, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
    }));
  }
  const body: UsageDrillResponse = { items };
  return c.json(body);
});

/**
 * `GET /api/usage/export.csv?window=&scope=me|org` — the caller's (or the org's,
 * for admins) spend rows for the window as CSV. One row per billable turn from
 * `cost_entries`, capped at 100k rows.
 */
usageRouter.get("/export.csv", async (c) => {
  const { db } = c.var.providers;
  const windowMs = windowMsFrom(c.req.query("window"));
  const scoped = await resolveUsageScope(c);
  if (scoped instanceof Response) return scoped;
  const since = Date.now() - windowMs;

  interface Row {
    created_at: unknown; use_case: string; model: string | null; session_id: string | null; workflow_run_id: string | null;
    user_id: string | null; input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown;
    total_tokens: unknown; cost_total: unknown; priced: unknown;
  }
  const result = (await db.execute(sql`
    SELECT created_at, use_case, model, session_id, workflow_run_id, user_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total, priced
    FROM cost_entries
    WHERE ${scopeWhere("", since, scoped)}
    ORDER BY created_at DESC LIMIT 100000`)) as { rows: Row[] };

  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "timestamp,use_case,model,session_id,workflow_run_id,user_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,priced";
  const lines = result.rows.map((r) =>
    [
      new Date(toNum(r.created_at)).toISOString(), r.use_case, r.model, r.session_id, r.workflow_run_id, r.user_id,
      toNum(r.input_tokens), toNum(r.output_tokens), toNum(r.cache_read_tokens), toNum(r.cache_write_tokens), toNum(r.total_tokens),
      r.cost_total === null ? "" : toNum(r.cost_total), r.priced,
    ].map(esc).join(","),
  );
  const csv = `${header}\n${lines.join("\n")}\n`;
  const label = c.req.query("window") ?? "30d";
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="valet-usage-${scoped.scope}-${label}.csv"`);
  return c.body(csv);
});
