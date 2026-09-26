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
import type { ResolvedUsagePeriod } from "./usage-period.js";
import { canAdministerTeam, getTeamInOrg, isTeamMember } from "./teams.js";
import type {
  UsageBreakdownResponse,
  DailyAgentActivityResponse,
  UsageBucket,
  UsageDrillItem,
  UsageSessionRow,
  SkillUsageBreakdown,
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

function skillScopeWhere(scope: UsageScope): SQL {
  const orgId = sql`COALESCE(s.org_id, d.org_id)`;
  const ownerType = sql`COALESCE(s.owner_type, r.owner_type)`;
  const ownerId = sql`COALESCE(s.owner_id, r.owner_id)`;
  const userId = sql`CASE
    WHEN s.id IS NOT NULL THEN s.user_id
    WHEN r.owner_type = 'user' THEN NULLIF(r.owner_id, '')
  END`;
  const base = sql`${orgId} = ${scope.orgId}`;
  switch (scope.scope) {
    case "team":
      return sql`${base} AND ${ownerType} = 'team' AND ${ownerId} = ${scope.teamId}`;
    case "me":
      return sql`${base} AND ${userId} = ${scope.userId}`;
    case "org":
      return base;
  }
}

// JSON.stringify can persist a NUL as \u0000 in tool output. PostgreSQL jsonb
// cannot decode it, so replace that escape before reading the call metadata.
const TOOL_PARTS = sql`jsonb_array_elements(
  replace(e.parts, chr(92) || 'u0000', chr(92) || 'uFFFD')::jsonb
)`;

/** Settled assistant tool calls and workflow tool nodes executed without a model. */
export async function getUsageToolEfficiency(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): Promise<UsageToolEfficiencyResponse> {
  const period = periodFromOpts(opts);
  const scope = opts.scope;
  const engineScope = skillScopeWhere(scope);
  const actionOwner = scope.scope === "team"
    ? sql`AND r.owner_type = 'team' AND r.owner_id = ${scope.teamId}`
    : scope.scope === "me"
      ? sql`AND r.owner_type = 'user' AND r.owner_id = ${scope.userId}`
      : sql``;
  interface CountRow { use_case: string; calls: unknown }
  const [engine, workflow] = await Promise.all([
    db.execute(sql`
      SELECT CASE
        WHEN e.session_id LIKE 'orchestrator:%' THEN 'orchestrator'
        WHEN e.session_id LIKE 'wf:%' THEN 'workflow'
        ELSE 'session'
      END AS use_case, COUNT(*) AS calls
      FROM engine_entries e
      LEFT JOIN agent_sessions s ON s.id = e.session_id
      LEFT JOIN workflow_runs r
        ON e.session_id LIKE 'wf:%' AND r.id = split_part(e.session_id, ':', 2)
      LEFT JOIN workflow_definitions d ON d.id = r.workflow_id
      CROSS JOIN LATERAL ${TOOL_PARTS} AS p(part)
      WHERE e.created_at >= ${period.startMs} AND e.created_at < ${period.endMs}
        AND e.entry_type = 'message' AND e.role = 'assistant' AND e.parts IS NOT NULL
        AND ${engineScope}
        AND p.part->>'type' = 'tool_call'
        AND p.part->>'status' IN ('completed', 'error')
      GROUP BY 1`) as Promise<{ rows: CountRow[] }>,
    db.execute(sql`
      SELECT COUNT(*) AS calls
      FROM action_invocations ai
      JOIN workflow_runs r ON r.id = ai.workflow_execution_id
      JOIN workflow_definitions d ON d.id = r.workflow_id
      WHERE COALESCE(ai.started_at, ai.created_at) >= ${period.startMs}
        AND COALESCE(ai.started_at, ai.created_at) < ${period.endMs}
        AND ai.org_id = ${scope.orgId} AND d.org_id = ${scope.orgId}
        ${actionOwner}
        AND ai.service IS NOT NULL AND ai.action_id IS NOT NULL
        AND ai.status IN ('completed', 'error') AND ai.duration_ms IS NOT NULL`) as Promise<{ rows: { calls: unknown }[] }>,
  ]);
  const directed = new Map(engine.rows.filter((r) => isUsageUseCase(r.use_case)).map((r) => [r.use_case as UsageUseCase, toNum(r.calls)]));
  return {
    windowMs: period.windowMs ?? period.endMs - period.startMs,
    scope: scope.scope,
    byUseCase: USE_CASES.map((useCase) => ({
      useCase,
      modelDirectedCalls: directed.get(useCase) ?? 0,
      modelFreeActions: useCase === "workflow" ? toNum(workflow.rows[0]?.calls) : 0,
    })),
  };
}

const OUTCOME_KINDS: readonly UsageOutcomeKind[] = [
  "pull_request_created", "review_submitted", "slack_message_sent", "slack_dm_sent",
];

/** Count confirmed writes, then allocate each parent's observed model cost
 * across its outcomes in the selected period. This is a cost estimate. */
export async function getUsageOutcomes(
  db: AppDb,
  opts: UsagePeriodOpts & { scope: UsageScope },
): Promise<UsageOutcomesResponse> {
  const period = periodFromOpts(opts);
  const { scope } = opts;
  const actionScope = skillScopeWhere(scope);
  const costScope = scopeWhere("", period, scope);
  interface OutcomeRow { parent: string; kind: string; count: unknown }
  interface CostRow { parent: string; cost_usd: unknown; unpriced_turns: unknown }
  const [actions, terminal, costs] = await Promise.all([
    db.execute(sql`
      SELECT CASE WHEN r.id IS NOT NULL
          THEN 'w:' || r.id ELSE 's:' || ai.session_id END AS parent,
        CASE
          WHEN ai.action_id = 'github.create_pull_request' THEN 'pull_request_created'
          WHEN ai.action_id = 'github.create_review' THEN 'review_submitted'
          WHEN ai.action_id IN ('slack.dm_owner', 'slack.dm_user')
            OR ai.result::jsonb->'data'->>'channel' LIKE 'D%' THEN 'slack_dm_sent'
          ELSE 'slack_message_sent'
        END AS kind,
        COUNT(*) AS count
      FROM action_invocations ai
      LEFT JOIN agent_sessions s ON s.id = ai.session_id
      LEFT JOIN workflow_runs r ON r.id = COALESCE(
        ai.workflow_execution_id,
        CASE WHEN ai.session_id LIKE 'wf:%' THEN split_part(ai.session_id, ':', 2) END)
      LEFT JOIN workflow_definitions d ON d.id = r.workflow_id
      WHERE COALESCE(ai.started_at, ai.created_at) >= ${period.startMs}
        AND COALESCE(ai.started_at, ai.created_at) < ${period.endMs}
        AND ai.org_id = ${scope.orgId} AND ${actionScope}
        AND ai.status = 'completed' AND ai.duration_ms IS NOT NULL
        AND ai.result::jsonb->>'success' = 'true'
        AND (ai.session_id IS NOT NULL OR ai.workflow_execution_id IS NOT NULL)
        AND (ai.action_id = 'github.create_pull_request'
          OR (ai.action_id = 'github.create_review'
            AND ai.result::jsonb->'data'->>'state' IN ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'))
          OR ai.action_id IN ('slack.send_message', 'slack.reply_to_origin', 'slack.dm_owner', 'slack.dm_user'))
      GROUP BY 1, 2`) as Promise<{ rows: OutcomeRow[] }>,
    db.execute(sql`
      SELECT CASE WHEN r.id IS NOT NULL THEN 'w:' || r.id ELSE 's:' || e.session_id END AS parent,
        p.part->'result'->'details'->'outcome'->>'kind' AS kind,
        COUNT(*) AS count
      FROM engine_entries e
      LEFT JOIN agent_sessions s ON s.id = e.session_id
      LEFT JOIN workflow_runs r
        ON e.session_id LIKE 'wf:%' AND r.id = split_part(e.session_id, ':', 2)
      LEFT JOIN workflow_definitions d ON d.id = r.workflow_id
      CROSS JOIN LATERAL ${TOOL_PARTS} AS p(part)
      WHERE e.created_at >= ${period.startMs} AND e.created_at < ${period.endMs}
        AND e.entry_type = 'message' AND e.role = 'assistant' AND e.parts IS NOT NULL
        AND ${actionScope}
        AND p.part->>'type' = 'tool_call' AND p.part->>'toolName' = 'bash'
        AND p.part->>'status' = 'completed'
        AND p.part->'result'->'details'->'outcome'->>'kind'
          IN ('pull_request_created', 'review_submitted')
      GROUP BY 1, 2`) as Promise<{ rows: OutcomeRow[] }>,
    db.execute(sql`
      SELECT CASE WHEN workflow_run_id IS NOT NULL THEN 'w:' || workflow_run_id
        ELSE 's:' || session_id END AS parent,
        COALESCE(SUM(cost_total), 0) AS cost_usd,
        COUNT(*) FILTER (WHERE NOT priced) AS unpriced_turns
      FROM cost_entries
      WHERE ${costScope} AND session_id IS NOT NULL
      GROUP BY 1`) as Promise<{ rows: CostRow[] }>,
  ]);

  const byParent = new Map<string, Map<UsageOutcomeKind, number>>();
  for (const row of [...actions.rows, ...terminal.rows]) {
    if (!OUTCOME_KINDS.includes(row.kind as UsageOutcomeKind)) continue;
    const kind = row.kind as UsageOutcomeKind;
    const counts = byParent.get(row.parent) ?? new Map<UsageOutcomeKind, number>();
    counts.set(kind, (counts.get(kind) ?? 0) + toNum(row.count));
    byParent.set(row.parent, counts);
  }
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

interface SkillBreakdownRow {
  skill_key: string;
  skill_name: string;
  origin: "plugin" | "local" | "repo";
  plugin_name: string | null;
  invocations: unknown;
  unique_invokers: unknown;
  unassigned_invocations: unknown;
  attributed_context_tokens: unknown;
  carrying_calls: unknown;
}

async function getSkillBreakdown(
  db: AppDb,
  period: ResolvedUsagePeriod,
  scope: UsageScope,
): Promise<SkillUsageBreakdown[]> {
  const where = skillScopeWhere(scope);
  const result = (await db.execute(sql`
    SELECT si.skill_key, si.skill_name, si.origin, si.plugin_name,
           COUNT(DISTINCT si.id) FILTER (WHERE si.created_at >= ${period.startMs} AND si.created_at < ${period.endMs}) AS invocations,
           COUNT(DISTINCT si.invoker_user_id) FILTER (WHERE si.created_at >= ${period.startMs} AND si.created_at < ${period.endMs}) AS unique_invokers,
           COUNT(DISTINCT si.id) FILTER (
             WHERE si.created_at >= ${period.startMs} AND si.created_at < ${period.endMs} AND si.invoker_user_id IS NULL
           ) AS unassigned_invocations,
           COALESCE(SUM(sca.estimated_skill_tokens) FILTER (WHERE sca.created_at >= ${period.startMs} AND sca.created_at < ${period.endMs}), 0)
             AS attributed_context_tokens,
           COUNT(DISTINCT sca.llm_request_id) FILTER (WHERE sca.created_at >= ${period.startMs} AND sca.created_at < ${period.endMs})
             AS carrying_calls
    FROM skill_invocations si
    LEFT JOIN skill_context_attributions sca ON sca.skill_invocation_id = si.id
    LEFT JOIN agent_sessions s ON s.id = si.session_id
    LEFT JOIN workflow_runs r
      ON si.session_id LIKE 'wf:%' AND r.id = split_part(si.session_id, ':', 2)
    LEFT JOIN workflow_definitions d ON d.id = r.workflow_id
    WHERE ${where} AND ((si.created_at >= ${period.startMs} AND si.created_at < ${period.endMs}) OR (sca.created_at >= ${period.startMs} AND sca.created_at < ${period.endMs}))
    GROUP BY si.skill_key, si.skill_name, si.origin, si.plugin_name
    ORDER BY invocations DESC, si.skill_name ASC
  `)) as { rows: SkillBreakdownRow[] };
  return result.rows.map((row) => ({
    skillKey: row.skill_key,
    name: row.skill_name,
    origin: row.origin,
    ...(row.plugin_name ? { pluginName: row.plugin_name } : {}),
    invocations: toNum(row.invocations),
    uniqueInvokers: toNum(row.unique_invokers),
    unassignedInvocations: toNum(row.unassigned_invocations),
    attributedContextTokens: toNum(row.attributed_context_tokens),
    carryingCalls: toNum(row.carrying_calls),
  }));
}

/** Distinct sessions with positive token usage, grouped into UTC calendar days.
 * Reads retained usage; page views, idle sessions and proxy calls do not count.
 */
export async function getDailyAgentActivity(
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
    FROM cost_entries ce
    LEFT JOIN teams t ON ce.owner_type = 'team' AND t.id = ce.owner_id AND t.org_id = ce.org_id
    WHERE ${where}
      AND ce.session_id IS NOT NULL AND ce.total_tokens > 0
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

/** Count session-days per actor, not turns or distinct sessions over the range.
 * Shared assistants must not be credited to the first member who opened them.
 * A session used by two members on one day counts once for each member.
 */
async function getMemberAgentDays(db: AppDb, scope: UsageScope, period: ResolvedUsagePeriod) {
  // The raw query result type describes columns selected below on both DB backends.
  const result = await db.execute(sql`
    WITH active AS (
      SELECT (floor(ce.created_at / ${DAY_MS}) * ${DAY_MS})::bigint AS day_ms,
        ce.session_id,
        COALESCE(NULLIF(q.author::jsonb->>'id', ''), NULLIF(cw.actor_user_id, ''),
          CASE WHEN a.id IS NULL AND ce.session_id NOT LIKE 'orchestrator:%'
            THEN ce.user_id END) AS actor_id
      FROM cost_entries ce
      JOIN engine_entries e ON e.id = ce.entry_id AND e.session_id = ce.session_id
      LEFT JOIN engine_queue_items q ON q.id = e.queue_item_id AND q.session_id = e.session_id
      LEFT JOIN child_watches cw ON cw.child_session_id = ce.session_id AND cw.org_id = ce.org_id
      LEFT JOIN assistants a ON a.session_id = ce.session_id AND a.org_id = ce.org_id
      WHERE ${scopeWhere("ce.", period, scope)}
        AND ce.session_id IS NOT NULL AND ce.total_tokens > 0
    ), daily AS (
      SELECT actor_id, day_ms, COUNT(DISTINCT session_id) AS active_agents
      FROM active GROUP BY actor_id, day_ms
    )
    SELECT actor_id, SUM(active_agents) AS agent_days FROM daily GROUP BY actor_id
  `) as { rows: { actor_id: string | null; agent_days: unknown }[] };
  return result.rows;
}

/** All-use-case spend for a window: totals, by use case, by model, by day, and
 * (org scope) by member. */
export async function getUsageBreakdown(
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
      WITH scoped AS (
        SELECT use_case, model, user_id, session_id,
          (floor(created_at / ${DAY_MS}) * ${DAY_MS})::bigint AS day_ms,
          cost_total, total_tokens, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, priced
        FROM cost_entries WHERE ${where}
      )
      SELECT GROUPING(use_case, model, day_ms, user_id) AS grouping_key,
        use_case, model, day_ms, user_id, ${BUCKET_COLS},
        COUNT(DISTINCT session_id) FILTER (
          WHERE session_id IS NOT NULL AND total_tokens > 0
        ) AS active_agents
      FROM scoped
      GROUP BY GROUPING SETS ((use_case), (model), (day_ms), (user_id), ())
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
export async function getUsageDrillItems(
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
    const whereCe = scopeWhere("ce.", period, scope);
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
  const whereProxy = scope.scope === "team"
    ? sql`created_at >= ${period.startMs} AND created_at < ${period.endMs} AND org_id = ${scope.orgId} AND team_id = ${scope.teamId}`
    : scopeWhere("", period, scope);
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
           COALESCE(SUM(ce.cost_total),0) AS cost_usd, COALESCE(SUM(ce.total_tokens),0) AS total_tokens, COUNT(*) AS turns
    FROM cost_entries ce
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
export async function getUsageAggregateExportCsv(
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
           COUNT(*) AS turns, COUNT(*) FILTER (WHERE NOT ce.priced) AS unpriced_turns,
           COALESCE(SUM(ce.input_tokens), 0) AS input_tokens,
           COALESCE(SUM(ce.output_tokens), 0) AS output_tokens,
           COALESCE(SUM(ce.cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(ce.cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(ce.total_tokens), 0) AS total_tokens,
           COALESCE(SUM(ce.cost_total), 0) AS cost_usd
    FROM cost_entries ce
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
    SELECT user_id, ${BUCKET_COLS}
    FROM cost_entries
    WHERE created_at >= ${sinceMs} AND org_id = ${orgId} AND user_id IS NOT NULL
      AND use_case <> 'proxy'
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
