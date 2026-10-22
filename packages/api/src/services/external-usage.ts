import { visibleThreadIds, type AccessDeps } from "./thread-access.js";
import { getTeamInOrg, isTeamMember } from "./teams.js";
import type { ToolUsageFact } from "@valet/shared";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, externalCalls, mcpClientInfo, sessionThreads, users, workflowDefinitions, workflowRuns } from "../schema/index.js";
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
  await bestEffortTelemetry(async () => {
    await db.insert(externalCalls).values(call).onConflictDoUpdate({
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
    });
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
    const value = { name: info.name.slice(0, 200), version: info.version.slice(0, 100) };
    await db.insert(mcpClientInfo).values({ ...identity, ...value }).onConflictDoUpdate({
      target: [mcpClientInfo.orgId, mcpClientInfo.userId, mcpClientInfo.clientId], set: value,
    });
  });
}

export async function getExternalUsage(db: AppDb, opts: {
  viewer: { deps: AccessDeps; userId: string }; period: ResolvedUsagePeriod; scope: UsageScope; surface?: "hosted" | "mcp" | "cli"; search: string; offset: number; limit: number;
}): Promise<ExternalUsageResponse> {
  const { scope, period } = opts;
  const where = and(eq(externalCalls.orgId, scope.orgId),
    opts.surface ? eq(externalCalls.surface, opts.surface) : undefined,
    sql`${externalCalls.createdAt} >= ${period.startMs} AND ${externalCalls.createdAt} < ${period.endMs}`,
    scope.scope === "me" ? eq(externalCalls.userId, scope.userId) : undefined,
    scope.scope === "team" ? and(eq(externalCalls.ownerType, "team"), eq(externalCalls.ownerId, scope.teamId)) : undefined);
  const detailsVisible = scope.scope !== "team" || scope.byMember;
  const [daily, tools, clients] = await Promise.all([
    db.select({ dayMs: sql<number>`floor(${externalCalls.createdAt}::numeric / 86400000) * 86400000`.mapWith(Number),
      surface: externalCalls.surface, calls: sql<number>`count(*)`.mapWith(Number) }).from(externalCalls)
      .where(where).groupBy(sql`1`, externalCalls.surface).orderBy(sql`1`),
    db.select({ name: externalCalls.name, surface: externalCalls.surface,
      calls: sql<number>`count(*)`.mapWith(Number),
      errorRate: sql<number>`count(*) filter (where ${externalCalls.outcome} = 'error')::float / count(*)`.mapWith(Number),
      uniqueUsers: sql<number>`count(distinct ${externalCalls.userId})`.mapWith(Number) }).from(externalCalls)
      .where(where).groupBy(externalCalls.name, externalCalls.surface).orderBy(sql`count(*) desc`, externalCalls.name).limit(25),
    db.select({ surface: externalCalls.surface, name: sql<string>`coalesce(${externalCalls.clientName}, case when ${externalCalls.surface} = 'hosted' then 'Hosted Valet' else 'Unknown client' end)`,
      version: externalCalls.clientVersion, calls: sql<number>`count(*)`.mapWith(Number) }).from(externalCalls)
      .where(where).groupBy(externalCalls.clientName, externalCalls.clientVersion, externalCalls.surface)
      .orderBy(sql`count(*) desc`, externalCalls.clientName, externalCalls.clientVersion).limit(25),
  ]);
  const counts = new Map(daily.map(row => [`${row.dayMs}:${row.surface}`, row.calls]));
  const filledDaily: ExternalUsageResponse["daily"] = [];
  for (let dayMs = Math.floor(period.startMs / 86400000) * 86400000; dayMs < period.endMs; dayMs += 86400000) {
    for (const surface of opts.surface ? [opts.surface] : ["hosted", "mcp", "cli"] as const) {
      filledDaily.push({ dayMs, surface, calls: counts.get(`${dayMs}:${surface}`) ?? 0 });
    }
  }
  if (!detailsVisible) return { daily: filledDaily, tools, clients, detailsVisible, recent: [], hasMore: false };
  const feedWhere = and(where,
    scope.scope === "org" && !ORG_RECENT_INCLUDES_PERSONAL ? eq(externalCalls.ownerType, "team") : undefined);
  // Resolve audiences before text search or pagination; hidden intents must not affect either.
  const pairs = await db.selectDistinct({ sessionId: externalCalls.sessionId, threadId: externalCalls.threadId }).from(externalCalls)
    .where(and(feedWhere, eq(externalCalls.ownerType, "team"), sql`${externalCalls.sessionId} IS NOT NULL AND ${externalCalls.threadId} IS NOT NULL`));
  const teamThreads = pairs.flatMap(pair => pair.sessionId && pair.threadId ? [{ sessionId: pair.sessionId, threadId: pair.threadId }] : []);
  const visible = await visibleThreadIds(opts.viewer.deps, { ownerType: "team" }, { orgId: scope.orgId, userId: opts.viewer.userId }, teamThreads);
  const hidden = teamThreads.filter(pair => !visible.has(`${pair.sessionId}:${pair.threadId}`));
  const audience = hidden.length ? sql`NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(hidden)}::jsonb)
    AS hidden("sessionId" text, "threadId" text) WHERE ${externalCalls.ownerType} = 'team'
    AND hidden."sessionId" = ${externalCalls.sessionId} AND hidden."threadId" = ${externalCalls.threadId})` : undefined;
  // strpos treats search as literal text, not a wildcard pattern.
  const recent = await db.select({ call: externalCalls, userName: users.name }).from(externalCalls)
    .leftJoin(users, eq(users.id, externalCalls.userId)).where(and(feedWhere, audience,
    opts.search ? sql`strpos(lower(coalesce(${externalCalls.intent}, '')), lower(${opts.search})) > 0` : undefined))
    .orderBy(sql`${externalCalls.createdAt} desc`, sql`${externalCalls.id} desc`).offset(opts.offset).limit(opts.limit + 1);
  return { daily: filledDaily, tools, clients, detailsVisible, hasMore: recent.length > opts.limit,
    recent: recent.slice(0, opts.limit).map(({ call: r, userName }) => ({ userName, id: r.id, surface: r.surface, name: r.name,
      clientName: r.clientName, clientVersion: r.clientVersion, userId: r.userId, outcome: r.outcome, intent: r.intent, createdAt: r.createdAt })) };
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
      ) UPDATE external_calls SET intent = NULL WHERE id IN (SELECT id FROM expired) RETURNING id`) as { rows: { id: string }[] };
      nextRun = Date.now() + (result.rows.length === 5000 ? 1000 : 3600000);
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
