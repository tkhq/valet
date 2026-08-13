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
import { and, eq, inArray } from "drizzle-orm";
import { dispatchCommand } from "@valet/engine";
import type { SessionEntry, Session as EngineSession } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionThreads } from "../schema/index.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  ListCommandsResponse,
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
import { commandResultEntryToMessage, engineGateToWire, engineSignalToWire, engineToWireParts } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";

export const messagesRouter = new Hono<AppEnv>();

async function loadOwnedSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;
  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export function entryToMessage(e: SessionEntry, sessionId: string, threadId: string): Message | null {
  if (e.type === "command_result") {
    return commandResultEntryToMessage(e, sessionId, threadId);
  }
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

// ── Commands ────────────────────────────────────────────────────────────────
//
// GET /:id/commands — the merged slash-command registry for the session
// (built-ins + skills + user/repo templates + plugin commands) plus registry
// diagnostics. Building the session (via `loadEngineSession`) is what wires the
// host `templateProvider`/`commandContext`; the registry is built lazily and
// cached on the Session, refreshed after workspace prep.
messagesRouter.get("/:id/commands", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  // Refresh before reading so user templates (DB-backed, always available) and
  // repo templates (readable once the sandbox is ready) land in the registry.
  // Cheap when nothing changed: one DB read plus, only when the sandbox is
  // ready, one exec.
  await engineSession.refreshCommandRegistry();
  const registry = engineSession.commandRegistry();
  const body: ListCommandsResponse = {
    commands: registry.list(),
    diagnostics: registry.diagnostics(),
  };
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

messagesRouter.post("/:id/messages", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text is required" }, 400);
  }

  await engineSession.ensureDefaultThread();
  const thread = resolveThread(engineSession, body.threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  // Resolve "/"-text against the registry BEFORE choosing a path, so only
  // confirmed commands lose thread targeting:
  // - execute-kind (builtin/plugin) → `session.prompt()`; commands run on
  //   the default thread (engine invariant).
  // - expand-kind (skill/template) → expand here, then submit the expanded
  //   text to the REQUESTED thread like any prompt.
  // - pass-kind (unknown "/word", e.g. "/etc/passwd is the file") → the
  //   requested thread, text unchanged — never silently rerouted.
  const outcome = body.text.startsWith("/")
    ? dispatchCommand(body.text, engineSession.commandRegistry())
    : null;
  const receipt =
    outcome && outcome.kind === "execute"
      ? await engineSession.prompt(body.text, {})
      : await thread.submitPrompt(outcome?.kind === "expand" ? outcome.text : body.text, {});

  // Touch the session row so list ordering reflects recency.
  await db
    .update(agentSessions)
    .set({ updatedAt: Date.now() })
    .where(eq(agentSessions.id, session.id));

  const resp: SendPromptResponse = {
    // Commands take no queue item; "" would read as a real (broken) id.
    messageId: receipt.queueItemId || null,
    threadId: receipt.threadId,
  };
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
