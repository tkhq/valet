import { stripNul } from "@valet/engine";
import { intentKey, intentKeyFilter, intentJoins, toolIntentUsage } from "../tagging/usage.js";
import { taggingAvailable } from "../tagging/availability.js";
import { readRegistry } from "../tagging/registry.js";
import { enqueueTagging } from "../tagging/tagger.js";
import { canAccessSessionResources } from "./session-access.js";
import type { Providers } from "../providers/types.js";
import { visibleThreadIds } from "./thread-access.js";
import { getTeamInOrg, isTeamMember } from "./teams.js";
import type { ToolUsageFact } from "@valet/shared";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, externalCalls, mcpClientInfo, sessionThreads, teams, users, workflowDefinitions, workflowRuns } from "../schema/index.js";
import type { UsageScope } from "./usage.js";
import type { ResolvedUsagePeriod } from "./usage-period.js";
import type { ExternalUsageResponse } from "../wire/types.js";

export async function bestEffortTelemetry(write: () => Promise<unknown>): Promise<void> {
  try { await write(); }
  catch { console.warn("External usage telemetry failed. Check database availability."); }
}

/** Flip only after the personal-workspace privacy decision changes. Aggregates remain unchanged. */
export const ORG_RECENT_INCLUDES_PERSONAL = false;

export type ExternalCall = typeof externalCalls.$inferInsert;

export async function recordExternalCall(db: AppDb, call: ExternalCall): Promise<void> {
  call = stripNul(call);
  await bestEffortTelemetry(async () => {
    const rows = await db.insert(externalCalls).values(call).onConflictDoUpdate({
      target: externalCalls.id,
      // A CLI invocation can issue many requests. Keep one fact and its latest outcome.
      set: call.surface !== "cli" ? { outcome: call.outcome, errorCode: call.errorCode, durationMs: call.durationMs, createdAt: call.createdAt } : {
        outcome: sql`CASE WHEN ${call.createdAt + call.durationMs} >= ${externalCalls.createdAt} + ${externalCalls.durationMs} THEN ${call.outcome} ELSE ${externalCalls.outcome} END`,
        errorCode: sql`CASE WHEN ${call.createdAt + call.durationMs} >= ${externalCalls.createdAt} + ${externalCalls.durationMs} THEN ${call.errorCode ?? null} ELSE ${externalCalls.errorCode} END`,
        // Discovery requests may precede invocation. Keep the admitted team workspace once known.
        ownerType: call.ownerType === "team" ? call.ownerType : externalCalls.ownerType,
        ownerId: call.ownerType === "team" ? call.ownerId : externalCalls.ownerId,
        createdAt: sql`least(${call.createdAt}, ${externalCalls.createdAt})`,
        durationMs: sql`greatest(0, greatest(${call.createdAt + call.durationMs}, ${externalCalls.createdAt} + ${externalCalls.durationMs}) - least(${call.createdAt}, ${externalCalls.createdAt}))::integer`,
      },
      setWhere: and(eq(externalCalls.orgId, call.orgId), sql`${externalCalls.userId} IS NOT DISTINCT FROM ${call.userId ?? null}`),
    }).returning({ id: externalCalls.id });
    if (rows.length && await taggingAvailable(db, call.orgId)) await enqueueTagging(db, call.orgId, "tool_intent", [{ type: "external_call", id: call.id }]);
  });
}

/** Only server-resolved ownership can put a call in a team's usage. */
export async function externalCallOwner(db: AppDb, orgId: string, userId: string, threadId?: string, sessionId?: string, teamId?: string) {
  const personal = { ownerType: "user" as const, ownerId: userId };
  if (!threadId && !sessionId) {
    if (teamId && await getTeamInOrg(db, orgId, teamId) && await isTeamMember(db, teamId, userId)) {
      return { ownerType: "team" as const, ownerId: teamId };
    }
    return personal;
  }
  const rows = await db.select({ session: agentSessions }).from(agentSessions)
    .leftJoin(sessionThreads, eq(sessionThreads.sessionId, agentSessions.id))
    .where(and(eq(agentSessions.orgId, orgId), threadId ? eq(sessionThreads.id, threadId) : eq(agentSessions.id, sessionId ?? ""))).limit(1);
  const session = rows[0]?.session;
  if (!session) return personal;
  return { ownerType: session.ownerType === "team" ? "team" as const : "user" as const, ownerId: session.ownerId, sessionId: session.id, ...(threadId ? { threadId } : {}) };
}

/** Call only with an API path that admitted this caller. Ownership comes from stored rows, never tool arguments. */
export async function externalWorkflowOwner(db: AppDb, orgId: string, admittedPath: string | undefined) {
  const parts = admittedPath?.split("/");
  if (parts?.[1] !== "api" || parts[2] !== "workflows" || !parts[3]) return undefined;
  const table = parts[3] === "runs" ? workflowRuns : workflowDefinitions;
  const id = decodeURIComponent(parts[3] === "runs" ? parts[4] ?? "" : parts[3]);
  const [row] = await db.select({ ownerType: table.ownerType, ownerId: table.ownerId }).from(table)
    .where(and(eq(table.id, id), eq(table.orgId, orgId))).limit(1);
  return row?.ownerType === "team" ? { ownerType: "team" as const, ownerId: row.ownerId } : undefined;
}

export async function saveMcpClientInfo(db: AppDb, identity: { orgId: string; userId: string; clientId: string }, info: { name: string; version: string }) {
  await bestEffortTelemetry(async () => {
    const value = stripNul({ name: info.name.slice(0, 200), version: info.version.slice(0, 100) });
    await db.insert(mcpClientInfo).values({ ...identity, ...value }).onConflictDoUpdate({
      target: [mcpClientInfo.orgId, mcpClientInfo.userId, mcpClientInfo.clientId], set: value,
    });
  });
}

export async function getExternalUsage(db: AppDb, opts: {
  viewer: { deps: Pick<Providers, "db" | "engineStore" | "engineCredentials" | "onePassword">; userId: string }; period: ResolvedUsagePeriod; scope: UsageScope; key?: string; canManage?: boolean; surface?: "hosted" | "mcp" | "cli"; search: string; offset: number; limit: number;
}): Promise<ExternalUsageResponse> {
  const { scope, period } = opts;
  const baseWhere = and(eq(externalCalls.orgId, scope.orgId),
    opts.surface ? eq(externalCalls.surface, opts.surface) : undefined,
    sql`${externalCalls.createdAt} >= ${period.startMs} AND ${externalCalls.createdAt} < ${period.endMs}`,
    scope.scope === "me" ? eq(externalCalls.userId, scope.userId) : undefined,
    scope.scope === "team" ? and(eq(externalCalls.ownerType, "team"), eq(externalCalls.ownerId, scope.teamId)) : undefined);
  const registry = await readRegistry(db, scope.orgId, "tool_intent");
  const { join: intentLabelJoin, on: intentLabelOn } = intentJoins(registry, scope.orgId, opts.canManage ?? false);
  const where = and(baseWhere, intentKeyFilter(opts.key));
  const classification = await toolIntentUsage(db, scope.orgId, baseWhere, opts.canManage ?? false, registry);
  const detailsVisible = scope.scope !== "team" || scope.byMember;
  const [daily, tools, clients] = await Promise.all([
    db.select({ dayMs: sql<number>`floor(${externalCalls.createdAt}::numeric / 86400000) * 86400000`.mapWith(Number),
      surface: externalCalls.surface, calls: sql<number>`count(*)`.mapWith(Number) }).from(externalCalls)
      .leftJoin(intentLabelJoin, intentLabelOn).where(where).groupBy(sql`1`, externalCalls.surface).orderBy(sql`1`),
    db.select({ name: externalCalls.name, surface: externalCalls.surface,
      calls: sql<number>`count(*)`.mapWith(Number),
      errorRate: sql<number>`coalesce(count(*) filter (where ${externalCalls.outcome} = 'error')::float / nullif(count(*) filter (where ${externalCalls.outcome} in ('ok', 'error')), 0), 0)`.mapWith(Number),
      uniqueUsers: sql<number>`count(distinct ${externalCalls.userId})`.mapWith(Number) }).from(externalCalls)
      .leftJoin(intentLabelJoin, intentLabelOn).where(where).groupBy(externalCalls.name, externalCalls.surface).orderBy(sql`count(*) desc`, externalCalls.name).limit(25),
    db.select({ surface: externalCalls.surface, name: sql<string>`coalesce(${externalCalls.clientName}, case when ${externalCalls.surface} = 'hosted' then 'Hosted Valet' else 'Unknown client' end)`,
      version: externalCalls.clientVersion, calls: sql<number>`count(*)`.mapWith(Number) }).from(externalCalls)
      .leftJoin(intentLabelJoin, intentLabelOn).where(where).groupBy(externalCalls.clientName, externalCalls.clientVersion, externalCalls.surface)
      .orderBy(sql`count(*) desc`, externalCalls.clientName, externalCalls.clientVersion).limit(25),
  ]);
  const counts = new Map(daily.map(row => [`${row.dayMs}:${row.surface}`, row.calls]));
  const filledDaily: ExternalUsageResponse["daily"] = [];
  for (let dayMs = Math.floor(period.startMs / 86400000) * 86400000; dayMs < period.endMs; dayMs += 86400000) {
    for (const surface of opts.surface ? [opts.surface] : ["hosted", "mcp", "cli"] as const) {
      filledDaily.push({ dayMs, surface, calls: counts.get(`${dayMs}:${surface}`) ?? 0 });
    }
  }
  if (!detailsVisible) return { classification, daily: filledDaily, tools, clients, detailsVisible, recent: [], hasMore: false };
  // Workflow-step threads do not carry the run's originating audience. Fail closed on details.
  const feedWhere = and(where,
    sql`NOT (${externalCalls.ownerType} = 'team' AND (coalesce(${externalCalls.sessionId}, '') LIKE 'wf:%'
      OR ${externalCalls.name} IN ('run_workflow', 'get_workflow_run', 'cancel_workflow_run', 'retry_workflow_run')
      OR ${externalCalls.name} LIKE 'workflows %'))`,
    scope.scope === "org" && !ORG_RECENT_INCLUDES_PERSONAL ? eq(externalCalls.ownerType, "team") : undefined);
  // Search first, then check a bounded candidate window. Hidden matches never set hasMore.
  const candidates = await db.select({ call: externalCalls, key: intentKey, userName: users.name, teamName: teams.name }).from(externalCalls).leftJoin(intentLabelJoin, intentLabelOn)
    .leftJoin(users, eq(users.id, externalCalls.userId))
    .leftJoin(teams, and(eq(externalCalls.ownerType, "team"), eq(teams.id, externalCalls.ownerId), eq(teams.orgId, scope.orgId)))
    .where(and(feedWhere, opts.search ? sql`strpos(lower(coalesce(${externalCalls.intent}, '')), lower(${opts.search})) > 0` : undefined))
    .orderBy(sql`${externalCalls.createdAt} desc`, sql`${externalCalls.id} desc`).limit(Math.min(500, 5 * (opts.offset + opts.limit + 1)));
  const teamThreads = candidates.flatMap(({ call }) => call.ownerType === "team" && call.sessionId && call.threadId
    ? [{ sessionId: call.sessionId, threadId: call.threadId }] : []);
  // The batch deduplicates thread and channel checks for this viewer/request.
  const visible = await visibleThreadIds(opts.viewer.deps, { ownerType: "team" }, { orgId: scope.orgId, userId: opts.viewer.userId }, teamThreads);
  const sessionVisibility = new Map<string, Promise<boolean>>();
  const shown = [];
  for (const row of candidates) {
    const r = row.call;
    if (r.ownerType === "team" && r.sessionId) {
      if (r.threadId) {
        if (!visible.has(`${r.sessionId}:${r.threadId}`)) continue;
      } else {
        const sessionId = r.sessionId;
        let check = sessionVisibility.get(sessionId);
        if (!check) {
          check = (async () => {
            const [session] = await db.select().from(agentSessions).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, scope.orgId))).limit(1);
            return !!session && canAccessSessionResources(opts.viewer.deps, session, { type: "user", id: opts.viewer.userId });
          })();
          sessionVisibility.set(sessionId, check);
        }
        if (!await check) continue;
      }
    }
    shown.push(row);
    if (shown.length > opts.offset + opts.limit) break;
  }
  return { classification, daily: filledDaily, tools, clients, detailsVisible, hasMore: shown.length > opts.offset + opts.limit,
    recent: shown.slice(opts.offset, opts.offset + opts.limit).map(({ call: r, key, userName, teamName }) => ({ key, userName, teamName,
      intentCleared: r.intentClearedAt !== null,
      id: r.id, surface: r.surface, name: r.name, clientName: r.clientName, clientVersion: r.clientVersion,
      userId: r.userId, outcome: r.outcome, intent: r.intent, createdAt: r.createdAt })) };
}

export function newExternalCallId(): string { return randomUUID(); }

export function hostedToolUsageSink(db: AppDb, persona?: string): (fact: ToolUsageFact) => void {
  return fact => { void recordExternalCall(db, { ...fact, surface: "hosted", persona }); };
}

/** Bounded column-nulling runs on the existing event-dispatch rail, not on a tool's response path. */
export function externalUsageRetention(db: AppDb): () => Promise<void> {
  let nextRun = 0;
  let inFlight: Promise<void> | undefined;
  return () => {
    if (inFlight) return inFlight;
    if (Date.now() < nextRun) return Promise.resolve();
    inFlight = (async () => {
      const result = await db.execute(sql`WITH expired AS (
        SELECT id FROM external_calls WHERE intent IS NOT NULL AND created_at < ${Date.now() - 90 * 86400000}
        ORDER BY created_at LIMIT 5000
      ) UPDATE external_calls SET intent = NULL, intent_cleared_at = ${Date.now()} WHERE id IN (SELECT id FROM expired) RETURNING id`) as { rows: { id: string }[] };
      nextRun = Date.now() + (result.rows.length === 5000 ? 1000 : 3600000);
    })().catch(error => { nextRun = Date.now() + 60_000; throw error; }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
