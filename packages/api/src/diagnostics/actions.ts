/**
 * Agent-facing diagnostics: which tools fail and why, which API routes are
 * slow or answer 5xx, which error paths fired, and the health of the API
 * process and its pods. They read what the Usage page, the request traces,
 * `reportError`, and the kubernetes API already record, so Valet can
 * investigate an error rate, a slow page, or a 503 itself. Every tool here
 * only reads.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls, orgMembers, users } from "../schema/index.js";
import { visibleThreadIds, type AccessDeps } from "../services/thread-access.js";
import { recentErrorReports } from "@valet/engine";
import { requestTimingSummary, serverErrorSummary } from "../observability/request-timings.js";
import { processHealthSummary } from "../observability/process-health.js";
import { readPodHealth, type PodHealthTarget } from "./pod-health.js";

const DAY_MS = 86_400_000;
const MAX_TOOLS = 15;
/** Failed calls read to find samples the caller may see. */
const SAMPLE_CANDIDATES = 50;
const MESSAGE_CHARS = 300;
/** A tool result is written within this long of the call's start. */
const RESULT_WINDOW_MS = 30 * 60_000;

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

/** What the infrastructure tools may read. */
export interface DiagnosticsInfra {
  /** The sandbox backend this deployment runs (`VALET_SANDBOX_BACKEND`). */
  sandboxBackend: string;
  /** The kubernetes pod reader. Built on first use, so a bad kubeconfig
   * fails the tool call and not the boot. Present on kubernetes only. */
  podHealth?: () => PodHealthTarget;
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

export function diagnosticsActionPlugin(db: AppDb, deps: () => Omit<AccessDeps, "db">, infra: DiagnosticsInfra = { sandboxBackend: "docker" }): ActionPlugin {
  const member = async (ctx: PluginActionContext) => {
    const userId = ctx.actor?.id ?? ctx.userId;
    if (!userId || !ctx.orgId) return undefined;
    if (isTeamRun(ctx, userId)) return { userId, role: "member" as const, teamRun: true };
    const [row] = await db.select({ role: orgMembers.role }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
    return row ? { userId, role: row.role, teamRun: false } : undefined;
  };

  /** The caller's organization when the caller is one of its admins, or the refusal to return. */
  const adminOrg = async (ctx: PluginActionContext, what: string): Promise<{ orgId: string; userId: string } | { refusal: PluginActionResult }> => {
    if (ctx.externalSender) return { refusal: EXTERNAL_SENDER };
    const caller = await member(ctx);
    if (!caller || !ctx.orgId) return { refusal: { success: false, error: "You are not a member of this organization. Ask an organization admin to add you." } };
    if (caller.role !== "admin") return { refusal: { success: false, error: `${what} are for organization admins. Ask an admin to run this check.` } };
    return { orgId: ctx.orgId, userId: caller.userId };
  };

  /** Why the caller may not read numbers that count every organization on
   * the deployment (the error-path tally and sandbox pods), or undefined when
   * they may. Only a deployment operator (`users.role`, not
   * `org_members.role`) reads them, and only where nobody else reads the
   * transcript. */
  const deploymentWideRefusal = async (ctx: PluginActionContext, userId: string): Promise<string | undefined> => {
    if (transcriptIsShared(ctx)) {
      return "These numbers count every organization on this deployment, and other people read this conversation. Ask in a private conversation.";
    }
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (row?.role !== "admin") {
      return "These numbers count every organization on this deployment, so only a deployment operator can read them. Ask an operator to run this check.";
    }
    return undefined;
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
      const visible = await visibleThreadIds({ db, ...deps() }, { ownerType: "team" },
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
      const gate = await adminOrg(ctx, "Request timings");
      if ("refusal" in gate) return gate.refusal;
      const summary = requestTimingSummary({ orgId: gate.orgId, sinceMs: Date.now() - (minutes ?? 15) * 60_000, limit: limit ?? 10 });
      return { success: true, data: summary };
    },
  });

  const listServerErrors = action(Type.Object({
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "How many minutes back to read. Default 15." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Routes and error paths to return. Default 10." })),
  }))({
    id: "diagnostics.list_server_errors",
    name: "List server errors",
    description:
      "Find which Valet API routes answered 5xx and which internal error paths fired. Returns each route pattern with its request count and 5xx counts by status (500, 502, 503, 504). " +
      "Routes count this organization's requests and requests with no organization. Error paths, such as channels/outbound_delivery/slack or workflows/schedule_fire, " +
      "count every organization on the deployment, so only a deployment operator in a private conversation gets them. " +
      "Reads this API process only, up to the last 60 minutes; a restart clears it. A 503 the load balancer returns while no API pod is ready never reaches this process: " +
      "use diagnostics.list_pod_restarts for that. Organization admins only.",
    riskLevel: "low",
    execute: async ({ minutes, limit }, ctx) => {
      const gate = await adminOrg(ctx, "Server errors");
      if ("refusal" in gate) return gate.refusal;
      const sinceMs = Date.now() - (minutes ?? 15) * 60_000;
      const routes = serverErrorSummary({ orgId: gate.orgId, sinceMs, limit: limit ?? 10 });
      // The tally has no organization: most error paths run in sweeps that serve every organization.
      const refusal = await deploymentWideRefusal(ctx, gate.userId);
      const errorPaths = refusal === undefined
        ? { errorPaths: recentErrorReports({ sinceMs, limit: limit ?? 10 }) }
        : { errorPathsOmitted: refusal };
      return { success: true, data: { ...routes, ...errorPaths } };
    },
  });

  const processHealth = action(Type.Object({
    minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "How many minutes of samples the peaks cover. Default 15." })),
  }))({
    id: "diagnostics.process_health",
    name: "Read API process health",
    description:
      "Read the health of the Valet API process that answers this call: RSS, V8 heap used, total and limit, the container's cgroup memory and limit, " +
      "event-loop delay, uptime and start time, plus peak memory and event-loop delay over 10-second samples. " +
      "A heap or cgroup usage near its limit means an OOM kill is close; a high event-loop delay means slow or failed requests. " +
      "Reads this process only, up to the last 60 minutes; a restart clears the samples. For restart counts and OOM kills, use diagnostics.list_pod_restarts. Organization admins only.",
    riskLevel: "low",
    execute: async ({ minutes }, ctx) => {
      const gate = await adminOrg(ctx, "Process health checks");
      if ("refusal" in gate) return gate.refusal;
      return { success: true, data: { ...processHealthSummary({ sinceMs: Date.now() - (minutes ?? 15) * 60_000 }), sandboxBackend: infra.sandboxBackend } };
    },
  });

  const listPodRestarts = action(Type.Object({}))({
    id: "diagnostics.list_pod_restarts",
    name: "List pod restarts",
    description:
      "Find restarts and OOM kills of Valet's pods on the kubernetes backend. Returns the API namespace's pods, such as the API and its database, " +
      "with each container's restart count, state and last termination reason (OOMKilled, Error), and the last hour's Warning events, such as failed liveness probes. " +
      "Returns sandbox pods as counts by node and termination reason, without pod or session names, to a deployment operator in a private conversation only. " +
      "If the API's service account may not read a namespace, the result names the RBAC rule an operator must add. Read-only. Organization admins only.",
    riskLevel: "low",
    execute: async (_args, ctx) => {
      const gate = await adminOrg(ctx, "Pod restart checks");
      if ("refusal" in gate) return gate.refusal;
      if (!infra.podHealth) {
        return { success: false, error: `Pod restarts exist only on the kubernetes sandbox backend. This deployment runs the ${infra.sandboxBackend} backend: read the API logs instead.` };
      }
      let target: PodHealthTarget;
      try {
        target = infra.podHealth();
      } catch (err) {
        return { success: false, error: `The kubernetes client could not start: ${err instanceof Error ? err.message : String(err)} Check the API's kubeconfig or in-cluster service account.` };
      }
      const refusal = await deploymentWideRefusal(ctx, gate.userId);
      return { success: true, data: await readPodHealth(target, refusal === undefined ? {} : { omitSandboxes: refusal }) };
    },
  });

  return {
    service: "diagnostics",
    description: "Find which tools fail and why, which Valet API routes are slow or fail, and the health of the API process and its pods.",
    actions: [listToolFailures, listSlowRequests, listServerErrors, processHealth, listPodRestarts],
  };
}
