/**
 * Approval to act through another member's shared account.
 *
 * A team action uses the acting member's own shared account, then the team's
 * own connection (`credential-resolution.ts#readTeamCredential`). When only
 * another member's account would answer, that member is asked first, and
 * their approval is recorded here as a runtime grant: for one conversation
 * (thread) of a session, or for one workflow run. The host's credential read
 * borrows the account only while that grant stands.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { agentSessions, credentialShares, runtimeGrants } from "../schema/index.js";

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
  return sessionId.startsWith("wf:") ? sessionId.split(":")[1] || undefined : undefined;
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

export async function hasBorrowGrant(db: AppQueryable, scope: BorrowScope): Promise<boolean> {
  const key = await borrowKey(db, scope);
  if (!key) return false;
  const runId = workflowRunOf(scope.sessionId);
  const rows = await db.select({ id: runtimeGrants.id }).from(runtimeGrants).where(and(
    runId ? eq(runtimeGrants.workflowExecutionId, runId) : eq(runtimeGrants.sessionId, scope.sessionId),
    eq(runtimeGrants.policyKey, key),
    isNull(runtimeGrants.revokedAt),
  )).limit(1);
  return rows.length > 0;
}

/** Only a live workspace runtime can request unattended account consent. */
function unattendedRuntimeOwner(scope: { orgId: string; teamId: string; sessionId: string; threadId?: string; actorId?: string }) {
  return sql`EXISTS (SELECT 1 FROM agent_sessions s JOIN assistants a ON a.session_id = s.id
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

/** Grants require a current teammate, or an unattended run owned by the team. */
export async function canBorrowCredential(
  db: AppQueryable,
  scope: BorrowScope & { orgId: string; teamId: string; actorId?: string },
): Promise<boolean> {
  if (!scope.actorId) return false;
  const key = await borrowKey(db, scope);
  if (!key) return false;
  const runId = workflowRunOf(scope.sessionId);
  const unattended = scope.actorId === `team:${scope.teamId}`;
  if (unattended && !runId && !scope.threadId) return false;
  const rows = await db.select({ id: runtimeGrants.id }).from(runtimeGrants).where(and(
    eq(runtimeGrants.orgId, scope.orgId),
    runId ? eq(runtimeGrants.workflowExecutionId, runId) : eq(runtimeGrants.sessionId, scope.sessionId),
    eq(runtimeGrants.policyKey, key),
    isNull(runtimeGrants.revokedAt),
    sql`EXISTS (SELECT 1 FROM team_members m JOIN teams t ON t.id = m.team_id
      WHERE m.team_id = ${scope.teamId} AND m.user_id = ${unattended ? scope.memberId : scope.actorId} AND t.org_id = ${scope.orgId})`,
    unattended ? (runId ? sql`EXISTS (SELECT 1 FROM workflow_runs r
      WHERE r.id = ${runId} AND r.owner_type = 'team' AND r.owner_id = ${scope.teamId}
        AND (r.actor_user_id IS NULL OR r.actor_user_id = ${scope.actorId}))` : unattendedRuntimeOwner(scope)) : undefined,
  )).limit(1);
  return rows.length > 0;
}

/** Records `scope.memberId`'s approval. Approving again is a no-op. */
export async function writeBorrowGrant(db: AppQueryable, orgId: string, scope: BorrowScope & { shareGeneration: string }, now = Date.now()): Promise<void> {
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
