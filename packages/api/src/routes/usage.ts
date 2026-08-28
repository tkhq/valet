/**
 * `/api/usage` — token/cost aggregates for the dashboard. Thin handlers: they
 * resolve the request (window, scope, admin gate) and delegate every query to
 * the `services/usage` library, which owns the SQL over the one `cost_entries`
 * definition (so the dashboard and Grafana cannot drift).
 */
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { UsageDrillResponse, UsageSessionsResponse } from "../wire/types.js";
import {
  getUsageBreakdown,
  getUsageDrillItems,
  getUsageExportCsv,
  getUsageSessions,
  getUsageSummary,
  isUsageUseCase,
  resolveUsageScope,
  windowLabelFrom,
  windowMsFrom,
} from "../services/usage.js";

export const usageRouter = new Hono<AppEnv>();

/** The denial names the scope the caller asked for: a team refusal must not
 * send them chasing an org-admin toggle. */
function forbiddenBody(requestedScope: string | undefined): { error: string } {
  if (requestedScope?.startsWith("team:")) {
    return { error: "Team usage is available to that team's members. Ask a team admin to add you." };
  }
  return { error: "Organization usage is available to org admins only." };
}

usageRouter.get("/summary", async (c) => {
  const body = await getUsageSummary(c.var.providers.db, {
    orgId: c.var.user.orgId,
    userId: c.var.user.id,
    now: Date.now(),
  });
  return c.json(body);
});

usageRouter.get("/breakdown", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const scope = await resolveUsageScope(db, { orgId: user.orgId, userId: user.id, requestedScope: c.req.query("scope") });
  if (scope === "forbidden") return c.json(forbiddenBody(c.req.query("scope")), 403);
  const body = await getUsageBreakdown(db, { windowMs: windowMsFrom(c.req.query("window")), scope });
  return c.json(body);
});

/** Superseded by `/items`; kept while the dashboard migrates. */
usageRouter.get("/sessions", async (c) => {
  const body: UsageSessionsResponse = {
    sessions: await getUsageSessions(c.var.providers.db, {
      windowMs: windowMsFrom(c.req.query("window")),
      orgId: c.var.user.orgId,
      userId: c.var.user.id,
      useCase: c.req.query("useCase"),
    }),
  };
  return c.json(body);
});

usageRouter.get("/items", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const useCaseQ = c.req.query("useCase");
  if (!useCaseQ || !isUsageUseCase(useCaseQ)) {
    return c.json({ error: "useCase must be one of orchestrator, session, workflow, proxy." }, 400);
  }
  const scope = await resolveUsageScope(db, { orgId: user.orgId, userId: user.id, requestedScope: c.req.query("scope") });
  if (scope === "forbidden") return c.json(forbiddenBody(c.req.query("scope")), 403);
  const body: UsageDrillResponse = {
    items: await getUsageDrillItems(db, { windowMs: windowMsFrom(c.req.query("window")), scope, useCase: useCaseQ }),
  };
  return c.json(body);
});

usageRouter.get("/export.csv", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const scope = await resolveUsageScope(db, { orgId: user.orgId, userId: user.id, requestedScope: c.req.query("scope") });
  if (scope === "forbidden") return c.json(forbiddenBody(c.req.query("scope")), 403);
  const windowLabel = windowLabelFrom(c.req.query("window"));
  const csv = await getUsageExportCsv(db, { windowMs: windowMsFrom(c.req.query("window")), scope });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="valet-usage-${scope.scope}-${windowLabel}.csv"`);
  return c.body(csv);
});
