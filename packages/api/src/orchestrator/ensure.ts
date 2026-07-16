/**
 * Get-or-create the caller's orchestrator session (Phase 4 decision 17/22).
 * Extracted from `POST /api/orchestrator` (`routes/orchestrator.ts`) so
 * channel inbound routing (Task 6) can wake the same orchestrator session
 * without going through the HTTP route.
 */
import { eq } from "drizzle-orm";
import type { Principal, Session } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import type { EngineHost } from "../engine/host.js";

export async function ensureOrchestratorSession(
  deps: { db: AppDb; engineHost: EngineHost },
  principal: Principal,
  meta: { actorUserId: string; orgId: string },
): Promise<{ sessionId: string; session: Session }> {
  const session = await deps.engineHost.orchestratorSessionFor(principal, meta);
  const sessionId = session.id;

  // Mirror POST /api/sessions: an `agent_sessions` app row is what makes the
  // existing /api/sessions/:id/* routes (messages, threads, decisions) work
  // against this session id too. Idempotent — a second ensure call finds the
  // row from the first and skips the insert. `sessionId` is deterministic
  // per principal (`orchestratorSessionId`), so two concurrent first-ensure
  // requests can both see no existing row and both attempt this insert;
  // `onConflictDoNothing` on the primary key makes the loser a no-op instead
  // of an uncaught unique-constraint 500.
  const existingRows = await deps.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!existingRows[0]) {
    const now = Date.now();
    const data = await session.toData();
    await deps.db
      .insert(agentSessions)
      .values({
        id: sessionId,
        userId: meta.actorUserId,
        orgId: meta.orgId,
        workspace: data.workspace,
        title: "Assistant",
        status: "active",
        ownerType: principal.type,
        ownerId: principal.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }

  return { sessionId, session };
}
