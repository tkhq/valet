/**
 * Approval to act through another member's shared account.
 *
 * A team action uses the acting member's own shared account, then the team's
 * own connection (`credential-resolution.ts#readTeamCredential`). When only
 * another member's account would answer, that member is asked first, and
 * their approval covers one conversation (thread) or workflow run by default.
 * Explicit lasting consent stays on the current share until it ends.
 * The host checks that consent and current team authorization on each read.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { actionInvocations, agentSessions, credentialShares, runtimeGrants, workflowRuns } from "../schema/index.js";

/** Where a borrow approval applies: a session's thread, or a workflow run
 * (a `wf:<runId>:<node>` session). */
export interface BorrowScope {
  teamId: string;
  sessionId: string;
  threadId?: string;
  service: string;
  memberId: string;
}

function workflowRunOf(sessionId: string): string | undefined {
  // Tool nodes use the run scope; engine sessions include a node and iteration.
  const runScope = /^wf:([A-Za-z0-9_-]+)$/.exec(sessionId);
  if (runScope) return runScope[1];
  try { return parseWorkflowSessionId(sessionId).runId; }
  catch { return undefined; }
}

export async function shareGeneration(db: AppQueryable, teamId: string, service: string, memberId: string): Promise<string | undefined> {
  const [share] = await db.select({ generation: credentialShares.generation }).from(credentialShares)
    .where(and(eq(credentialShares.teamId, teamId), eq(credentialShares.service, service),
      eq(credentialShares.userId, memberId))).limit(1);
  return share?.generation;
}

async function borrowKey(db: AppQueryable, scope: BorrowScope): Promise<string | undefined> {
  const generation = await shareGeneration(db, scope.teamId, scope.service, scope.memberId);
  return generation ? grantKey(scope, generation) : undefined;
}

function grantKey(scope: BorrowScope, generation: string): string {
  const base = `credential:${scope.service}:${scope.memberId}:${generation}`;
  return workflowRunOf(scope.sessionId) ? base : `${base}:${scope.threadId ?? ""}`;
}

/** Only a live workspace runtime can request unattended account consent. */
function unattendedRuntimeOwner(scope: { orgId: string; teamId: string; sessionId: string; threadId?: string; actorId?: string }) {
  return sql`EXISTS (SELECT 1 FROM agent_sessions s
    LEFT JOIN assistant_executions e ON e.session_id = s.id
    JOIN assistants a ON a.session_id = s.id OR a.id = e.assistant_id
    WHERE s.id = ${scope.sessionId} AND s.org_id = ${scope.orgId} AND s.owner_type = 'team'
      AND s.owner_id = ${scope.teamId} AND s.status <> 'deleted'
      AND a.org_id = ${scope.orgId} AND a.owner_type = 'team' AND a.owner_id = ${scope.teamId}
      AND a.archived_at IS NULL)`;
}

export async function isUnattendedTeamRuntime(
  db: AppQueryable,
  scope: { orgId: string; teamId: string; sessionId: string; threadId?: string; actorId?: string },
): Promise<boolean> {
  if (!scope.threadId || scope.actorId !== `team:${scope.teamId}`) return false;
  const rows = await db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(eq(agentSessions.id, scope.sessionId), unattendedRuntimeOwner(scope))).limit(1);
  return rows.length > 0;
}

/** The same durable workflow ownership proof guards consent and later borrowing. */
function unattendedWorkflowOwner(scope: { orgId: string; teamId: string; sessionId: string; actorId?: string }, runId: string) {
  return sql`EXISTS (SELECT 1 FROM workflow_runs r
    JOIN workflow_definitions d ON d.id = r.workflow_id
    JOIN teams t ON t.id = r.owner_id
    WHERE r.id = ${runId} AND r.owner_type = 'team' AND r.owner_id = ${scope.teamId}
      AND d.org_id = ${scope.orgId} AND t.org_id = ${scope.orgId}
      AND (r.actor_user_id IS NULL OR r.actor_user_id = ${scope.actorId})
      AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = ${scope.sessionId}))`;
}

/** An unattended engine session must belong to a live workspace or its stored workflow run. */
export async function isUnattendedTeamSession(
  db: AppQueryable,
  scope: { orgId: string; teamId: string; sessionId: string; threadId?: string; actorId?: string },
): Promise<boolean> {
  if (!scope.threadId || scope.actorId !== `team:${scope.teamId}`) return false;
  if (!scope.sessionId.startsWith("wf:")) return isUnattendedTeamRuntime(db, scope);
  let runId: string;
  try { runId = parseWorkflowSessionId(scope.sessionId).runId; }
  catch { return false; }
  const rows = await db.select({ id: workflowRuns.id }).from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), unattendedWorkflowOwner(scope, runId))).limit(1);
  return rows.length > 0;
}

/** Grants require a current teammate, or an unattended run owned by the team. */
export async function canBorrowCredential(
  db: AppQueryable,
  scope: BorrowScope & { orgId: string; teamId: string; actorId?: string },
): Promise<boolean> {
  if (!scope.actorId) return false;
  const runId = workflowRunOf(scope.sessionId);
  if (scope.sessionId.startsWith("wf:") && !runId) return false;
  const unattended = scope.actorId === `team:${scope.teamId}`;
  if (unattended && !runId && !scope.threadId) return false;
  const memberAuthorization = sql`EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE m.team_id = ${scope.teamId} AND m.user_id = ${unattended ? scope.memberId : scope.actorId} AND t.org_id = ${scope.orgId})`;
  const runtimeAuthorization = unattended ? (runId ? unattendedWorkflowOwner(scope, runId) : unattendedRuntimeOwner(scope)) : undefined;
  const [consent] = await db.select({ generation: credentialShares.generation }).from(credentialShares).where(and(
    eq(credentialShares.teamId, scope.teamId), eq(credentialShares.service, scope.service), eq(credentialShares.userId, scope.memberId),
    isNotNull(credentialShares.borrowConsentAt), memberAuthorization, runtimeAuthorization,
    sql`EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = ${scope.teamId} AND m.user_id = ${scope.memberId})`,
    sql`EXISTS (SELECT 1 FROM credentials c WHERE c.owner_type = 'user' AND c.owner_id = ${scope.memberId} AND c.service = ${scope.service})`,
  )).limit(1);
  if (consent) return true;
  const key = await borrowKey(db, scope);
  if (!key) return false;
  const rows = await db.select({ id: runtimeGrants.id }).from(runtimeGrants).where(and(
    eq(runtimeGrants.orgId, scope.orgId),
    runId ? eq(runtimeGrants.workflowExecutionId, runId) : eq(runtimeGrants.sessionId, scope.sessionId),
    eq(runtimeGrants.policyKey, key),
    isNull(runtimeGrants.revokedAt),
    sql`EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.team_id = ${scope.teamId} AND m.user_id = ${unattended ? scope.memberId : scope.actorId} AND t.org_id = ${scope.orgId})`,
    unattended ? (runId ? unattendedWorkflowOwner(scope, runId) : unattendedRuntimeOwner(scope)) : undefined,
  )).limit(1);
  return rows.length > 0;
}

/** Records `scope.memberId`'s approval. Approving again is a no-op. */
export async function writeBorrowGrant(db: AppQueryable, orgId: string, scope: BorrowScope & { shareGeneration: string; consentScope?: "team" }, now = Date.now()): Promise<void> {
  if (scope.consentScope === "team") return db.transaction(async tx => {
    const updated = await tx.update(credentialShares).set({ borrowConsentAt: sql`COALESCE(${credentialShares.borrowConsentAt}, ${now})` }).where(and(
      eq(credentialShares.teamId, scope.teamId), eq(credentialShares.service, scope.service), eq(credentialShares.userId, scope.memberId),
      eq(credentialShares.generation, scope.shareGeneration),
      sql`EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
        WHERE m.team_id = ${scope.teamId} AND m.user_id = ${scope.memberId} AND t.org_id = ${orgId})`,
      sql`EXISTS (SELECT 1 FROM credentials c WHERE c.owner_type = 'user' AND c.owner_id = ${scope.memberId} AND c.service = ${scope.service})`,
    )).returning({ generation: credentialShares.generation });
    if (updated.length === 0) throw new Error("This account share changed. Request account approval again.");
    const runId = workflowRunOf(scope.sessionId);
    await tx.insert(actionInvocations).values({
      invocationId: `credential-consent:${scope.shareGeneration}`, createdAt: now,
      service: scope.service, actionId: "credential.borrow", resolvedMode: "require_approval", status: "approved",
      orgId, sessionId: runId ? null : scope.sessionId, threadId: scope.threadId ?? null,
      workflowExecutionId: runId ?? null, userId: scope.memberId, resolvedBy: scope.memberId,
      params: { scope: "team", teamId: scope.teamId, memberId: scope.memberId, shareGeneration: scope.shareGeneration },
    }).onConflictDoNothing();
  });
  const key = await borrowKey(db, scope);
  if (!key || key !== grantKey(scope, scope.shareGeneration)) throw new Error("This account share changed. Request account approval again.");
  const runId = workflowRunOf(scope.sessionId);
  await db.insert(runtimeGrants).values({
    id: randomUUID(), orgId,
    sessionId: runId ? null : scope.sessionId,
    workflowExecutionId: runId ?? null,
    policyKey: key, mode: "allow", grantedBy: scope.memberId, createdAt: now, revokedAt: null,
  }).onConflictDoNothing();
}
