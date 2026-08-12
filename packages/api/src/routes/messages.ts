/**
 * Messages + threads routes — the agent loop entry points.
 *
 * Each session has a default engine thread (`web:default`); the user can
 * create additional threads via POST /threads. Subsequent calls to
 * /messages can target any thread by id (defaults to the default thread
 * when omitted, so single-thread clients keep working).
 *
 *   GET  /api/sessions/:id/threads   → all threads for the session
 *   POST /api/sessions/:id/threads   → create a new engine thread
 *   GET  /api/sessions/:id/messages  → list messages (?threadId=…)
 *   POST /api/sessions/:id/messages  → send prompt (body.threadId optional)
 */
import { Hono, type Context } from "hono";
import { eq, inArray } from "drizzle-orm";
import type { SessionEntry, Session as EngineSession } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionThreads } from "../schema/index.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  MessagePart,
  MessageRole,
  ResolveDecisionRequest,
  SendPromptRequest,
  SendPromptResponse,
  ThreadSummary,
  WithdrawDecisionRequest,
} from "../wire/types.js";
import { engineGateToWire, engineSignalToWire, engineToWireParts } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type { Providers } from "../providers/types.js";
import { canViewSession } from "../services/session-access.js";

export const messagesRouter = new Hono<AppEnv>();

/**
 * Every route in this file (threads, messages, decisions) shares this one
 * check — view access, not just direct ownership, so a team's orchestrator
 * session works the same way here as `GET /api/sessions/:id` does (see
 * `services/session-access.ts`). Session lifecycle routes (delete, pause,
 * model change — in `routes/sessions.ts`) are NOT widened by this; talking
 * to a team's orchestrator is not the same decision as reconfiguring it.
 */
async function loadOwnedSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, userId))) return null;
  return row;
}

function entryToMessage(e: SessionEntry, sessionId: string, threadId: string): Message | null {
  if (e.type !== "message") return null;
  // Engine has 4 roles: user/assistant/tool/system. We forward as-is.
  const role: MessageRole = e.role;
  const parts: MessagePart[] = engineToWireParts(e.parts);
  // Engine entries have createdAt as `string` (ISO-ish) per BaseEntry. Coerce
  // to number for the wire.
  const created = typeof e.createdAt === "number" ? e.createdAt : Date.parse(e.createdAt as unknown as string);
  return {
    id: e.id,
    sessionId,
    threadId,
    role,
    content: e.content,
    parts,
    createdAt: Number.isFinite(created) ? created : Date.now(),
    queueItemId: e.queueItemId,
    signal: engineSignalToWire(e.signal),
  };
}

// ── Threads ───────────────────────────────────────────────────────────────

function threadToSummary(
  threadId: string,
  createdAt: number,
  sessionId: string,
  title?: string,
  model?: string,
  key?: string,
): ThreadSummary {
  return { id: threadId, sessionId, title, createdAt, model, key };
}

async function loadEngineSession(
  c: Context<AppEnv>,
): Promise<{ session: typeof agentSessions.$inferSelect; engineSession: EngineSession } | { error: Response }> {
  const session = await loadOwnedSession(c);
  if (!session) return { error: c.json({ error: "session not found" }, 404) };
  const { engineHost, db } = c.var.providers;

  // Repo bindings + git identity (GitHub/repo integration plan, Task 9) —
  // assembled centrally via `loadSessionMeta` so EVERY `sessionFor` caller
  // carries them. The first call to actually build the session (create or
  // restore) wires `prepareSandbox`; later calls are no-op reads once cached
  // (`sessionFor` returns early without touching `meta`).
  const engineSession = await engineHost.sessionFor(session.id, await loadSessionMeta(db, session));
  return { session, engineSession };
}

messagesRouter.get("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  await engineSession.ensureDefaultThread();
  const threads = engineSession.listThreads();

  // Titles live in the app-side `session_threads` mirror (populated by
  // auto-title). One lookup by id set — small, since a session has O(few)
  // threads. Missing rows → undefined title, same as before.
  const ids = threads.map((t) => t.id);
  const titleRows = ids.length
    ? await db
        .select({ id: sessionThreads.id, title: sessionThreads.title })
        .from(sessionThreads)
        .where(inArray(sessionThreads.id, ids))
    : [];
  const titleById = new Map(titleRows.map((r) => [r.id, r.title ?? undefined] as const));

  const summaries = threads.map((t) =>
    threadToSummary(
      t.id,
      t.toThreadData().createdAt,
      session.id,
      titleById.get(t.id),
      t.modelId(),
      t.key,
    ),
  );
  const body: ListThreadsResponse = { threads: summaries };
  return c.json(body);
});

messagesRouter.patch("/:id/threads/:threadId", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  let body: { model?: string | null };
  try {
    body = (await c.req.json()) as { model?: string | null };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.model === undefined) {
    return c.json({ error: "model is required (use null to clear)" }, 400);
  }

  try {
    await thread.setModel(
      typeof body.model === "string" ? body.model : null,
    );
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const summary = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    undefined,
    thread.modelId(),
    thread.key,
  );
  return c.json(summary);
});

messagesRouter.post("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  let body: CreateThreadRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as CreateThreadRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Engine identifies threads by `key`; we generate a fresh one so each
  // POST creates a new thread (calling thread() with an existing key
  // returns the cached one).
  const key = `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const thread = engineSession.thread(key);
  const summary: CreateThreadResponse = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    body.title,
    thread.modelId(),
    thread.key,
  );
  return c.json(summary, 201);
});

/**
 * Resolve the target thread from a `?threadId=` query param or body field.
 * Returns either the matching engine Thread, or the session's default thread
 * when no id was supplied. Returns null if a specific id was given but no
 * thread matches — caller should 404.
 */
function resolveThread(
  engineSession: EngineSession,
  threadId: string | undefined,
) {
  if (!threadId) return engineSession.thread();
  return engineSession.threadById(threadId);
}

// ── Messages: list ────────────────────────────────────────────────────────

messagesRouter.get("/:id/messages", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  await engineSession.ensureDefaultThread();
  const requested = c.req.query("threadId") || undefined;
  const thread = resolveThread(engineSession, requested);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const cursor = c.req.query("cursor") ?? undefined;
  const entries = await thread.readEntries({ limit, cursor });

  const messages = entries
    .map((e) => entryToMessage(e, session.id, thread.id))
    .filter((m): m is Message => m !== null);

  const body: ListMessagesResponse = {
    messages,
    hasMore: entries.length === limit,
    nextCursor: undefined, // engine cursor pagination is opaque; revisit if needed
  };
  return c.json(body);
});

// ── Messages: send prompt ─────────────────────────────────────────────────

/**
 * Queue one user prompt on a session's thread and touch the session row so
 * list ordering reflects recency. This is the whole submit path: the route
 * below wraps it in authorization and HTTP, and `POST /api/sessions` calls it
 * to honour `CreateSessionRequest.initialPrompt`.
 *
 * Returns null when `threadId` names no thread of this session. The caller
 * must have authorized the session already — this function does not.
 */
export async function submitSessionPrompt(
  providers: Pick<Providers, "db" | "engineHost">,
  row: typeof agentSessions.$inferSelect,
  text: string,
  threadId?: string,
): Promise<SendPromptResponse | null> {
  const { db, engineHost } = providers;
  const engineSession = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));

  await engineSession.ensureDefaultThread();
  const thread = resolveThread(engineSession, threadId);
  if (!thread) return null;

  const receipt = await thread.submitPrompt(text, {});

  await db
    .update(agentSessions)
    .set({ updatedAt: Date.now() })
    .where(eq(agentSessions.id, row.id));

  return { messageId: receipt.queueItemId, threadId: thread.id };
}

messagesRouter.post("/:id/messages", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row) return c.json({ error: "session not found" }, 404);

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text is required" }, 400);
  }

  const resp = await submitSessionPrompt(c.var.providers, row, body.text, body.threadId);
  if (!resp) return c.json({ error: "thread not found" }, 404);
  return c.json(resp, 202);
});

// ── Thread abort ──────────────────────────────────────────────────────────
//
// Mirrors the engine-spec route table: `POST .../threads/:threadId/abort`
// aborts the current turn on this thread and clears its queue. Delegates to
// `Session.abort({ threadId })`, which stamps `abortRequestedAt` durably and
// lets the claim/reconcile settlement path record the terminal outcome —
// see `packages/engine/src/session.ts` `abort()`. A thread with nothing
// running/queued is a no-op: `Thread.abort()` withdraws no gates, aborts a
// non-streaming agent (a safe no-op), and settles zero unclaimed items.
messagesRouter.post("/:id/threads/:threadId/abort", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  await engineSession.abort({ threadId });
  return c.json({ ok: true });
});

// ── Decision gates ────────────────────────────────────────────────────────
//
// A gate is created by a tool calling `ctx.requestDecision(...)`. The engine
// emits `decision_gate` on the bus (forwarded to the WS by the bridge) and
// suspends the thread on `blocked_on_decision_gate` status. The user resolves
// or withdraws via these endpoints, which routes to `Session.resolveDecision`
// / `Session.withdrawDecision` — which finds the thread that owns the gate
// and unblocks it.

messagesRouter.get("/:id/decisions", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const pending = await engineSession.pendingDecisionGates();
  const body: ListDecisionsResponse = { gates: pending.map(engineGateToWire) };
  return c.json(body);
});

messagesRouter.post("/:id/decisions/:gateId/resolve", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;
  const gateId = c.req.param("gateId");

  let body: ResolveDecisionRequest;
  try {
    body = (await c.req.json()) as ResolveDecisionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.actionId === undefined && body.value === undefined) {
    return c.json({ error: "actionId or value is required" }, 400);
  }

  // Confirm the gate is actually pending in this session before resolving.
  // Without this check, a stale gateId from the client would silently no-op.
  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.resolveDecision(gateId, {
    actionId: body.actionId,
    value: body.value,
    resolvedBy: c.var.user.id,
    resolvedAt: Date.now(),
    source: { channelType: "web" },
  });
  return c.json({ ok: true });
});

messagesRouter.post("/:id/decisions/:gateId/withdraw", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;
  const gateId = c.req.param("gateId");

  let body: WithdrawDecisionRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as WithdrawDecisionRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // The user-initiated path should always be `cancel`. `steer` and `abort`
  // are engine-internal reasons; reject them so we don't end up with
  // misleading audit records.
  const reason = body.reason ?? "cancel";
  if (reason !== "cancel") {
    return c.json({ error: "only reason='cancel' is allowed from clients" }, 400);
  }

  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.withdrawDecision(gateId, reason);
  return c.json({ ok: true });
});
