import { and, eq, isNull, sql } from "drizzle-orm";
import { parsePrincipal, type Principal } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, assistantExecutions, assistants, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";
import { isLegacyAssistantRuntime, legacyWorkflowRuntime } from "./legacy-runtime.js";
import type { MemoryScope } from "./memory.js";
import { runEventChannel } from "./thread-access.js";

/**
 * The memory scope an agent session reads: its owner, and for a team the
 * namespace `routes/memory.ts` resolves for the same session id. A child's
 * or workflow step's snapshot is built from this scope, and its memory
 * tools read the same corpus, so the prompt never lists a file the tools
 * cannot open. Throws `NotFoundError` when a team audience cannot be
 * resolved; callers must then leave memory out, never widen to the team.
 */
export async function delegatedMemoryScope(
  db: AppDb,
  input: { sessionId: string; owner: Principal; actorUserId: string; orgId: string },
): Promise<MemoryScope> {
  const base = { owner: input.owner, actorUserId: input.actorUserId };
  if (input.owner.type !== "team") return base;
  const namespace = input.sessionId.startsWith("wf:")
    ? await workflowMemoryNamespace(db, parseWorkflowSessionId(input.sessionId).runId, input.owner.id, input.orgId)
    : await assistantMemoryNamespace(db, input.sessionId, input.owner.id, input.orgId);
  return { ...base, namespace };
}

/** The memory scope of a session that already ran, from its app row or,
 * for a workflow step, its run. Null when the session has no live owner. */
export async function memoryScopeForSession(db: AppDb, sessionId: string): Promise<MemoryScope | null> {
  const [session] = await db.select({
    userId: agentSessions.userId, orgId: agentSessions.orgId, status: agentSessions.status,
    ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId,
  }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (session) {
    if (session.status === "deleted") return null;
    const owner = parsePrincipal(`${session.ownerType}:${session.ownerId || (session.ownerType === "user" ? session.userId : "")}`);
    if (!owner) return null;
    return delegatedMemoryScope(db, { sessionId, owner, actorUserId: session.userId, orgId: session.orgId });
  }
  if (!sessionId.startsWith("wf:")) return null;
  let runId: string;
  try {
    runId = parseWorkflowSessionId(sessionId).runId;
  } catch {
    return null;
  }
  const [run] = await db.select({ orgId: workflowDefinitions.orgId, actorUserId: workflowRuns.actorUserId })
    .from(workflowRuns).innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.id, runId)).limit(1);
  if (!run) return null;
  const owner = await workflowSessionOwner(db, sessionId, run.orgId);
  if (!owner) return null;
  return delegatedMemoryScope(db, { sessionId, owner, actorUserId: run.actorUserId ?? "", orgId: run.orgId });
}

/** Shared web conversations retain the team's established corpus. Private and
 * external conversations keep their execution storage, regardless of who wakes them. */
export async function assistantMemoryNamespace(db: AppDb, sessionId: string, teamId: string, orgId: string, depth = 0): Promise<string> {
  if (depth > 8) throw new NotFoundError("memory origin ancestry");
  const [legacyOwner] = await db.select({ id: assistants.id }).from(assistants)
    .where(and(eq(assistants.sessionId, sessionId), eq(assistants.ownerType, "team"), sql`(${assistants.ownerId} = ${teamId} OR EXISTS (SELECT 1 FROM legacy_assistant_runtimes l
      WHERE l.session_id = ${sessionId} AND l.owner_id = ${teamId} AND l.owner_type = 'team'))`)).limit(1);
  if (legacyOwner && await isLegacyAssistantRuntime(db, sessionId, orgId)) return "";
  const [execution] = await db.select({ key: assistantExecutions.conversationKey })
    .from(assistantExecutions).innerJoin(assistants, eq(assistants.id, assistantExecutions.assistantId))
    .where(and(eq(assistantExecutions.sessionId, sessionId), eq(assistants.ownerType, "team"),
      eq(assistants.ownerId, teamId), eq(assistants.orgId, orgId), isNull(assistants.archivedAt),
      sql`EXISTS (SELECT 1 FROM engine_threads t
        WHERE t.session_id = ${assistants.sessionId} AND t.id = ${assistantExecutions.governingThreadId}
          AND t.key = ${assistantExecutions.conversationKey})`,
      sql`NOT EXISTS (SELECT 1 FROM engine_sessions s WHERE s.id = ${sessionId}
        AND (s.parent_session_id IS DISTINCT FROM ${assistants.sessionId}
          OR s.parent_thread_id IS DISTINCT FROM ${assistantExecutions.governingThreadId}))`)).limit(1);
  const run = /^(?:signal:workflow:|slack-events:[^:]+:workflow:)([A-Za-z0-9_-]+)$/.exec(execution?.key ?? "");
  if (run) return workflowMemoryNamespace(db, run[1], teamId, orgId, depth + 1);
  return execution?.key.startsWith("web:") ? "" : sessionId;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Resolve a stored run only within its organization and execution owner.
 * Ordinary team workflows retain shared persistent memory. Narrower audiences
 * use a stable origin/channel scope, never a fresh namespace for each run. */
export async function workflowMemoryNamespace(db: AppDb, runId: string, teamId: string, orgId: string, depth = 0): Promise<string> {
  if (depth > 8) throw new NotFoundError("memory origin ancestry");
  const [run] = await db.select({ params: workflowRuns.params, workflowId: workflowRuns.workflowId })
    .from(workflowRuns).innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .where(and(eq(workflowRuns.id, runId), eq(workflowDefinitions.orgId, orgId),
      sql`((${workflowRuns.ownerType} = 'team' AND ${workflowRuns.ownerId} = ${teamId})
        OR (${workflowRuns.ownerType} = 'user' AND ${workflowRuns.ownerId} = ${`team:${teamId}`}))`)).limit(1);
  const params = record(run?.params);
  if (!run || !params) throw new NotFoundError("workflow memory");
  const binding = await legacyWorkflowRuntime(db, run.workflowId, orgId);
  if (binding) return await isLegacyAssistantRuntime(db, binding, orgId) ? "" : binding;
  const input = record(params.input);
  const data = record(input?.data);
  let channel: string | undefined;
  if (input?.type === "event" && typeof data?.key === "string" && data.key.startsWith("slack.")) {
    channel = runEventChannel(params);
    // Missing channel provenance must not widen the audience to the team.
    if (!channel) throw new NotFoundError("workflow memory audience");
  }
  // A run can carry both a channel audience and a narrower conversation origin.
  const scoped = (namespace: string) => channel
    ? `workflow-channel:${JSON.stringify([run.workflowId, channel, namespace])}` : namespace;
  if (params.origin == null) return scoped("");
  const origin = record(params.origin);
  if (!origin || typeof origin.assistantSessionId !== "string" || typeof origin.threadId !== "string") {
    throw new NotFoundError("workflow memory origin");
  }
  const [source] = await db.select({ ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId,
    key: sql<string>`t.key` }).from(agentSessions)
    .innerJoin(sql`engine_threads t`, sql`t.session_id = ${agentSessions.id} AND t.id = ${origin.threadId}`)
    .where(and(eq(agentSessions.id, origin.assistantSessionId), eq(agentSessions.orgId, orgId),
      sql`${agentSessions.status} <> 'deleted'`)).limit(1);
  if (!source) throw new NotFoundError("workflow memory origin");
  if (source.ownerType === "team" && source.ownerId === teamId) {
    const [root] = await db.select({ id: assistants.id }).from(assistants)
      .where(and(eq(assistants.sessionId, origin.assistantSessionId), eq(assistants.orgId, orgId))).limit(1);
    if (!root) return scoped(await assistantMemoryNamespace(db, origin.assistantSessionId, teamId, orgId, depth + 1));
    if (await isLegacyAssistantRuntime(db, origin.assistantSessionId, orgId)) return "";
    // Old assistant roots held many audiences; never use the root ID as a private scope.
    if (source.key.startsWith("web:")) return scoped("");
    const [execution] = await db.select({ id: assistantExecutions.sessionId }).from(assistantExecutions)
      .where(and(eq(assistantExecutions.assistantId, root.id), eq(assistantExecutions.governingThreadId, origin.threadId))).limit(1);
    if (execution) return scoped(execution.id);
    throw new NotFoundError("workflow origin execution");
  }
  return scoped(`workflow-origin:${JSON.stringify([origin.assistantSessionId, origin.threadId])}`);
}
