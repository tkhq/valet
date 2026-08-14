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
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { orchestratorSessionId, type Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, childWatches, orchestratorIdentities } from "../schema/index.js";
import { ensureOrchestratorSession } from "../orchestrator/ensure.js";
import { readOwnFile, writeFile, type MemoryScope } from "../services/memory.js";
import type {
  EnsureOrchestratorResponse,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
  GetOrchestratorResponse,
  OrchestratorChildSummary,
  OrchestratorPresence,
  PatchOrchestratorInfoRequest,
  PatchOrchestratorInfoResponse,
} from "../wire/types.js";

export const orchestratorRouter = new Hono<AppEnv>();

function userPrincipal(userId: string): Principal {
  return { type: "user", id: userId };
}

// ── Ensure (create-if-absent) ───────────────────────────────────────────────

orchestratorRouter.post("/", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);

  const { sessionId } = await ensureOrchestratorSession({ db, engineHost }, principal, {
    actorUserId: user.id,
    orgId: user.orgId,
  });

  const body: EnsureOrchestratorResponse = { sessionId };
  return c.json(body, 200);
});

// ── Probe (no create) ───────────────────────────────────────────────────────

orchestratorRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);
  const sessionId = orchestratorSessionId(principal);

  const identityRows = await db
    .select()
    .from(orchestratorIdentities)
    .where(
      and(
        eq(orchestratorIdentities.orgId, user.orgId),
        eq(orchestratorIdentities.ownerType, principal.type),
        eq(orchestratorIdentities.ownerId, principal.id),
      ),
    )
    .limit(1);

  const body: GetOrchestratorResponse = { sessionId, exists: identityRows[0] !== undefined };
  return c.json(body);
});

// ── Info (identity + presence) ──────────────────────────────────────────────

/**
 * GET /api/orchestrator/info — decision 4. Never creates the engine session
 * or the identity row; a first-visit caller sees `name: null`.
 *
 * Presence source (documented per task-2 brief, "pick the cheapest honest
 * source"): `working` if any child_watches row is unsettled; else `thinking`
 * if the orchestrator is LIVE in this process (`engineHost.liveSession`,
 * which never builds/restores) and any of its threads has a running queue
 * item (`Thread.runningItemId()`); else `idle`. This collapses the wire
 * `status` event's finer-grained `thinking`/`tool_calling`/`streaming`
 * states into one bucket — a running item is "the assistant is doing
 * something", which is all the dashboard's presence dot needs — rather than
 * replaying/holding onto the transient per-turn status stream server-side.
 */
orchestratorRouter.get("/info", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);
  const sessionId = orchestratorSessionId(principal);

  const identityRows = await db
    .select()
    .from(orchestratorIdentities)
    .where(
      and(
        eq(orchestratorIdentities.orgId, user.orgId),
        eq(orchestratorIdentities.ownerType, principal.type),
        eq(orchestratorIdentities.ownerId, principal.id),
      ),
    )
    .limit(1);
  const name = identityRows[0]?.handle ?? null;

  // Own-scope only — a team member's `assistant/personality.md` must never
  // leak into this user's persona/info response (`readOwnFile` bypasses
  // `readFile`'s team read-union entirely; consistent with `EngineHost`'s
  // `resolvePersonaPrefix`, the other personality-read call site).
  const scope: MemoryScope = { owner: principal, actorUserId: user.id };
  const personalityRow = await readOwnFile(db, scope, "assistant/personality.md");
  const personality = personalityRow ? personalityRow.content : null;

  const unsettledRows = await db
    .select({ n: count() })
    .from(childWatches)
    .where(and(eq(childWatches.parentSessionId, sessionId), eq(childWatches.settled, false)))
    .limit(1);
  const activeChildren = unsettledRows[0]?.n ?? 0;

  let presence: OrchestratorPresence = "idle";
  if (activeChildren > 0) {
    presence = "working";
  } else {
    const live = engineHost.liveSession(sessionId);
    if (live && live.listThreads().some((t) => t.runningItemId() !== undefined)) {
      presence = "thinking";
    }
  }

  const body: GetOrchestratorInfoResponse = { sessionId, name, personality, presence, activeChildren };
  return c.json(body);
});

/**
 * PATCH /api/orchestrator/info — decision 4/5/20. Works before the engine
 * session exists: `name` upserts `orchestrator_identities.handle` (row
 * keyed by org/owner, `sessionId` set to the deterministic
 * `orchestratorSessionId(principal)` even if no `agent_sessions`/engine row
 * exists yet — same id `ensure` would compute); `personality` writes the
 * `assistant/personality.md` memory file, which never touches the engine
 * either. Either write evicts the cached engine session (cache-only —
 * `EngineHost.evictCache`, NOT `destroy()`, which would delete the engine
 * session row) so the next wake rebuilds the persona from the new identity.
 */
orchestratorRouter.patch("/info", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);
  const sessionId = orchestratorSessionId(principal);

  let body: PatchOrchestratorInfoRequest;
  try {
    body = (await c.req.json()) as PatchOrchestratorInfoRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body.name !== undefined) {
    await db
      .insert(orchestratorIdentities)
      .values({
        id: randomUUID(),
        orgId: user.orgId,
        ownerType: principal.type,
        ownerId: principal.id,
        sessionId,
        handle: body.name,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [orchestratorIdentities.orgId, orchestratorIdentities.ownerType, orchestratorIdentities.ownerId],
        set: { handle: body.name },
      });
  }

  if (body.personality !== undefined) {
    const scope: MemoryScope = { owner: principal, actorUserId: user.id };
    await writeFile(db, scope, {
      path: "assistant/personality.md",
      content: body.personality,
      type: "preference",
      origin: "user-stated",
      pinned: false,
    });
  }

  engineHost.evictCache(sessionId);

  const responseBody: PatchOrchestratorInfoResponse = { ok: true };
  return c.json(responseBody);
});

// ── Children ─────────────────────────────────────────────────────────────

/** GET /api/orchestrator/children — decision 6: `child_watches` ⋈
 * `agent_sessions` for the caller's orchestrator, newest first. `outcome`
 * is never populated this pass — `child_watches` has no outcome column, and
 * decision 6 marks deriving one (e.g. from the engine store's submission
 * outcome) as an optional future improvement, not required here; the UI
 * only needs `status: 'settled'` to show a checkmark. */
orchestratorRouter.get("/children", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);
  const sessionId = orchestratorSessionId(principal);

  const rows = await db
    .select({
      sessionId: childWatches.childSessionId,
      parentThreadId: childWatches.parentThreadId,
      settled: childWatches.settled,
      createdAt: childWatches.createdAt,
      title: agentSessions.title,
    })
    .from(childWatches)
    .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
    .where(and(eq(childWatches.parentSessionId, sessionId), isNull(childWatches.dismissedAt)))
    .orderBy(desc(childWatches.createdAt));

  const children: OrchestratorChildSummary[] = rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title ?? r.sessionId,
    parentThreadId: r.parentThreadId,
    status: r.settled ? "settled" : "running",
    createdAt: r.createdAt,
  }));

  const body: GetOrchestratorChildrenResponse = { children };
  return c.json(body);
});

/** POST /children/:childSessionId/dismiss — hide a settled child from the
 * tree. Display state only: the watch row gets `dismissed_at`, the child
 * session and its history stay reachable from the Sessions page. */
orchestratorRouter.post("/children/:childSessionId/dismiss", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const sessionId = orchestratorSessionId(userPrincipal(user.id));
  const childSessionId = c.req.param("childSessionId");

  const rows = await db
    .select({ settled: childWatches.settled })
    .from(childWatches)
    .where(
      and(
        eq(childWatches.childSessionId, childSessionId),
        eq(childWatches.parentSessionId, sessionId),
      ),
    )
    .limit(1);
  if (!rows[0]) return c.json({ error: "child not found" }, 404);
  if (!rows[0].settled) {
    return c.json(
      { error: "child is still running. Wait for it to settle, then dismiss it." },
      409,
    );
  }

  await db
    .update(childWatches)
    .set({ dismissedAt: Date.now() })
    .where(eq(childWatches.childSessionId, childSessionId));
  return c.json({ ok: true });
});
