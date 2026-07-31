import { Hono } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import type { AnalyticsPerformanceResponse, AnalyticsEventsResponse, AnalyticsValueResponse, AnalyticsAdoptionResponse, AnalyticsHealthResponse, ValueMetricsWindow } from '@valet/shared';
import {
  getPercentiles,
  getPerfTrend,
  getStageBreakdown,
  getErrorRate,
  getSlowPaths,
  getThroughputStats,
  getEventFeed,
  getUsageByModel,
  billableInputTokens,
  billableOutputTokens,
} from '../lib/db/analytics.js';
import { getCronHeartbeats, getWebhookDeliveryStats } from '../lib/db/observability.js';
import { adminMiddleware } from '../middleware/admin.js';
import {
  getWorkflowResolutionStats,
  getSessionResolutionStats,
  getApprovalDecisionStats,
  getAgentPrStats,
  getSessionModelPairs,
  getSandboxSecondsInWindow,
  getSessionSourceStats,
} from '../lib/db/value-metrics.js';
import {
  getActiveUsersByDay,
  getActiveUsersByWeek,
  getReturningUserStats,
  getTotalUserCount,
  getEnabledTriggerCounts,
  getWorkflowRunsByDay,
  getChannelBreadth,
  getChannelStickiness,
  getConnectorBreadth,
  getActionsPerPromptByChannel,
  getWorkflowAutonomyStats,
  getWorkflowOutcomesByWorkflow,
  getWorkflowOutcomesByTriggerType,
  getWorkflowFailureReasons,
  getWorkflowDurationStats,
} from '../lib/db/adoption-metrics.js';
import { getFileChangeTotals } from '../lib/db/dashboard.js';
import { classifyModelTier, safeRate, computeWindowBounds } from '../lib/value-metrics.js';
import { getModelPricing, computeCost, type ModelPricing } from '../services/model-catalog.js';
import { computeSandboxCost } from '../services/sandbox-pricing.js';
import { getDb } from '../lib/drizzle.js';

export const analyticsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

analyticsRouter.use('*', adminMiddleware);

// GET /api/analytics/performance?period=720
analyticsRouter.get('/performance', async (c) => {
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

async function computeValueWindow(
  db: D1Database,
  pricingMap: Map<string, ModelPricing>,
  startIso: string,
  endIso: string,
): Promise<ValueMetricsWindow> {
  const [workflows, sessions, approvals, prs, modelRows, sessionModels, sandboxSeconds, sessionSources] = await Promise.all([
    getWorkflowResolutionStats(db, startIso, endIso),
    getSessionResolutionStats(db, startIso, endIso),
    getApprovalDecisionStats(db, startIso, endIso),
    getAgentPrStats(db, startIso, endIso),
    getUsageByModel(db, startIso, endIso),
    getSessionModelPairs(db, startIso, endIso),
    getSandboxSecondsInWindow(db, startIso, endIso),
    getSessionSourceStats(db, startIso, endIso),
  ]);

  // LLM cost mirrors /api/usage/stats: models without pricing contribute
  // nothing and leave llmCost null only when NO model has pricing.
  let llmCost: number | null = null;
  let frontierTokens = 0;
  let nonFrontierTokens = 0;
  let unknownTokens = 0;
  for (const row of modelRows) {
    const cost = computeCost(row.model, row, pricingMap);
    if (cost !== null) llmCost = (llmCost ?? 0) + cost;
    const tokens = billableInputTokens(row) + billableOutputTokens(row);
    const tier = classifyModelTier(row.model);
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
    resolvedWorkflowRuns: workflows.completed,
    resolvedSessions: sessions.resolved,
    resolvedTasks,
    costPerResolvedTask: totalCost !== null && resolvedTasks > 0 ? totalCost / resolvedTasks : null,
    approvalsAccepted: approvals.accepted,
    approvalsDenied: approvals.denied,
    approvalsExpired: approvals.expired,
    acceptedOutputRate: safeRate(approvals.accepted, decisions),
    erroredSessions: sessions.errored,
    endedSessions: sessions.ended,
    failedWorkflowRuns: workflows.failed,
    terminalWorkflowRuns: workflows.terminal,
    sessionErrorRate: safeRate(sessions.errored, sessions.ended),
    medianSessionMinutes: sessions.medianResolvedMinutes,
    medianWorkflowMinutes: workflows.medianCompletedMinutes,
    prsOpened: prs.opened,
    prsMerged: prs.merged,
    prsClosedUnmerged: prs.closedUnmerged,
    prsStillOpen: prs.stillOpen,
    prMergeRate: safeRate(prs.merged, prs.merged + prs.closedUnmerged),
    medianHoursToMerge: prs.medianHoursToMerge,
    unknownTokens,
    nonFrontierTokenShare: safeRate(nonFrontierTokens, frontierTokens + nonFrontierTokens),
    sessionsWithModelUsage: sessionsWithModels.size,
    frontierFreeSessionShare: safeRate(sessionsWithModels.size - frontierSessions.size, sessionsWithModels.size),
    sessionSources,
  };
}

// GET /api/analytics/value?period=720
analyticsRouter.get('/value', async (c) => {
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

// GET /api/analytics/adoption?period=720 — activity + workflow-autonomy
// metrics. Aggregation only over already-written tables; every workflow
// number excludes mode='test' runs, and "human decision" means
// resolved_by IS NOT NULL (status alone cannot distinguish policy
// auto-allows and cancel-cleanup flips from real approvals).
analyticsRouter.get('/adoption', async (c) => {
  const rawPeriod = parseInt(c.req.query('period') || '720', 10);
  const periodHours = Number.isFinite(rawPeriod) ? Math.min(Math.max(rawPeriod, 1), 8760) : 720;
  const windows = computeWindowBounds(new Date(), periodHours);
  const startIso = windows.currentStart;
  const endIso = windows.currentEnd;

  const db = c.env.DB;

  const [
    activeUsersByDay,
    activeUsersByWeek,
    returning,
    totalUsers,
    enabledTriggers,
    workflowRunsByDay,
    channels,
    channelStickiness,
    connectors,
    actionsPerPromptByChannel,
    fileChangeTotals,
    autonomy,
    outcomesByWorkflow,
    outcomesByTriggerType,
    failureReasons,
    durations,
  ] = await Promise.all([
    getActiveUsersByDay(db, startIso, endIso),
    getActiveUsersByWeek(db, startIso, endIso),
    getReturningUserStats(db, startIso, endIso),
    getTotalUserCount(db),
    getEnabledTriggerCounts(db),
    getWorkflowRunsByDay(db, startIso, endIso),
    getChannelBreadth(db, startIso, endIso),
    getChannelStickiness(db, startIso, endIso),
    getConnectorBreadth(db, startIso, endIso),
    getActionsPerPromptByChannel(db, startIso, endIso),
    getFileChangeTotals(db, startIso),
    getWorkflowAutonomyStats(db, startIso, endIso),
    getWorkflowOutcomesByWorkflow(db, startIso, endIso),
    getWorkflowOutcomesByTriggerType(db, startIso, endIso),
    getWorkflowFailureReasons(db, startIso, endIso),
    getWorkflowDurationStats(db, startIso, endIso),
  ]);

  const response: AnalyticsAdoptionResponse = {
    adoption: {
      activeUsersByDay,
      activeUsersByWeek,
      activeUsers: returning.activeUsers,
      returningUsers: returning.returningUsers,
      returningUserRate: safeRate(returning.returningUsers, returning.activeUsers),
      totalUsers,
      enabledTriggers,
      workflowRunsByDay,
      channels,
      channelStickiness,
      connectors,
      actionsPerPromptByChannel,
      linesChanged: fileChangeTotals.lines_changed,
      filesChanged: fileChangeTotals.files_changed,
    },
    autonomy: {
      terminalRuns: autonomy.terminalRuns,
      completedRuns: autonomy.completedRuns,
      failedRuns: autonomy.failedRuns,
      cancelledRuns: autonomy.cancelledRuns,
      successRate: safeRate(autonomy.completedRuns, autonomy.terminalRuns),
      unattendedCompletedRuns: autonomy.unattendedCompletedRuns,
      unattendedCompletionRate: safeRate(autonomy.unattendedCompletedRuns, autonomy.terminalRuns),
      attendedRuns: autonomy.attendedRuns,
      interventionRate: safeRate(autonomy.attendedRuns, autonomy.terminalRuns),
      medianBlockedMinutes: autonomy.medianBlockedMinutes,
      outcomesByWorkflow,
      outcomesByTriggerType,
      failureReasons,
      medianRunMinutes: durations.medianRunMinutes,
      p95RunMinutes: durations.p95RunMinutes,
      measuredRuns: durations.measuredRuns,
    },
    period: periodHours,
  };

  return c.json(response);
});

// How often each scheduled sweep is expected to run, keyed by the job_name the
// runSweep wrapper records (see index.ts). A job is flagged stale when it hasn't
// succeeded in more than 3x its interval. Jobs absent from this map (e.g. a
// renamed sweep, or a heartbeat row from an old deploy) are never flagged.
// Base cron is "* * * * *" (minutely) + "0 3 * * *" (nightly); credential_refresh
// self-gates to every 5th minute.
const EXPECTED_INTERVAL_MS: Record<string, number> = {
  workflow_dispatch: 60_000,
  cancel_cleanup: 60_000,
  spawned_session_cleanup: 60_000,
  approval_resume: 60_000,
  github_reconcile: 60_000,
  orchestrator_reconcile: 60_000,
  credential_refresh: 300_000,
  nightly_session_archive: 86_400_000,
  nightly_trace_retention: 86_400_000,
  nightly_journal_prune: 86_400_000,
  nightly_memory_expiry: 86_400_000,
  nightly_analytics_retention: 86_400_000,
  nightly_webhook_retention: 86_400_000,
  nightly_schedule_tick_retention: 86_400_000,
  nightly_auth_session_expiry: 86_400_000,
};

/**
 * A job is stale when its last success is older than 3x its expected interval.
 * A job with no known interval, or that has never succeeded, is not stale — the
 * dashboard surfaces "never ran" separately via lastSuccessAt=null.
 *
 * cron_heartbeats writes SQLite datetime('now') strings ("YYYY-MM-DD HH:MM:SS",
 * UTC, no zone). Date.parse reads the space form as LOCAL time, so normalise it
 * to ISO-UTC first; ISO strings (Drizzle-written rows) already carry a zone.
 */
export function isJobStale(jobName: string, lastSuccessAt: string | null, now: number): boolean {
  const interval = EXPECTED_INTERVAL_MS[jobName];
  if (interval === undefined || lastSuccessAt === null) return false;
  const iso = lastSuccessAt.includes('T') ? lastSuccessAt : `${lastSuccessAt.replace(' ', 'T')}Z`;
  const last = Date.parse(iso);
  if (Number.isNaN(last)) return false;
  return now - last > interval * 3;
}

// GET /api/analytics/health — cron heartbeat + webhook delivery health
analyticsRouter.get('/health', async (c) => {
  const db = c.env.DB;
  // cron_heartbeats stores UTC datetime('now') strings ("YYYY-MM-DD HH:MM:SS"),
  // which Date.parse reads as UTC; compare against Date.now() (also UTC epoch).
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const [heartbeats, webhookStats] = await Promise.all([
    getCronHeartbeats(db),
    getWebhookDeliveryStats(db, since24h),
  ]);

  const jobs = heartbeats.map((h) => ({
    jobName: h.jobName,
    lastSuccessAt: h.lastSuccessAt,
    lastErrorAt: h.lastErrorAt,
    lastError: h.lastError,
    lastDurationMs: h.lastDurationMs,
    lastItems: h.lastItems,
    stale: isJobStale(h.jobName, h.lastSuccessAt, now),
  }));

  // Roll the per-(provider, outcome) rows up into one entry per provider.
  const byProvider = new Map<string, AnalyticsHealthResponse['webhooks'][number]>();
  for (const row of webhookStats) {
    let entry = byProvider.get(row.provider);
    if (!entry) {
      entry = {
        provider: row.provider,
        received: 0,
        invalidSignature: 0,
        processed: 0,
        failed: 0,
        total: 0,
        lastCreatedAt: null,
      };
      byProvider.set(row.provider, entry);
    }
    if (row.outcome === 'received') entry.received += row.count;
    else if (row.outcome === 'invalid_signature') entry.invalidSignature += row.count;
    else if (row.outcome === 'processed') entry.processed += row.count;
    else if (row.outcome === 'failed') entry.failed += row.count;
    entry.total += row.count;
    if (entry.lastCreatedAt === null || row.lastCreatedAt > entry.lastCreatedAt) {
      entry.lastCreatedAt = row.lastCreatedAt;
    }
  }

  const response: AnalyticsHealthResponse = {
    jobs,
    webhooks: Array.from(byProvider.values()),
  };

  return c.json(response);
});
