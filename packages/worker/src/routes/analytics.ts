import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import type { AnalyticsPerformanceResponse, AnalyticsEventsResponse, AnalyticsValueResponse, ValueMetricsWindow } from '@valet/shared';
import {
  getPercentiles,
  getPerfTrend,
  getStageBreakdown,
  getErrorRate,
  getSlowPaths,
  getThroughputStats,
  getEventFeed,
} from '../lib/db/analytics.js';
import {
  getWorkflowResolutionStats,
  getSessionResolutionStats,
  getEscalationStats,
  getApprovalDecisionStats,
  getAgentPrStats,
  getModelUsageRows,
  getSessionModelPairs,
  getSandboxSecondsInWindow,
} from '../lib/db/value-metrics.js';
import { classifyModelTier, safeRate, computeWindowBounds } from '../lib/value-metrics.js';
import { getModelPricing, computeCost, type ModelPricing } from '../services/model-catalog.js';
import { computeSandboxCost } from '../services/sandbox-pricing.js';
import { getDb } from '../lib/drizzle.js';

export const analyticsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/analytics/performance?period=720
analyticsRouter.get('/performance', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();

  const db = c.env.DB;

  const [turnPercentiles, queuePercentiles, wakePercentiles, errorRate, throughput, trend, stages, slowByChannel, slowByModel] = await Promise.all([
    getPercentiles(db, 'turn_complete', periodStart),
    getPercentiles(db, 'queue_wait', periodStart),
    getPercentiles(db, 'runner_idle', periodStart),
    getErrorRate(db, periodStart),
    getThroughputStats(db, periodStart),
    getPerfTrend(db, 'turn_complete', periodStart),
    getStageBreakdown(db, periodStart),
    getSlowPaths(db, periodStart, 'channel'),
    getSlowPaths(db, periodStart, 'model'),
  ]);

  const slowPaths = [
    ...slowByChannel.map((r) => ({ dimension: 'channel', value: r.dimension, p50: r.p50, p95: r.p95, count: r.count })),
    ...slowByModel.map((r) => ({ dimension: 'model', value: r.dimension, p50: r.p50, p95: r.p95, count: r.count })),
  ];

  const response: AnalyticsPerformanceResponse = {
    hero: {
      turnLatencyP50: turnPercentiles.p50,
      turnLatencyP95: turnPercentiles.p95,
      queueWaitP50: queuePercentiles.p50,
      sandboxWakeP50: wakePercentiles.p50,
      errorRate: errorRate.errorRate,
      turnCount: errorRate.totalCompleted,
      errorCount: errorRate.totalErrors,
      tokensPerSecP50: throughput.medianTokensPerSec,
    },
    trend,
    stages,
    slowPaths,
    period: periodHours,
  };

  return c.json(response);
});

// GET /api/analytics/events?period=720&type=github.&limit=50&offset=0
analyticsRouter.get('/events', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const periodStart = new Date(Date.now() - periodHours * 60 * 60 * 1000).toISOString();
  const typePrefix = c.req.query('type') || undefined;
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10), 1), 200);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);

  const db = c.env.DB;
  const { events, total } = await getEventFeed(db, periodStart, { typePrefix, limit, offset });

  // Parse properties JSON for the response
  const parsed = events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    sessionId: e.sessionId,
    sessionTitle: e.sessionTitle,
    userId: e.userId,
    userEmail: e.userEmail,
    userName: e.userName,
    turnId: e.turnId,
    durationMs: e.durationMs,
    channel: e.channel,
    model: e.model,
    toolName: e.toolName,
    errorCode: e.errorCode,
    summary: e.summary,
    createdAt: e.createdAt,
    properties: e.properties ? (() => { try { return JSON.parse(e.properties!) as Record<string, unknown>; } catch { return null; } })() : null,
  }));

  const response: AnalyticsEventsResponse = {
    events: parsed,
    total,
    period: periodHours,
  };

  return c.json(response);
});

/**
 * Compute one window of value metrics. All queries are windowed [start, end)
 * so the same function serves the current window and the prior one (deltas).
 */
async function computeValueWindow(
  db: D1Database,
  pricingMap: Map<string, ModelPricing>,
  startIso: string,
  endIso: string,
): Promise<ValueMetricsWindow> {
  const [workflows, sessions, escalations, approvals, prs, modelRows, sessionModels, sandboxSeconds] = await Promise.all([
    getWorkflowResolutionStats(db, startIso, endIso),
    getSessionResolutionStats(db, startIso, endIso),
    getEscalationStats(db, startIso, endIso),
    getApprovalDecisionStats(db, startIso, endIso),
    getAgentPrStats(db, startIso, endIso),
    getModelUsageRows(db, startIso, endIso),
    getSessionModelPairs(db, startIso, endIso),
    getSandboxSecondsInWindow(db, startIso, endIso),
  ]);

  // LLM cost mirrors /api/usage/stats: models without pricing contribute
  // nothing and leave llmCost null only when NO model has pricing.
  let llmCost: number | null = null;
  let frontierTokens = 0;
  let nonFrontierTokens = 0;
  let unknownTokens = 0;
  for (const row of modelRows) {
    const cost = computeCost(row.model, row.inputTokens, row.outputTokens, pricingMap);
    if (cost !== null) llmCost = (llmCost ?? 0) + cost;
    const tokens = row.inputTokens + row.outputTokens;
    const tier = classifyModelTier(row.model);
    // Unclassifiable models are excluded from the share rather than lumped
    // into "non-frontier" — otherwise new model names silently inflate it.
    if (tier === 'frontier') frontierTokens += tokens;
    else if (tier === 'unknown') unknownTokens += tokens;
    else nonFrontierTokens += tokens;
  }

  const sandboxCost = computeSandboxCost(sandboxSeconds);
  const totalCost = llmCost !== null ? llmCost + sandboxCost : sandboxCost > 0 ? sandboxCost : null;

  const resolvedTasks = workflows.completed + sessions.resolved;
  const decisions = approvals.accepted + approvals.denied;

  const sessionsWithModels = new Set<string>();
  const frontierSessions = new Set<string>();
  for (const pair of sessionModels) {
    sessionsWithModels.add(pair.sessionId);
    if (classifyModelTier(pair.model) === 'frontier') frontierSessions.add(pair.sessionId);
  }

  return {
    totalCost,
    llmCost,
    sandboxCost,
    resolvedWorkflowRuns: workflows.completed,
    resolvedSessions: sessions.resolved,
    resolvedTasks,
    costPerResolvedTask: totalCost !== null && resolvedTasks > 0 ? totalCost / resolvedTasks : null,
    approvalsAccepted: approvals.accepted,
    approvalsDenied: approvals.denied,
    approvalsExpired: approvals.expired,
    acceptedOutputRate: safeRate(approvals.accepted, decisions),
    reworkSessions: sessions.reworkSessions,
    escalationMessages: escalations.escalationMessages,
    erroredSessions: sessions.errored,
    endedSessions: sessions.ended,
    failedWorkflowRuns: workflows.failed,
    terminalWorkflowRuns: workflows.terminal,
    reworkEscalationRate: safeRate(sessions.reworkSessions, sessions.ended),
    medianSessionMinutes: sessions.medianResolvedMinutes,
    medianWorkflowMinutes: workflows.medianCompletedMinutes,
    prsOpened: prs.opened,
    prsMerged: prs.merged,
    prsClosedUnmerged: prs.closedUnmerged,
    prsStillOpen: prs.stillOpen,
    prMergeRate: safeRate(prs.merged, prs.merged + prs.closedUnmerged),
    medianHoursToMerge: prs.medianHoursToMerge,
    frontierTokens,
    nonFrontierTokens,
    unknownTokens,
    nonFrontierTokenShare: safeRate(nonFrontierTokens, frontierTokens + nonFrontierTokens),
    sessionsWithModelUsage: sessionsWithModels.size,
    frontierFreeSessionShare: safeRate(sessionsWithModels.size - frontierSessions.size, sessionsWithModels.size),
  };
}

// GET /api/analytics/value?period=720
analyticsRouter.get('/value', async (c) => {
  const user = c.get('user');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Admin access required', code: 'FORBIDDEN' }, 403);
  }

  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const windows = computeWindowBounds(new Date(), periodHours);

  const db = c.env.DB;
  const pricingMap = await getModelPricing(getDb(db), c.env);

  const [current, previous] = await Promise.all([
    computeValueWindow(db, pricingMap, windows.currentStart, windows.currentEnd),
    computeValueWindow(db, pricingMap, windows.previousStart, windows.previousEnd),
  ]);

  const response: AnalyticsValueResponse = {
    current,
    previous,
    period: periodHours,
  };

  return c.json(response);
});
