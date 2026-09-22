/**
 * `/api/usage` — token/cost aggregates for the dashboard. Thin handlers: they
 * resolve the request (window, scope, admin gate) and delegate every query to
 * the `services/usage` library, which owns the SQL over the one `cost_entries`
 * definition (so the dashboard and Grafana cannot drift).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { UsageDrillResponse, UsageSessionsResponse } from "../wire/types.js";
import {
  getUsageBreakdown,
  getDailyAgentActivity,
  getUsageDrillItems,
  getUsageExportCsv,
  getUsageSessions,
  getUsageSummary,
  isUsageUseCase,
  resolveUsageScope,
  type UsageScope,
} from "../services/usage.js";
import { resolveUsagePeriod, type ResolvedUsagePeriod } from "../services/usage-period.js";

export const usageRouter = new Hono<AppEnv>();

const MISSING_TEAM = { error: "scope=team needs a teamId query parameter. Pass the team's id." } as const;
const FORBIDDEN = { error: "Organization usage is available to org admins only." } as const;
const TEAM_NOT_FOUND = { error: "Team not found." } as const;

/**
 * Resolves the request's scope, or the error Response to return — one
 * definition for the three scoped endpoints so their error contracts cannot
 * drift. A team refusal is 404, not 403: a team the caller is not on must be
 * indistinguishable from one that does not exist, the same existence-hiding
 * convention the sessions, teams, and events routes use.
 */
async function scopeOrError(c: Context<AppEnv>): Promise<UsageScope | Response> {
  const scope = await resolveUsageScope(c.var.providers.db, {
    orgId: c.var.user.orgId,
    userId: c.var.user.id,
    requestedScope: c.req.query("scope"),
    requestedTeamId: c.req.query("teamId"),
  });
  if (scope === "missing-team") return c.json(MISSING_TEAM, 400);
  if (scope === "team-not-found") return c.json(TEAM_NOT_FOUND, 404);
  if (scope === "forbidden") return c.json(FORBIDDEN, 403);
  return scope;
}

function periodOrError(c: Context<AppEnv>): ResolvedUsagePeriod | Response {
  const result = resolveUsagePeriod({
    window: c.req.query("window"),
    month: c.req.query("month"),
    start: c.req.query("start"),
    end: c.req.query("end"),
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return result.period;
}

usageRouter.get("/summary", async (c) => {
  const body = await getUsageSummary(c.var.providers.db, {
    orgId: c.var.user.orgId,
    userId: c.var.user.id,
    now: Date.now(),
  });
  return c.json(body);
});

usageRouter.get("/daily-agents", async (c) => {
  const scope = await scopeOrError(c);
  if (scope instanceof Response) return scope;
  const period = periodOrError(c);
  if (period instanceof Response) return period;
  return c.json(await getDailyAgentActivity(c.var.providers.db, { period, scope }));
});

usageRouter.get("/breakdown", async (c) => {
  const scope = await scopeOrError(c);
  if (scope instanceof Response) return scope;
  const period = periodOrError(c);
  if (period instanceof Response) return period;
  const body = await getUsageBreakdown(c.var.providers.db, { period, scope });
  return c.json(body);
});

/** Superseded by `/items`; kept while the dashboard migrates. */
usageRouter.get("/sessions", async (c) => {
  const period = periodOrError(c);
  if (period instanceof Response) return period;
  const body: UsageSessionsResponse = {
    sessions: await getUsageSessions(c.var.providers.db, {
      period,
      orgId: c.var.user.orgId,
      userId: c.var.user.id,
      useCase: c.req.query("useCase"),
    }),
  };
  return c.json(body);
});

usageRouter.get("/items", async (c) => {
  const { db } = c.var.providers;
  const useCaseQ = c.req.query("useCase");
  if (!useCaseQ || !isUsageUseCase(useCaseQ)) {
    return c.json({ error: "useCase must be one of orchestrator, session, workflow, proxy." }, 400);
  }
  const scope = await scopeOrError(c);
  if (scope instanceof Response) return scope;
  const period = periodOrError(c);
  if (period instanceof Response) return period;
  const body: UsageDrillResponse = {
    items: await getUsageDrillItems(db, { period, scope, useCase: useCaseQ }),
  };
  return c.json(body);
});

usageRouter.get("/export.csv", async (c) => {
  const scope = await scopeOrError(c);
  if (scope instanceof Response) return scope;
  const period = periodOrError(c);
  if (period instanceof Response) return period;
  const result = await getUsageExportCsv(c.var.providers.db, { period, scope });
  if (!result.ok) return c.json({ error: result.error }, 422);
  // Name the team in a team export's filename, or a member of two teams
  // downloads two indistinguishable files.
  const scopeLabel = scope.scope === "team" ? `team-${scope.teamId}` : scope.scope;
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="valet-usage-${scopeLabel}-${period.label}.csv"`);
  return c.body(result.csv);
});
