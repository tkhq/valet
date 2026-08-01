/**
 * `/api/usage` — token/cost aggregates for the dashboard.
 *
 * Source of truth: `engine_entries.usage` / `.cost` (JSON text columns the
 * engine stamps on each turn's final assistant entry). This route reads the
 * engine table directly with a raw aggregate — the engine store's port has
 * no analytics surface, and adding one for a dashboard card would bloat a
 * deliberately small port. If a second consumer appears, promote this to a
 * store method.
 *
 * `org.members` is included ONLY when the org's `features.organizations`
 * flag is on — single-user mode never sees comparative usage.
 */
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { orgs, users } from "../schema/index.js";
import type { UsageSummaryResponse, UsageWindow } from "../wire/types.js";

export const usageRouter = new Hono<AppEnv>();

const DAY_MS = 24 * 60 * 60 * 1000;

interface AggRow {
  user_id: string;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cost_usd: string | number | null;
  turns: string | number | null;
}

function toWindow(row: AggRow | undefined): UsageWindow {
  return {
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    costUsd: Number(row?.cost_usd ?? 0),
    turns: Number(row?.turns ?? 0),
  };
}

usageRouter.get("/summary", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const now = Date.now();

  // Per-user aggregate since a cutoff. `usage`/`cost` are JSON text — cast
  // per row; entries without usage (user/tool messages) are filtered out.
  async function aggregate(sinceMs: number, onlyUserId?: string): Promise<AggRow[]> {
    // drizzle's execute() is typed `unknown` for raw SQL; narrow to the
    // node-postgres/PGlite result shape ({ rows }).
    const result = (await db.execute(sql`
      SELECT s.user_id,
             SUM(COALESCE((e.usage::jsonb->>'input')::bigint, 0))  AS input_tokens,
             SUM(COALESCE((e.usage::jsonb->>'output')::bigint, 0)) AS output_tokens,
             SUM(COALESCE((e.cost::jsonb->>'total')::float8, 0))   AS cost_usd,
             COUNT(*)                                              AS turns
      FROM engine_entries e
      JOIN agent_sessions s ON s.id = e.session_id
      WHERE e.usage IS NOT NULL
        AND e.created_at >= ${sinceMs}
        AND s.org_id = ${user.orgId}
        ${onlyUserId ? sql`AND s.user_id = ${onlyUserId}` : sql``}
      GROUP BY s.user_id
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
    const userRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users);
    const nameById = new Map(userRows.map((u) => [u.id, u.name || u.email] as const));
    body.org = {
      windowDays: 30,
      members: memberAgg
        .map((row) => ({
          userId: row.user_id,
          name: nameById.get(row.user_id) ?? row.user_id,
          ...toWindow(row),
        }))
        .sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens),
    };
  }

  return c.json(body);
});

export type UsageRouter = typeof usageRouter;
