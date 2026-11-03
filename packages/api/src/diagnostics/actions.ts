/**
 * Agent-facing diagnostics: which tools fail and why, which threads ended
 * without the work done, and which API routes are slow. They read what the
 * Usage page and the request traces already record, so Valet can
 * investigate an error rate, a slow page or where people get stuck itself.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls, orgMembers, teamMembers } from "../schema/index.js";
import { visibleThreadIds, type AccessDeps } from "../services/thread-access.js";
import { requestTimingSummary } from "../observability/request-timings.js";
import { taggingAvailable } from "../tagging/availability.js";
import {
  FRICTION_OUTCOMES, groupFrictionThreads, readThreadOutcomes, readThreadText, threadPerson,
  type FrictionThread, type OutcomeScope,
} from "./thread-outcomes.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OUTCOME_KEYS = ["completed", ...FRICTION_OUTCOMES] as const;
const MAX_TOOLS = 15;
/** Failed calls read to find samples the caller may see. */
const SAMPLE_CANDIDATES = 50;
const MESSAGE_CHARS = 300;
/** A tool result is written within this long of the call's start. */
const RESULT_WINDOW_MS = 30 * 60_000;

export interface DiagnosticsDeps extends Omit<AccessDeps, "db"> {
  /** This deployment's public base URL, for thread links. */
  publicUrl?: string;
}

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

const EXTERNAL_SENDER = {
  success: false as const,
  error: "Only a teammate with a linked Valet account can read diagnostics. Ask them, or link your Slack account in Valet.",
};

/** A team's unattended run acts as `team:{id}`; it reads only its team's calls. */
function isTeamRun(ctx: PluginActionContext, userId: string): boolean {
  return ctx.owner?.type === "team" && userId === `team:${ctx.owner.id}`;
}

/** Whether people other than the caller read this turn's transcript. */
function transcriptIsShared(ctx: PluginActionContext): boolean {
  return ctx.owner?.type !== "user" || ctx.origin !== undefined || ctx.sharedTranscript === true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text a tool result shows the model, in the shapes the engine stores. */
function resultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (!record(result)) return undefined;
  if (typeof result.text === "string") return result.text;
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  return record(first) && typeof first.text === "string" ? first.text : undefined;
}

/** The requested tool id and result text of one tool call, read from its transcript. */
async function failedCallDetail(db: AppDb, call: { id: string; sessionId: string; threadId: string; createdAt: number }) {
  const callId = call.id.slice(call.sessionId.length + 1);
  if (!call.id.startsWith(`${call.sessionId}:`) || !callId) return undefined;
  const rows = await db.execute(sql`SELECT parts FROM engine_entries
    WHERE session_id = ${call.sessionId} AND thread_id = ${call.threadId} AND entry_type = 'message' AND role = 'assistant'
      AND created_at BETWEEN ${call.createdAt - RESULT_WINDOW_MS} AND ${call.createdAt + RESULT_WINDOW_MS}
      AND strpos(parts, ${callId}) > 0
    ORDER BY created_at DESC LIMIT 1`) as { rows: Array<{ parts: string | null }> };
  let parts: unknown;
  try { parts = JSON.parse(rows.rows[0]?.parts ?? "[]"); } catch { return undefined; }
  const part = Array.isArray(parts) ? parts.find((p) => record(p) && p.callId === callId) : undefined;
  if (!record(part)) return undefined;
  const args = record(part.args) ? part.args : {};
  return {
    requestedToolId: typeof args.tool_id === "string" ? args.tool_id.slice(0, 200) : undefined,
    message: resultText(part.result)?.replace(/\s+/g, " ").slice(0, MESSAGE_CHARS),
  };
}

export function diagnosticsActionPlugin(db: AppDb, deps: () => DiagnosticsDeps): ActionPlugin {
  const access = (): AccessDeps => {
    const { engineCredentials, onePassword } = deps();
    return { db, engineCredentials, onePassword };
  };
  const member = async (ctx: PluginActionContext) => {
    const userId = ctx.actor?.id ?? ctx.userId;
    if (!userId || !ctx.orgId) return undefined;
    if (isTeamRun(ctx, userId)) return { userId, role: "member" as const, teamRun: true };
    const [row] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
    return row ? { userId, role: row.role, teamRun: false } : undefined;
  };

  const listToolFailures = action(Type.Object({
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "How many days back to read. Default 7." })),
    tool: Type.Optional(Type.String({ maxLength: 200, description: "Only this tool, by the name the Usage page shows, such as calendar.list_events." })),
    samples: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Recent failed calls to return with their error text. Default 5." })),
  }))({
    id: "diagnostics.list_tool_failures",
    name: "List tool failures",
    description:
      "Find which tools fail and why. Returns each tool's calls, error rate and most common error codes, newest failures first, " +
      "with the tool id the agent asked for and the error text the tool returned. Error codes: unknown = no tool has that id; " +
      "missing_credential = the account is not connected; invalid_args = the input did not match the tool; action_failed = the tool ran and failed. " +
      "An organization admin in a private conversation sees the whole organization's counts; others see their own calls. " +
      "Error text comes only from conversations the caller can open.",
    riskLevel: "low",
    execute: async ({ days, tool, samples }, ctx) => {
      if (ctx.externalSender) return EXTERNAL_SENDER;
      const caller = await member(ctx);
      if (!caller || !ctx.orgId) return { success: false, error: "You are not a member of this organization. Ask an organization admin to add you." };
      const since = Date.now() - (days ?? 7) * DAY_MS;
      const orgWide = caller.role === "admin" && !transcriptIsShared(ctx);
      const scope = caller.teamRun && ctx.owner?.type === "team"
        ? and(eq(externalCalls.ownerType, "team"), eq(externalCalls.ownerId, ctx.owner.id))
        : orgWide ? undefined : eq(externalCalls.userId, caller.userId);
      const where = and(eq(externalCalls.orgId, ctx.orgId), gte(externalCalls.createdAt, since), scope,
        tool ? eq(externalCalls.name, tool) : undefined);
      const tools = await db.select({
        name: externalCalls.name, surface: externalCalls.surface, calls: sql<number>`count(*)`.mapWith(Number),
        errors: sql<number>`count(*) filter (where ${externalCalls.outcome} = 'error')`.mapWith(Number),
        denied: sql<number>`count(*) filter (where ${externalCalls.outcome} = 'denied')`.mapWith(Number),
      }).from(externalCalls).where(where).groupBy(externalCalls.name, externalCalls.surface)
        .orderBy(sql`count(*) filter (where ${externalCalls.outcome} = 'error') desc`, sql`count(*) desc`).limit(MAX_TOOLS);
      const codes = await db.select({ name: externalCalls.name, surface: externalCalls.surface,
        code: sql<string>`coalesce(${externalCalls.errorCode}, 'unspecified')`, calls: sql<number>`count(*)`.mapWith(Number) })
        .from(externalCalls).where(and(where, eq(externalCalls.outcome, "error")))
        .groupBy(externalCalls.name, externalCalls.surface, sql`3`).orderBy(sql`count(*) desc`);

      // Samples need the conversation: the caller's own personal ones, and
      // team ones the caller may see. Error text never enters a transcript
      // that other people read.
      const wanted = transcriptIsShared(ctx) ? 0 : samples ?? 5;
      const failures = wanted === 0 ? [] : await db.select().from(externalCalls)
        .where(and(where, eq(externalCalls.outcome, "error"), eq(externalCalls.surface, "hosted"),
          caller.teamRun ? undefined : sql`(${externalCalls.ownerType} = 'team' OR ${externalCalls.ownerId} = ${caller.userId})`))
        .orderBy(desc(externalCalls.createdAt)).limit(SAMPLE_CANDIDATES);
      const teamThreads = failures.flatMap((row) => row.ownerType === "team" && row.sessionId && row.threadId ? [{ sessionId: row.sessionId, threadId: row.threadId }] : []);
      const visible = await visibleThreadIds(access(), { ownerType: "team" },
        { orgId: ctx.orgId, userId: caller.teamRun ? undefined : caller.userId }, teamThreads);
      const shown = [];
      for (const row of failures) {
        if (shown.length >= wanted || !row.sessionId || !row.threadId) continue;
        if (row.ownerType === "team" && !visible.has(`${row.sessionId}:${row.threadId}`)) continue;
        const detail = await failedCallDetail(db, { id: row.id, sessionId: row.sessionId, threadId: row.threadId, createdAt: row.createdAt });
        shown.push({ tool: row.name, errorCode: row.errorCode, at: row.createdAt, threadId: row.threadId, ...detail });
      }
      return {
        success: true,
        data: {
          scope: caller.teamRun ? "team" : orgWide ? "organization" : "you",
          since,
          tools: tools.map((row) => ({
            ...row, errorRate: row.calls === 0 ? 0 : row.errors / row.calls,
            errorCodes: codes.filter((code) => code.name === row.name && code.surface === row.surface).slice(0, 3).map(({ code, calls }) => ({ code, calls })),
          })),
          samples: shown,
          ...(wanted === 0 && samples !== 0 ? { note: "Error text is left out because other people read this conversation. Ask in a private conversation to see it." } : {}),
        },
      };
    },
  });

  const listThreadOutcomes = action(Type.Object({
    hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168, description: "How many hours back to read. Default 24." })),
    outcomes: Type.Optional(Type.Array(Type.Union(OUTCOME_KEYS.map((key) => Type.Literal(key))), {
      maxItems: OUTCOME_KEYS.length,
      description: "Only threads with these outcomes. Default: every outcome except completed.",
    })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Threads to return, newest first. Default 50." })),
  }))({
    id: "diagnostics.list_thread_outcomes",
    name: "List thread outcomes",
    description:
      "Find the threads where people got stuck. Returns the outcome count for every label in the period, the threads with the requested outcomes " +
      "grouped by person and main tool intent, and the threads themselves newest first: outcome, link, person, tool calls, tool errors and error codes. " +
      "Outcomes: completed, partial, failed, blocked_on_human, abandoned, unclear. Only threads the outcome classifier labeled are counted. " +
      "An organization admin in a private conversation reads the whole organization; a team workflow reads its team's threads. " +
      "A thread title and a short excerpt of the first request come only from threads the caller can open.",
    riskLevel: "low",
    execute: async ({ hours, outcomes, limit }, ctx) => {
      if (ctx.externalSender) return EXTERNAL_SENDER;
      const caller = await member(ctx);
      if (!caller || !ctx.orgId) return { success: false, error: "You are not a member of this organization. Ask an organization admin to add you." };
      const teamRun = caller.teamRun && ctx.owner?.type === "team" ? ctx.owner.id : undefined;
      if (!teamRun && caller.role !== "admin") {
        return { success: false, error: "Thread outcomes are for organization admins. Ask an admin to run this check, or run it from a team workflow to read that team's threads." };
      }
      if (!teamRun && transcriptIsShared(ctx)) {
        return { success: false, error: "Thread outcomes list other people's threads, and other people read this conversation. Ask in a private conversation." };
      }
      const scope: OutcomeScope = teamRun ? { kind: "team", teamId: teamRun } : { kind: "organization" };
      const until = Date.now();
      const since = until - (hours ?? 24) * HOUR_MS;
      const read = await readThreadOutcomes(db, {
        orgId: ctx.orgId, scope, since, until, outcomes: outcomes ?? FRICTION_OUTCOMES, canManageIntents: !teamRun,
      });

      // Text comes from threads the caller could open in Valet: their own
      // personal threads, and threads of their teams that the thread's
      // audience rules allow. An admin opens a team's sessions only as a
      // member (`canViewSession`), so admin rights alone do not count.
      const teamIds = [...new Set(read.threads.filter((row) => row.ownerType === "team").map((row) => row.ownerId))];
      const memberOf = teamRun ? new Set([teamRun]) : new Set(teamIds.length === 0 ? [] : (await db.select({ teamId: teamMembers.teamId })
        .from(teamMembers).where(and(eq(teamMembers.userId, caller.userId), inArray(teamMembers.teamId, teamIds)))).map((row) => row.teamId));
      const teamThreads = read.threads.filter((row) => row.ownerType === "team" && memberOf.has(row.ownerId));
      const visibleTeam = await visibleThreadIds(access(), { ownerType: "team" }, { orgId: ctx.orgId, userId: teamRun ? undefined : caller.userId }, teamThreads);
      const canOpen = (row: (typeof read.threads)[number]) => row.ownerType === "team"
        ? memberOf.has(row.ownerId) && visibleTeam.has(`${row.sessionId}:${row.threadId}`)
        : !teamRun && row.ownerType === "user" && (row.ownerId || row.userId) === caller.userId;
      const shown = read.threads.slice(0, limit ?? 50);
      const text = await readThreadText(db, shown.filter(canOpen));
      const base = deps().publicUrl?.replace(/\/+$/, "") ?? "";
      const threads: FrictionThread[] = read.threads.map((row) => {
        const id = `${row.sessionId}:${row.threadId}`;
        const calls = read.calls.get(id);
        return {
          threadId: row.threadId, sessionId: row.sessionId, link: `${base}/threads/${encodeURIComponent(row.threadId)}`,
          outcome: row.outcome, classifiedAt: row.classifiedAt, workspace: row.ownerType === "team" ? "team" : "personal",
          person: threadPerson(row, read.names), child: row.child,
          intent: calls?.intent ?? { key: "no_tool_calls", label: "No tool calls" },
          toolCalls: calls?.toolCalls ?? 0, toolErrors: calls?.toolErrors ?? 0, errorCodes: calls?.errorCodes ?? [],
          canOpen: canOpen(row), ...text.get(id),
        };
      });
      const notes: string[] = [];
      if (read.counts.length === 0) {
        notes.push(await taggingAvailable(db, ctx.orgId)
          ? "No thread got an outcome label in this period."
          : "No thread got an outcome label in this period. Outcome labels need the xs model tier: in Settings > Models, point tier xs at a provider this organization holds a key for.");
      }
      if (read.truncated) notes.push("More threads matched than one read covers. Groups count the newest 500; shorten the period to see the rest.");
      if (!base) notes.push("This deployment has no public URL, so thread links are paths. Set the public URL to get full links.");
      return {
        success: true,
        data: {
          scope: scope.kind, since, until,
          outcomes: read.counts,
          groups: groupFrictionThreads(threads),
          threads: threads.slice(0, limit ?? 50),
          truncated: read.truncated || threads.length > (limit ?? 50),
          note: notes.join(" "),
        },
      };
    },
  });

  const listSlowRequests = action(Type.Object({
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "How many minutes back to read. Default 15." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Routes to return. Default 10." })),
  }))({
    id: "diagnostics.list_slow_requests",
    name: "List slow requests",
    description:
      "Find which Valet API routes take the most time. Returns each route pattern with its request count and p50, p90, p99 and maximum duration in milliseconds, " +
      "slowest total first. Reads this API process only, up to the last 60 minutes; a restart clears it. Organization admins only.",
    riskLevel: "low",
    execute: async ({ minutes, limit }, ctx) => {
      if (ctx.externalSender) return EXTERNAL_SENDER;
      const caller = await member(ctx);
      if (!caller || !ctx.orgId) return { success: false, error: "You are not a member of this organization. Ask an organization admin to add you." };
      if (caller.role !== "admin") return { success: false, error: "Request timings are for organization admins. Ask an admin to run this check." };
      const summary = requestTimingSummary({ orgId: ctx.orgId, sinceMs: Date.now() - (minutes ?? 15) * 60_000, limit: limit ?? 10 });
      return { success: true, data: summary };
    },
  });

  return {
    service: "diagnostics",
    description: "Find which tools fail and why, which threads ended without the work done, and which Valet API routes are slow.",
    actions: [listToolFailures, listSlowRequests, listThreadOutcomes],
  };
}
