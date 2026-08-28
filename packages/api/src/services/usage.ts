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
import { canAdministerTeam, getTeamInOrg, isTeamMember } from "./teams.js";
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

/**
 * The resolved read scope for a usage query — a discriminated union so an
 * illegal pairing (a team scope without its team id, a personal scope
 * without its user) cannot be represented.
 */
export type UsageScope =
  | { scope: "me"; orgId: string; userId: string }
  | { scope: "org"; orgId: string }
  | {
      scope: "team";
      orgId: string;
      teamId: string;
      /** Whether the caller may see per-member rows (`byUser`, CSV
       * attribution): true when they ADMINISTER the team. A plain member
       * reads the team's aggregate, never colleagues' individual spend. */
      byMember: boolean;
    };

/**
 * Resolves the scope for a usage query. `scope=org` covers every member of the
 * org and is org-admin-only (the org feature must be on) — `"forbidden"` (→
 * 403) otherwise. `scope=team` covers one team's owned spend and is
 * team-member-only; an unknown team, a foreign org's team, and a team the
 * caller is not on all resolve to `"team-not-found"` (→ 404), indistinguishable
 * by design — the same existence hiding every other team surface uses.
 * `scope=team` without a `teamId` gets `"missing-team"` (→ 400). Anything else
 * is the caller's own spend.
 */
export async function resolveUsageScope(
  db: AppDb,
  opts: { orgId: string; userId: string; requestedScope: string | undefined; requestedTeamId?: string | undefined },
): Promise<UsageScope | "forbidden" | "missing-team" | "team-not-found"> {
  if (opts.requestedScope === "org") {
    const rows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, opts.orgId)).limit(1);
    const features = (rows[0]?.features ?? {}) as { organizations?: boolean };
    const admin = await isOrgAdmin(db, opts.orgId, opts.userId);
    if (!features.organizations || !admin) return "forbidden";
    return { scope: "org", orgId: opts.orgId };
  }
  if (opts.requestedScope === "team") {
    if (!opts.requestedTeamId) return "missing-team";
    // The membership table alone does not tie a team to an org, so resolve
    // the team row first: a teamId from another org (or none) is refused
    // here, not answered as an empty 200 by the downstream org_id filter.
    const team = await getTeamInOrg(db, opts.orgId, opts.requestedTeamId);
    if (!team) return "team-not-found";
    const member = await isTeamMember(db, opts.requestedTeamId, opts.userId);
    if (!member) return "team-not-found";
    // Team admins (and org admins who are members) also read per-member rows.
    const byMember = await canAdministerTeam(db, opts.requestedTeamId, opts.userId);
    return { scope: "team", orgId: opts.orgId, teamId: opts.requestedTeamId, byMember };
  }
  return { scope: "me", orgId: opts.orgId, userId: opts.userId };
}

/**
 * The window + scope WHERE clause, with columns optionally qualified by a table
 * alias (`prefix`, e.g. `"ce."`) so joined queries (where `workflow_definitions`
 * / `agent_sessions` share `org_id`/`created_at`) are unambiguous. `prefix` is a
 * hardcoded literal, never user input.
 *
 * The team clause reads `owner_type`/`owner_id`, which only the `cost_entries`
 * view carries — do not apply a team scope to `llm_proxy_requests` directly
 * (see the proxy branch of `getUsageDrillItems`).
 */
function scopeWhere(prefix: "" | "ce.", since: number, s: UsageScope): SQL {
  const col = (name: string): SQL => sql.raw(`${prefix}${name}`);
  const base = sql`${col("created_at")} >= ${since} AND ${col("org_id")} = ${s.orgId}`;
  switch (s.scope) {
    case "team":
      return sql`${base} AND ${col("owner_type")} = 'team' AND ${col("owner_id")} = ${s.teamId}`;
    case "me":
      return sql`${base} AND ${col("user_id")} = ${s.userId}`;
    case "org":
      return base;
  }
}

// ── Buckets (token-type split + unpriced, shared by every aggregate) ─────────

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
    opts.scope.scope === "org" || (opts.scope.scope === "team" && opts.scope.byMember)
      ? // Keep the NULL user_id group (team-/org-owned turns, e.g. team-owned
        // workflow runs) so the per-member sum reconciles with the total —
        // dropping it made Σ byUser < totalCostUsd.
        (db.execute(sql`SELECT user_id, ${BUCKET_COLS} FROM cost_entries WHERE ${where} GROUP BY user_id ORDER BY cost_usd DESC`) as Promise<{ rows: (BucketRow & { user_id: string | null })[] }>)
      : Promise.resolve({ rows: [] as (BucketRow & { user_id: string | null })[] }),
  ]);

  const total = toBucket(totals.rows[0]);
  let byUserOut: (UsageBucket & { userId: string; name: string })[] | undefined;
  if (opts.scope.scope === "org" || (opts.scope.scope === "team" && opts.scope.byMember)) {
    const ids = byUser.rows.map((r) => r.user_id).filter((id): id is string => id !== null);
    const userRows = ids.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    byUserOut = byUser.rows.map((r) => ({
      userId: r.user_id ?? "shared",
      name: r.user_id === null ? "Team / shared" : (nameById.get(r.user_id) ?? r.user_id),
      ...toBucket(r),
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
    byUseCase: byUseCase.rows.filter((r) => isUsageUseCase(r.use_case)).map((r) => ({ useCase: r.use_case as UsageUseCase, ...toBucket(r) })).sort((a, b) => b.costUsd - a.costUsd),
    byModel: byModel.rows.map((r) => ({ model: r.model, ...toBucket(r) })),
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
  // Proxy rows are always user-owned (the view stamps owner_type='user'), so a
  // team scope matches none — and `llm_proxy_requests` has no owner columns,
  // so the team WHERE clause would not even parse against it.
  if (scope.scope === "team") return [];
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

/** One CSV row per billable turn for the window/scope, capped at 100k rows.
 * A plain member's team export blanks `user_id`: per-member attribution
 * follows the breakdown's byUser rule (org scope, or a team scope whose
 * caller administers the team), and the CSV must not let a plain team
 * member reconstruct it with one GROUP BY. */
export async function getUsageExportCsv(db: AppDb, opts: { windowMs: number; scope: UsageScope }): Promise<string> {
  const since = Date.now() - opts.windowMs;
  const withholdUserId = opts.scope.scope === "team" && !opts.scope.byMember;
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
      new Date(toNum(r.created_at)).toISOString(), r.use_case, r.model, r.session_id, r.workflow_run_id, withholdUserId ? "" : r.user_id,
      toNum(r.input_tokens), toNum(r.output_tokens), toNum(r.cache_read_tokens), toNum(r.cache_write_tokens), toNum(r.total_tokens),
      r.cost_total === null ? "" : toNum(r.cost_total), r.priced,
    ].map(csvEscape).join(","),
  );
  return `${CSV_HEADER}\n${lines.join("\n")}\n`;
}

// ── Per-user windows (home card + /summary) ──────────────────────────────────

interface WindowAggRow {
  user_id: string;
  input_tokens: unknown; output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown;
  total_tokens: unknown; cost_usd: unknown; turns: unknown; unpriced_turns: unknown;
}
function toWindow(row: WindowAggRow | undefined): UsageWindow {
  return {
    inputTokens: toNum(row?.input_tokens),
    outputTokens: toNum(row?.output_tokens),
    cacheReadTokens: toNum(row?.cache_read_tokens),
    cacheWriteTokens: toNum(row?.cache_write_tokens),
    totalTokens: toNum(row?.total_tokens),
    costUsd: toNum(row?.cost_usd),
    turns: toNum(row?.turns),
    unpricedTurns: toNum(row?.unpriced_turns),
  };
}

/** Per-user token/cost aggregate since a cutoff, one row per user. `onlyUserId`
 * scopes to a single user; omit it for the org-wide member list. */
async function windowAggregate(db: AppDb, orgId: string, sinceMs: number, onlyUserId?: string): Promise<WindowAggRow[]> {
  const result = (await db.execute(sql`
    SELECT user_id, ${BUCKET_COLS}
    FROM cost_entries
    WHERE created_at >= ${sinceMs} AND org_id = ${orgId} AND user_id IS NOT NULL
      ${onlyUserId ? sql`AND user_id = ${onlyUserId}` : sql``}
    GROUP BY user_id`)) as { rows: WindowAggRow[] };
  return result.rows;
}

/** The `/api/usage/summary` body: the caller's day/week/month windows, plus an
 * org-wide member comparison when the organizations feature is on. */
export async function getUsageSummary(db: AppDb, opts: { orgId: string; userId: string; now: number }): Promise<UsageSummaryResponse> {
  const { orgId, userId, now } = opts;
  const [day, week, month] = await Promise.all([
    windowAggregate(db, orgId, now - DAY_MS, userId),
    windowAggregate(db, orgId, now - 7 * DAY_MS, userId),
    windowAggregate(db, orgId, now - 30 * DAY_MS, userId),
  ]);
  const body: UsageSummaryResponse = { me: { day: toWindow(day[0]), week: toWindow(week[0]), month: toWindow(month[0]) } };

  const orgRows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const features = (orgRows[0]?.features ?? {}) as { organizations?: boolean };
  if (features.organizations === true) {
    const memberAgg = await windowAggregate(db, orgId, now - 30 * DAY_MS);
    // Look up exactly the ids the aggregate returned — bounded (not every user
    // in the deployment) AND complete (keeps a since-left member's name).
    const spenderIds = memberAgg.map((row) => row.user_id);
    const userRows = spenderIds.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, spenderIds));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    body.org = {
      windowDays: 30,
      members: memberAgg
        .map((row) => ({ userId: row.user_id, name: nameById.get(row.user_id) ?? row.user_id, ...toWindow(row) }))
        .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
    };
  }
  return body;
}
