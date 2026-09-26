/**
 * Usage query library — the SQL for the `/api/usage` dashboard, extracted from
 * the route handlers so they stay thin (resolve scope, call a function, return
 * the result). Every query reads the one `cost_entries` definition (plus the
 * raw `llm_proxy_requests` for the proxy harness drill-down), so the dashboard
 * and Grafana cannot drift.
 */
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { usageRead } from "./usage-read.js";
import { getMemberAgentDays } from "./usage-member-activity.js";
import { getActionToolCalls, getActionOutcomes, getSkillBreakdown } from "./usage-aux-rollups.js";
import { proxyPeriodRows, usagePeriodRows, HOURLY_BUCKET_COLS } from "./usage-hourly.js";
import type { AppDb } from "../lib/drizzle.js";
import { orgs, users } from "../schema/index.js";
import { isOrgAdmin } from "./org.js";
import type { ResolvedUsagePeriod } from "./usage-period.js";
import { canAdministerTeam, getTeamInOrg, isTeamMember } from "./teams.js";
import type {
  UsageBreakdownResponse,
  DailyAgentActivityResponse,
  UsageBucket,
  UsageDrillItem,
  UsageSessionRow,
  UsageSummaryResponse,
  UsageOutcomesResponse,
  UsageOutcomeKind,
  UsageToolEfficiencyResponse,
  UsageUseCase,
  UsageWindow,
} from "../wire/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const USE_CASES: readonly UsageUseCase[] = ["orchestrator", "session", "workflow", "proxy"];
export function isUsageUseCase(v: string): v is UsageUseCase {
  return (USE_CASES as readonly string[]).includes(v);
}

function toNum(v: unknown): number {
  return Number(v ?? 0);
}

type UsagePeriodOpts =
  | { period: ResolvedUsagePeriod }
  | { windowMs: number; now?: number };

function periodFromOpts(opts: UsagePeriodOpts): ResolvedUsagePeriod {
  if ("period" in opts) return opts.period;
  const now = opts.now ?? Date.now();
  return {
    startMs: now - opts.windowMs,
    endMs: now + 1,
    windowMs: opts.windowMs,
    activityStartMs: Math.floor(now / DAY_MS) * DAY_MS - opts.windowMs + DAY_MS,
    activityDays: opts.windowMs / DAY_MS,
    label: `${opts.windowMs}ms`,
    kind: "lookback",
  };
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
function scopeWhere(prefix: "" | "ce.", period: ResolvedUsagePeriod, s: UsageScope): SQL {
  const col = (name: string): SQL => sql.raw(`${prefix}${name}`);
  const base = sql`${col("created_at")} >= ${period.startMs} AND ${col("created_at")} < ${period.endMs} AND ${col("org_id")} = ${s.orgId}`;
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

/** Settled assistant tool calls and workflow tool nodes executed without a model. */
async function queryUsageToolEfficiency(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): Promise<UsageToolEfficiencyResponse> {
  const period = periodFromOpts(opts);
  const scope = opts.scope;
  const engineScope = scopeWhere("ce.", period, scope);
  interface CountRow { use_case: string; calls: unknown }
  const [engine, workflow] = await Promise.all([
    db.execute(sql`
      SELECT ce.use_case, SUM(ce.tool_calls) AS calls
      FROM ${usagePeriodRows(period, true)} ce
      WHERE ${engineScope} AND ce.tool_calls > 0
      GROUP BY ce.use_case`) as Promise<{ rows: CountRow[] }>,
    getActionToolCalls(db, period, scope),
  ]);
  const directed = new Map(engine.rows.filter((r) => isUsageUseCase(r.use_case)).map((r) => [r.use_case as UsageUseCase, toNum(r.calls)]));
  return {
    windowMs: period.windowMs ?? period.endMs - period.startMs,
    scope: scope.scope,
    byUseCase: USE_CASES.map((useCase) => ({
      useCase,
      modelDirectedCalls: directed.get(useCase) ?? 0,
      modelFreeActions: useCase === "workflow" ? workflow : 0,
    })),
  };
}

const OUTCOME_KINDS: readonly UsageOutcomeKind[] = [
  "pull_request_created", "review_submitted", "slack_message_sent", "slack_dm_sent",
];

/** Count confirmed writes, then allocate each parent's observed model cost
 * across its outcomes in the selected period. This is a cost estimate. */
async function queryUsageOutcomes(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): Promise<UsageOutcomesResponse> {
  const period = periodFromOpts(opts);
  const { scope } = opts;
  const costScope = scopeWhere("", period, scope);
  interface OutcomeRow { parent: string; kind: string; count: unknown }
  interface CostRow { parent: string; cost_usd: unknown; unpriced_turns: unknown }
  const [actions, terminal] = await Promise.all([
    getActionOutcomes(db, period, scope),
    db.execute(sql`
      SELECT CASE WHEN ce.workflow_run_id IS NOT NULL THEN 'w:' || ce.workflow_run_id
        ELSE 's:' || ce.session_id END AS parent,
        outcome.kind, SUM(outcome.count) AS count
      FROM ${usagePeriodRows(period, true)} ce
      CROSS JOIN LATERAL (VALUES
        ('pull_request_created', ce.pull_requests), ('review_submitted', ce.reviews)
      ) outcome(kind, count)
      WHERE ${scopeWhere("ce.", period, scope)} AND outcome.count > 0
        AND (ce.pull_requests > 0 OR ce.reviews > 0)
      GROUP BY 1, 2`) as Promise<{ rows: OutcomeRow[] }>,
  ]);

  const byParent = new Map<string, Map<UsageOutcomeKind, number>>();
  for (const row of [...actions, ...terminal.rows]) {
    if (!OUTCOME_KINDS.includes(row.kind as UsageOutcomeKind)) continue;
    const kind = row.kind as UsageOutcomeKind;
    const counts = byParent.get(row.parent) ?? new Map<UsageOutcomeKind, number>();
    counts.set(kind, (counts.get(kind) ?? 0) + toNum(row.count));
    byParent.set(row.parent, counts);
  }
  // Parents without outcomes need no cost allocation. Keep this query bounded
  // to confirmed parents instead of aggregating every session in the org.
  const sessions = [...byParent.keys()].filter((p) => p.startsWith("s:")).map((p) => p.slice(2));
  const workflows = [...byParent.keys()].filter((p) => p.startsWith("w:")).map((p) => p.slice(2));
  const parentFilters: SQL[] = [];
  if (sessions.length) parentFilters.push(sql`(workflow_run_id IS NULL AND session_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(sessions)}::jsonb)))`);
  if (workflows.length) parentFilters.push(sql`workflow_run_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(workflows)}::jsonb))`);
  const costs = parentFilters.length ? await db.execute(sql`
    SELECT CASE WHEN workflow_run_id IS NOT NULL THEN 'w:' || workflow_run_id
      ELSE 's:' || session_id END AS parent,
      COALESCE(SUM(cost_total), 0) AS cost_usd,
      COALESCE(SUM(unpriced_turns),0) AS unpriced_turns
    FROM ${usagePeriodRows(period)} ce
    WHERE ${costScope} AND (${sql.join(parentFilters, sql` OR `)})
    GROUP BY 1`) as { rows: CostRow[] } : { rows: [] };
  const costByParent = new Map(costs.rows.map((row) => [row.parent, row]));
  const totals = new Map<UsageOutcomeKind, { count: number; cost: number }>(
    OUTCOME_KINDS.map((kind) => [kind, { count: 0, cost: 0 }]),
  );
  let unpricedTurns = 0;
  for (const [parent, counts] of byParent) {
    const parentCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const cost = costByParent.get(parent);
    unpricedTurns += toNum(cost?.unpriced_turns);
    for (const [kind, count] of counts) {
      const total = totals.get(kind);
      if (!total) continue;
      total.count += count;
      total.cost += toNum(cost?.cost_usd) * count / parentCount;
    }
  }
  return {
    scope: scope.scope,
    byOutcome: OUTCOME_KINDS.map((kind) => {
      const { count, cost } = totals.get(kind) ?? { count: 0, cost: 0 };
      return { kind, count, estimatedCostUsd: cost, estimatedCostPerOutcomeUsd: count ? cost / count : null };
    }),
    unpricedTurns,
  };
}

/** Distinct sessions with positive token usage, grouped into UTC calendar days.
 * Reads retained usage; page views, idle sessions and proxy calls do not count.
 */
async function queryDailyAgentActivity(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): Promise<DailyAgentActivityResponse> {
  const period = periodFromOpts(opts);
  const activityPeriod = period.activityStartMs === undefined ? period : { ...period, startMs: period.activityStartMs };
  const where = scopeWhere("ce.", activityPeriod, opts.scope);
  type ActivityRow = {
    day_ms: unknown; team_id: string | null; team_name: string | null;
    kind: "assistant" | "child" | "workflow" | "session"; active_agents: unknown;
  };
  // AppDb abstracts Postgres and PGlite; the selected columns define this result.
  const rows = await db.execute(sql`
    SELECT (floor(ce.created_at / ${DAY_MS}) * ${DAY_MS})::bigint AS day_ms,
      CASE WHEN ce.owner_type = 'team' THEN ce.owner_id END AS team_id,
      t.name AS team_name,
      CASE
        WHEN ce.use_case = 'workflow' THEN 'workflow'
        WHEN ce.session_id LIKE 'orchestrator:%' OR EXISTS (
          SELECT 1 FROM assistants a WHERE a.session_id = ce.session_id AND a.org_id = ce.org_id
        ) THEN 'assistant'
        WHEN EXISTS (
          SELECT 1 FROM child_watches w WHERE w.child_session_id = ce.session_id AND w.org_id = ce.org_id
        ) THEN 'child'
        ELSE 'session'
      END AS kind,
      COUNT(DISTINCT ce.session_id) AS active_agents
    FROM ${usagePeriodRows(activityPeriod)} ce
    LEFT JOIN teams t ON ce.owner_type = 'team' AND t.id = ce.owner_id AND t.org_id = ce.org_id
    WHERE ${where}
      AND ce.session_id IS NOT NULL AND ce.positive_turns > 0
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2 NULLS FIRST, 4
  `) as { rows: ActivityRow[] };
  return {
    scope: opts.scope.scope,
    timezone: "UTC",
    days: rows.rows.map((r) => ({
      dayMs: toNum(r.day_ms), teamId: r.team_id, teamName: r.team_name,
      kind: r.kind, activeAgents: toNum(r.active_agents),
    })),
  };
}

// ── Breakdown ────────────────────────────────────────────────────────────────

/** All-use-case spend for a window: totals, by use case, by model, by day, and
 * (org scope) by member. */
async function queryUsageBreakdown(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): Promise<UsageBreakdownResponse> {
  const period = periodFromOpts(opts);
  const where = scopeWhere("", period, opts.scope);
  const agentWindow = opts.scope.scope === "team" && opts.scope.byMember
    ? {
        days: period.activityDays ?? Math.max(1, Math.ceil((period.endMs - period.startMs) / DAY_MS)),
        sinceMs: period.activityStartMs ?? period.startMs,
        untilMs: period.endMs,
        timezone: "UTC" as const,
      }
    : undefined;

  interface GroupRow extends BucketRow {
    grouping_key: unknown; use_case: string | null; model: string | null;
    day_ms: unknown; user_id: string | null; active_agents: unknown;
  }
  // One cost view scan produces the use-case, model, day, member, and total
  // buckets. GROUPING distinguishes a real NULL value from an omitted column.
  const [grouped, skillBreakdown, agentDays] = await Promise.all([
    db.execute(sql`
      WITH scoped AS MATERIALIZED (
        SELECT use_case, model, user_id, session_id,
          (floor(created_at / ${DAY_MS}) * ${DAY_MS})::bigint AS day_ms,
          cost_total, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, turns, unpriced_turns, positive_turns
        FROM ${usagePeriodRows(period)} ce WHERE ${where}
      ), grouped AS (
      SELECT GROUPING(use_case, model, day_ms, user_id) AS grouping_key,
        use_case, model, day_ms, user_id, ${HOURLY_BUCKET_COLS}
      FROM scoped
      GROUP BY GROUPING SETS ((use_case), (model), (day_ms), (user_id), ())
      ) SELECT grouped.*, CASE WHEN grouping_key=15 THEN
        (SELECT COUNT(DISTINCT session_id) FROM scoped WHERE session_id IS NOT NULL AND positive_turns>0)
        ELSE 0 END AS active_agents FROM grouped
    `) as Promise<{ rows: GroupRow[] }>,
    getSkillBreakdown(db, period, opts.scope),
    agentWindow ? getMemberAgentDays(db, opts.scope, { ...period, startMs: agentWindow.sinceMs }) : Promise.resolve([]),
  ]);

  const groups = (key: number) => grouped.rows.filter((r) => toNum(r.grouping_key) === key);
  const totals = groups(15)[0];
  const total = toBucket(totals);
  let byUserOut: UsageBreakdownResponse["byUser"];
  if (opts.scope.scope === "org" || (opts.scope.scope === "team" && opts.scope.byMember)) {
    const memberBuckets = new Map(groups(14).map((r) => [r.user_id, toBucket(r)]));
    const agentDaysByUser = new Map(agentDays.map((r) => [r.actor_id, toNum(r.agent_days)]));
    // Prompt actors can differ from the member billed for a shared session.
    // Keep their activity even when they have no attributed spend.
    for (const r of agentDays) if (!memberBuckets.has(r.actor_id)) memberBuckets.set(r.actor_id, toBucket(undefined));
    const ids = [...memberBuckets.keys()].filter((id): id is string => id !== null);
    const userRows = ids.length === 0 ? [] : await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    byUserOut = [...memberBuckets].map(([userId, bucket]) => ({
      userId: userId ?? "shared",
      name: userId === null ? "Team / shared" : (nameById.get(userId) ?? userId),
      ...bucket,
      ...(agentWindow ? { avgDailyActiveAgents: (agentDaysByUser.get(userId) ?? 0) / agentWindow.days } : {}),
    })).sort((a, b) => b.costUsd - a.costUsd || a.userId.localeCompare(b.userId));
  }

  return {
    windowMs: period.windowMs ?? period.endMs - period.startMs,
    scope: opts.scope.scope,
    activeAgents: toNum(totals?.active_agents),
    totalCostUsd: total.costUsd,
    totalTokens: total.totalTokens,
    totalInputTokens: total.inputTokens,
    totalOutputTokens: total.outputTokens,
    totalCacheReadTokens: total.cacheReadTokens,
    totalCacheWriteTokens: total.cacheWriteTokens,
    totalTurns: total.turns,
    unpricedTurns: total.unpricedTurns,
    skillBreakdown,
    byUseCase: groups(7).filter((r): r is GroupRow & { use_case: UsageUseCase } => r.use_case !== null && isUsageUseCase(r.use_case)).map((r) => ({ useCase: r.use_case, ...toBucket(r) })).sort((a, b) => b.costUsd - a.costUsd),
    byModel: groups(11).map((r) => ({ model: r.model, ...toBucket(r) })).sort((a, b) => b.costUsd - a.costUsd),
    byUser: byUserOut,
    dailyAgentWindow: agentWindow,
    byDay: groups(13).map((r) => ({ dayMs: toNum(r.day_ms), costUsd: toNum(r.cost_usd), totalTokens: toNum(r.total_tokens) })).sort((a, b) => a.dayMs - b.dayMs),
  };
}

// ── Drill-down (per use case) ────────────────────────────────────────────────

/** Drill-down rows for ONE use case: sessions (title + child nesting), workflow
 * runs (workflow name), or proxy (by harness). */
async function queryUsageDrillItems(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope; useCase: UsageUseCase },
): Promise<UsageDrillItem[]> {
  const period = periodFromOpts(opts);
  const { useCase, scope } = opts;

  if (useCase === "session" || useCase === "orchestrator") {
    const whereCe = scopeWhere("ce.", period, scope);
    interface Row { session_id: string; title: string | null; parent_session_id: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
    const r = (await db.execute(sql`
      SELECT ce.session_id, s.title, cw.parent_session_id,
             COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COALESCE(SUM(ce.turns),0) AS turns
      FROM ${usagePeriodRows(period)} ce
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
    const whereCe = scopeWhere("ce.", period, scope);
    interface Row { workflow_run_id: string | null; name: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
    const r = (await db.execute(sql`
      SELECT ce.workflow_run_id, wd.name,
             COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COALESCE(SUM(ce.turns),0) AS turns
      FROM ${usagePeriodRows(period)} ce
      LEFT JOIN workflow_definitions wd ON wd.id = ce.workflow_id
      WHERE ${whereCe} AND ce.use_case = 'workflow' AND ce.workflow_run_id IS NOT NULL
      GROUP BY ce.workflow_run_id, wd.name
      ORDER BY cost_usd DESC LIMIT 200`)) as { rows: Row[] };
    return r.rows.map((x) => ({
      id: x.workflow_run_id ?? "", label: x.name ?? `run ${x.workflow_run_id}`, useCase, isChild: false,
      parentId: null, sessionId: null, costUsd: toNum(x.cost_usd), totalTokens: toNum(x.total_tokens), turns: toNum(x.turns),
    }));
  }
  // Proxy hours retain harness identity; partial hours retain exact timestamps.
  const whereProxy = scope.scope === "team"
    ? sql`created_at >= ${period.startMs} AND created_at < ${period.endMs} AND org_id = ${scope.orgId} AND team_id = ${scope.teamId}`
    : scopeWhere("", period, scope);
  interface Row { harness: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
  const r = (await db.execute(sql`
    SELECT harness, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS total_tokens, COALESCE(SUM(turns),0) AS turns
    FROM ${proxyPeriodRows(period)} proxy_usage
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
async function queryUsageSessions(
  db: AppDb,
  opts: UsagePeriodOpts & { orgId: string; userId: string; useCase?: string },
): Promise<UsageSessionRow[]> {
  const period = periodFromOpts(opts);
  // This endpoint only covers the two agent-session use cases; a workflow/proxy
  // filter would contradict the `IN ('orchestrator','session')` clause and
  // silently return nothing, so ignore any other value.
  const useCaseFilter = opts.useCase === "orchestrator" || opts.useCase === "session" ? sql`AND ce.use_case = ${opts.useCase}` : sql``;
  interface Row { session_id: string; title: string | null; use_case: string; parent_session_id: string | null; cost_usd: unknown; total_tokens: unknown; turns: unknown }
  const result = (await db.execute(sql`
    SELECT ce.session_id, s.title, ce.use_case, cw.parent_session_id,
           COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COALESCE(SUM(ce.turns),0) AS turns
    FROM ${usagePeriodRows(period)} ce
    LEFT JOIN agent_sessions s ON s.id = ce.session_id
    LEFT JOIN child_watches cw ON cw.child_session_id = ce.session_id
    WHERE ce.created_at >= ${period.startMs} AND ce.created_at < ${period.endMs} AND ce.org_id = ${opts.orgId} AND ce.user_id = ${opts.userId}
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

const TURN_EXPORT_BATCH_SIZE = 5_000;

const TURN_CSV_HEADER = "timestamp,use_case,model,session_id,workflow_run_id,user_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd,priced,employee_name,employee_email,repository,channel_type,channel_id";
const AGGREGATE_CSV_HEADER = "bucket_start,use_case,provider,model,owner_type,owner_id,user_id,employee_name,employee_email,turns,unpriced_turns,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_usd";

function csvEscape(v: unknown): string {
  const value = v === null || v === undefined ? "" : String(v);
  const formulaPrefix = /^[-=+@\t\r]/.test(value);
  const safe = formulaPrefix ? `'${value}` : value;
  return formulaPrefix || /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

interface AggregateExportRow {
  bucket_start: unknown; use_case: string; provider: string | null; model: string | null;
  owner_type: string | null; owner_id: string | null; user_id: string | null;
  employee_name: string | null; employee_email: string | null; turns: unknown;
  unpriced_turns: unknown; input_tokens: unknown; output_tokens: unknown;
  cache_read_tokens: unknown; cache_write_tokens: unknown; total_tokens: unknown; cost_usd: unknown;
}

/** Aggregate CSV rows use UTC epoch buckets and the same ledger sums as the
 * dashboard. A plain team member gets one aggregate across users: the query
 * does not group by stable or human user identity. */
async function queryUsageAggregateExportCsv(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope; granularity: "day" | "hour" },
): Promise<string> {
  const period = periodFromOpts(opts);
  const bucketMs = opts.granularity === "day" ? DAY_MS : 60 * 60 * 1000;
  const withholdIdentity = opts.scope.scope === "team" && !opts.scope.byMember;
  const identitySelect = withholdIdentity
    ? sql`NULL::text AS user_id, NULL::text AS employee_name, NULL::text AS employee_email`
    : sql`ce.user_id, u.name AS employee_name, u.email AS employee_email`;
  const groupColumns = withholdIdentity ? sql`1,2,3,4,5,6` : sql`1,2,3,4,5,6,7,8,9`;
  const result = (await db.execute(sql`
    SELECT (floor(ce.created_at / ${bucketMs}) * ${bucketMs})::bigint AS bucket_start,
           ce.use_case, ce.provider, ce.model, ce.owner_type, ce.owner_id,
           ${identitySelect},
           COALESCE(SUM(ce.turns),0) AS turns, COALESCE(SUM(ce.unpriced_turns),0) AS unpriced_turns,
           COALESCE(SUM(ce.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(ce.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(ce.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(ce.cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(ce.total_tokens), 0) AS total_tokens,
           COALESCE(SUM(ce.cost_total), 0) AS cost_usd
    FROM ${usagePeriodRows(period, false, opts.granularity === "day")} ce
    LEFT JOIN "user" u ON u.id = ce.user_id
    WHERE ${scopeWhere("ce.", period, opts.scope)}
    GROUP BY ${groupColumns}
    ORDER BY 1 DESC, 2, 3 NULLS FIRST, 4 NULLS FIRST, 5 NULLS FIRST, 6 NULLS FIRST,
             7 NULLS FIRST, 8 NULLS FIRST, 9 NULLS FIRST
  `)) as { rows: AggregateExportRow[] };

  const lines = result.rows.map((row) => [
    new Date(toNum(row.bucket_start)).toISOString(), row.use_case, row.provider, row.model,
    row.owner_type, row.owner_id, row.user_id, row.employee_name, row.employee_email,
    toNum(row.turns), toNum(row.unpriced_turns), toNum(row.input_tokens), toNum(row.output_tokens),
    toNum(row.cache_read_tokens), toNum(row.cache_write_tokens), toNum(row.total_tokens), toNum(row.cost_usd),
  ].map(csvEscape).join(","));
  return `${AGGREGATE_CSV_HEADER}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

interface TurnExportRow {
  entry_id: string; created_at: unknown; use_case: string; model: string | null;
  session_id: string | null; workflow_run_id: string | null; user_id: string | null;
  employee_name: string | null; employee_email: string | null; repository: string | null;
  channel_type: string | null; channel_id: string | null; input_tokens: unknown;
  output_tokens: unknown; cache_read_tokens: unknown; cache_write_tokens: unknown;
  total_tokens: unknown; cost_total: unknown; priced: unknown;
}

function turnExportLine(row: TurnExportRow, withholdIdentity: boolean): string {
  return [
    new Date(toNum(row.created_at)).toISOString(), row.use_case, row.model, row.session_id, row.workflow_run_id,
    withholdIdentity ? "" : row.user_id, toNum(row.input_tokens), toNum(row.output_tokens),
    toNum(row.cache_read_tokens), toNum(row.cache_write_tokens), toNum(row.total_tokens),
    row.cost_total === null ? "" : toNum(row.cost_total), row.priced,
    withholdIdentity ? "" : row.employee_name, withholdIdentity ? "" : row.employee_email,
    row.repository, row.channel_type, row.channel_id,
  ].map(csvEscape).join(",");
}

/** Stream one CSV row per billable turn. Each pull loads one keyset page, so
 * memory is bounded by the page size. The `(created_at, use_case, entry_id)`
 * order is total across both ledger branches. A query error errors the stream;
 * it never closes a truncated CSV as a successful response. */
export function createUsageTurnExportStream(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): ReadableStream<Uint8Array> {
  const period = periodFromOpts(opts);
  const withholdIdentity = opts.scope.scope === "team" && !opts.scope.byMember;
  const encoder = new TextEncoder();
  let cursor: { createdAt: number; useCase: string; entryId: string } | undefined;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${TURN_CSV_HEADER}\n`));
    },
    async pull(controller) {
      if (finished) return;
      try {
        const cursorWhere = cursor === undefined ? sql`` : sql`AND (
          ce.created_at < ${cursor.createdAt}
          OR (ce.created_at = ${cursor.createdAt} AND ce.use_case < ${cursor.useCase})
          OR (ce.created_at = ${cursor.createdAt} AND ce.use_case = ${cursor.useCase} AND ce.entry_id < ${cursor.entryId})
        )`;
        const result = (await db.execute(sql`
          WITH page AS (
            SELECT ce.entry_id, ce.created_at, ce.use_case, ce.model, ce.session_id,
                   ce.workflow_run_id, ce.user_id, ce.input_tokens, ce.output_tokens,
                   ce.cache_read_tokens, ce.cache_write_tokens, ce.total_tokens,
                   ce.cost_total, ce.priced
            FROM cost_entries ce
            WHERE ${scopeWhere("ce.", period, opts.scope)} ${cursorWhere}
            ORDER BY ce.created_at DESC, ce.use_case DESC, ce.entry_id DESC
            LIMIT ${TURN_EXPORT_BATCH_SIZE}
          ), page_repositories AS (
            SELECT sr.session_id, string_agg(sr.full_name, ';' ORDER BY sr.position) AS repository
            FROM session_repos sr
            JOIN (SELECT DISTINCT session_id FROM page WHERE session_id IS NOT NULL) ps
              ON ps.session_id = sr.session_id
            GROUP BY sr.session_id
          )
          SELECT page.*, u.name AS employee_name, u.email AS employee_email,
                 pr.repository, q.channel::jsonb->>'channelType' AS channel_type,
                 q.channel::jsonb->>'channelId' AS channel_id
          FROM page
          LEFT JOIN "user" u ON u.id = page.user_id
          LEFT JOIN page_repositories pr ON pr.session_id = page.session_id
          LEFT JOIN engine_entries e ON e.id = page.entry_id AND e.session_id = page.session_id
          LEFT JOIN engine_queue_items q ON q.id = e.queue_item_id AND q.session_id = e.session_id
          ORDER BY page.created_at DESC, page.use_case DESC, page.entry_id DESC
        `)) as { rows: TurnExportRow[] };

        if (result.rows.length === 0) {
          finished = true;
          controller.close();
          return;
        }
        const last = result.rows[result.rows.length - 1];
        if (!last) throw new Error("Usage export page was unexpectedly empty.");
        cursor = { createdAt: toNum(last.created_at), useCase: last.use_case, entryId: last.entry_id };
        controller.enqueue(encoder.encode(`${result.rows.map((row) => turnExportLine(row, withholdIdentity)).join("\n")}\n`));
        if (result.rows.length < TURN_EXPORT_BATCH_SIZE) {
          finished = true;
          controller.close();
        }
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
  });
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
 * scopes to a single user; omit it for the org-wide member list.
 * Home dashboard windows and rankings count only Valet activity. */
async function windowAggregate(db: AppDb, orgId: string, sinceMs: number, onlyUserId?: string): Promise<WindowAggRow[]> {
  const result = (await db.execute(sql`
    SELECT user_id, ${HOURLY_BUCKET_COLS}
    FROM ${usagePeriodRows({startMs:sinceMs,endMs:8640000000000000,kind:"lookback",label:"home"})} ce
    WHERE created_at >= ${sinceMs} AND org_id = ${orgId} AND user_id IS NOT NULL
      AND use_case <> 'proxy'
      ${onlyUserId ? sql`AND user_id = ${onlyUserId}` : sql``}
    GROUP BY user_id`)) as { rows: WindowAggRow[] };
  return result.rows;
}

/** The `/api/usage/summary` body: the caller's day/week/month windows, plus an
 * org-wide member comparison when the organizations feature is on. */
async function queryUsageSummary(db: AppDb, opts: { orgId: string; userId: string; now: number }): Promise<UsageSummaryResponse> {
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

export const getUsageToolEfficiency = usageRead(queryUsageToolEfficiency);

export const getUsageOutcomes = usageRead(queryUsageOutcomes);

export const getDailyAgentActivity = usageRead(queryDailyAgentActivity);

export const getUsageBreakdown = usageRead(queryUsageBreakdown);

export const getUsageDrillItems = usageRead(queryUsageDrillItems);

export const getUsageSessions = usageRead(queryUsageSessions);

export const getUsageAggregateExportCsv = usageRead(queryUsageAggregateExportCsv);

export const getUsageSummary = usageRead(queryUsageSummary);
