/**
 * The caller's DEFAULT assistant (Phase 4 decision 17/22).
 *
 *   POST /api/orchestrator → ensure the caller's default assistant session
 *                             exists (instant sandbox-less wake), return its id.
 *   GET  /api/orchestrator → probe only, never creates anything.
 *
 * A user owns any number of assistants. Every route here means the DEFAULT
 * one — the target a caller that named only a principal can be asking for.
 * `GET/POST/PATCH /api/assistants` (`routes/assistants.ts`) is where the
 * others are listed, created and administered, and a team's assistant is
 * reached through `POST /api/teams/:id/orchestrator`.
 *
 * `resolveDefaultAssistant` (`assistants/service.ts`) creates the default
 * row on first use. That row is not the engine session: it is one insert,
 * with no sandbox and no agent loop behind it. Routes below say which of
 * the two they create.
 */
import { Hono } from "hono";
import { and, count, desc, eq } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, assistants, childWatches } from "../schema/index.js";
import {
  ensureDefaultAssistantSession,
  findDefaultAssistant,
  resolveDefaultAssistant,
} from "../assistants/service.js";
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

  const { sessionId } = await ensureDefaultAssistantSession({ db, engineHost }, principal, {
    actorUserId: user.id,
    orgId: user.orgId,
  });

  const body: EnsureOrchestratorResponse = { sessionId };
  return c.json(body, 200);
});

// ── Probe (no create) ───────────────────────────────────────────────────────

/**
 * Creates nothing — not the assistant row, not the engine session. A caller
 * with no default assistant yet gets `exists: false` and a null
 * `sessionId`, because there is no session to address until one exists. The
 * id is no longer derivable from the caller: an assistant addresses its
 * session by its own id, so only a lookup can supply one.
 */
orchestratorRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const assistant = await findDefaultAssistant(db, user.orgId, userPrincipal(user.id));

  const body: GetOrchestratorResponse = {
    sessionId: assistant?.sessionId ?? null,
    exists: assistant !== undefined,
  };
  return c.json(body);
});

// ── Info (identity + presence) ──────────────────────────────────────────────

/**
 * GET /api/orchestrator/info — decision 4. Never creates the engine session
 * or the `agent_sessions` row; a first-visit caller sees `name: null`.
 *
 * It DOES resolve (and therefore create) the caller's default assistant
 * row, because the response carries that assistant's `sessionId` and the id
 * is no longer derivable from the caller alone. The row costs one insert
 * and starts nothing.
 *
 * Presence source (documented per task-2 brief, "pick the cheapest honest
 * source"): `working` if any child_watches row is unsettled; else `thinking`
 * if the assistant is LIVE in this process (`engineHost.liveSession`,
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

  const assistant = await resolveDefaultAssistant(db, user.orgId, principal);
  const sessionId = assistant.sessionId;
  const name = assistant.name;

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
 * session exists: `name` sets `assistants.name` on the caller's default
 * assistant (resolving that row if this is the first touch); `personality`
 * writes the `assistant/personality.md` memory file, which never touches
 * the engine either. Either write evicts the cached engine session
 * (cache-only — `EngineHost.evictCache`, NOT `destroy()`, which would
 * delete the engine session row) so the next wake rebuilds the persona from
 * the new name.
 */
orchestratorRouter.patch("/info", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);

  let body: PatchOrchestratorInfoRequest;
  try {
    body = (await c.req.json()) as PatchOrchestratorInfoRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const assistant = await resolveDefaultAssistant(db, user.orgId, principal);

  if (body.name !== undefined) {
    await db.update(assistants).set({ name: body.name }).where(eq(assistants.id, assistant.id));
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

  engineHost.evictCache(assistant.sessionId);

  const responseBody: PatchOrchestratorInfoResponse = { ok: true };
  return c.json(responseBody);
});

// ── Children ─────────────────────────────────────────────────────────────

/** GET /api/orchestrator/children — decision 6: `child_watches` ⋈
 * `agent_sessions` for the caller's default assistant, newest first.
 * Creates nothing: a caller with no default assistant has no children, so
 * the empty list is the honest answer. `outcome` is never populated this
 * pass — `child_watches` has no outcome column, and decision 6 marks
 * deriving one (e.g. from the engine store's submission outcome) as an
 * optional future improvement, not required here; the UI only needs
 * `status: 'settled'` to show a checkmark. */
orchestratorRouter.get("/children", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const assistant = await findDefaultAssistant(db, user.orgId, userPrincipal(user.id));
  if (!assistant) {
    const empty: GetOrchestratorChildrenResponse = { children: [] };
    return c.json(empty);
  }

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
    .where(eq(childWatches.parentSessionId, assistant.sessionId))
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
