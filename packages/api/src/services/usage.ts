/**
 * Usage query library — the SQL for the `/api/usage` dashboard, extracted from
 * the route handlers so they stay thin (resolve scope, call a function, return
 * the result). Every query reads the one `cost_entries` definition (plus the
 * raw `llm_proxy_requests` for the proxy harness drill-down), so the dashboard
 * and Grafana cannot drift.
 */
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { orgs, users } from "../schema/index.js";
import { isOrgAdmin } from "./org.js";
import type {
  UsageBreakdownResponse,
  UsageBucket,
  UsageDrillItem,
  UsageSessionRow,
  UsageSummaryResponse,
  UsageUseCase,
  UsageWindow,
} from "../wire/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const USAGE_WINDOWS: Record<string, number> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
};
export function windowMsFrom(q: string | undefined): number {
  return USAGE_WINDOWS[q ?? "30d"] ?? 30 * DAY_MS;
}
/** The canonical window key for labels (e.g. the CSV filename), so an unknown
 * `?window=` doesn't mislabel a file as a range it doesn't cover. */
export function windowLabelFrom(q: string | undefined): string {
  return q && q in USAGE_WINDOWS ? q : "30d";
}

const USE_CASES: readonly UsageUseCase[] = ["orchestrator", "session", "workflow", "proxy"];
export function isUsageUseCase(v: string): v is UsageUseCase {
  return (USE_CASES as readonly string[]).includes(v);
}

function toNum(v: unknown): number {
  return Number(v ?? 0);
}

// ── Scope ──────────────────────────────────────────────────────────────────

export interface UsageScope {
  scope: "me" | "org";
  isOrg: boolean;
  orgId: string;
  userId: string | null;
}

/**
 * Resolves the scope for a usage query. `scope=org` covers every member of the
 * org and is org-admin-only (the org feature must be on) — a caller who lacks
 * permission gets `"forbidden"`, which the handler maps to a 403. Anything else
 * is the caller's own spend.
 */
export async function resolveUsageScope(
  db: AppDb,
  opts: { orgId: string; userId: string; requestedScope: string | undefined },
): Promise<UsageScope | "forbidden"> {
  if (opts.requestedScope === "org") {
    const rows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, opts.orgId)).limit(1);
    const features = (rows[0]?.features ?? {}) as { organizations?: boolean };
    const admin = await isOrgAdmin(db, opts.orgId, opts.userId);
    if (!features.organizations || !admin) return "forbidden";
    return { scope: "org", isOrg: true, orgId: opts.orgId, userId: null };
  }
  return { scope: "me", isOrg: false, orgId: opts.orgId, userId: opts.userId };
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

// ── Buckets (token-type split + unpriced, shared by every aggregate) ─────────

/** The bucket metrics, in output order — the ONE list `bucketCols` emits as
 * SQL and `readBucket` reads back. `sum` names the summed source column;
 * the two count metrics are special-cased in `bucketCols`. */
const BUCKET_METRICS: ReadonlyArray<{ column: string; sum?: string }> = [
  { column: "cost_usd", sum: "cost_total" },
  { column: "total_tokens", sum: "total_tokens" },
  { column: "input_tokens", sum: "input_tokens" },
  { column: "output_tokens", sum: "output_tokens" },
  { column: "cache_read_tokens", sum: "cache_read_tokens" },
  { column: "cache_write_tokens", sum: "cache_write_tokens" },
  { column: "turns" },
  { column: "unpriced_turns" },
];

type WindowSuffix = "d" | "w" | "m";

/** One row of bucket aggregates as raw (optionally suffixed) columns. */
type BucketRow = Record<string, unknown>;

/** The bucket aggregate columns. With `windowed`, every aggregate is
 * FILTERed to the cutoff and each column name gets `_${suffix}`, so one
 * scan computes several windows side by side. All names are hardcoded
 * literals from `BUCKET_METRICS`, never input. */
function bucketCols(windowed?: { since: number; suffix: WindowSuffix }): SQL {
  const cond = windowed ? sql`created_at >= ${windowed.since}` : undefined;
  const filter = (extra?: SQL): SQL => {
    const both = cond && extra ? sql`${cond} AND ${extra}` : (cond ?? extra);
    return both ? sql` FILTER (WHERE ${both})` : sql``;
  };
  const name = (base: string): SQL => sql.raw(windowed ? `${base}_${windowed.suffix}` : base);
  const cols = BUCKET_METRICS.map(({ column, sum }) => {
    if (sum !== undefined) return sql`COALESCE(SUM(${sql.raw(sum)})${filter()},0) AS ${name(column)}`;
    if (column === "turns") return sql`COUNT(*)${filter()} AS ${name(column)}`;
    return sql`COUNT(*)${filter(sql`NOT priced`)} AS ${name(column)}`;
  });
  return sql.join(cols, sql`, `);
}
const BUCKET_COLS = bucketCols();

/** The read half of `bucketCols` — one mapper for windowed and unwindowed
 * rows. `UsageBucket` and `UsageWindow` are the same eight fields. */
function readBucket(row: BucketRow | undefined, suffix?: WindowSuffix): UsageBucket & UsageWindow {
  const v = (base: string): number => toNum(row?.[suffix !== undefined ? `${base}_${suffix}` : base]);
  return {
    costUsd: v("cost_usd"),
    totalTokens: v("total_tokens"),
    inputTokens: v("input_tokens"),
    outputTokens: v("output_tokens"),
    cacheReadTokens: v("cache_read_tokens"),
    cacheWriteTokens: v("cache_write_tokens"),
    turns: v("turns"),
    unpricedTurns: v("unpriced_turns"),
  };
}

// ── Breakdown ────────────────────────────────────────────────────────────────

/** All-use-case spend for a window: totals, by use case, by model, by day, and
 * (org scope) by member. */
export async function getUsageBreakdown(
  db: AppDb,
  opts: { windowMs: number; scope: UsageScope },
): Promise<UsageBreakdownResponse> {
  const since = Date.now() - opts.windowMs;
  const where = scopeWhere("", since, opts.scope);

  const [byUseCase, byModel, byDay, totals, byUser] = await Promise.all([
    db.execute(sql`SELECT use_case, ${BUCKET_COLS} FROM cost_entries WHERE ${where} GROUP BY use_case`) as Promise<{ rows: (BucketRow & { use_case: string })[] }>,
    db.execute(sql`SELECT model, ${BUCKET_COLS} FROM cost_entries WHERE ${where} GROUP BY model ORDER BY cost_usd DESC`) as Promise<{ rows: (BucketRow & { model: string | null })[] }>,
    // `floor` truncates the day index deterministically whether Postgres infers
    // the `${DAY_MS}` parameter as integer or float (a plain `bigint / param`
    // could do float division on real Postgres → one bucket per row).
    db.execute(sql`SELECT (floor(created_at / ${DAY_MS}) * ${DAY_MS})::bigint AS day_ms, COALESCE(SUM(cost_total),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens FROM cost_entries WHERE ${where} GROUP BY 1 ORDER BY 1 ASC`) as Promise<{ rows: { day_ms: unknown; cost_usd: unknown; total_tokens: unknown }[] }>,
    db.execute(sql`SELECT ${BUCKET_COLS} FROM cost_entries WHERE ${where}`) as Promise<{ rows: BucketRow[] }>,
    opts.scope.isOrg
      ? // Keep the NULL user_id group (team-/org-owned turns, e.g. team-owned
        // workflow runs) so the per-member sum reconciles with the total —
        // dropping it made Σ byUser < totalCostUsd.
        (db.execute(sql`SELECT user_id, ${BUCKET_COLS} FROM cost_entries WHERE ${where} GROUP BY user_id ORDER BY cost_usd DESC`) as Promise<{ rows: (BucketRow & { user_id: string | null })[] }>)
      : Promise.resolve({ rows: [] as (BucketRow & { user_id: string | null })[] }),
  ]);

  const total = readBucket(totals.rows[0]);
  let byUserOut: (UsageBucket & { userId: string; name: string })[] | undefined;
  if (opts.scope.isOrg) {
    const ids = byUser.rows.map((r) => r.user_id).filter((id): id is string => id !== null);
    const userRows = ids.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    byUserOut = byUser.rows.map((r) => ({
      userId: r.user_id ?? "shared",
      name: r.user_id === null ? "Team / shared" : (nameById.get(r.user_id) ?? r.user_id),
      ...readBucket(r),
    }));
  }

  return {
    windowMs: opts.windowMs,
    scope: opts.scope.scope,
    totalCostUsd: total.costUsd,
    totalTokens: total.totalTokens,
    totalInputTokens: total.inputTokens,
    totalOutputTokens: total.outputTokens,
    totalCacheReadTokens: total.cacheReadTokens,
    totalCacheWriteTokens: total.cacheWriteTokens,
    totalTurns: total.turns,
    unpricedTurns: total.unpricedTurns,
    byUseCase: byUseCase.rows.filter((r) => isUsageUseCase(r.use_case)).map((r) => ({ useCase: r.use_case as UsageUseCase, ...readBucket(r) })).sort((a, b) => b.costUsd - a.costUsd),
    byModel: byModel.rows.map((r) => ({ model: r.model, ...readBucket(r) })),
    byUser: byUserOut,
    byDay: byDay.rows.map((r) => ({ dayMs: toNum(r.day_ms), costUsd: toNum(r.cost_usd), totalTokens: toNum(r.total_tokens) })),
  };
}

// ── Drill-down (per use case) ────────────────────────────────────────────────

/** Drill-down rows for ONE use case: sessions (title + child nesting), workflow
 * runs (workflow name), or proxy (by harness). */
export async function getUsageDrillItems(
  db: AppDb,
  opts: { windowMs: number; scope: UsageScope; useCase: UsageUseCase },
): Promise<UsageDrillItem[]> {
  const since = Date.now() - opts.windowMs;
  const { useCase, scope } = opts;

  if (useCase === "session" || useCase === "orchestrator") {
    const whereCe = scopeWhere("ce.", since, scope);
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
    return r.rows.map((x) => ({
      id: x.session_id, label: x.title ?? x.session_id, useCase, isChild: x.parent_session_id !== null,
      parentId: x.parent_session_id, sessionId: x.session_id, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
    }));
  }
  if (useCase === "workflow") {
    const whereCe = scopeWhere("ce.", since, scope);
    interface Row { workflow_run_id: string | null; name: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
    const r = (await db.execute(sql`
      SELECT ce.workflow_run_id, wd.name,
             COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COUNT(*) AS turns
      FROM cost_entries ce
      LEFT JOIN workflow_definitions wd ON wd.id = ce.workflow_id
      WHERE ${whereCe} AND ce.use_case = 'workflow' AND ce.workflow_run_id IS NOT NULL
      GROUP BY ce.workflow_run_id, wd.name
      ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
    return r.rows.map((x) => ({
      id: x.workflow_run_id ?? "", label: x.name ?? `run ${x.workflow_run_id}`, useCase, isChild: false,
      parentId: null, sessionId: null, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
    }));
  }
  // proxy — group the raw proxy rows by harness (cost_entries has no harness).
  const whereProxy = scopeWhere("", since, scope);
  interface Row { harness: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
  const r = (await db.execute(sql`
    SELECT harness, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens, COUNT(*) AS turns
    FROM llm_proxy_requests
    WHERE ${whereProxy} AND total_tokens > 0
    GROUP BY harness ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
  return r.rows.map((x) => ({
    id: x.harness ?? "unknown", label: x.harness ?? "unknown", useCase, isChild: false,
    parentId: null, sessionId: null, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
  }));
}

/** Superseded by `getUsageDrillItems` (which covers all use cases); kept while
 * the dashboard migrates. Per-session spend for the agent-session use cases,
 * child-nested via `child_watches`, scoped to the caller. */
export async function getUsageSessions(
  db: AppDb,
  opts: { windowMs: number; orgId: string; userId: string; useCase?: string },
): Promise<UsageSessionRow[]> {
  const since = Date.now() - opts.windowMs;
  // This endpoint only covers the two agent-session use cases; a workflow/proxy
  // filter would contradict the `IN ('orchestrator','session')` clause and
  // silently return nothing, so ignore any other value.
  const useCaseFilter = opts.useCase === "orchestrator" || opts.useCase === "session" ? sql`AND ce.use_case = ${opts.useCase}` : sql``;
  interface Row { session_id: string; title: string | null; use_case: string; parent_session_id: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
  const result = (await db.execute(sql`
    SELECT ce.session_id, s.title, ce.use_case, cw.parent_session_id,
           COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COUNT(*) AS turns
    FROM cost_entries ce
    LEFT JOIN agent_sessions s ON s.id = ce.session_id
    LEFT JOIN child_watches cw ON cw.child_session_id = ce.session_id
    WHERE ce.created_at >= ${since} AND ce.org_id = ${opts.orgId} AND ce.user_id = ${opts.userId}
      AND ce.session_id IS NOT NULL AND ce.use_case IN ('orchestrator','session')
      ${useCaseFilter}
    GROUP BY ce.session_id, s.title, ce.use_case, cw.parent_session_id
    ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
  return result.rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    useCase: r.use_case as UsageUseCase,
    isChild: r.parent_session_id !== null,
    parentSessionId: r.parent_session_id,
    costUsd: toNum(r.cost_usd),
    totalTokens: toNum(r.total_tokens),
    turns: toNum(r.turns),
  }));
}

// ── CSV export ───────────────────────────────────────────────────────────────

const CSV_HEADER = "timestamp,use_case,model,session_id,workflow_run_id,user_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,priced";

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote on comma, quote, newline OR carriage return — a lone \r in a title
  // would otherwise break a CSV row boundary.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV row per billable turn for the window/scope, capped at 100k rows. */
export async function getUsageExportCsv(db: AppDb, opts: { windowMs: number; scope: UsageScope }): Promise<string> {
  const since = Date.now() - opts.windowMs;
  interface Row {
    created_at: unknown; use_case: string; model: string | null; session_id: string | null; workflow_run_id: string | null;
    user_id: string | null; input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown;
    total_tokens: unknown; cost_total: unknown; priced: unknown;
  }
  const result = (await db.execute(sql`
    SELECT created_at, use_case, model, session_id, workflow_run_id, user_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_total, priced
    FROM cost_entries
    WHERE ${scopeWhere("", since, opts.scope)}
    ORDER BY created_at DESC LIMIT 100000`)) as { rows: Row[] };

  const lines = result.rows.map((r) =>
    [
      new Date(toNum(r.created_at)).toISOString(), r.use_case, r.model, r.session_id, r.workflow_run_id, r.user_id,
      toNum(r.input_tokens), toNum(r.output_tokens), toNum(r.cache_read_tokens), toNum(r.cache_write_tokens), toNum(r.total_tokens),
      r.cost_total === null ? "" : toNum(r.cost_total), r.priced,
    ].map(csvEscape).join(","),
  );
  return `${CSV_HEADER}\n${lines.join("\n")}\n`;
}

// ── Per-user windows (home card + /summary) ──────────────────────────────────

/** One row per user with day/week/month aggregates side by side, keyed by
 * suffix (`cost_usd_d`, `cost_usd_w`, `cost_usd_m`, ...). */
type MultiWindowRow = BucketRow & { user_id: string };

/** The `/api/usage/summary` body: the caller's day/week/month windows, plus an
 * org-wide member comparison when the organizations feature is on.
 *
 * The view cannot push the org/user predicates down into `engine_entries`
 * (`org_id`/`user_id` are computed from joins), so every scan reads the whole
 * 30-day window. One grouped scan with per-window FILTERs therefore replaces
 * the previous scan-per-window (day, week, month, org members = 4 scans). */
export async function getUsageSummary(db: AppDb, opts: { orgId: string; userId: string; now: number }): Promise<UsageSummaryResponse> {
  const { orgId, userId, now } = opts;
  const orgRows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const features = (orgRows[0]?.features ?? {}) as { organizations?: boolean };
  const orgWide = features.organizations === true;

  const monthCut = now - 30 * DAY_MS;
  const result = (await db.execute(sql`
    SELECT user_id,
      ${bucketCols({ since: now - DAY_MS, suffix: "d" })},
      ${bucketCols({ since: now - 7 * DAY_MS, suffix: "w" })},
      ${bucketCols({ since: monthCut, suffix: "m" })}
    FROM cost_entries
    WHERE created_at >= ${monthCut} AND org_id = ${orgId} AND user_id IS NOT NULL
      ${orgWide ? sql`` : sql`AND user_id = ${userId}`}
    GROUP BY user_id`)) as { rows: MultiWindowRow[] };

  const meRow = result.rows.find((row) => row.user_id === userId);
  const body: UsageSummaryResponse = {
    me: { day: readBucket(meRow, "d"), week: readBucket(meRow, "w"), month: readBucket(meRow, "m") },
  };

  if (orgWide) {
    // Look up exactly the ids the aggregate returned — bounded (not every user
    // in the deployment) AND complete (keeps a since-left member's name).
    const spenderIds = result.rows.map((row) => row.user_id);
    const userRows = spenderIds.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, spenderIds));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    body.org = {
      windowDays: 30,
      members: result.rows
        .map((row) => ({ userId: row.user_id, name: nameById.get(row.user_id) ?? row.user_id, ...readBucket(row, "m") }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    };
  }
  return body;
}
