import { Hono, type Context } from 'hono';
import type { Env, Variables } from '../env.js';
import type { UsageStatsResponse } from '@valet/shared';
import { getUsageHeroStats, getUsageByDay, getUsageByUser, getUsageByModel, getUsageByUserModel, getUsageByPurposeModel, getUsageByWorkflowModel, getSandboxHeroStats, getSandboxByDay, getSandboxByUser } from '../lib/db/analytics.js';
import { getModelPricing } from '../services/model-catalog.js';
import { computeSandboxCost, DEFAULT_CPU_CORES, DEFAULT_MEMORY_GIB } from '../services/sandbox-pricing.js';
import { getDb } from '../lib/drizzle.js';
import { parseUsageScope, resolveUsagePeriod, UsagePeriodError, type ResolvedUsagePeriod, type UsageScope } from '../services/usage-period.js';
import { usageReportToCsv } from '../services/usage-csv.js';

type UsageContext = Context<{ Bindings: Env; Variables: Variables }>;

export const usageRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Compute cost for a given token count using the pricing map.
 * Returns null if no pricing data is available for the model.
 */
function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricingMap: Map<string, { inputCostPerMillion: number; outputCostPerMillion: number }>,
): number | null {
  const pricing = pricingMap.get(model);
  if (!pricing) return null;
  return (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
}

function resolveRequest(c: UsageContext): { period: ResolvedUsagePeriod; scope: UsageScope; userFilter?: string } {
  const user = c.get('user');
  if (!user) throw new UsagePeriodError('Authentication required');
  const url = new URL(c.req.url);
  const scope = parseUsageScope(url.searchParams.get('scope') ?? undefined);
  if (scope !== 'personal' && user.role !== 'admin') {
    throw new UsagePeriodError('Admin access required for org scope');
  }
  return { period: resolveUsagePeriod(url.searchParams), scope, userFilter: scope === 'personal' ? user.id : undefined };
}

async function buildUsageResponse(c: UsageContext, period: ResolvedUsagePeriod, scope: UsageScope, userFilter?: string): Promise<UsageStatsResponse> {
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
    const cost = computeCost(modelRow.model, modelRow.inputTokens, modelRow.outputTokens, pricingMap);
    if (cost !== null) {
      heroLlmCost = (heroLlmCost ?? 0) + cost;
    }
  }

  // Compute hero sandbox cost
  const heroSandboxCost = computeSandboxCost(sandboxHero.totalActiveSeconds);
  const heroTotalCost = heroLlmCost !== null ? heroLlmCost + heroSandboxCost : heroSandboxCost > 0 ? heroSandboxCost : null;

  // Aggregate cost by day (collapse model-level rows into day-level)
  const dayMap = new Map<string, { cost: number | null; inputTokens: number; outputTokens: number; sandboxCost: number; sandboxActiveSeconds: number }>();
  for (const row of byDayRaw) {
    const existing = dayMap.get(row.date) ?? { cost: null, inputTokens: 0, outputTokens: 0, sandboxCost: 0, sandboxActiveSeconds: 0 };
    existing.inputTokens += row.inputTokens;
    existing.outputTokens += row.outputTokens;
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
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

  // Build per-user LLM cost from per-user per-model data
  const userCostMap = new Map<string, number | null>();
  for (const row of byUserModelRaw) {
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) {
      userCostMap.set(row.userId, (userCostMap.get(row.userId) ?? 0) + cost);
    }
  }

  const byUserModel = byUserModelRaw.map((row) => ({
    ...row,
    cost: computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap),
  }));

  const byPurposeMap = new Map<string, { inputTokens: number; outputTokens: number; cost: number | null; callCount: number }>();
  for (const row of byPurposeModelRaw) {
    const item = byPurposeMap.get(row.purpose) ?? { inputTokens: 0, outputTokens: 0, cost: null, callCount: 0 };
    item.inputTokens += row.inputTokens; item.outputTokens += row.outputTokens; item.callCount += row.callCount;
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) item.cost = (item.cost ?? 0) + cost;
    byPurposeMap.set(row.purpose, item);
  }
  const purposeTokenTotal = Array.from(byPurposeMap.values()).reduce((total, row) => total + row.inputTokens + row.outputTokens, 0);
  const byPurpose = Array.from(byPurposeMap.entries()).map(([purpose, row]) => ({ ...row, purpose, percentage: purposeTokenTotal ? Math.round(((row.inputTokens + row.outputTokens) / purposeTokenTotal) * 1000) / 10 : 0 }));
  const byWorkflowMap = new Map<string, UsageStatsResponse['byWorkflow'][number]>();
  for (const row of byWorkflowRaw) {
    const key = `${row.workflowId ?? ''}\u0000${row.workflowName}\u0000${row.triggerType}`;
    const item = byWorkflowMap.get(key) ?? {
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      triggerType: row.triggerType,
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
      cost: null,
    };
    item.inputTokens += row.inputTokens;
    item.outputTokens += row.outputTokens;
    item.callCount += row.callCount;
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) item.cost = (item.cost ?? 0) + cost;
    byWorkflowMap.set(key, item);
  }
  const byWorkflow = Array.from(byWorkflowMap.values());

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
  const totalTokens = byModelRaw.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
  const byModel = byModelRaw.map((row) => {
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    const percentage = totalTokens > 0
      ? Math.round(((row.inputTokens + row.outputTokens) / totalTokens) * 1000) / 10
      : 0;
    return {
      model: row.model,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cost,
      callCount: row.callCount,
      percentage,
    };
  });

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
      sandboxUsage: 'recorded-intervals-with-legacy-session-start-attribution' as const,
    },
  };

  return response;
}

function exportFilename(scope: UsageScope, label: string): string {
  return `valet-usage-${scope}-${label}.csv`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function withUsageReport(c: UsageContext, format: 'json' | 'csv') {
  try {
    const { period, scope, userFilter } = resolveRequest(c);
    const response = await buildUsageResponse(c, period, scope, userFilter);
    if (format === 'csv') {
      return c.body(usageReportToCsv(response), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${exportFilename(scope, period.label)}"`,
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
