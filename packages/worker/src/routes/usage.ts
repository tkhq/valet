import { Hono } from 'hono';
import type { Env, Variables } from '../env.js';
import type { UsageStatsResponse } from '@valet/shared';
import { getUsageHeroStats, getUsageByDay, getUsageByUser, getUsageByModel, getUsageByUserModel, getUsageByPurposeModel, getUsageByWorkflowModel, getSandboxHeroStats, getSandboxByDay, getSandboxByUser, billableInputTokens, billableOutputTokens } from '../lib/db/analytics.js';
import { getModelPricing, computeCost } from '../services/model-catalog.js';
import { computeSandboxCost, DEFAULT_CPU_CORES, DEFAULT_MEMORY_GIB } from '../services/sandbox-pricing.js';
import { getDb } from '../lib/drizzle.js';
import { parseUsageScope, resolveUsagePeriod, UsagePeriodError, type ResolvedUsagePeriod, type UsageScope } from '../services/usage-period.js';
import { usageReportToCsv } from '../services/usage-csv.js';

export const usageRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function resolveRequest(c: any): { period: ResolvedUsagePeriod; scope: UsageScope; userFilter?: string } {
  const user = c.get('user');
  if (!user) throw new UsagePeriodError('Authentication required');
  const url = new URL(c.req.url);
  const scope = parseUsageScope(url.searchParams.get('scope') ?? undefined);
  if (scope !== 'personal' && user.role !== 'admin') {
    throw new UsagePeriodError('Admin access required for team and org scope');
  }
  return { period: resolveUsagePeriod(url.searchParams), scope, userFilter: scope === 'personal' ? user.id : undefined };
}

async function buildUsageResponse(c: any, period: ResolvedUsagePeriod, scope: UsageScope, userFilter?: string): Promise<UsageStatsResponse> {
  const db = c.env.DB;
  const appDb = getDb(db);

  // Fetch all data + pricing in parallel (including sandbox stats)
  const [heroStats, byDayRaw, byUserRaw, byModelRaw, byUserModelRaw, pricingMap, sandboxHero, sandboxByDay, sandboxByUser, byPurposeModelRaw, byWorkflowRaw] = await Promise.all([
    getUsageHeroStats(db, period.start, period.end, userFilter),
    getUsageByDay(db, period.start, period.end, userFilter),
    getUsageByUser(db, period.start, period.end, userFilter),
    getUsageByModel(db, period.start, period.end, userFilter),
    getUsageByUserModel(db, period.start, period.end, userFilter),
    getModelPricing(appDb, c.env),
    getSandboxHeroStats(db, period.start, period.end, userFilter),
    getSandboxByDay(db, period.start, period.end, userFilter),
    getSandboxByUser(db, period.start, period.end, userFilter),
    getUsageByPurposeModel(db, period.start, period.end, userFilter),
    getUsageByWorkflowModel(db, period.start, period.end, userFilter),
  ]);

  // Compute hero LLM total cost
  let heroLlmCost: number | null = null;
  for (const modelRow of byModelRaw) {
    const cost = computeCost(modelRow.model, modelRow, pricingMap);
    if (cost !== null) {
      heroLlmCost = (heroLlmCost ?? 0) + cost;
    }
  }

  // Compute hero sandbox cost
  const heroSandboxCost = computeSandboxCost(sandboxHero.totalActiveSeconds);
  const heroTotalCost = heroLlmCost !== null ? heroLlmCost + heroSandboxCost : heroSandboxCost > 0 ? heroSandboxCost : null;

  // Build sandbox-by-day lookup
  const sandboxDayMap = new Map<string, number>();
  for (const row of sandboxByDay) {
    sandboxDayMap.set(row.date, row.activeSeconds);
  }

  // Aggregate cost by day (collapse model-level rows into day-level)
  const dayMap = new Map<string, { cost: number | null; inputTokens: number; outputTokens: number; sandboxCost: number; sandboxActiveSeconds: number }>();
  for (const row of byDayRaw) {
    const existing = dayMap.get(row.date) ?? { cost: null, inputTokens: 0, outputTokens: 0, sandboxCost: 0, sandboxActiveSeconds: 0 };
    existing.inputTokens += billableInputTokens(row);
    existing.outputTokens += billableOutputTokens(row);
    const cost = computeCost(row.model, row, pricingMap);
    if (cost !== null) {
      existing.cost = (existing.cost ?? 0) + cost;
    }
    dayMap.set(row.date, existing);
  }
  // Merge sandbox data into day map (some days may only have sandbox data)
  for (const row of sandboxByDay) {
    const existing = dayMap.get(row.date) ?? { cost: null, inputTokens: 0, outputTokens: 0, sandboxCost: 0, sandboxActiveSeconds: 0 };
    existing.sandboxActiveSeconds = row.activeSeconds;
    existing.sandboxCost = computeSandboxCost(row.activeSeconds);
    dayMap.set(row.date, existing);
  }
  const costByDay = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({ date, ...data }));

  // Build per-user LLM cost from per-user per-model data, and surface the
  // per-user per-model rows (with cost) so the UI can drill into who is using
  // which models. Ordered by tokens desc (from the query).
  const userCostMap = new Map<string, number | null>();
  const byUserModel = byUserModelRaw.map((row) => {
    const cost = computeCost(row.model, row, pricingMap);
    if (cost !== null) {
      userCostMap.set(row.userId, (userCostMap.get(row.userId) ?? 0) + cost);
    }
    return {
      userId: row.userId,
      model: row.model,
      inputTokens: billableInputTokens(row),
      outputTokens: billableOutputTokens(row),
      cost,
      callCount: row.callCount,
    };
  });

  // Build per-user sandbox cost lookup
  const userSandboxMap = new Map<string, { cost: number; activeSeconds: number }>();
  for (const row of sandboxByUser) {
    const cpuCores = row.sandboxCpuCores ?? DEFAULT_CPU_CORES;
    const memoryGiB = row.sandboxMemoryMib != null ? row.sandboxMemoryMib / 1024 : DEFAULT_MEMORY_GIB;
    userSandboxMap.set(row.userId, {
      cost: computeSandboxCost(row.activeSeconds, cpuCores, memoryGiB),
      activeSeconds: row.activeSeconds,
    });
  }

  const byUser = byUserRaw.map((row) => {
    const llmCost = userCostMap.get(row.userId) ?? null;
    const sandbox = userSandboxMap.get(row.userId);
    const sandboxCost = sandbox?.cost ?? 0;
    const totalCost = llmCost !== null ? llmCost + sandboxCost : sandboxCost > 0 ? sandboxCost : null;
    return {
      userId: row.userId,
      email: row.email,
      ...(row.name ? { name: row.name } : {}),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cost: totalCost,
      sessionCount: row.sessionCount,
      sandboxCost,
      sandboxActiveSeconds: sandbox?.activeSeconds ?? 0,
    };
  });

  // Cost by model
  const totalTokens = byModelRaw.reduce((sum, r) => sum + billableInputTokens(r) + billableOutputTokens(r), 0);
  const byModel = byModelRaw.map((row) => {
    const cost = computeCost(row.model, row, pricingMap);
    const rowTokens = billableInputTokens(row) + billableOutputTokens(row);
    const percentage = totalTokens > 0
      ? Math.round((rowTokens / totalTokens) * 1000) / 10
      : 0;
    return {
      model: row.model,
      inputTokens: billableInputTokens(row),
      outputTokens: billableOutputTokens(row),
      cost,
      callCount: row.callCount,
      percentage,
    };
  });

  // Roll usage up by session origin (sessions.purpose). Cost is per-model, so compute it on the
  // origin×model rows first, then sum to the origin. Percentage is share of total tokens.
  const purposeMap = new Map<string, { inputTokens: number; outputTokens: number; cost: number | null; callCount: number }>();
  for (const row of byPurposeModelRaw) {
    const cost = computeCost(row.model, row, pricingMap);
    const e = purposeMap.get(row.purpose) ?? { inputTokens: 0, outputTokens: 0, cost: null, callCount: 0 };
    e.inputTokens += billableInputTokens(row);
    e.outputTokens += billableOutputTokens(row);
    e.callCount += row.callCount;
    if (cost !== null) e.cost = (e.cost ?? 0) + cost;
    purposeMap.set(row.purpose, e);
  }
  const purposeTotalTokens = Array.from(purposeMap.values()).reduce((s, d) => s + d.inputTokens + d.outputTokens, 0);
  const byPurpose = Array.from(purposeMap.entries())
    .map(([purpose, d]) => ({
      purpose,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cost: d.cost,
      callCount: d.callCount,
      percentage: purposeTotalTokens > 0 ? Math.round(((d.inputTokens + d.outputTokens) / purposeTotalTokens) * 1000) / 10 : 0,
    }))
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

  // Per-automation drill-down: roll the workflow×model rows up per (workflow, trigger type),
  // cost computed per-model first. Keyed by workflow id + trigger so a workflow fired by both a
  // schedule and a manual run shows as separate, honest rows.
  const workflowMap = new Map<string, { workflowId: string | null; workflowName: string; triggerType: string; inputTokens: number; outputTokens: number; cost: number | null; callCount: number }>();
  for (const row of byWorkflowRaw) {
    const key = `${row.workflowId ?? 'null'}::${row.triggerType}`;
    const cost = computeCost(row.model, row, pricingMap);
    const e = workflowMap.get(key) ?? { workflowId: row.workflowId, workflowName: row.workflowName, triggerType: row.triggerType, inputTokens: 0, outputTokens: 0, cost: null, callCount: 0 };
    e.inputTokens += billableInputTokens(row);
    e.outputTokens += billableOutputTokens(row);
    e.callCount += row.callCount;
    if (cost !== null) e.cost = (e.cost ?? 0) + cost;
    workflowMap.set(key, e);
  }
  const byWorkflow = Array.from(workflowMap.values())
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));

  const response: UsageStatsResponse = {
    hero: {
      totalCost: heroTotalCost,
      totalInputTokens: heroStats.totalInputTokens,
      totalOutputTokens: heroStats.totalOutputTokens,
      totalSessions: heroStats.totalSessions,
      totalUsers: heroStats.totalUsers,
      sandboxCost: heroSandboxCost,
      sandboxActiveSeconds: sandboxHero.totalActiveSeconds,
    },
    costByDay,
    byUser,
    byModel,
    byUserModel,
    byPurpose,
    byWorkflow,
    period: period.selection.kind === 'lookback' ? period.selection.hours : 0,
    report: {
      scope,
      periodType: period.selection.kind,
      start: period.start,
      end: period.end,
      label: period.label,
      timezone: period.timezone,
      boundary: 'start-inclusive/end-exclusive' as const,
    },
  };

  return response;
}

async function withUsageReport(c: any, format: 'json' | 'csv') {
  try {
    const { period, scope, userFilter } = resolveRequest(c);
    const response = await buildUsageResponse(c, period, scope, userFilter);
    if (format === 'csv') {
      return c.body(usageReportToCsv(response), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="valet-usage-${scope}-${period.label}.csv"`,
      });
    }
    return c.json(response);
  } catch (error) {
    if (error instanceof UsagePeriodError) {
      const status = error.message === 'Authentication required' ? 401 : error.message.startsWith('Admin access') ? 403 : 400;
      return c.json({ error: error.message, code: status === 403 ? 'FORBIDDEN' : 'INVALID_PERIOD' }, status);
    }
    throw error;
  }
}

// GET /api/usage/stats. All report windows are exact [start, end) UTC intervals.
usageRouter.get('/stats', (c) => withUsageReport(c, 'json'));
usageRouter.get('/export.csv', (c) => withUsageReport(c, 'csv'));
