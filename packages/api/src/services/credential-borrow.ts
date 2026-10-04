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
import { and, eq, isNull } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { runtimeGrants } from "../schema/index.js";

/** Where a borrow approval applies: a session's thread, or a workflow run
 * (a `wf:<runId>:<node>` session). */
export interface BorrowScope {
  sessionId: string;
  threadId?: string;
  service: string;
  memberId: string;
}

function workflowRunOf(sessionId: string): string | undefined {
  return sessionId.startsWith("wf:") ? sessionId.split(":")[1] || undefined : undefined;
}

function borrowKey(scope: BorrowScope): string {
  const base = `credential:${scope.service}:${scope.memberId}`;
  return workflowRunOf(scope.sessionId) ? base : `${base}:${scope.threadId ?? ""}`;
}

export async function hasBorrowGrant(db: AppQueryable, scope: BorrowScope): Promise<boolean> {
  const runId = workflowRunOf(scope.sessionId);
  const rows = await db.select({ id: runtimeGrants.id }).from(runtimeGrants).where(and(
    runId ? eq(runtimeGrants.workflowExecutionId, runId) : eq(runtimeGrants.sessionId, scope.sessionId),
    eq(runtimeGrants.policyKey, borrowKey(scope)),
    isNull(runtimeGrants.revokedAt),
  )).limit(1);
  return rows.length > 0;
}

/** Records `scope.memberId`'s approval. Approving again is a no-op. */
export async function writeBorrowGrant(db: AppQueryable, orgId: string, scope: BorrowScope, now = Date.now()): Promise<void> {
  if (await hasBorrowGrant(db, scope)) return;
  const runId = workflowRunOf(scope.sessionId);
  await db.insert(runtimeGrants).values({
    id: randomUUID(), orgId,
    sessionId: runId ? null : scope.sessionId,
    workflowExecutionId: runId ?? null,
    policyKey: borrowKey(scope), mode: "allow", grantedBy: scope.memberId, createdAt: now, revokedAt: null,
  }).onConflictDoNothing();
}
