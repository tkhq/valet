/**
 * Orchestrator lifecycle (Phase 4 decision 17/22).
 *
 *   POST /api/orchestrator → ensure the caller's user-orchestrator exists
 *                             (instant sandbox-less wake) and return its id.
 *   GET  /api/orchestrator → probe only, never creates.
 *
 * This phase mounts only the user-orchestrator entry point (web nav "Assistant"
 * per decision 22) — team/org orchestrators are created via other paths
 * (Task 8+) and aren't reachable through this route.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { orchestratorSessionId, type Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, orchestratorIdentities } from "../schema/index.js";
import type { EnsureOrchestratorResponse, GetOrchestratorResponse } from "../wire/types.js";

export const orchestratorRouter = new Hono<AppEnv>();

function userPrincipal(userId: string): Principal {
  return { type: "user", id: userId };
}

// ── Ensure (create-if-absent) ───────────────────────────────────────────────

orchestratorRouter.post("/", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);

  const session = await engineHost.orchestratorSessionFor(principal, {
    actorUserId: user.id,
    orgId: user.orgId,
  });
  const sessionId = session.id;

  // Mirror POST /api/sessions: an `agent_sessions` app row is what makes the
  // existing /api/sessions/:id/* routes (messages, threads, decisions) work
  // against this session id too. Idempotent — a second ensure call finds the
  // row from the first and skips the insert. `sessionId` is deterministic
  // per principal (`orchestratorSessionId`), so two concurrent first-ensure
  // requests can both see no existing row and both attempt this insert;
  // `onConflictDoNothing` on the primary key makes the loser a no-op instead
  // of an uncaught unique-constraint 500.
  const existingRow = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get();
  if (!existingRow) {
    const now = Date.now();
    const data = await session.toData();
    await db
      .insert(agentSessions)
      .values({
        id: sessionId,
        userId: user.id,
        orgId: user.orgId,
        workspace: data.workspace,
        title: "Assistant",
        status: "active",
        ownerType: principal.type,
        ownerId: principal.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  const body: EnsureOrchestratorResponse = { sessionId };
  return c.json(body, 200);
});

// ── Probe (no create) ───────────────────────────────────────────────────────

orchestratorRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);
  const sessionId = orchestratorSessionId(principal);

  const identity = await db
    .select()
    .from(orchestratorIdentities)
    .where(
      and(
        eq(orchestratorIdentities.orgId, user.orgId),
        eq(orchestratorIdentities.ownerType, principal.type),
        eq(orchestratorIdentities.ownerId, principal.id),
      ),
    )
    .get();

  const body: GetOrchestratorResponse = { sessionId, exists: identity !== undefined };
  return c.json(body);
});
